package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/go-logr/logr"
	"github.com/spf13/pflag"
	"golang.org/x/sync/errgroup"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/client"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	agentserver "github.com/benebsworth/paprika/internal/agent/server"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/clusterconfig"
	"github.com/benebsworth/paprika/internal/metrics"
	"github.com/benebsworth/paprika/internal/observability"
	"github.com/benebsworth/paprika/internal/satellite"
	"github.com/benebsworth/paprika/internal/satellitecontrol"
)

func registerSatelliteFlags(fs *pflag.FlagSet) {
	fs.String("satellite-control-plane-url", "", "HTTPS control plane URL for outbound cluster reports.")
	fs.String("satellite-cluster-name", "", "Central Cluster registration name.")
	fs.String("satellite-cluster-namespace", "paprika-system", "Central Cluster registration namespace.")
	fs.String("satellite-display-name", "", "Display name used when the cluster is first onboarded.")
	fs.String("satellite-token-file", "", "Mounted per-cluster enrollment credential file.")
	fs.String("satellite-ca-file", "", "Optional PEM CA bundle for the control plane.")
	fs.Duration("satellite-heartbeat-interval", 30*time.Second, "Maximum interval between inventory reports.")
	fs.Duration("satellite-batch-interval", 2*time.Second, "Interval for coalescing application state changes.")
	fs.StringSlice("satellite-management-policies", []string{string(clustersv1alpha1.ManagementPolicyAll)},
		"Management policies this satellite permits locally, comma-separated (Observe,Apply,Prune,Delete,SelfHeal,Rollout,*). Reported to the control plane; the Cluster's own ceiling is authoritative there.")
	fs.String("satellite-autonomy", string(clustersv1alpha1.AutonomyFailover),
		"Autonomy mode: ObserveOnly reports and never reconciles locally, Failover reconciles after a control-plane outage, Delegated always reconciles.")
	fs.String("satellite-state-namespace", "",
		"Namespace this satellite keeps its own state in. Defaults to the pod's namespace; it is not the registration namespace.")
	fs.Duration("satellite-failover-timeout", satellite.DefaultFailoverTimeout,
		"How long Failover waits without control-plane contact before reconciling locally.")
	fs.Duration("satellite-autonomy-interval", satellite.DefaultAutonomyInterval,
		"How often the autonomy loop checks connectivity and re-applies remembered bundles.")
	fs.Bool("satellite-stream-enabled", false,
		"Keep one bidirectional link to the control plane instead of one POST per report. Enables tasks sent by the control plane, such as applying a rendered manifest bundle.")
}

//nolint:cyclop // satellite startup assembles collector, executor, store and loop.
func runSatelliteMode(ctx context.Context, cfg *cliConfig, logger logr.Logger) error {
	kubeConfig, err := rest.InClusterConfig()
	if err != nil {
		return fmt.Errorf("load satellite in-cluster config: %w", err)
	}
	kubeConfig = clusterconfig.WithClientRateLimits(negotiateProtobuf(kubeConfig))
	kubeClient, err := kubernetes.NewForConfig(kubeConfig)
	if err != nil {
		return fmt.Errorf("create satellite Kubernetes client: %w", err)
	}
	dynClient, err := dynamic.NewForConfig(kubeConfig)
	if err != nil {
		return fmt.Errorf("create satellite dynamic client: %w", err)
	}
	autonomy, err := parseSatelliteAutonomy(cfg.SatelliteAutonomy)
	if err != nil {
		return err
	}
	policies, err := parseSatellitePolicies(cfg.SatelliteManagementPolicies)
	if err != nil {
		return err
	}
	executor, err := buildSatelliteExecutor(cfg, kubeConfig, cfg.SatelliteStreamEnabled || autonomy.ReconcilesLocally())
	if err != nil {
		return err
	}
	// The bundle store belongs to the satellite's own namespace, not to the
	// registration namespace: it is local state, and the satellite's namespaced
	// Role is scoped to where it runs.
	store := satellite.NewConfigMapBundleStore(kubeClient, satelliteStateNamespace(cfg), satelliteBundleStoreName)
	var taskExecutor satellite.TaskExecutor
	if executor != nil {
		taskExecutor = &satellite.RecordingExecutor{Inner: executor, Store: store}
	}
	var collectorRef *satellite.Collector
	var autonomyLoop *satellite.Autonomy
	if autonomy.ReconcilesLocally() {
		autonomyLoop, err = satellite.NewAutonomy(&satellite.AutonomyConfig{
			Mode:            autonomy,
			FailoverTimeout: cfg.SatelliteFailoverTimeout,
			Interval:        cfg.SatelliteAutonomyInterval,
			Store:           store,
			Executor:        taskExecutor,
			Connected:       func() bool { return collectorRef != nil && collectorRef.Connected() },
		})
		if err != nil {
			return fmt.Errorf("configure satellite autonomy: %w", err)
		}
	}
	operatingState := func() clustersv1alpha1.SatelliteOperatingState { return autonomyLoop.State() }
	collector, err := satellite.NewCollector(kubeClient, dynClient, satellite.Config{
		ControlPlaneURL: cfg.SatelliteControlPlaneURL, ClusterName: cfg.SatelliteClusterName,
		ClusterNamespace: cfg.SatelliteClusterNamespace, DisplayName: cfg.SatelliteDisplayName,
		TokenFile: cfg.SatelliteTokenFile, CAFile: cfg.SatelliteCAFile,
		HeartbeatInterval: cfg.SatelliteHeartbeatInterval, BatchInterval: cfg.SatelliteBatchInterval,
		Autonomy: autonomy, ManagementPolicies: policies,
		Stream: cfg.SatelliteStreamEnabled, Executor: taskExecutor,
	})
	if err != nil {
		return fmt.Errorf("configure satellite: %w", err)
	}
	collectorRef = collector
	if autonomyLoop != nil {
		collector.SetOperatingState(operatingState)
	}
	telemetry := observability.NewTelemetry(ctx, observability.ConfigFromEnv())
	defer func() { _ = telemetry.Shutdown(ctx) }() //nolint:errcheck // telemetry shutdown is best-effort.
	group, runCtx := errgroup.WithContext(ctx)
	healthServer := buildHealthProbeServer(buildHealthMux(logger, func(_ *http.Request) error {
		if !collector.Ready() {
			return errors.New("satellite inventory caches are not ready")
		}
		return nil
	}), cfg.ProbeAddr)
	group.Go(func() error {
		return runHTTPServer(runCtx, healthServer, "satellite health probes", logger, nil, false, 0)
	})
	group.Go(func() error { return collector.Run(runCtx) })
	if autonomyLoop != nil {
		group.Go(func() error { return autonomyLoop.Run(runCtx) })
	}
	startMetricsServer(runCtx, cfg.MetricsAddr, logger)
	startPprofServer(runCtx, cfg.PprofAddr, logger)
	if err := group.Wait(); err != nil {
		return fmt.Errorf("run satellite: %w", err)
	}
	return nil
}

// parseSatelliteAutonomy rejects an unrecognised mode at startup rather than
// reporting a value the control plane will refuse to store.
func parseSatelliteAutonomy(raw string) (clustersv1alpha1.AutonomyMode, error) {
	mode := clustersv1alpha1.AutonomyMode(strings.TrimSpace(raw))
	if mode == "" {
		return clustersv1alpha1.DefaultAutonomyMode(), nil
	}
	if !mode.Valid() {
		return "", fmt.Errorf("satellite autonomy %q is not one of ObserveOnly, Failover or Delegated", raw)
	}
	return mode, nil
}

// parseSatellitePolicies validates the local policy claim. The satellite reports
// it so the control plane can spot a registration whose two sides disagree; it
// does not grant anything the Cluster ceiling withholds.
func parseSatellitePolicies(raw []string) ([]clustersv1alpha1.ManagementPolicy, error) {
	if len(raw) == 0 {
		return paprikav1.DefaultManagementPolicies(), nil
	}
	policies := make([]clustersv1alpha1.ManagementPolicy, 0, len(raw))
	for _, value := range raw {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		policy := clustersv1alpha1.ManagementPolicy(trimmed)
		if !paprikav1.ValidManagementPolicy(policy) {
			return nil, fmt.Errorf("satellite management policy %q is not one of Observe, Apply, Prune, Delete, SelfHeal, Rollout or *", trimmed)
		}
		policies = append(policies, policy)
	}
	if len(policies) == 0 {
		return paprikav1.DefaultManagementPolicies(), nil
	}
	return policies, nil
}

// satelliteApplyExecutor runs an apply task the control plane sends down the
// link, through the same agent server the inbound transport uses. Sharing that
// path is what makes the two transports equivalent: a bundle applied over the
// link and one applied over the agent endpoint produce the same result.
// satelliteBundleStoreName is the ConfigMap the satellite keeps its remembered
// bundles in, inside its own namespace.
const satelliteBundleStoreName = "paprika-satellite-bundles"

// satelliteStateNamespace resolves where this satellite keeps local state. The
// registration namespace names the Cluster on the control plane and is a
// different thing entirely.
func satelliteStateNamespace(cfg *cliConfig) string {
	if cfg.SatelliteStateNamespace != "" {
		return cfg.SatelliteStateNamespace
	}
	if data, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace"); err == nil {
		if namespace := strings.TrimSpace(string(data)); namespace != "" {
			return namespace
		}
	}
	if namespace := strings.TrimSpace(os.Getenv("PAPRIKA_NAMESPACE")); namespace != "" {
		return namespace
	}
	return cfg.SatelliteClusterNamespace
}

type satelliteApplyExecutor struct {
	server *agentserver.Server
}

func (e satelliteApplyExecutor) Apply(
	ctx context.Context,
	namespace, appName string,
	manifests []byte,
) (applied int, errs []string, err error) {
	response, err := e.server.Apply(ctx, &agentserver.ApplyRequest{
		Namespace: namespace,
		AppName:   appName,
		Manifests: manifests,
	})
	if err != nil {
		return 0, nil, fmt.Errorf("apply bundle over satellite link: %w", err)
	}
	return response.Applied, response.Errors, nil
}

// buildSatelliteExecutor returns nil when the link is disabled: a satellite that
// only reports declines work rather than building an applier it will never use.
func buildSatelliteExecutor(cfg *cliConfig, kubeConfig *rest.Config, enabled bool) (executor satellite.TaskExecutor, err error) {
	if !enabled {
		return nil, nil
	}
	server, err := agentserver.NewServer(cfg.SatelliteClusterName, kubeConfig)
	if err != nil {
		return nil, fmt.Errorf("create satellite apply executor: %w", err)
	}
	return satelliteApplyExecutor{server: server}, nil
}

// satelliteMuxRegistrar mounts both satellite transports: the pooled POST and
// the bidirectional link. hub is shared with the release controller so a task
// can be dispatched down the same connection that carries reports.
//
// Use an uncached client for credential rotation and the report sequence fence.
// Every API replica must read the latest resourceVersion before accepting a
// delta — a cached read could accept a report against a stale baseline.
// newInstrumentedHub builds the control-plane hub and publishes its link gauge.
// A hub is created once per process, so the gauge registers exactly once.
func newInstrumentedHub() *satellitecontrol.Hub {
	hub := satellitecontrol.NewHub()
	metrics.MustRegisterSatelliteLinkGauge(func() []metrics.SatelliteLinkState {
		keys := hub.ConnectedClusters()
		states := make([]metrics.SatelliteLinkState, 0, len(keys))
		for _, key := range keys {
			states = append(states, metrics.SatelliteLinkState{Namespace: key.Namespace, Name: key.Name})
		}
		return states
	})
	return hub
}

func satelliteMuxRegistrar(cfg *rest.Config, scheme *runtime.Scheme, hub *satellitecontrol.Hub) (func(*http.ServeMux), error) {
	c, err := client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		return nil, fmt.Errorf("create satellite registry client: %w", err)
	}
	if hub == nil {
		// This process owns the only hub it will ever create, so the link gauge
		// registers here. A caller that passes a hub registers it where it built
		// one, which keeps a second registration from resetting the series.
		hub = newInstrumentedHub()
	}
	handler := satellitecontrol.NewHandler(c)
	_, linkHandler := v1connect.NewSatelliteLinkHandler(
		satellitecontrol.NewLinkServer(handler, hub),
		connect.WithReadMaxBytes(satellite.MaxReportBytes),
	)
	return func(mux *http.ServeMux) {
		mux.Handle(satellite.ReportPath, handler)
		mux.Handle(satellitecontrol.LinkPrefix, linkHandler)
	}, nil
}

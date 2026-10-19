package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

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
	"github.com/benebsworth/paprika/internal/clusterconfig"
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
		"Autonomy mode reported to the control plane: ObserveOnly, Failover or Delegated.")
}

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
	collector, err := satellite.NewCollector(kubeClient, dynClient, satellite.Config{
		ControlPlaneURL: cfg.SatelliteControlPlaneURL, ClusterName: cfg.SatelliteClusterName,
		ClusterNamespace: cfg.SatelliteClusterNamespace, DisplayName: cfg.SatelliteDisplayName,
		TokenFile: cfg.SatelliteTokenFile, CAFile: cfg.SatelliteCAFile,
		HeartbeatInterval: cfg.SatelliteHeartbeatInterval, BatchInterval: cfg.SatelliteBatchInterval,
		Autonomy: autonomy, ManagementPolicies: policies,
	})
	if err != nil {
		return fmt.Errorf("configure satellite: %w", err)
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

// Use an uncached client for credential rotation and the report sequence fence.
// Every API replica must read the latest resourceVersion before accepting a delta.
func satelliteMuxRegistrar(cfg *rest.Config, scheme *runtime.Scheme) (func(*http.ServeMux), error) {
	c, err := client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		return nil, fmt.Errorf("create satellite registry client: %w", err)
	}
	handler := satellitecontrol.NewHandler(c)
	return func(mux *http.ServeMux) { mux.Handle(satellite.ReportPath, handler) }, nil
}

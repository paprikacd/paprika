package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-logr/logr"
	"github.com/spf13/pflag"
	"golang.org/x/sync/errgroup"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/client"

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
	collector, err := satellite.NewCollector(kubeClient, dynClient, satellite.Config{
		ControlPlaneURL: cfg.SatelliteControlPlaneURL, ClusterName: cfg.SatelliteClusterName,
		ClusterNamespace: cfg.SatelliteClusterNamespace, DisplayName: cfg.SatelliteDisplayName,
		TokenFile: cfg.SatelliteTokenFile, CAFile: cfg.SatelliteCAFile,
		HeartbeatInterval: cfg.SatelliteHeartbeatInterval, BatchInterval: cfg.SatelliteBatchInterval,
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

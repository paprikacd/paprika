// paprika-insights serves provider queries and persisted dashboards independently
// of the Kubernetes controller. Expose it through Paprika's authenticated proxy.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/benebsworth/paprika/internal/insights"
	"github.com/benebsworth/paprika/internal/memlimit"
	"github.com/benebsworth/paprika/internal/observability"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "lint" {
		os.Exit(runLint(os.Args[2:], os.Stdout, os.Stderr))
	}
	if err := run(); err != nil {
		slog.Error("insights stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	memlimit.Apply(slog.Info)
	listen := flag.String("listen", "127.0.0.1:8090", "HTTP address (use :8090 in Kubernetes)")
	dataDir := flag.String("data-dir", "./data/insights", "Persistent dashboard directory; one service replica only")
	providersFile := flag.String("providers", "", "Path to provider configuration JSON")
	dev := flag.Bool("dev", false, "Disable service authentication on a loopback listener for local development")
	metricsListen := flag.String("metrics-listen", "", "Optional second HTTP address that serves only /metrics, such as :8080, so a scraper can be admitted to it without reaching /api")
	capacity := registerCapacityFlags(flag.CommandLine)
	resultCacheMiB := registerResultCacheFlag(flag.CommandLine)
	flag.Parse()
	if *dev {
		host, _, err := net.SplitHostPort(*listen)
		ip := net.ParseIP(host)
		if err != nil || ip == nil || !ip.IsLoopback() {
			return errors.New("--dev requires an explicit loopback listen address")
		}
	}
	admission := capacity.capacity()
	cfg := insights.Config{Token: os.Getenv("PAPRIKA_INSIGHTS_TOKEN"), InsecureDev: *dev, ObservabilityURL: os.Getenv("PAPRIKA_OBSERVABILITY_GATEWAY_ADDR"), Capacity: &admission, ResultCacheMiB: resultCacheBudget(*resultCacheMiB)}
	if *providersFile != "" {
		if configErr := loadProvidersConfig(*providersFile, &cfg); configErr != nil {
			return configErr
		}
	}
	telemetryConfig := observability.ConfigFromEnv()
	if os.Getenv("OTEL_SERVICE_NAME") == "" {
		telemetryConfig.ServiceName = "paprika-insights"
	}
	telemetry := observability.NewTelemetry(context.Background(), telemetryConfig)
	defer shutdownTelemetry(telemetry)
	// Telemetry starts before the store opens so that the quarantine counter, which NewServer increments when startup
	// commits the quarantine, reaches the configured providers.
	// The metrics listener binds first, so a taken address also stops startup before the store is read.
	metricsListener, err := listenMetrics(*metricsListen)
	if err != nil {
		return err
	}
	service, listener, err := openService(*listen, *dataDir, cfg)
	if err != nil {
		return errors.Join(err, closeListener(metricsListener))
	}
	server := &http.Server{Addr: *listen, Handler: service.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	effective := service.Capacity()
	slog.Info("Insights capacity", "queryConcurrency", effective.QueryConcurrency, "queryQueue", effective.QueryQueue, "queryQueueWait", effective.QueryWait.String(),
		"catalogConcurrency", effective.CatalogConcurrency, "catalogQueue", effective.CatalogQueue, "catalogQueueWait", effective.CatalogWait.String(),
		"dashboardQueryParallelism", effective.DashboardQueryParallelism)
	slog.Info("Paprika Insights listening", "address", listener.Addr().String(), "providers", len(cfg.Providers), "development", *dev)
	startMetrics(ctx, stop, service, metricsListener)
	return serve(ctx, server, listener)
}

// startMetrics serves the metrics-only listener in the background, when one is bound.
// A failed metrics listener stops the service, so the pod restarts rather than running unobserved.
func startMetrics(ctx context.Context, stop context.CancelFunc, service *insights.Server, listener net.Listener) {
	if listener == nil {
		return
	}
	server := newMetricsServer(service)
	slog.Info("Paprika Insights metrics listening", "address", listener.Addr().String())
	go func() {
		if err := serve(ctx, server, listener); err != nil {
			slog.Error("Insights metrics listener stopped", "error", err)
			stop()
		}
	}()
}

// listenMetrics binds the optional metrics-only listener. An empty address binds nothing.
func listenMetrics(addr string) (net.Listener, error) {
	if addr == "" {
		return nil, nil
	}
	var lc net.ListenConfig
	listener, err := lc.Listen(context.Background(), "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("listen Insights metrics: %w", err)
	}
	return listener, nil
}

func closeListener(listener net.Listener) error {
	if listener == nil {
		return nil
	}
	if err := listener.Close(); err != nil {
		return fmt.Errorf("close Insights metrics listener: %w", err)
	}
	return nil
}

// newMetricsServer serves only /metrics. It answers no /api route, so a NetworkPolicy
// can admit a scraper to its port without admitting it to the service API.
func newMetricsServer(service *insights.Server) *http.Server {
	return &http.Server{Handler: service.MetricsHandler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
}

// openService binds the listener before the store is read. A taken or invalid address therefore stops startup while
// every stored document is still in place. The store then opens, and NewServer commits the quarantine moves only once
// the whole startup has succeeded. The caller serves on the returned listener.
func openService(listen, dataDir string, cfg insights.Config) (*insights.Server, net.Listener, error) {
	// listenInsights bounds each accepted connection's receive buffer (see listen.go).
	listener, err := listenInsights(context.Background(), listen)
	if err != nil {
		return nil, nil, fmt.Errorf("listen Insights: %w", err)
	}
	store, err := insights.OpenStore(dataDir)
	if err != nil {
		return nil, nil, errors.Join(fmt.Errorf("open Insights store: %w", err), listener.Close())
	}
	service, err := insights.NewServer(cfg, store)
	if err != nil {
		return nil, nil, errors.Join(fmt.Errorf("configure Insights server: %w", err), listener.Close())
	}
	return service, listener, nil
}

func loadProvidersConfig(path string, cfg *insights.Config) error {
	f, err := os.Open(path) //nolint:gosec // G304: The local operator chooses the provider configuration path through a CLI flag.
	if err != nil {
		return fmt.Errorf("open providers config: %w", err)
	}
	defer func() {
		if closeErr := f.Close(); closeErr != nil {
			slog.Warn("close providers config", "error", closeErr)
		}
	}()
	decoder := json.NewDecoder(http.MaxBytesReader(nil, f, 1<<20))
	decoder.DisallowUnknownFields()
	if decodeErr := decoder.Decode(cfg); decodeErr != nil {
		return fmt.Errorf("decode providers config: %w", decodeErr)
	}
	if decodeErr := decoder.Decode(new(any)); decodeErr != io.EOF {
		return errors.New("providers config must contain one JSON document")
	}
	return nil
}

func shutdownTelemetry(telemetry *observability.Telemetry) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := telemetry.Shutdown(ctx); err != nil {
		slog.Warn("telemetry shutdown incomplete", "error", err)
	}
}

func serve(ctx context.Context, server *http.Server, listener net.Listener) error {
	errCh := make(chan error, 1)
	go func() { errCh <- server.Serve(listener) }()
	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve Insights: %w", err)
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shut down Insights server: %w", err)
		}
		return nil
	}
}

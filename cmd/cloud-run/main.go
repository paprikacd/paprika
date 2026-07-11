// Cloud Run entrypoint for the Paprika stateless plane.
// Serves: Connect RPC API (CRUD + source resolve + rendering),
// webhook receiver and the Next.js UI.
// Connects to K8s via kubeconfig (local dev, Kind) or in-cluster config (Cloud Run with Workload Identity).
// Controllers stay in the K8s cluster; this binary never reconciles.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"connectrpc.com/connect"
	"connectrpc.com/otelconnect"
	"github.com/go-logr/logr"
	"github.com/go-logr/zapr"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/contrib/bridges/otelzap"
	gozap "go.uber.org/zap"
	gozapcore "go.uber.org/zap/zapcore"
	"golang.org/x/crypto/bcrypt"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/apiutil"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	crmetrics "sigs.k8s.io/controller-runtime/pkg/metrics"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
	apiserver "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/audit"
	"github.com/benebsworth/paprika/internal/cache"
	"github.com/benebsworth/paprika/internal/controller/pipelines"
	"github.com/benebsworth/paprika/internal/engine"
	"github.com/benebsworth/paprika/internal/governance"
	"github.com/benebsworth/paprika/internal/metrics"
	"github.com/benebsworth/paprika/internal/observability"
	reposerverclient "github.com/benebsworth/paprika/internal/reposerverclient"
	"github.com/benebsworth/paprika/internal/webhook/receiver"
)

const (
	defaultReadHeaderTimeout     = 10 * time.Second
	healthProbeReadHeaderTimeout = 5 * time.Second
	serverShutdownTimeout        = 15 * time.Second
	defaultRedisAddr             = "localhost:6379"
	defaultPort                  = "8080"
)

func newScheme() *runtime.Scheme {
	scheme := runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(pipelinesv1alpha1.AddToScheme(scheme))
	utilruntime.Must(corev1alpha1.AddToScheme(scheme))
	utilruntime.Must(clustersv1alpha1.AddToScheme(scheme))
	utilruntime.Must(policyv1alpha1.AddToScheme(scheme))
	return scheme
}

func main() {
	ctrl.SetLogger(zap.New(zap.UseDevMode(false)))
	setupLog := ctrl.Log.WithName("setup")

	if err := metrics.RegisterCollectors(crmetrics.Registry); err != nil {
		setupLog.Error(err, "Failed to register metrics collectors")
		os.Exit(1)
	}

	if err := run(setupLog); err != nil {
		setupLog.Error(err, "Fatal startup error")
		os.Exit(1)
	}
}

//nolint:cyclop,funlen,gocyclo // CLI setup and wiring.
func run(setupLog logr.Logger) error {
	ctx := context.Background()

	var (
		port                                                        = os.Getenv("PORT")
		kubeconfig                                                  = flag.String("kubeconfig", "", "Path to kubeconfig. Uses default loading rules (KUBECONFIG env, ~/.kube/config) when empty.")
		probeAddr                                                   = flag.String("health-probe-bind-address", ":8081", "Health probe bind address.")
		metricsAddr                                                 = flag.String("metrics-bind-address", ":0", "The address the metrics endpoint binds to. Use :8080 for HTTP or :0 to disable.")
		workDir                                                     = flag.String("work-dir", "/tmp/paprika-cloudrun", "Working directory for template sources.")
		webhookSecret                                               = os.Getenv("PAPRIKA_WEBHOOK_SECRET")
		authEnabled                                                 bool
		authBasicUsername, authBasicPassword, authBasicPasswordHash string
		authOIDCIssuerURL, authOIDCClientID, authOIDCClientSecret   string
	)

	flag.BoolVar(&authEnabled, "auth-enabled", false, "Enable authentication.")
	flag.StringVar(&authBasicUsername, "auth-basic-username", "", "Basic auth username.")
	flag.StringVar(&authBasicPassword, "auth-basic-password", "", "Basic auth password (deprecated: use --auth-basic-password-hash instead).")
	flag.StringVar(&authBasicPasswordHash, "auth-basic-password-hash", "", "Basic auth SHA-256 hash.")
	flag.StringVar(&authOIDCIssuerURL, "auth-oidc-issuer-url", "", "OIDC issuer URL.")
	flag.StringVar(&authOIDCClientID, "auth-oidc-client-id", "", "OIDC client ID.")
	flag.StringVar(&authOIDCClientSecret, "auth-oidc-client-secret", "", "OIDC client secret. Prefer setting via env var to avoid process-list exposure.")
	flag.Parse()

	if port == "" {
		port = defaultPort
	}
	addr := ":" + port

	auditEnabled := os.Getenv("PAPRIKA_AUDIT_ENABLED") == "true"
	repoServerAddr := os.Getenv("PAPRIKA_REPO_SERVER_ADDR")
	cacheCfg := cache.Config{
		Backend:       os.Getenv("PAPRIKA_CACHE_BACKEND"),
		RedisAddr:     os.Getenv("PAPRIKA_REDIS_ADDR"),
		RedisPassword: os.Getenv("PAPRIKA_REDIS_PASSWORD"),
		RedisDB:       0,
	}
	if cacheCfg.Backend == "" {
		cacheCfg.Backend = cache.BackendMemory
	}
	if cacheCfg.RedisAddr == "" {
		cacheCfg.RedisAddr = defaultRedisAddr
	}
	if dbStr := os.Getenv("PAPRIKA_REDIS_DB"); dbStr != "" {
		if db, err := strconv.Atoi(dbStr); err == nil {
			cacheCfg.RedisDB = db
		}
	}

	telemetry := observability.NewTelemetry(ctx, observability.ConfigFromEnv())
	if telemetry.IsTracingEnabled() {
		setupLog.Info("OpenTelemetry tracing enabled")
		// Bridge zap logs to the OTel Logs signal (otelzap) so every record is
		// forwarded to the configured OTLP backend alongside traces/metrics.
		raw := zap.NewRaw(zap.UseDevMode(false))
		ctrl.SetLogger(zapr.NewLogger(bridgeZapWithOTel(raw, telemetry)))
		setupLog = ctrl.Log.WithName("setup")
	}
	defer func() {
		if shutdownErr := telemetry.Shutdown(ctx); shutdownErr != nil {
			setupLog.Error(shutdownErr, "Failed to shutdown tracing")
		}
	}()

	k8sConfig, err := buildK8sConfig(*kubeconfig)
	if err != nil {
		return fmt.Errorf("build K8s config: %w", err)
	}

	scheme := newScheme()
	k8sClient, err := client.New(k8sConfig, client.Options{Scheme: scheme})
	if err != nil {
		return fmt.Errorf("create K8s client: %w", err)
	}

	k8sClientset, err := kubernetes.NewForConfig(k8sConfig)
	if err != nil {
		return fmt.Errorf("create k8s clientset: %w", err)
	}

	renderer := buildRenderer(ctx, setupLog, *workDir, k8sClient, repoServerAddr, cacheCfg)

	resolver := governance.NewProjectResolver(k8sClient)
	projectValidator := governance.NewProjectValidator(resolver, governance.NewClusterResolver(k8sClient), nil)
	policyEvaluator := governance.NewPolicyEvaluator(k8sClient)

	opts := []apiserver.ServerOption{
		apiserver.WithRenderer(renderer),
		apiserver.WithGovernanceValidator(projectValidator),
		apiserver.WithGovernancePolicyEvaluator(policyEvaluator),
	}

	authCfg := buildAuthConfig(authEnabled, authBasicUsername, authBasicPassword, authBasicPasswordHash,
		authOIDCIssuerURL, authOIDCClientID, authOIDCClientSecret)
	authInterceptor, err := auth.Interceptor(ctx, authCfg, k8sClient)
	if err != nil {
		return fmt.Errorf("build auth interceptor: %w", err)
	}
	if authCfg.Enabled {
		authz, authzErr := auth.BuildAuthorizer(authCfg, k8sClient)
		if authzErr != nil {
			return fmt.Errorf("build authorizer: %w", authzErr)
		}
		opts = append(opts, apiserver.WithAuthorizer(authz))
	}
	if auditEnabled {
		opts = append(opts, apiserver.WithAuditor(audit.NewLogAuditor()))
	}
	opts = append(opts, apiserver.WithK8sClient(k8sClientset))
	if dc, dErr := dynamic.NewForConfig(k8sConfig); dErr == nil {
		opts = append(opts, apiserver.WithDynamicClient(dc))
	}
	if mapper, mapperErr := apiutil.NewDynamicRESTMapper(k8sConfig, nil); mapperErr == nil {
		opts = append(opts, apiserver.WithRESTMapper(mapper))
	}

	paprikaServer := apiserver.NewPaprikaServer(k8sClient, nil, opts...)

	otelInterceptor, err := otelconnect.NewInterceptor()
	if err != nil {
		return fmt.Errorf("otelconnect interceptor: %w", err)
	}

	const maxMsgBytes = 10 * 1024 * 1024 // 10 MiB
	_, connectHandler := v1connect.NewPaprikaServiceHandler(paprikaServer,
		connect.WithInterceptors(otelInterceptor, authInterceptor, paprikaServer.AuditInterceptor()),
		connect.WithReadMaxBytes(maxMsgBytes),
	)

	uiHandler, uiErr := apiserver.UIHandler()
	if uiErr != nil {
		return fmt.Errorf("build UI handler: %w", uiErr)
	}
	mux := buildCloudRunMux(
		connectHandler,
		receiver.NewHandler(k8sClient, webhookSecret),
		uiHandler,
		setupLog,
	)

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: defaultReadHeaderTimeout,
	}

	// Cloud Run sends SIGTERM with a grace period (default 30s).
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	go func() {
		setupLog.Info("Starting Cloud Run server", "addr", addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			setupLog.Error(err, "Server error")
		}
	}()

	healthSrv := startHealthProbe(setupLog, *probeAddr)

	startMetricsServer(ctx, *metricsAddr, setupLog)

	<-ctx.Done()
	setupLog.Info("Shutting down...")

	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), serverShutdownTimeout)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		setupLog.Error(err, "Server forced to shutdown")
	}
	if err := healthSrv.Shutdown(shutdownCtx); err != nil {
		setupLog.Error(err, "Health probe server forced to shutdown")
	}

	setupLog.Info("Server exited")
	return nil
}

func buildCloudRunMux(
	connectHandler http.Handler,
	webhookHandler http.Handler,
	uiHandler http.Handler,
	setupLog logr.Logger,
) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("/paprika.v1.PaprikaService/", connectHandler)
	// Fail the legacy unauthenticated browser stream closed. The embedded UI is
	// a catch-all, so omitting this exact route would incorrectly return 200.
	mux.Handle("/events", http.NotFoundHandler())
	mux.Handle("/webhook", webhookHandler)
	mux.HandleFunc("/healthz", healthzHandler(setupLog))
	mux.HandleFunc("/readyz", healthzHandler(setupLog))
	mux.Handle("/", uiHandler)
	return mux
}

// bridgeZapWithOTel tees raw's zap core with an otelzap core that forwards
// records to the OTel Logs signal via telemetry's LoggerProvider. When telemetry
// is disabled (or has no LoggerProvider) it returns raw unchanged so there is no
// bridging overhead.
func bridgeZapWithOTel(raw *gozap.Logger, telemetry *observability.Telemetry) *gozap.Logger {
	if telemetry == nil || !telemetry.IsTracingEnabled() {
		return raw
	}
	lp := telemetry.LoggerProvider()
	if lp == nil {
		return raw
	}
	return gozap.New(gozapcore.NewTee(
		raw.Core(),
		otelzap.NewCore("paprika", otelzap.WithLoggerProvider(lp)),
	))
}

func buildK8sConfig(kubeconfigPath string) (*rest.Config, error) {
	loadingRules := clientcmd.NewDefaultClientConfigLoadingRules()
	if kubeconfigPath != "" {
		loadingRules.ExplicitPath = kubeconfigPath
	}

	configOverrides := &clientcmd.ConfigOverrides{}
	k8sConfig, err := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
		loadingRules, configOverrides,
	).ClientConfig()
	if err != nil {
		// Fallback: in-cluster config (Cloud Run with Workload Identity).
		inCluster, inErr := rest.InClusterConfig()
		if inErr != nil {
			return nil, fmt.Errorf("no kubeconfig and no in-cluster config: %w", err)
		}
		negotiateProtobuf(inCluster)
		return inCluster, nil
	}
	negotiateProtobuf(k8sConfig)
	return k8sConfig, nil
}

// negotiateProtobuf configures the client-go rest.Config to prefer protobuf over JSON
// for built-in K8s kinds. CRDs and Watch payloads without protobuf schemas fall back
// to JSON automatically because AcceptContentTypes lists both.
func negotiateProtobuf(cfg *rest.Config) {
	cfg.ContentType = runtime.ContentTypeProtobuf
	cfg.AcceptContentTypes = runtime.ContentTypeProtobuf + "," + runtime.ContentTypeJSON
}

func buildRenderer(ctx context.Context, setupLog logr.Logger, workDir string, k8sClient client.Client, repoServerAddr string, cacheCfg cache.Config) pipelines.TemplateRenderer {
	// When PAPRIKA_REPO_SERVER_ADDR is set, delegate render/resolve to a remote repo server.
	if repoServerAddr != "" {
		setupLog.Info("Using remote repo server", "addr", repoServerAddr)
		base := engine.NewHelmSDKRendererWithClient(workDir, k8sClient)
		cached := engine.NewCachedTemplateRenderer(base, cache.NewMemoryCache(), workDir, 0)
		return engine.NewRepoServerRenderer(reposerverclient.New(repoServerAddr), cached)
	}

	// Embedded renderer with Redis or in-memory cache.
	var c interface {
		cache.Getter
		cache.Setter
	}
	cacheClient, err := cache.New(ctx, cacheCfg)
	if err != nil {
		setupLog.Info("No external cache found, using in-memory cache")
		c = cache.NewMemoryCache()
	} else if pingErr := cacheClient.Ping(ctx); pingErr != nil {
		setupLog.Error(pingErr, "Cache ping failed, using in-memory cache")
		if closeErr := cacheClient.Close(); closeErr != nil {
			setupLog.Error(closeErr, "Failed to close cache after ping failure")
		}
		c = cache.NewMemoryCache()
	} else {
		c = cacheClient
	}
	base := engine.NewHelmSDKRendererWithClient(workDir, k8sClient)
	return engine.NewCachedTemplateRenderer(base, c, workDir, 0)
}

func startHealthProbe(setupLog logr.Logger, addr string) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", healthzHandler(setupLog))
	mux.HandleFunc("/readyz", healthzHandler(setupLog))

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: healthProbeReadHeaderTimeout,
	}
	go func() {
		setupLog.Info("Starting health probe server", "addr", addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			setupLog.Error(err, "Health probe server error")
		}
	}()
	return server
}

func startMetricsServer(ctx context.Context, addr string, setupLog logr.Logger) {
	if addr == "0" || addr == "" {
		return
	}
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(crmetrics.Registry, promhttp.HandlerOpts{}))
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: defaultReadHeaderTimeout,
	}
	go func() {
		setupLog.Info("Starting metrics server", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			setupLog.Error(err, "Metrics server exited with error")
		}
	}()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), serverShutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			setupLog.Error(err, "Failed to shutdown metrics server")
		}
	}()
}

func healthzHandler(setupLog logr.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		if _, err := fmt.Fprintln(w, "ok"); err != nil {
			setupLog.Error(err, "Failed to write health response")
		}
	}
}

func buildAuthConfig(enabled bool, basicUsername, basicPassword, basicPasswordHash, oidcIssuerURL, oidcClientID, oidcClientSecret string) auth.Config {
	cfg := auth.Config{
		Enabled: enabled,
	}
	if !enabled {
		return cfg
	}
	if basicUsername != "" {
		passHash := basicPasswordHash
		if passHash == "" && basicPassword != "" {
			h, err := bcrypt.GenerateFromPassword([]byte(basicPassword), bcrypt.DefaultCost)
			if err != nil {
				panic(err)
			}
			passHash = string(h)
		}
		cfg.BasicAuth = &auth.BasicAuthConfig{
			Username:     basicUsername,
			PasswordHash: passHash,
		}
	}
	if oidcIssuerURL != "" {
		cfg.OIDC = &auth.OIDCConfig{
			IssuerURL:    oidcIssuerURL,
			ClientID:     oidcClientID,
			ClientSecret: oidcClientSecret,
		}
	}
	return cfg
}

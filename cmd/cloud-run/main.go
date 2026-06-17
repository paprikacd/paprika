// Cloud Run entrypoint for the Paprika stateless plane.
// Serves: Connect RPC API (CRUD + source resolve + rendering),
// webhook receiver, SSE events, and the Next.js UI.
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
	"syscall"
	"time"

	"connectrpc.com/connect"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
	"github.com/benebsworth/paprika/engine"
	"github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/cache"
	"github.com/benebsworth/paprika/internal/governance"
	"github.com/benebsworth/paprika/internal/observability"
	repoclient "github.com/benebsworth/paprika/internal/reposerver/client"
	"github.com/benebsworth/paprika/internal/webhook/receiver"
)

var (
	scheme   = runtime.NewScheme()
	setupLog = ctrl.Log.WithName("setup")
)

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(pipelinesv1alpha1.AddToScheme(scheme))
	utilruntime.Must(corev1alpha1.AddToScheme(scheme))
	utilruntime.Must(clustersv1alpha1.AddToScheme(scheme))
	utilruntime.Must(policyv1alpha1.AddToScheme(scheme))
}

func main() {
	if err := run(); err != nil {
		setupLog.Error(err, "Fatal startup error")
		os.Exit(1)
	}
}

//nolint:cyclop,funlen // CLI setup and wiring.
func run() error {
	var (
		port                                                        = os.Getenv("PORT")
		kubeconfig                                                  = flag.String("kubeconfig", "", "Path to kubeconfig. Uses default loading rules (KUBECONFIG env, ~/.kube/config) when empty.")
		probeAddr                                                   = flag.String("health-probe-bind-address", ":8081", "Health probe bind address.")
		workDir                                                     = flag.String("work-dir", "/tmp/paprika-cloudrun", "Working directory for template sources.")
		webhookSecret                                               = os.Getenv("PAPRIKA_WEBHOOK_SECRET")
		authEnabled                                                 bool
		authBasicUsername, authBasicPassword, authBasicPasswordHash string
		authOIDCIssuerURL, authOIDCClientID, authOIDCClientSecret   string
		authAllowUnauth                                             bool
	)

	flag.BoolVar(&authEnabled, "auth-enabled", false, "Enable authentication.")
	flag.StringVar(&authBasicUsername, "auth-basic-username", "", "Basic auth username.")
	flag.StringVar(&authBasicPassword, "auth-basic-password", "", "Basic auth password.")
	flag.StringVar(&authBasicPasswordHash, "auth-basic-password-hash", "", "Basic auth SHA-256 hash.")
	flag.StringVar(&authOIDCIssuerURL, "auth-oidc-issuer-url", "", "OIDC issuer URL.")
	flag.StringVar(&authOIDCClientID, "auth-oidc-client-id", "", "OIDC client ID.")
	flag.StringVar(&authOIDCClientSecret, "auth-oidc-client-secret", "", "OIDC client secret.")
	flag.BoolVar(&authAllowUnauth, "auth-allow-unauthenticated", false, "Allow unauthenticated requests.")
	flag.Parse()

	ctrl.SetLogger(zap.New(zap.UseDevMode(true)))

	if port == "" {
		port = "8080"
	}
	addr := ":" + port

	shutdownTracing := setupTracing()
	if shutdownTracing != nil {
		defer shutdownTracing()
	}

	k8sConfig, err := buildK8sConfig(*kubeconfig)
	if err != nil {
		return fmt.Errorf("build K8s config: %w", err)
	}

	k8sClient, err := client.New(k8sConfig, client.Options{Scheme: scheme})
	if err != nil {
		return fmt.Errorf("create K8s client: %w", err)
	}

	renderer := buildRenderer(*workDir, k8sClient)

	paprikaServer := api.NewPaprikaServer(k8sClient, nil)
	paprikaServer.SetRenderer(renderer)

	resolver := governance.NewProjectResolver(k8sClient)
	projectValidator := governance.NewProjectValidator(resolver, governance.NewClusterResolver(k8sClient), nil)
	policyEvaluator := governance.NewPolicyEvaluator(k8sClient)
	paprikaServer.SetGovernanceValidator(projectValidator)
	paprikaServer.SetGovernancePolicyEvaluator(policyEvaluator)

	authCfg := buildAuthConfig(authEnabled, authBasicUsername, authBasicPassword, authBasicPasswordHash,
		authOIDCIssuerURL, authOIDCClientID, authOIDCClientSecret, authAllowUnauth)
	authInterceptor, err := auth.Interceptor(authCfg, k8sClient)
	if err != nil {
		return fmt.Errorf("build auth interceptor: %w", err)
	}
	if authCfg.Enabled {
		authz, err := auth.BuildAuthorizer(authCfg, k8sClient)
		if err != nil {
			return fmt.Errorf("build authorizer: %w", err)
		}
		paprikaServer.SetAuthorizer(authz)
	}

	_, connectHandler := v1connect.NewPaprikaServiceHandler(paprikaServer, connect.WithInterceptors(authInterceptor))

	mux := http.NewServeMux()
	mux.Handle("/paprika.v1.PaprikaService/", connectHandler)
	mux.Handle("/events", api.NewSSEHandler(paprikaServer.Broker()))
	mux.Handle("/webhook", receiver.NewHandler(k8sClient, webhookSecret))
	mux.HandleFunc("/healthz", healthzHandler)
	mux.HandleFunc("/readyz", healthzHandler)
	mux.Handle("/", api.UIHandler())

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
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

	startHealthProbe(*probeAddr)

	<-ctx.Done()
	setupLog.Info("Shutting down...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		setupLog.Error(err, "Server forced to shutdown")
	}

	setupLog.Info("Server exited")
	return nil
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
		return inCluster, nil
	}
	return k8sConfig, nil
}

func buildRenderer(workDir string, k8sClient client.Client) engine.TemplateRenderer {
	// When PAPRIKA_REPO_SERVER_ADDR is set, delegate render/resolve to a remote repo server.
	if repoClient := repoclient.NewFromEnv(); repoClient != nil {
		setupLog.Info("Using remote repo server", "addr", os.Getenv("PAPRIKA_REPO_SERVER_ADDR"))
		base := engine.NewHelmSDKRendererWithClient(workDir, k8sClient)
		cached := engine.NewCachedTemplateRenderer(base, cache.NewMemoryCache(), workDir, 0)
		return engine.NewRepoServerRenderer(repoClient, cached)
	}

	// Embedded renderer with Redis or in-memory cache.
	c, err := cache.NewFromEnv()
	if err != nil {
		setupLog.Info("No external cache found, using in-memory cache")
		c = cache.NewMemoryCache()
	}
	base := engine.NewHelmSDKRendererWithClient(workDir, k8sClient)
	return engine.NewCachedTemplateRenderer(base, c, workDir, 0)
}

func setupTracing() func() {
	shutdown, err := observability.InitTracing()
	if err != nil {
		setupLog.Error(err, "Failed to initialize tracing")
		return nil
	}
	if observability.IsTracingEnabled() {
		setupLog.Info("OpenTelemetry tracing enabled")
	}
	return shutdown
}

var muxHealth = http.NewServeMux()

func init() {
	muxHealth.HandleFunc("/healthz", healthzHandler)
	muxHealth.HandleFunc("/readyz", healthzHandler)
}

func startHealthProbe(addr string) {
	server := &http.Server{
		Addr:              addr,
		Handler:           muxHealth,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		setupLog.Info("Starting health probe server", "addr", addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			setupLog.Error(err, "Health probe server error")
		}
	}()
}

func healthzHandler(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintln(w, "ok")
}

func buildAuthConfig(enabled bool, basicUsername, basicPassword, basicPasswordHash, oidcIssuerURL, oidcClientID, oidcClientSecret string, allowUnauth bool) auth.Config {
	cfg := auth.Config{
		Enabled:     enabled,
		AllowUnauth: allowUnauth,
	}
	if !enabled {
		return cfg
	}
	if basicUsername != "" {
		cfg.BasicAuth = &auth.BasicAuthConfig{
			Username:     basicUsername,
			Password:     basicPassword,
			PasswordHash: basicPasswordHash,
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

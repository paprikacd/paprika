/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Package main is the entry point for the Paprika operator and API server.
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"time"

	"connectrpc.com/connect"
	"github.com/go-logr/logr"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/manager"
	"sigs.k8s.io/controller-runtime/pkg/metrics/filters"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
	"sigs.k8s.io/controller-runtime/pkg/webhook"

	"github.com/benebsworth/paprika/analysis"
	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
	"github.com/benebsworth/paprika/engine"
	"github.com/benebsworth/paprika/gates"
	"github.com/benebsworth/paprika/health"
	agentserver "github.com/benebsworth/paprika/internal/agent/server"
	"github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/events"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/cache"
	"github.com/benebsworth/paprika/internal/controller/bootstrap"
	clusterscontroller "github.com/benebsworth/paprika/internal/controller/clusters"
	corecontroller "github.com/benebsworth/paprika/internal/controller/core"
	controller "github.com/benebsworth/paprika/internal/controller/pipelines"
	policycontroller "github.com/benebsworth/paprika/internal/controller/policy"
	"github.com/benebsworth/paprika/internal/governance"
	"github.com/benebsworth/paprika/internal/observability"
	"github.com/benebsworth/paprika/internal/ratelimit"
	"github.com/benebsworth/paprika/internal/reposerver"
	repoclient "github.com/benebsworth/paprika/internal/reposerver/client"
	"github.com/benebsworth/paprika/internal/sharding"
	"github.com/benebsworth/paprika/internal/syncwindow"
	webhookcorev1alpha1 "github.com/benebsworth/paprika/internal/webhook/core/v1alpha1"
	webhookpipelinesv1alpha1 "github.com/benebsworth/paprika/internal/webhook/pipelines/v1alpha1"
	webhookpolicyv1alpha1 "github.com/benebsworth/paprika/internal/webhook/policy/v1alpha1"
	webhookreceiver "github.com/benebsworth/paprika/internal/webhook/receiver"
	"github.com/benebsworth/paprika/traffic"
	// +kubebuilder:scaffold:imports
)

var (
	scheme   = runtime.NewScheme()
	setupLog = ctrl.Log.WithName("setup")
)

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))

	utilruntime.Must(pipelinesv1alpha1.AddToScheme(scheme))
	utilruntime.Must(clustersv1alpha1.AddToScheme(scheme))
	utilruntime.Must(corev1alpha1.AddToScheme(scheme))
	utilruntime.Must(policyv1alpha1.AddToScheme(scheme))
	// +kubebuilder:scaffold:scheme
}

type cliConfig struct {
	metricsAddr, metricsCertPath, metricsCertName, metricsCertKey string
	webhookCertPath, webhookCertName, webhookCertKey              string
	probeAddr, uiAddr, webhookAddr                                string
	operatorNamespace, mode, k8sAPIServer, k8sTokenFile           string
	repoServerAddr                                                string
	enableLeaderElection, secureMetrics, enableHTTP2              bool
	authEnabled, authAllowUnauth                                  bool
	authBasicUsername, authBasicPassword, authBasicPasswordHash   string
	authOIDCIssuerURL, authOIDCClientID, authOIDCClientSecret     string
	zapOptions                                                    zap.Options
}

func main() {
	cfg := registerFlags()

	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&cfg.zapOptions)))

	if err := dispatchMode(&cfg); err != nil {
		setupLog.Error(err, "Failed to start")
		os.Exit(1)
	}
}

func dispatchMode(cfg *cliConfig) error {
	if err := validateMode(cfg.mode); err != nil {
		return err
	}

	switch cfg.mode {
	case "agent":
		return runAgentMode(cfg.uiAddr, cfg.probeAddr)
	case "repo-server":
		return runRepoServerMode(cfg.uiAddr, cfg.probeAddr)
	case "api":
		return runAPIMode(cfg.k8sAPIServer, cfg.k8sTokenFile, cfg.uiAddr, cfg.probeAddr,
			cfg.authEnabled, cfg.authBasicUsername, cfg.authBasicPassword, cfg.authBasicPasswordHash,
			cfg.authOIDCIssuerURL, cfg.authOIDCClientID, cfg.authOIDCClientSecret, cfg.authAllowUnauth)
	case "webhook":
		return runWebhookMode(cfg.webhookAddr, cfg.probeAddr)
	default:
		return runOperatorMode(cfg.uiAddr, cfg.metricsAddr, cfg.probeAddr,
			cfg.webhookCertPath, cfg.webhookCertName, cfg.webhookCertKey,
			cfg.metricsCertPath, cfg.metricsCertName, cfg.metricsCertKey, cfg.operatorNamespace,
			cfg.enableLeaderElection, cfg.secureMetrics, cfg.enableHTTP2,
			cfg.authEnabled, cfg.authBasicUsername, cfg.authBasicPassword, cfg.authBasicPasswordHash,
			cfg.authOIDCIssuerURL, cfg.authOIDCClientID, cfg.authOIDCClientSecret, cfg.authAllowUnauth)
	}
}

func validateMode(mode string) error {
	if mode != "operator" && mode != "api" && mode != "webhook" && mode != "repo-server" && mode != "agent" {
		return fmt.Errorf("invalid mode: %s (must be 'operator', 'api', 'webhook', 'repo-server', or 'agent')", mode)
	}
	return nil
}

func registerFlags() cliConfig {
	var cfg cliConfig
	flag.StringVar(&cfg.metricsAddr, "metrics-bind-address", "0", "The address the metrics endpoint binds to. "+
		"Use :8443 for HTTPS or :8080 for HTTP, or leave as 0 to disable the metrics service.")
	flag.StringVar(&cfg.probeAddr, "health-probe-bind-address", ":8081", "The address the probe endpoint binds to.")
	flag.BoolVar(&cfg.enableLeaderElection, "leader-elect", false,
		"Enable leader election for controller manager. "+
			"Enabling this will ensure there is only one active controller manager.")
	flag.BoolVar(&cfg.secureMetrics, "metrics-secure", true,
		"If set, the metrics endpoint is served securely via HTTPS. Use --metrics-secure=false to use HTTP instead.")
	flag.StringVar(&cfg.webhookCertPath, "webhook-cert-path", "", "The directory that contains the webhook certificate.")
	flag.StringVar(&cfg.webhookCertName, "webhook-cert-name", "tls.crt", "The name of the webhook certificate file.")
	flag.StringVar(&cfg.webhookCertKey, "webhook-cert-key", "tls.key", "The name of the webhook key file.")
	flag.StringVar(&cfg.metricsCertPath, "metrics-cert-path", "",
		"The directory that contains the metrics server certificate.")
	flag.StringVar(&cfg.metricsCertName, "metrics-cert-name", "tls.crt", "The name of the metrics server certificate file.")
	flag.StringVar(&cfg.metricsCertKey, "metrics-cert-key", "tls.key", "The name of the metrics server key file.")
	flag.BoolVar(&cfg.enableHTTP2, "enable-http2", false,
		"If set, HTTP/2 will be enabled for the metrics and webhook servers")
	flag.StringVar(&cfg.operatorNamespace, "operator-namespace", "paprika-system",
		"The namespace where the operator runs (used for manifest snapshots and step jobs).")
	flag.StringVar(&cfg.uiAddr, "ui-bind-address", ":3000",
		"The address the UI dashboard server binds to.")
	flag.StringVar(&cfg.mode, "mode", "operator",
		"Running mode: 'operator' (controllers + API), 'api' (API server only), 'webhook' (webhook receiver only), 'repo-server' (repo server only), or 'agent' (in-cluster agent).")
	flag.StringVar(&cfg.k8sAPIServer, "k8s-api-server", "",
		"Kubernetes API server URL. Only used in 'api' mode.")
	flag.StringVar(&cfg.k8sTokenFile, "k8s-token-file", "",
		"Path to Kubernetes service account token. Only used in 'api' mode.")
	flag.StringVar(&cfg.webhookAddr, "webhook-bind-address", ":8080",
		"The address the webhook receiver binds to. Only used in 'webhook' mode.")
	flag.StringVar(&cfg.repoServerAddr, "repo-server-addr", os.Getenv("PAPRIKA_REPO_SERVER_ADDR"),
		"Address of the repo server. When set, controllers delegate source resolution/rendering to it.")
	flag.BoolVar(&cfg.authEnabled, "auth-enabled", false,
		"Enable authentication and authorization for the API server.")
	flag.StringVar(&cfg.authBasicUsername, "auth-basic-username", "",
		"Basic auth username. Only used when --auth-enabled=true.")
	flag.StringVar(&cfg.authBasicPassword, "auth-basic-password", "",
		"Basic auth plain-text password. Only used when --auth-enabled=true and --auth-basic-password-hash is empty.")
	flag.StringVar(&cfg.authBasicPasswordHash, "auth-basic-password-hash", "",
		"Basic auth SHA-256 password hash (hex). Only used when --auth-enabled=true.")
	flag.StringVar(&cfg.authOIDCIssuerURL, "auth-oidc-issuer-url", "",
		"OIDC issuer URL. Only used when --auth-enabled=true.")
	flag.StringVar(&cfg.authOIDCClientID, "auth-oidc-client-id", "",
		"OIDC client ID. Only used when --auth-enabled=true.")
	flag.StringVar(&cfg.authOIDCClientSecret, "auth-oidc-client-secret", "",
		"OIDC client secret. Only used when --auth-enabled=true.")
	flag.BoolVar(&cfg.authAllowUnauth, "auth-allow-unauthenticated", false,
		"Allow unauthenticated requests through when no credentials are provided. Only used when --auth-enabled=true.")
	cfg.zapOptions = zap.Options{Development: true}
	cfg.zapOptions.BindFlags(flag.CommandLine)
	flag.Parse()
	return cfg
}

//nolint:cyclop // operator setup wiring
func runOperatorMode(uiAddr, metricsAddr, probeAddr, webhookCertPath, webhookCertName, webhookCertKey,
	metricsCertPath, metricsCertName, metricsCertKey, operatorNamespace string,
	enableLeaderElection, secureMetrics, enableHTTP2 bool,
	authEnabled bool, authBasicUsername, authBasicPassword, authBasicPasswordHash string,
	authOIDCIssuerURL, authOIDCClientID, authOIDCClientSecret string, authAllowUnauth bool) error {
	tlsOpts := buildOperatorTLSOptions(enableHTTP2)
	webhookServer := buildOperatorWebhookServer(tlsOpts, webhookCertPath, webhookCertName, webhookCertKey)
	metricsServerOptions := buildOperatorMetricsOptions(tlsOpts, metricsAddr, metricsCertPath, metricsCertName, metricsCertKey, secureMetrics)

	cfg := ctrl.GetConfigOrDie()
	cfg.QPS = 50
	cfg.Burst = 100
	mgr, err := ctrl.NewManager(cfg, ctrl.Options{
		Scheme:                 scheme,
		Metrics:                metricsServerOptions,
		WebhookServer:          webhookServer,
		HealthProbeBindAddress: probeAddr,
		LeaderElection:         enableLeaderElection,
		LeaderElectionID:       "paprika-operator.paprika.io",
	})
	if err != nil {
		return fmt.Errorf("failed to start manager: %w", err)
	}

	if bootstrapErr := registerDefaultProjectBootstrap(mgr, operatorNamespace); bootstrapErr != nil {
		return bootstrapErr
	}

	authCfg := buildAuthConfig(authEnabled, authBasicUsername, authBasicPassword, authBasicPasswordHash,
		authOIDCIssuerURL, authOIDCClientID, authOIDCClientSecret, authAllowUnauth)

	resolver := governance.NewProjectResolver(mgr.GetClient())
	projectValidator := governance.NewProjectValidator(resolver, governance.NewClusterResolver(mgr.GetClient()), mgr.GetRESTMapper())
	policyEvaluator := governance.NewPolicyEvaluator(mgr.GetClient())

	var authz auth.Authorizer
	if authCfg.Enabled {
		var authzErr error
		authz, authzErr = auth.BuildAuthorizer(authCfg, mgr.GetClient())
		if authzErr != nil {
			return fmt.Errorf("build authorizer: %w", authzErr)
		}
	}

	k8sClient, err := kubernetes.NewForConfig(mgr.GetConfig())
	if err != nil {
		return fmt.Errorf("failed to create kubernetes clientset: %w", err)
	}

	c, err := cache.NewFromEnv()
	if err != nil {
		setupLog.Error(err, "Failed to create cache, falling back to in-memory")
		c = cache.NewMemoryCache()
	}
	defer func() { _ = c.Close() }()

	shutdownTracing, err := observability.InitTracing()
	if err != nil {
		setupLog.Error(err, "Failed to initialize tracing")
	} else {
		defer shutdownTracing()
		if observability.IsTracingEnabled() {
			setupLog.Info("OpenTelemetry tracing enabled")
		}
	}

	shardFilter := sharding.NewFilterFromEnv()
	if shardFilter.Enabled() {
		setupLog.Info("Controller sharding enabled", "shard", shardFilter.ShardID(), "total", shardFilter.TotalShards())
	}

	rateLimiter := ratelimit.NewControllerRateLimit()
	setupLog.Info("Rate limiting enabled", "globalRate", 100, "perAppRate", 10, "perSourceRate", 5)

	broker, err := events.NewBrokerFromEnv()
	if err != nil {
		return fmt.Errorf("create event broker: %w", err)
	}
	defer broker.Close()

	if err := setupOperatorControllers(mgr, k8sClient, operatorNamespace, c, shardFilter, rateLimiter, projectValidator, policyEvaluator, broker); err != nil {
		return err
	}
	if err := startOperatorUI(mgr, uiAddr, authCfg, projectValidator, policyEvaluator, authz, broker); err != nil {
		return err
	}

	startInlineWebhook(mgr.GetClient())

	setupLog.Info("Starting manager")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		return fmt.Errorf("failed to run manager: %w", err)
	}
	return nil
}

func registerDefaultProjectBootstrap(mgr ctrl.Manager, operatorNamespace string) error {
	if err := mgr.Add(manager.RunnableFunc(func(ctx context.Context) error {
		// Run bootstrapping in a goroutine so that manager startup is not blocked
		// while waiting for the local webhook endpoints to become reachable.
		go bootstrapDefaultProjects(ctx, mgr.GetClient(), operatorNamespace)
		<-ctx.Done()
		return nil
	})); err != nil {
		return fmt.Errorf("register default appproject bootstrap: %w", err)
	}
	return nil
}

func bootstrapDefaultProjects(ctx context.Context, c client.Client, operatorNamespace string) {
	log := ctrl.Log.WithName("bootstrap")

	if err := ensureProjectWithRetry(ctx, c, operatorNamespace, log); err != nil {
		log.Error(err, "Failed to ensure operator namespace default AppProject")
		return
	}

	var apps pipelinesv1alpha1.ApplicationList
	if err := c.List(ctx, &apps); err != nil {
		log.Error(err, "Failed to list applications during bootstrap")
		return
	}

	seen := map[string]bool{operatorNamespace: true}
	for i := range apps.Items {
		ns := apps.Items[i].Namespace
		if seen[ns] {
			continue
		}
		seen[ns] = true
		if err := ensureProjectWithRetry(ctx, c, ns, log); err != nil {
			log.Error(err, "Failed to ensure default AppProject", "namespace", ns)
		}
	}
}

func ensureProjectWithRetry(ctx context.Context, c client.Client, ns string, log logr.Logger) error {
	if err := wait.ExponentialBackoffWithContext(ctx, wait.Backoff{
		Duration: 1 * time.Second,
		Factor:   2,
		Cap:      30 * time.Second,
		Steps:    20,
	}, func(ctx context.Context) (bool, error) {
		if err := bootstrap.EnsureDefaultAppProject(ctx, c, ns); err != nil {
			log.Error(err, "Failed to ensure default AppProject, will retry", "namespace", ns)
			return false, nil
		}
		log.Info("Ensured default AppProject", "namespace", ns)
		return true, nil
	}); err != nil {
		return fmt.Errorf("ensure default AppProject in %q: %w", ns, err)
	}
	return nil
}

func startInlineWebhook(c client.Client) {
	go func() {
		secret := os.Getenv("PAPRIKA_WEBHOOK_SECRET")
		handler := webhookreceiver.NewHandler(c, secret)
		webhookMux := http.NewServeMux()
		webhookMux.Handle("/webhook", handler)
		webhookSrv := &http.Server{
			Addr:              ":8080",
			Handler:           webhookMux,
			ReadHeaderTimeout: 10 * time.Second,
		}
		setupLog.Info("Starting inline webhook receiver", "addr", ":8080")
		if srvErr := webhookSrv.ListenAndServe(); srvErr != nil && srvErr != http.ErrServerClosed {
			setupLog.Error(srvErr, "Inline webhook receiver error")
		}
	}()
}

func buildOperatorTLSOptions(enableHTTP2 bool) []func(*tls.Config) {
	if enableHTTP2 {
		return nil
	}
	setupLog.Info("Disabling HTTP/2")
	return []func(*tls.Config){func(c *tls.Config) {
		c.NextProtos = []string{"http/1.1"}
	}}
}

func buildOperatorWebhookServer(tlsOpts []func(*tls.Config), certPath, certName, certKey string) webhook.Server {
	options := webhook.Options{TLSOpts: tlsOpts}
	if certPath != "" {
		setupLog.Info("Initializing webhook certificate watcher using provided certificates",
			"webhook-cert-path", certPath, "webhook-cert-name", certName, "webhook-cert-key", certKey)
		options.CertDir = certPath
		options.CertName = certName
		options.KeyName = certKey
	}
	return webhook.NewServer(options)
}

func buildOperatorMetricsOptions(tlsOpts []func(*tls.Config), bindAddr, certPath, certName, certKey string, secure bool) metricsserver.Options {
	options := metricsserver.Options{
		BindAddress:   bindAddr,
		SecureServing: secure,
		TLSOpts:       tlsOpts,
	}
	if secure {
		options.FilterProvider = filters.WithAuthenticationAndAuthorization
	}
	if certPath != "" {
		setupLog.Info("Initializing metrics certificate watcher using provided certificates",
			"metrics-cert-path", certPath, "metrics-cert-name", certName, "metrics-cert-key", certKey)
		options.CertDir = certPath
		options.CertName = certName
		options.KeyName = certKey
	}
	return options
}

func setupPipelineController(mgr ctrl.Manager, k8sClient kubernetes.Interface, operatorNamespace string, shardFilter *sharding.Filter) error {
	if err := (&controller.PipelineReconciler{
		Client: mgr.GetClient(), Scheme: mgr.GetScheme(),
		K8sClient: k8sClient, Namespace: operatorNamespace,
		WorkflowEngine: engine.NewWorkflowEngine(k8sClient, operatorNamespace),
		ShardFilter:    shardFilter,
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up pipeline controller: %w", err)
	}
	return nil
}

func setupStageController(mgr ctrl.Manager, shardFilter *sharding.Filter) error {
	if err := (&controller.StageReconciler{
		Client: mgr.GetClient(), Scheme: mgr.GetScheme(),
		ShardFilter: shardFilter,
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up stage controller: %w", err)
	}
	return nil
}

func setupReleaseController(mgr ctrl.Manager, k8sClient kubernetes.Interface, operatorNamespace string, cacheClient cache.Cache, shardFilter *sharding.Filter, rateLimiter *ratelimit.ControllerRateLimit, projectValidator *governance.ProjectValidator, policyEvaluator *governance.PolicyEvaluator, broker *events.Broker) error {
	dynamicClient, err := dynamic.NewForConfig(mgr.GetConfig())
	if err != nil {
		return fmt.Errorf("failed to create dynamic client: %w", err)
	}
	baseRenderer := engine.NewHelmSDKRendererWithClient("/tmp/paprika-helm", mgr.GetClient())
	cachedRenderer := engine.NewCachedTemplateRenderer(baseRenderer, cacheClient, "/tmp/paprika-helm", 0)
	renderer := engine.NewRepoServerRenderer(repoclient.NewFromEnv(), cachedRenderer)
	if err := (&controller.ReleaseReconciler{
		Client: mgr.GetClient(), Scheme: mgr.GetScheme(),
		K8sClient: k8sClient, Namespace: operatorNamespace,
		DynamicClient:        dynamicClient,
		RestConfig:           mgr.GetConfig(),
		ClusterMgr:           controller.NewClusterConnectionPool(mgr.GetClient(), mgr.GetConfig()),
		GateExecutor:         gates.NewSmokeGate(),
		Analyzer:             analysis.NewAnalyzer(k8sClient, operatorNamespace, mgr.GetConfig()),
		TemplateRenderer:     renderer,
		TrafficRouterFactory: traffic.NewRouter,
		ShardFilter:          shardFilter,
		RateLimiter:          rateLimiter,
		//nolint:staticcheck,nolintlint // reconcilers use the legacy record.EventRecorder API
		EventRecorder:    mgr.GetEventRecorderFor("release-controller"),
		ProjectValidator: projectValidator,
		PolicyEvaluator:  policyEvaluator,
		EventBroker:      broker,
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up release controller: %w", err)
	}
	return nil
}

func setupTemplateController(mgr ctrl.Manager, shardFilter *sharding.Filter) error {
	if err := (&controller.TemplateReconciler{
		Client: mgr.GetClient(), Scheme: mgr.GetScheme(),
		ShardFilter: shardFilter,
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up template controller: %w", err)
	}
	return nil
}

func setupArtifactController(mgr ctrl.Manager, shardFilter *sharding.Filter) error {
	if err := (&controller.ArtifactReconciler{
		Client: mgr.GetClient(), Scheme: mgr.GetScheme(),
		ShardFilter: shardFilter,
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up artifact controller: %w", err)
	}
	return nil
}

func setupApplicationSetController(mgr ctrl.Manager, shardFilter *sharding.Filter) error {
	if err := (&controller.ApplicationSetReconciler{
		Client:      mgr.GetClient(),
		Scheme:      mgr.GetScheme(),
		ShardFilter: shardFilter,
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up applicationset controller: %w", err)
	}
	return nil
}

func setupAnalysisRunController(mgr ctrl.Manager, k8sClient kubernetes.Interface, operatorNamespace string, broker *events.Broker) error {
	if err := (&controller.AnalysisRunReconciler{
		Client:   mgr.GetClient(),
		Scheme:   mgr.GetScheme(),
		Analyzer: analysis.NewAnalyzer(k8sClient, operatorNamespace, mgr.GetConfig()),
		//nolint:staticcheck,nolintlint // reconcilers use the legacy record.EventRecorder API
		EventRecorder: mgr.GetEventRecorderFor("analysisrun-controller"),
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up analysisrun controller: %w", err)
	}
	return nil
}

func setupApplicationController(mgr ctrl.Manager, k8sClient kubernetes.Interface, operatorNamespace string, cacheClient cache.Cache, shardFilter *sharding.Filter, rateLimiter *ratelimit.ControllerRateLimit, projectValidator *governance.ProjectValidator, broker *events.Broker) error {
	dynClient, err := dynamic.NewForConfig(mgr.GetConfig())
	if err != nil {
		return fmt.Errorf("creating dynamic client: %w", err)
	}
	k8sClientset, ok := k8sClient.(*kubernetes.Clientset)
	if !ok {
		return fmt.Errorf("expected *kubernetes.Clientset, got %T", k8sClient)
	}
	baseRenderer := engine.NewHelmSDKRendererWithClient("/tmp/paprika-sources", mgr.GetClient())
	cachedRenderer := engine.NewCachedTemplateRenderer(baseRenderer, cacheClient, "/tmp/paprika-sources", 0)
	renderer := engine.NewRepoServerRenderer(repoclient.NewFromEnv(), cachedRenderer)
	if err := (&controller.ApplicationReconciler{
		Client:           mgr.GetClient(),
		Scheme:           mgr.GetScheme(),
		K8sClient:        k8sClientset,
		Namespace:        operatorNamespace,
		RestConfig:       mgr.GetConfig(),
		WorkDir:          "/tmp/paprika-sources",
		HealthEval:       health.NewEvaluator(),
		DiffEngine:       engine.NewScalableDiffEngine(dynClient),
		ResHealth:        health.NewResourceHealthChecker(mgr.GetClient()),
		ClusterMgr:       controller.NewClusterConnectionPool(mgr.GetClient(), mgr.GetConfig()),
		TemplateRenderer: renderer,
		ShardFilter:      shardFilter,
		RateLimiter:      rateLimiter,
		//nolint:staticcheck,nolintlint // reconcilers use the legacy record.EventRecorder API
		EventRecorder:       mgr.GetEventRecorderFor("application-controller"),
		ProjectValidator:    projectValidator,
		EventBroker:         broker,
		SyncWindowEvaluator: syncwindow.NewEvaluator(),
	}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("setting up application controller: %w", err)
	}
	return nil
}

func setupWebhooks(mgr ctrl.Manager) error {
	if os.Getenv("ENABLE_WEBHOOKS") == "false" {
		return nil
	}
	// +kubebuilder:scaffold:webhook
	webhooks := []struct {
		name string
		fn   func(ctrl.Manager) error
	}{
		{"Pipeline", webhookpipelinesv1alpha1.SetupPipelineWebhookWithManager},
		{"Stage", webhookpipelinesv1alpha1.SetupStageWebhookWithManager},
		{"Release", webhookpipelinesv1alpha1.SetupReleaseWebhookWithManager},
		{"Template", webhookpipelinesv1alpha1.SetupTemplateWebhookWithManager},
		{"Application", webhookpipelinesv1alpha1.SetupApplicationWebhookWithManager},
		{"AppProject", webhookcorev1alpha1.SetupAppProjectWebhookWithManager},
		{"Repository", webhookcorev1alpha1.SetupRepositoryWebhookWithManager},
		{"Policy", webhookpolicyv1alpha1.SetupPolicyWebhookWithManager},
	}
	for _, w := range webhooks {
		if err := w.fn(mgr); err != nil {
			return fmt.Errorf("failed to create webhook %s: %w", w.name, err)
		}
	}
	return nil
}

func setupCoreControllers(mgr ctrl.Manager) error {
	if err := (&clusterscontroller.ClusterReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "Failed to create controller", "controller", "clusters-cluster")
		os.Exit(1)
	}
	if err := (&corecontroller.AppProjectReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "Failed to create controller", "controller", "core-appproject")
		os.Exit(1)
	}
	if err := (&corecontroller.RepositoryReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "Failed to create controller", "controller", "core-repository")
		os.Exit(1)
	}
	if err := (&policycontroller.PolicyReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "Failed to create controller", "controller", "policy-policy")
		os.Exit(1)
	}
	return nil
}

func registerProjectLabelIndexers(mgr ctrl.Manager) error {
	indexer := mgr.GetFieldIndexer()
	types := []client.Object{
		&pipelinesv1alpha1.Release{},
		&pipelinesv1alpha1.Stage{},
		&pipelinesv1alpha1.Pipeline{},
		&pipelinesv1alpha1.Template{},
	}
	for _, t := range types {
		if err := indexer.IndexField(context.Background(), t, "projectLabel", func(obj client.Object) []string {
			return []string{obj.GetLabels()["app.paprika.io/project"]}
		}); err != nil {
			return fmt.Errorf("index project label for %T: %w", t, err)
		}
	}
	return nil
}

func setupOperatorControllers(mgr ctrl.Manager, k8sClient kubernetes.Interface, operatorNamespace string, c cache.Cache, shardFilter *sharding.Filter, rateLimiter *ratelimit.ControllerRateLimit, projectValidator *governance.ProjectValidator, policyEvaluator *governance.PolicyEvaluator, broker *events.Broker) error {
	if err := registerProjectLabelIndexers(mgr); err != nil {
		return err
	}

	controllers := []struct {
		name  string
		setup func() error
	}{
		{"analysisrun", func() error { return setupAnalysisRunController(mgr, k8sClient, operatorNamespace, broker) }},
		{"pipeline", func() error { return setupPipelineController(mgr, k8sClient, operatorNamespace, shardFilter) }},
		{"stage", func() error { return setupStageController(mgr, shardFilter) }},
		{"release", func() error {
			return setupReleaseController(mgr, k8sClient, operatorNamespace, c, shardFilter, rateLimiter, projectValidator, policyEvaluator, broker)
		}},
		{"template", func() error { return setupTemplateController(mgr, shardFilter) }},
		{"applicationset", func() error { return setupApplicationSetController(mgr, shardFilter) }},
		{"artifact", func() error { return setupArtifactController(mgr, shardFilter) }},
		{"application", func() error {
			return setupApplicationController(mgr, k8sClient, operatorNamespace, c, shardFilter, rateLimiter, projectValidator, broker)
		}},
		{"notification", func() error {
			return (&controller.NotificationConfigReconciler{
				Client:      mgr.GetClient(),
				EventBroker: broker,
				Sender:      controller.NewNotificationSender(),
			}).SetupWithManager(mgr)
		}},
	}

	for _, c := range controllers {
		if err := c.setup(); err != nil {
			return fmt.Errorf("failed to create controller %s: %w", c.name, err)
		}
	}
	if err := setupWebhooks(mgr); err != nil {
		return err
	}
	if err := setupCoreControllers(mgr); err != nil {
		return err
	}
	// +kubebuilder:scaffold:builder

	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		return fmt.Errorf("failed to set up health check: %w", err)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		return fmt.Errorf("failed to set up ready check: %w", err)
	}
	return nil
}

func startOperatorUI(mgr ctrl.Manager, uiAddr string, authCfg auth.Config, projectValidator *governance.ProjectValidator, policyEvaluator *governance.PolicyEvaluator, authz auth.Authorizer, broker *events.Broker) error {
	authInterceptor, err := auth.Interceptor(authCfg, mgr.GetClient())
	if err != nil {
		return fmt.Errorf("failed to build auth interceptor: %w", err)
	}

	paprikaServer := api.NewPaprikaServer(mgr.GetClient(), broker)
	paprikaServer.SetGovernanceValidator(projectValidator)
	paprikaServer.SetGovernancePolicyEvaluator(policyEvaluator)
	if authz != nil {
		paprikaServer.SetAuthorizer(authz)
	}
	_, connectHandler := v1connect.NewPaprikaServiceHandler(paprikaServer, connect.WithInterceptors(authInterceptor))

	uiMux := http.NewServeMux()
	uiMux.Handle("/paprika.v1.PaprikaService/", connectHandler)
	uiMux.Handle("/events", api.NewSSEHandler(paprikaServer.Broker()))
	uiMux.Handle("/", api.UIHandler())

	uiServer := &http.Server{
		Addr:              uiAddr,
		Handler:           uiMux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		setupLog.Info("Starting UI server", "addr", uiAddr)
		if err := uiServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			setupLog.Error(err, "UI server error")
		}
	}()
	return nil
}

func runAPIMode(k8sAPIServer, k8sTokenFile, uiAddr, probeAddr string,
	authEnabled bool, authBasicUsername, authBasicPassword, authBasicPasswordHash string,
	authOIDCIssuerURL, authOIDCClientID, authOIDCClientSecret string, authAllowUnauth bool) error {
	config, err := buildAPIConfig(k8sAPIServer, k8sTokenFile)
	if err != nil {
		return err
	}

	apiClient, err := createAPIClient(config)
	if err != nil {
		return err
	}

	authCfg := buildAuthConfig(authEnabled, authBasicUsername, authBasicPassword, authBasicPasswordHash,
		authOIDCIssuerURL, authOIDCClientID, authOIDCClientSecret, authAllowUnauth)
	authInterceptor, err := auth.Interceptor(authCfg, apiClient)
	if err != nil {
		return fmt.Errorf("failed to build auth interceptor: %w", err)
	}

	broker, err := events.NewBrokerFromEnv()
	if err != nil {
		return fmt.Errorf("create event broker: %w", err)
	}
	defer broker.Close()

	paprikaServer := api.NewPaprikaServer(apiClient, broker)
	if authCfg.Enabled {
		authz, err := auth.BuildAuthorizer(authCfg, apiClient)
		if err != nil {
			return fmt.Errorf("build authorizer: %w", err)
		}
		paprikaServer.SetAuthorizer(authz)
	}

	resolver := governance.NewProjectResolver(apiClient)
	projectValidator := governance.NewProjectValidator(resolver, governance.NewClusterResolver(apiClient), nil)
	policyEvaluator := governance.NewPolicyEvaluator(apiClient)
	paprikaServer.SetGovernanceValidator(projectValidator)
	paprikaServer.SetGovernancePolicyEvaluator(policyEvaluator)

	_, connectHandler := v1connect.NewPaprikaServiceHandler(paprikaServer, connect.WithInterceptors(authInterceptor))

	mux := buildAPIMux(connectHandler, paprikaServer.Broker())
	healthMux := buildHealthMux()

	startHealthProbeServer(healthMux, probeAddr)
	return startAPIServer(mux, uiAddr)
}

func runWebhookMode(webhookAddr, probeAddr string) error {
	config, err := rest.InClusterConfig()
	if err != nil {
		config = ctrl.GetConfigOrDie()
	}

	apiClient, err := createAPIClient(config)
	if err != nil {
		return err
	}

	secret := os.Getenv("PAPRIKA_WEBHOOK_SECRET")
	cacheClient, err := cache.NewFromEnv()
	if err != nil {
		setupLog.Error(err, "Failed to create webhook cache client, continuing without cache invalidation")
		cacheClient = nil
	}
	var inv *cache.Invalidator
	if cacheClient != nil {
		inv = cache.NewInvalidator(cacheClient)
		defer func() { _ = cacheClient.Close() }()
	}
	handler := webhookreceiver.NewHandlerWithCacheAndRepo(apiClient, secret, inv, repoclient.NewFromEnv())

	mux := http.NewServeMux()
	mux.Handle("/webhook", handler)
	mux.Handle("/healthz", http.HandlerFunc(healthzHandler))
	mux.Handle("/readyz", http.HandlerFunc(healthzHandler))

	healthMux := buildHealthMux()
	startHealthProbeServer(healthMux, probeAddr)

	server := &http.Server{
		Addr:              webhookAddr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	setupLog.Info("Starting webhook receiver", "addr", webhookAddr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("webhook server error: %w", err)
	}
	return nil
}

func buildAPIConfig(k8sAPIServer, k8sTokenFile string) (*rest.Config, error) {
	if k8sAPIServer == "" {
		config, err := rest.InClusterConfig()
		if err != nil {
			return nil, fmt.Errorf("get in-cluster config (use --k8s-api-server): %w", err)
		}
		return config, nil
	}

	token, err := readBearerToken(k8sTokenFile)
	if err != nil {
		return nil, err
	}
	return &rest.Config{
		Host:            k8sAPIServer,
		BearerToken:     token,
		TLSClientConfig: rest.TLSClientConfig{Insecure: false},
	}, nil
}

func readBearerToken(k8sTokenFile string) (string, error) {
	if k8sTokenFile == "" {
		// #nosec G304 -- hardcoded in-cluster token path
		data, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/token")
		if err != nil {
			return "", fmt.Errorf("no token file or in-cluster token: %w", err)
		}
		return string(data), nil
	}
	// #nosec G304 -- k8sTokenFile is from a command-line flag
	data, err := os.ReadFile(k8sTokenFile)
	if err != nil {
		return "", fmt.Errorf("read token file: %w", err)
	}
	return string(data), nil
}

func createAPIClient(config *rest.Config) (client.Client, error) {
	apiScheme := runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(apiScheme))
	utilruntime.Must(pipelinesv1alpha1.AddToScheme(apiScheme))
	utilruntime.Must(policyv1alpha1.AddToScheme(apiScheme))
	utilruntime.Must(corev1alpha1.AddToScheme(apiScheme))
	utilruntime.Must(clustersv1alpha1.AddToScheme(apiScheme))
	apiClient, err := client.New(config, client.Options{Scheme: apiScheme})
	if err != nil {
		return nil, fmt.Errorf("create k8s client: %w", err)
	}
	return apiClient, nil
}

func buildAPIMux(connectHandler http.Handler, broker *events.Broker) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("/paprika.v1.PaprikaService/", connectHandler)
	mux.Handle("/events", api.NewSSEHandler(broker))
	mux.Handle("/healthz", http.HandlerFunc(healthzHandler))
	mux.Handle("/", api.UIHandler())
	return mux
}

func buildHealthMux() *http.ServeMux {
	healthMux := http.NewServeMux()
	healthMux.Handle("/healthz", http.HandlerFunc(healthzHandler))
	healthMux.Handle("/readyz", http.HandlerFunc(healthzHandler))
	return healthMux
}

func healthzHandler(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintln(w, "ok")
}

func startHealthProbeServer(healthMux *http.ServeMux, probeAddr string) {
	healthServer := &http.Server{
		Addr:              probeAddr,
		Handler:           healthMux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		setupLog.Info("Starting health probe server", "addr", probeAddr)
		if err := healthServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			setupLog.Error(err, "Health probe server error")
		}
	}()
}

func startAPIServer(mux *http.ServeMux, uiAddr string) error {
	server := &http.Server{
		Addr:              uiAddr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	setupLog.Info("Starting API server", "addr", uiAddr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("api server error: %w", err)
	}
	return nil
}

func runRepoServerMode(addr, probeAddr string) error {
	workDir := os.Getenv("PAPRIKA_REPO_WORKDIR")
	if workDir == "" {
		workDir = "/tmp/paprika-repo"
	}

	c, err := cache.NewFromEnv()
	if err != nil {
		setupLog.Error(err, "Failed to create cache, falling back to in-memory")
		c = cache.NewMemoryCache()
	}
	defer func() { _ = c.Close() }()

	cfg, err := ctrl.GetConfig()
	if err != nil {
		return fmt.Errorf("get k8s config: %w", err)
	}
	k8sClient, err := client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		return fmt.Errorf("create k8s client: %w", err)
	}

	srv := reposerver.NewServerWithClient(workDir, c, k8sClient)

	healthMux := buildHealthMux()
	startHealthProbeServer(healthMux, probeAddr)

	if err := srv.Run(context.Background(), addr); err != nil {
		return fmt.Errorf("repo server run: %w", err)
	}
	return nil
}

func runAgentMode(addr, probeAddr string) error {
	clusterID := os.Getenv("PAPRIKA_AGENT_CLUSTER_ID")
	if clusterID == "" {
		clusterID = "default"
	}

	cfg, err := rest.InClusterConfig()
	if err != nil {
		return fmt.Errorf("load in-cluster config: %w", err)
	}

	srv, err := agentserver.NewServer(clusterID, cfg)
	if err != nil {
		return fmt.Errorf("create agent server: %w", err)
	}

	healthMux := buildHealthMux()
	startHealthProbeServer(healthMux, probeAddr)

	if err := srv.Run(context.Background(), addr); err != nil {
		return fmt.Errorf("agent server run: %w", err)
	}
	return nil
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
	if data := os.Getenv("PAPRIKA_AUTH_RBAC_RULES"); data != "" {
		var rules []auth.RBACRule
		if err := json.Unmarshal([]byte(data), &rules); err != nil {
			setupLog.Error(err, "Failed to parse PAPRIKA_AUTH_RBAC_RULES, ignoring RBAC rules")
		} else {
			cfg.RBACRules = rules
		}
	}
	return cfg
}

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
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	"connectrpc.com/connect"
	"connectrpc.com/otelconnect"
	"github.com/go-logr/logr"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	crmetrics "sigs.k8s.io/controller-runtime/pkg/metrics"

	"golang.org/x/crypto/bcrypt"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	featureflagsv1alpha1 "github.com/benebsworth/paprika/api/featureflags/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	agentserver "github.com/benebsworth/paprika/internal/agent/server"
	apiserver "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/events"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/audit"
	"github.com/benebsworth/paprika/internal/cache"
	"github.com/benebsworth/paprika/internal/governance"
	"github.com/benebsworth/paprika/internal/metrics"
	"github.com/benebsworth/paprika/internal/mtls"
	"github.com/benebsworth/paprika/internal/observability"
	"github.com/benebsworth/paprika/internal/reposerver"
	reposerverclient "github.com/benebsworth/paprika/internal/reposerverclient"
	"github.com/benebsworth/paprika/internal/sharding"
	webhookreceiver "github.com/benebsworth/paprika/internal/webhook/receiver"
)

const (
	defaultReadHeaderTimeout = 10 * time.Second
	serverShutdownTimeout    = 5 * time.Second
	defaultRedisAddr         = "localhost:6379"
)

func newScheme() *runtime.Scheme {
	scheme := runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))

	utilruntime.Must(pipelinesv1alpha1.AddToScheme(scheme))
	utilruntime.Must(featureflagsv1alpha1.AddToScheme(scheme))
	utilruntime.Must(clustersv1alpha1.AddToScheme(scheme))
	utilruntime.Must(corev1alpha1.AddToScheme(scheme))
	utilruntime.Must(policyv1alpha1.AddToScheme(scheme))
	utilruntime.Must(rolloutsv1alpha1.AddToScheme(scheme))
	// +kubebuilder:scaffold:scheme
	return scheme
}

type cliConfig struct {
	metricsAddr, metricsCertPath, metricsCertName, metricsCertKey string
	webhookCertPath, webhookCertName, webhookCertKey              string
	probeAddr, uiAddr, webhookAddr                                string
	operatorNamespace, mode, k8sAPIServer, k8sTokenFile           string
	repoServerAddr, repoWorkDir, agentClusterID                   string
	webhookSecret, authRBACRules                                  string
	cacheBackend, cacheRedisAddr, cacheRedisPassword              string
	cacheRedisDB                                                  int
	shardID, shardTotal                                           int
	shardIDSource                                                 string
	auditLogEnabled                                               bool
	enableLeaderElection, secureMetrics, enableHTTP2              bool
	cacheSyncTimeout                                              time.Duration
	authEnabled, enableWebhooks                                   bool
	authBasicUsername, authBasicPassword, authBasicPasswordHash   string
	authOIDCIssuerURL, authOIDCClientID, authOIDCClientSecret     string
	authTokenSecret                                               string
	coordinatorMode                                               bool
	coordinatorHeartbeat, coordinatorTTL                          time.Duration
	zapOptions                                                    zap.Options
}

func main() {
	if err := run(ctrl.SetupSignalHandler(), os.Args[1:], os.Getenv, os.Stdin, os.Stdout, os.Stderr); err != nil {
		if _, printErr := fmt.Fprintln(os.Stderr, "Failed to start:", err); printErr != nil {
			os.Exit(2)
		}
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, getenv func(string) string, _ io.Reader, _, stderr io.Writer) error {
	cfg, err := registerFlags(args, getenv, stderr)
	if err != nil {
		return fmt.Errorf("register flags: %w", err)
	}

	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&cfg.zapOptions)))
	setupLog := ctrl.Log.WithName("setup")
	scheme := newScheme()

	if err := metrics.RegisterCollectors(crmetrics.Registry); err != nil {
		return fmt.Errorf("register metrics collectors: %w", err)
	}

	return dispatchMode(ctx, cfg, scheme, setupLog)
}

func dispatchMode(ctx context.Context, cfg *cliConfig, scheme *runtime.Scheme, setupLog logr.Logger) error {
	if err := validateMode(cfg.mode); err != nil {
		return fmt.Errorf("validate mode: %w", err)
	}
	if err := validateCoordinatorConfig(cfg); err != nil {
		return err
	}

	switch cfg.mode {
	case "agent":
		return runAgentMode(ctx, cfg.uiAddr, cfg.probeAddr, cfg.agentClusterID, cfg.metricsAddr, setupLog)
	case "repo-server":
		return runRepoServerMode(ctx, cfg.uiAddr, cfg.probeAddr, cfg.repoWorkDir, cfg.metricsAddr, scheme, setupLog, cfg.cacheConfig(), nil, nil)
	case "api":
		return runAPIMode(ctx, cfg, scheme, setupLog, nil)
	case "webhook":
		return runWebhookMode(ctx, cfg, cfg.webhookAddr, cfg.probeAddr, cfg.webhookSecret, scheme, setupLog, cfg.cacheConfig())
	default:
		return runOperatorMode(ctx, cfg, scheme, setupLog)
	}
}

func (cfg *cliConfig) cacheConfig() cache.Config {
	backend := cfg.cacheBackend
	if backend == "" {
		backend = cache.BackendMemory
	}
	addr := cfg.cacheRedisAddr
	if addr == "" {
		addr = defaultRedisAddr
	}
	return cache.Config{
		Backend:       backend,
		RedisAddr:     addr,
		RedisPassword: cfg.cacheRedisPassword,
		RedisDB:       cfg.cacheRedisDB,
	}
}

func (cfg *cliConfig) shardFilter() *sharding.Filter {
	return sharding.NewFilter(cfg.shardID, cfg.shardTotal)
}

func validateMode(mode string) error {
	if mode != "operator" && mode != "api" && mode != "webhook" && mode != "repo-server" && mode != "agent" {
		return fmt.Errorf("invalid mode: %s (must be 'operator', 'api', 'webhook', 'repo-server', or 'agent')", mode)
	}
	return nil
}

func registerCoordinatorFlags(fs *flag.FlagSet, cfg *cliConfig) {
	fs.BoolVar(&cfg.coordinatorMode, "coordinator-mode", false,
		"Enable Redis-backed coordinator for active-active sharding (requires PAPRIKA_REDIS_ADDR). "+
			"Each replica processes a subset of namespaces via consistent hash ring.")
	fs.DurationVar(&cfg.coordinatorHeartbeat, "coordinator-heartbeat", 15*time.Second,
		"Coordinator heartbeat interval. How often replicas refresh their registration.")
	fs.DurationVar(&cfg.coordinatorTTL, "coordinator-ttl", 30*time.Second,
		"Coordinator heartbeat TTL. Must be greater than --coordinator-heartbeat. "+
			"Stale replicas are removed after this duration.")
}

func validateCoordinatorConfig(cfg *cliConfig) error {
	if !cfg.coordinatorMode {
		return nil
	}
	if cfg.cacheRedisAddr == "" {
		return errors.New("--coordinator-mode requires PAPRIKA_REDIS_ADDR environment variable")
	}
	if cfg.coordinatorHeartbeat >= cfg.coordinatorTTL {
		return fmt.Errorf("--coordinator-heartbeat (%v) must be less than --coordinator-ttl (%v)", cfg.coordinatorHeartbeat, cfg.coordinatorTTL)
	}
	return nil
}

func registerFlags(args []string, getenv func(string) string, stderr io.Writer) (*cliConfig, error) {
	var cfg cliConfig
	fs := flag.NewFlagSet("paprika", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.StringVar(&cfg.metricsAddr, "metrics-bind-address", "0", "The address the metrics endpoint binds to. "+
		"Use :8443 for HTTPS or :8080 for HTTP, or leave as 0 to disable the metrics service.")
	fs.StringVar(&cfg.probeAddr, "health-probe-bind-address", ":8081", "The address the probe endpoint binds to.")
	fs.BoolVar(&cfg.enableLeaderElection, "leader-elect", false,
		"Enable leader election for controller manager. "+
			"Enabling this will ensure there is only one active controller manager.")
	fs.DurationVar(&cfg.cacheSyncTimeout, "cache-sync-timeout", 2*time.Minute,
		"Maximum time to wait for caches to sync on startup before exiting. "+
			"Default 2m; raise this for large clusters or many CRDs (e.g. 5m) to avoid "+
			"CrashLoopBackOff due to slow initial list calls on small API servers.")
	registerCoordinatorFlags(fs, &cfg)
	fs.BoolVar(&cfg.secureMetrics, "metrics-secure", true,
		"If set, the metrics endpoint is served securely via HTTPS. Use --metrics-secure=false to use HTTP instead.")
	fs.StringVar(&cfg.webhookCertPath, "webhook-cert-path", "", "The directory that contains the webhook certificate.")
	fs.StringVar(&cfg.webhookCertName, "webhook-cert-name", "tls.crt", "The name of the webhook certificate file.")
	fs.StringVar(&cfg.webhookCertKey, "webhook-cert-key", "tls.key", "The name of the webhook key file.")
	fs.StringVar(&cfg.metricsCertPath, "metrics-cert-path", "",
		"The directory that contains the metrics server certificate.")
	fs.StringVar(&cfg.metricsCertName, "metrics-cert-name", "tls.crt", "The name of the metrics server certificate file.")
	fs.StringVar(&cfg.metricsCertKey, "metrics-cert-key", "tls.key", "The name of the metrics server key file.")
	fs.BoolVar(&cfg.enableHTTP2, "enable-http2", false,
		"If set, HTTP/2 will be enabled for the metrics and webhook servers")
	fs.StringVar(&cfg.operatorNamespace, "operator-namespace", "paprika-system",
		"The namespace where the operator runs (used for manifest snapshots and step jobs).")
	fs.StringVar(&cfg.uiAddr, "ui-bind-address", ":3000",
		"The address the UI dashboard server binds to.")
	fs.StringVar(&cfg.mode, "mode", "operator",
		"Running mode: 'operator' (controllers + API), 'api' (API server only), 'webhook' (webhook receiver only), 'repo-server' (repo server only), or 'agent' (in-cluster agent).")
	fs.StringVar(&cfg.k8sAPIServer, "k8s-api-server", "",
		"Kubernetes API server URL. Only used in 'api' mode.")
	fs.StringVar(&cfg.k8sTokenFile, "k8s-token-file", "",
		"Path to Kubernetes service account token. Only used in 'api' mode.")
	fs.StringVar(&cfg.webhookAddr, "webhook-bind-address", ":8080",
		"The address the webhook receiver binds to. Only used in 'webhook' mode.")
	fs.StringVar(&cfg.repoServerAddr, "repo-server-addr", getenv("PAPRIKA_REPO_SERVER_ADDR"),
		"Address of the repo server. When set, controllers delegate source resolution/rendering to it.")
	fs.StringVar(&cfg.repoWorkDir, "repo-workdir", getenv("PAPRIKA_REPO_WORKDIR"),
		"Working directory for the repo server. Only used in 'repo-server' mode.")
	fs.StringVar(&cfg.agentClusterID, "agent-cluster-id", getenv("PAPRIKA_AGENT_CLUSTER_ID"),
		"Cluster ID for the in-cluster agent. Only used in 'agent' mode.")
	fs.BoolVar(&cfg.authEnabled, "auth-enabled", false,
		"Enable authentication and authorization for the API server.")
	fs.StringVar(&cfg.authBasicUsername, "auth-basic-username", "",
		"Basic auth username. Only used when --auth-enabled=true.")
	fs.StringVar(&cfg.authBasicPassword, "auth-basic-password", "",
		"Basic auth plain-text password (deprecated: use --auth-basic-password-hash instead).")
	fs.StringVar(&cfg.authBasicPasswordHash, "auth-basic-password-hash", "",
		"Basic auth SHA-256 password hash (hex). Only used when --auth-enabled=true.")
	fs.StringVar(&cfg.authOIDCIssuerURL, "auth-oidc-issuer-url", "",
		"OIDC issuer URL. Only used when --auth-enabled=true.")
	fs.StringVar(&cfg.authOIDCClientID, "auth-oidc-client-id", "",
		"OIDC client ID. Only used when --auth-enabled=true.")
	fs.StringVar(&cfg.authOIDCClientSecret, "auth-oidc-client-secret", "",
		"OIDC client secret. Prefer setting via PAPRIKA_OIDC_CLIENT_SECRET env var to avoid process-list exposure.")
	fs.StringVar(&cfg.authTokenSecret, "auth-token-secret", "",
		"Secret key for signing self-issued auth tokens. Required for basic auth login flow. "+
			"Prefer setting via PAPRIKA_AUTH_TOKEN_SECRET env var.")

	cfg.webhookSecret = getenv("PAPRIKA_WEBHOOK_SECRET")
	cfg.authRBACRules = getenv("PAPRIKA_AUTH_RBAC_RULES")
	cfg.authTokenSecret = getenv("PAPRIKA_AUTH_TOKEN_SECRET")
	cfg.enableWebhooks = getenv("ENABLE_WEBHOOKS") != "false"

	cfg.cacheBackend = getenv("PAPRIKA_CACHE_BACKEND")
	cfg.cacheRedisAddr = getenv("PAPRIKA_REDIS_ADDR")
	cfg.cacheRedisPassword = getenv("PAPRIKA_REDIS_PASSWORD")
	if dbStr := getenv("PAPRIKA_REDIS_DB"); dbStr != "" {
		if db, err := strconv.Atoi(dbStr); err == nil {
			cfg.cacheRedisDB = db
		}
	}

	cfg.shardIDSource = getenv("PAPRIKA_SHARD_ID")
	if cfg.shardIDSource == "" {
		cfg.shardIDSource = getenv("POD_NAME")
	}
	if totalStr := getenv("PAPRIKA_SHARD_TOTAL"); totalStr != "" {
		if total, err := strconv.Atoi(totalStr); err == nil {
			cfg.shardTotal = total
		}
	}
	if idStr := getenv("PAPRIKA_SHARD_ID"); idStr != "" {
		if id, err := strconv.Atoi(idStr); err == nil {
			cfg.shardID = id
		}
	}

	cfg.auditLogEnabled = getenv("PAPRIKA_AUDIT_ENABLED") == "true"

	cfg.zapOptions = zap.Options{Development: false}
	cfg.zapOptions.BindFlags(fs)
	if err := fs.Parse(args); err != nil {
		return nil, fmt.Errorf("parse flags: %w", err)
	}
	return &cfg, nil
}

func buildAPIServerOptions(
	authCfg auth.Config,
	apiClient client.Client,
	k8sClient kubernetes.Interface,
	auditLogEnabled bool,
	projectValidator *governance.ProjectValidator,
	policyEvaluator *governance.PolicyEvaluator,
	restConfig *rest.Config,
) ([]apiserver.ServerOption, error) {
	opts := []apiserver.ServerOption{
		apiserver.WithGovernanceValidator(projectValidator),
		apiserver.WithGovernancePolicyEvaluator(policyEvaluator),
	}
	if authCfg.Enabled {
		authz, err := auth.BuildAuthorizer(authCfg, apiClient)
		if err != nil {
			return nil, fmt.Errorf("build authorizer: %w", err)
		}
		opts = append(opts, apiserver.WithAuthorizer(authz))
	}
	if auditLogEnabled {
		opts = append(opts, apiserver.WithAuditor(audit.NewLogAuditor()))
	}
	opts = append(opts, apiserver.WithK8sClient(k8sClient))
	if restConfig != nil {
		if dc, err := dynamic.NewForConfig(restConfig); err == nil {
			opts = append(opts, apiserver.WithDynamicClient(dc))
		}
	}
	return opts, nil
}

func runAPIMode(ctx context.Context, cfg *cliConfig, scheme *runtime.Scheme, setupLog logr.Logger, probeAddrCh chan<- string) error {
	apiCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	telemetry := observability.NewTelemetry(apiCtx, observability.ConfigFromEnv())
	defer func() { _ = telemetry.Shutdown(apiCtx) }() //nolint:errcheck // shutdown in defer; error is best-effort

	clients, err := buildAPIClients(apiCtx, cfg, scheme, setupLog)
	if err != nil {
		return err
	}

	broker, err := newBrokerFromConfig(apiCtx, cfg.cacheConfig(), setupLog)
	if err != nil {
		return fmt.Errorf("create event broker: %w", err)
	}
	defer broker.Close()

	paprikaServer, connectHandler, err := buildConnectHandler(clients.client, clients.k8sClient, clients.restConfig, broker, clients.authCfg, clients.interceptor, cfg, setupLog)
	if err != nil {
		return err
	}

	extraMuxHandlers, err := buildAuthHandlers(apiCtx, clients.authCfg)
	if err != nil {
		return err
	}

	mux, muxErr := buildAPIMux(connectHandler, paprikaServer.Broker(), setupLog, extraMuxHandlers...)
	if muxErr != nil {
		return fmt.Errorf("build API mux: %w", muxErr)
	}
	wrappedHandler := otelhttp.NewHandler(apiserver.MetricsMiddleware(mux), "paprika-http")
	healthMux := buildHealthMux(setupLog)

	healthSrv := buildHealthProbeServer(healthMux, cfg.probeAddr)
	go func() {
		if srvErr := runHTTPServer(apiCtx, healthSrv, "health probe server", setupLog, probeAddrCh, false); srvErr != nil {
			setupLog.Error(srvErr, "Health probe server exited with error")
		}
	}()

	startMetricsServer(ctx, cfg.metricsAddr, setupLog)

	return startAPIServer(apiCtx, wrappedHandler, cfg.uiAddr, setupLog)
}

type apiClients struct {
	client      client.Client
	k8sClient   kubernetes.Interface
	restConfig  *rest.Config
	authCfg     auth.Config
	interceptor connect.Interceptor
}

func buildAPIClients(ctx context.Context, cfg *cliConfig, scheme *runtime.Scheme, setupLog logr.Logger) (*apiClients, error) {
	config, err := buildAPIConfig(cfg.k8sAPIServer, cfg.k8sTokenFile)
	if err != nil {
		return nil, fmt.Errorf("build API config: %w", err)
	}

	apiClient, err := createAPIClient(config, scheme)
	if err != nil {
		return nil, fmt.Errorf("create API client: %w", err)
	}

	k8sClient, err := createK8sClient(config)
	if err != nil {
		return nil, err
	}

	authCfg := buildAuthConfig(cfg.authEnabled, cfg.authBasicUsername, cfg.authBasicPassword, cfg.authBasicPasswordHash,
		cfg.authOIDCIssuerURL, cfg.authOIDCClientID, cfg.authOIDCClientSecret, cfg.authTokenSecret, cfg.authRBACRules, setupLog)
	authInterceptor, err := auth.Interceptor(ctx, authCfg, apiClient)
	if err != nil {
		return nil, fmt.Errorf("failed to build auth interceptor: %w", err)
	}

	return &apiClients{
		client:      apiClient,
		k8sClient:   k8sClient,
		restConfig:  config,
		authCfg:     authCfg,
		interceptor: authInterceptor,
	}, nil
}

func buildConnectHandler(apiClient client.Client, k8sClient kubernetes.Interface, restConfig *rest.Config, broker *events.Broker, authCfg auth.Config, authInterceptor connect.Interceptor, cfg *cliConfig, setupLog logr.Logger) (*apiserver.PaprikaServer, http.Handler, error) {
	resolver := governance.NewProjectResolver(apiClient)
	projectValidator := governance.NewProjectValidator(resolver, governance.NewClusterResolver(apiClient), nil)
	policyEvaluator := governance.NewPolicyEvaluator(apiClient)

	opts, err := buildAPIServerOptions(authCfg, apiClient, k8sClient, cfg.auditLogEnabled, projectValidator, policyEvaluator, restConfig)
	if err != nil {
		return nil, nil, err
	}
	paprikaServer := apiserver.NewPaprikaServer(apiClient, broker, opts...)

	otelInterceptor, err := otelconnect.NewInterceptor()
	if err != nil {
		return nil, nil, fmt.Errorf("otelconnect interceptor: %w", err)
	}

	const maxMsgBytes = 10 * 1024 * 1024 // 10 MiB
	_, connectHandler := v1connect.NewPaprikaServiceHandler(paprikaServer,
		connect.WithInterceptors(otelInterceptor, authInterceptor, paprikaServer.AuditInterceptor()),
		connect.WithReadMaxBytes(maxMsgBytes),
	)
	return paprikaServer, connectHandler, nil
}

func buildAuthHandlers(ctx context.Context, authCfg auth.Config) ([]func(*http.ServeMux), error) {
	var handlers []func(*http.ServeMux)

	if authCfg.OIDC != nil {
		oidcAuth, err := auth.NewOIDCAuthenticator(ctx, authCfg.OIDC)
		if err != nil {
			return nil, fmt.Errorf("create OIDC authenticator: %w", err)
		}
		handlers = append(handlers, func(mux *http.ServeMux) {
			mux.HandleFunc("/auth/login", oidcAuth.LoginHandler())
			mux.HandleFunc("/auth/token", oidcAuth.TokenHandler())
		})
	}

	if authCfg.BasicAuth != nil && authCfg.Enabled && len(authCfg.TokenSecret) > 0 {
		secret := authCfg.TokenSecret
		basicCfg := *authCfg.BasicAuth
		handlers = append(handlers, func(mux *http.ServeMux) {
			mux.HandleFunc("/auth/basic-login", auth.BasicLoginHandler(basicCfg, secret))
		})
	}

	return handlers, nil
}

func buildWebhookCacheInvalidator(ctx context.Context, cacheCfg cache.Config, setupLog logr.Logger) *cache.Invalidator {
	cacheClient, err := cache.New(ctx, cacheCfg)
	if err != nil {
		setupLog.Error(err, "Failed to create webhook cache client, continuing without cache invalidation")
		return nil
	}
	if pingErr := cacheClient.Ping(ctx); pingErr != nil {
		setupLog.Error(pingErr, "Webhook cache ping failed, continuing without cache invalidation")
		if closeErr := cacheClient.Close(); closeErr != nil {
			setupLog.Error(closeErr, "Failed to close webhook cache client after ping failure")
		}
		return nil
	}
	// Intentionally NOT deferring cacheClient.Close() here — the returned
	// Invalidator wraps the client and its lifetime is managed by the caller.
	return cache.NewInvalidator(cacheClient)
}

func runWebhookMode(ctx context.Context, cfg *cliConfig, webhookAddr, probeAddr, webhookSecret string, scheme *runtime.Scheme, setupLog logr.Logger, cacheCfg cache.Config) error {
	whCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	telemetry := observability.NewTelemetry(whCtx, observability.ConfigFromEnv())
	defer func() { _ = telemetry.Shutdown(whCtx) }() //nolint:errcheck // shutdown in defer; error is best-effort

	config, err := rest.InClusterConfig()
	if err != nil {
		config = ctrl.GetConfigOrDie()
	}

	apiClient, err := createAPIClient(config, scheme)
	if err != nil {
		return fmt.Errorf("create API client: %w", err)
	}

	inv := buildWebhookCacheInvalidator(whCtx, cacheCfg, setupLog)

	var repoClient *reposerverclient.Client
	if cfg.repoServerAddr != "" {
		repoClient = reposerverclient.New(cfg.repoServerAddr)
	}
	handler := webhookreceiver.NewHandlerWithCacheAndRepo(apiClient, webhookSecret, inv, repoClient)

	mux := http.NewServeMux()
	mux.Handle("/webhook", handler)
	mux.Handle("/healthz", healthzHandler(setupLog))
	mux.Handle("/readyz", healthzHandler(setupLog))

	healthMux := buildHealthMux(setupLog)
	healthSrv := buildHealthProbeServer(healthMux, probeAddr)
	go func() {
		if srvErr := runHTTPServer(whCtx, healthSrv, "health probe server", setupLog, nil, false); srvErr != nil {
			setupLog.Error(srvErr, "Health probe server exited with error")
		}
	}()

	startMetricsServer(ctx, cfg.metricsAddr, setupLog)

	server := &http.Server{
		Addr:              webhookAddr,
		Handler:           mux,
		ReadHeaderTimeout: defaultReadHeaderTimeout,
	}
	return runHTTPServer(whCtx, server, "webhook receiver", setupLog, nil, true)
}

func runRepoServerMode(ctx context.Context, addr, probeAddr, workDir, metricsAddr string, scheme *runtime.Scheme, setupLog logr.Logger, cacheCfg cache.Config, probeAddrCh chan<- string, k8sClient client.Client) error {
	if workDir == "" {
		workDir = "/tmp/paprika-repo"
	}

	c, err := newCacheFromConfig(ctx, cacheCfg, setupLog)
	if err != nil {
		return fmt.Errorf("create cache: %w", err)
	}
	defer func() {
		if closeErr := c.Close(); closeErr != nil {
			setupLog.Error(closeErr, "Failed to close cache")
		}
	}()

	if k8sClient == nil {
		cfg, err := ctrl.GetConfig()
		if err != nil {
			return fmt.Errorf("get k8s config: %w", err)
		}
		k8sClient, err = client.New(cfg, client.Options{Scheme: scheme})
		if err != nil {
			return fmt.Errorf("create k8s client: %w", err)
		}
	}

	srv := reposerver.NewServerWithClient(workDir, c, k8sClient)

	rsCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	telemetry := observability.NewTelemetry(rsCtx, observability.ConfigFromEnv())
	defer func() { _ = telemetry.Shutdown(rsCtx) }() //nolint:errcheck // shutdown in defer; error is best-effort

	healthMux := buildHealthMux(setupLog)
	healthSrv := buildHealthProbeServer(healthMux, probeAddr)
	go func() {
		if srvErr := runHTTPServer(rsCtx, healthSrv, "health probe server", setupLog, probeAddrCh, false); srvErr != nil {
			setupLog.Error(srvErr, "Health probe server exited with error")
		}
	}()

	startMetricsServer(ctx, metricsAddr, setupLog)

	if err := srv.Run(rsCtx, addr); err != nil {
		return fmt.Errorf("repo server run: %w", err)
	}
	return nil
}

func runAgentMode(ctx context.Context, addr, probeAddr, clusterID, metricsAddr string, setupLog logr.Logger) error {
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

	agentCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	telemetry := observability.NewTelemetry(agentCtx, observability.ConfigFromEnv())
	defer func() { _ = telemetry.Shutdown(agentCtx) }() //nolint:errcheck // shutdown in defer; error is best-effort

	healthMux := buildHealthMux(setupLog)
	healthSrv := buildHealthProbeServer(healthMux, probeAddr)
	go func() {
		if srvErr := runHTTPServer(agentCtx, healthSrv, "health probe server", setupLog, nil, false); srvErr != nil {
			setupLog.Error(srvErr, "Health probe server exited with error")
		}
	}()

	startMetricsServer(ctx, metricsAddr, setupLog)

	if err := srv.Run(agentCtx, addr); err != nil {
		return fmt.Errorf("agent server run: %w", err)
	}
	return nil
}

func buildAPIConfig(k8sAPIServer, k8sTokenFile string) (*rest.Config, error) {
	if k8sAPIServer == "" {
		config, err := rest.InClusterConfig()
		if err != nil {
			return nil, fmt.Errorf("get in-cluster config (use --k8s-api-server): %w", err)
		}
		negotiateProtobuf(config)
		return config, nil
	}

	token, err := readBearerToken(k8sTokenFile)
	if err != nil {
		return nil, err
	}
	cfg := &rest.Config{
		Host:            k8sAPIServer,
		BearerToken:     token,
		TLSClientConfig: rest.TLSClientConfig{Insecure: false},
	}
	negotiateProtobuf(cfg)
	return cfg, nil
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

func createAPIClient(config *rest.Config, scheme *runtime.Scheme) (client.Client, error) {
	apiClient, err := client.New(config, client.Options{Scheme: scheme})
	if err != nil {
		return nil, fmt.Errorf("create k8s client: %w", err)
	}
	return apiClient, nil
}

func createK8sClient(config *rest.Config) (kubernetes.Interface, error) {
	k8sClient, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("create k8s clientset: %w", err)
	}
	return k8sClient, nil
}

func buildAPIMux(connectHandler http.Handler, broker *events.Broker, log logr.Logger, extraHandlers ...func(*http.ServeMux)) (*http.ServeMux, error) {
	mux := http.NewServeMux()
	mux.Handle("/paprika.v1.PaprikaService/", connectHandler)
	mux.Handle("/events", apiserver.NewSSEHandler(broker))
	mux.Handle("/healthz", healthzHandler(log))
	// Register extra handlers before the / catch-all so specific routes win.
	for _, h := range extraHandlers {
		h(mux)
	}
	uiHandler, err := apiserver.UIHandler()
	if err != nil {
		return nil, fmt.Errorf("build UI handler: %w", err)
	}
	mux.Handle("/", uiHandler)
	return mux, nil
}

func buildHealthMux(log logr.Logger) *http.ServeMux {
	healthMux := http.NewServeMux()
	healthMux.Handle("/healthz", healthzHandler(log))
	healthMux.Handle("/readyz", healthzHandler(log))
	return healthMux
}

func healthzHandler(log logr.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		if _, err := fmt.Fprintln(w, "ok"); err != nil {
			log.Error(err, "Failed to write healthz response")
		}
	}
}

func buildHealthProbeServer(healthMux *http.ServeMux, probeAddr string) *http.Server {
	return &http.Server{
		Addr:              probeAddr,
		Handler:           healthMux,
		ReadHeaderTimeout: defaultReadHeaderTimeout,
	}
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

func startAPIServer(ctx context.Context, handler http.Handler, uiAddr string, log logr.Logger) error {
	server := &http.Server{
		Addr:              uiAddr,
		Handler:           handler,
		ReadHeaderTimeout: defaultReadHeaderTimeout,
	}
	return runHTTPServer(ctx, server, "API server", log, nil, true)
}

func runHTTPServer(ctx context.Context, srv *http.Server, name string, log logr.Logger, boundAddrCh chan<- string, useMTLS bool) error {
	go func() {
		<-ctx.Done()
		// Use WithoutCancel so the shutdown deadline is independent of the
		// already-cancelled parent context while preserving its values.
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), serverShutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Error(err, "Failed to shutdown server", "name", name)
		}
	}()
	ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", srv.Addr)
	if err != nil {
		return fmt.Errorf("%s listen error: %w", name, err)
	}
	if boundAddrCh != nil {
		select {
		case boundAddrCh <- ln.Addr().String():
		case <-ctx.Done():
		}
	}
	log.Info("Starting "+name, "addr", ln.Addr().String())
	return serveListener(ln, srv, name, useMTLS, log)
}

// serveListener serves HTTP on ln, optionally with TLS when useMTLS is true and
// the mTLS env vars are set. It falls back to plaintext serving otherwise.
func serveListener(ln net.Listener, srv *http.Server, name string, useMTLS bool, log logr.Logger) error {
	if useMTLS {
		if cert, key, ok := mtls.ServingConfig(); ok {
			log.Info("Starting "+name+" with TLS", "cert", cert, "key", key)
			if err := srv.ServeTLS(ln, cert, key); err != nil && err != http.ErrServerClosed {
				return fmt.Errorf("%s error: %w", name, err)
			}
			return nil
		}
	}
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("%s error: %w", name, err)
	}
	return nil
}

func newBrokerFromConfig(ctx context.Context, cacheCfg cache.Config, log logr.Logger) (*events.Broker, error) {
	if cacheCfg.Backend != cache.BackendRedis {
		return events.NewBroker(log), nil
	}
	client := redis.NewClient(&redis.Options{
		Addr:     cacheCfg.RedisAddr,
		Password: cacheCfg.RedisPassword,
		DB:       cacheCfg.RedisDB,
	})
	if err := client.Ping(ctx).Err(); err != nil {
		if closeErr := client.Close(); closeErr != nil {
			return nil, fmt.Errorf("redis ping failed; close failed: %w", errors.Join(err, closeErr))
		}
		return nil, fmt.Errorf("redis ping failed: %w", err)
	}
	broker, err := events.NewRedisBrokerWithContext(ctx, client, log)
	if err != nil {
		return nil, fmt.Errorf("create redis event broker: %w", err)
	}
	return broker, nil
}

func newCacheFromConfig(ctx context.Context, cacheCfg cache.Config, setupLog logr.Logger) (*cache.Cache, error) {
	c, err := cache.New(ctx, cacheCfg)
	if err != nil {
		return nil, fmt.Errorf("create cache: %w", err)
	}
	if pingErr := c.Ping(ctx); pingErr != nil {
		setupLog.Error(pingErr, "Cache ping failed, falling back to in-memory")
		if closeErr := c.Close(); closeErr != nil {
			setupLog.Error(closeErr, "Failed to close cache after ping failure")
		}
		c, err = cache.New(ctx, cache.Config{Backend: cache.BackendMemory})
		if err != nil {
			return nil, fmt.Errorf("create in-memory cache: %w", err)
		}
		return c, nil
	}
	return c, nil
}

func buildAuthConfig(enabled bool, basicUsername, basicPassword, basicPasswordHash, oidcIssuerURL, oidcClientID, oidcClientSecret, tokenSecret, rbacRules string, log logr.Logger) auth.Config {
	cfg := auth.Config{
		Enabled: enabled,
	}
	if !enabled {
		return cfg
	}
	if tokenSecret != "" {
		cfg.TokenSecret = []byte(tokenSecret)
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
			Scopes:       []string{"openid", "profile", "email"},
		}
	}
	if rbacRules != "" {
		var rules []auth.RBACRule
		if err := json.Unmarshal([]byte(rbacRules), &rules); err != nil {
			log.Error(err, "Failed to parse RBAC rules, ignoring")
		} else {
			cfg.RBACRules = rules
		}
	}
	return cfg
}

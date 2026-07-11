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

package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"

	"connectrpc.com/connect"
	"connectrpc.com/otelconnect"
	"github.com/go-logr/logr"
	"github.com/go-logr/zapr"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/contrib/bridges/otelzap"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	gozap "go.uber.org/zap"
	gozapcore "go.uber.org/zap/zapcore"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	crcache "sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/config"
	crzap "sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/manager"
	"sigs.k8s.io/controller-runtime/pkg/metrics/filters"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
	"sigs.k8s.io/controller-runtime/pkg/webhook"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	apiserver "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/events"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/audit"
	"github.com/benebsworth/paprika/internal/cache"
	"github.com/benebsworth/paprika/internal/controller/bootstrap"
	"github.com/benebsworth/paprika/internal/coordinator"
	"github.com/benebsworth/paprika/internal/fleet"
	"github.com/benebsworth/paprika/internal/governance"
	"github.com/benebsworth/paprika/internal/metrics"
	"github.com/benebsworth/paprika/internal/observability"
	"github.com/benebsworth/paprika/internal/ratelimit"
	"github.com/benebsworth/paprika/internal/sharding"
	webhookreceiver "github.com/benebsworth/paprika/internal/webhook/receiver"
)

// operatorCache is the cache surface the operator dependency container needs:
// manifest rendering reads and writes, and shutdown closes the backend.
type operatorCache interface {
	cache.Getter
	cache.Setter
	cache.Closer
}

type operatorDependencies struct {
	cache          operatorCache
	telemetry      *observability.Telemetry
	shardFilter    *sharding.Filter
	broker         *events.Broker
	repoServerAddr string
	coordinator    *coordinator.Coordinator
	fleetReader    fleet.Reader
}

// bridgeZapWithOTel tees raw's zap core with an otelzap core that forwards
// records to the OTel Logs signal via telemetry's LoggerProvider. When telemetry
// is disabled (or has no LoggerProvider) it returns raw unchanged so there is no
// bridging overhead. The returned logger is functionally identical to the input —
// only an additional OTel-Logs-bridged core is appended via zapcore.NewTee.
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

func buildOperatorDependencies(ctx context.Context, cfg *cliConfig, setupLog logr.Logger) (*operatorDependencies, error) {
	c, err := newCacheFromConfig(ctx, cfg.cacheConfig(), setupLog)
	if err != nil {
		return nil, fmt.Errorf("create cache: %w", err)
	}

	telemetry := observability.NewTelemetry(ctx, observability.ConfigFromEnv())
	if telemetry.IsTracingEnabled() {
		setupLog.Info("OpenTelemetry tracing enabled")
		// Bridge zap logs to the OTel Logs signal (otelzap) so every record is
		// forwarded to the configured OTLP backend alongside traces/metrics.
		// The bridge is only wired when tracing is enabled; otherwise the global
		// LoggerProvider is a no-op and bridging would add overhead for nothing.
		raw := crzap.NewRaw(crzap.UseFlagOptions(&cfg.zapOptions))
		ctrl.SetLogger(zapr.NewLogger(bridgeZapWithOTel(raw, telemetry)))
	}

	shardFilter := cfg.shardFilter()
	if shardFilter.Enabled() {
		setupLog.Info("Controller sharding enabled", "shard", shardFilter.ShardID(), "total", shardFilter.TotalShards())
	}

	broker, err := newBrokerFromConfig(ctx, cfg.cacheConfig(), setupLog)
	if err != nil {
		return nil, fmt.Errorf("create event broker: %w", err)
	}

	return &operatorDependencies{
		cache:          c,
		telemetry:      telemetry,
		shardFilter:    shardFilter,
		broker:         broker,
		repoServerAddr: cfg.repoServerAddr,
	}, nil
}

func closeOperatorDependencies(ctx context.Context, deps *operatorDependencies, setupLog logr.Logger) {
	if deps == nil {
		return
	}
	deps.broker.Close()
	if deps.telemetry != nil {
		if shutdownErr := deps.telemetry.Shutdown(ctx); shutdownErr != nil {
			setupLog.Error(shutdownErr, "Failed to shutdown tracing")
		}
	}
	if closeErr := deps.cache.Close(); closeErr != nil {
		setupLog.Error(closeErr, "Failed to close cache")
	}
}

type operatorGovernance struct {
	authCfg          auth.Config
	authz            auth.Authorizer
	k8sClient        kubernetes.Interface
	projectValidator *governance.ProjectValidator
	policyEvaluator  *governance.PolicyEvaluator
	rateLimiter      *ratelimit.ControllerRateLimit
}

func runOperatorMode(ctx context.Context, cfg *cliConfig, scheme *runtime.Scheme, setupLog logr.Logger) error {
	opCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	deps, err := buildOperatorDependencies(opCtx, cfg, setupLog)
	if err != nil {
		return fmt.Errorf("build operator dependencies: %w", err)
	}
	defer closeOperatorDependencies(opCtx, deps, setupLog)

	mgr, fleetReader, err := buildOperatorManagerAndFleetRuntime(opCtx, cfg, scheme, setupLog)
	if err != nil {
		return err
	}
	deps.fleetReader = fleetReader

	if coordErr := startCoordinatorIfMode(opCtx, cfg, deps, mgr, setupLog); coordErr != nil {
		return fmt.Errorf("start coordinator: %w", coordErr)
	}

	if err = registerDefaultProjectBootstrap(mgr, cfg.operatorNamespace); err != nil {
		return fmt.Errorf("register default project bootstrap: %w", err)
	}

	gov, err := newOperatorGovernance(mgr, cfg, setupLog)
	if err != nil {
		return fmt.Errorf("build operator governance: %w", err)
	}

	if err = setupOperatorControllers(opCtx, mgr, gov.k8sClient, cfg.operatorNamespace, deps, gov.projectValidator, gov.policyEvaluator, gov.rateLimiter, cfg.enableWebhooks); err != nil {
		return fmt.Errorf("setup operator controllers: %w", err)
	}

	if err := startOperatorUIServer(opCtx, mgr, cfg, gov.k8sClient, gov.authCfg, gov.projectValidator, gov.policyEvaluator, gov.authz, deps.broker, deps.fleetReader, cfg.auditLogEnabled, setupLog); err != nil {
		return fmt.Errorf("start UI server: %w", err)
	}

	if err := startInlineWebhookServer(opCtx, mgr.GetClient(), cfg.webhookSecret, setupLog); err != nil {
		return fmt.Errorf("start inline webhook server: %w", err)
	}

	registerGauges(setupLog, mgr.GetClient())

	setupLog.Info("Starting manager")
	if err := mgr.Start(opCtx); err != nil {
		return fmt.Errorf("failed to run manager: %w", err)
	}
	return nil
}

func buildOperatorManagerAndFleetRuntime(
	ctx context.Context,
	cfg *cliConfig,
	scheme *runtime.Scheme,
	setupLog logr.Logger,
) (ctrl.Manager, fleet.Reader, error) {
	mgr, err := buildOperatorManagerAndServer(cfg, scheme, setupLog)
	if err != nil {
		return nil, nil, fmt.Errorf("build operator manager and server: %w", err)
	}

	fleetIndex := fleet.NewIndex()
	fleetStore := fleet.NewCacheStore(mgr.GetCache(), scheme)
	fleetRuntime, err := fleet.NewRuntime(mgr.GetCache(), fleetStore, fleetIndex)
	if err != nil {
		return nil, nil, fmt.Errorf("build fleet index runtime: %w", err)
	}
	if err = fleetRuntime.Register(ctx); err != nil {
		return nil, nil, fmt.Errorf("register fleet index informers: %w", err)
	}
	if err = mgr.Add(fleetRuntime); err != nil {
		return nil, nil, fmt.Errorf("register fleet index runtime: %w", err)
	}
	return mgr, fleetRuntime.Reader(), nil
}

func registerGauges(setupLog logr.Logger, c client.Client) {
	if err := metrics.RegisterKubernetesGaugeCallbacks(c); err != nil {
		setupLog.Error(err, "Failed to register kubernetes gauge callbacks")
	}
}

func startCoordinatorIfMode(ctx context.Context, cfg *cliConfig, deps *operatorDependencies, mgr ctrl.Manager, setupLog logr.Logger) error {
	if !cfg.coordinatorMode {
		return nil
	}
	redisAddr := cfg.cacheRedisAddr
	redisPassword := cfg.cacheRedisPassword
	redisDB := cfg.cacheRedisDB

	client := redis.NewClient(&redis.Options{
		Addr:     redisAddr,
		Password: redisPassword,
		DB:       redisDB,
	})
	podName := cfg.shardIDSource
	if podName == "" {
		var hostErr error
		podName, hostErr = os.Hostname()
		if hostErr != nil {
			return fmt.Errorf("cannot determine pod identity: %w", hostErr)
		}
	}

	c := coordinator.NewCoordinator(client, podName,
		coordinator.WithHeartbeatInterval(cfg.coordinatorHeartbeat),
		coordinator.WithHeartbeatTTL(cfg.coordinatorTTL),
	)
	if err := c.Join(ctx); err != nil {
		return fmt.Errorf("coordinator join: %w", err)
	}
	deps.shardFilter.SetMatcher(coordinator.NewRingShardFilter(c.Ring(), podName))
	deps.coordinator = c

	go func() {
		for range c.Events() {
			deps.shardFilter.SetMatcher(coordinator.NewRingShardFilter(c.Ring(), podName))
		}
	}()

	setupLog.Info("Coordinator started",
		"pod", podName,
		"redis", redisAddr,
		"heartbeat", cfg.coordinatorHeartbeat,
		"ttl", cfg.coordinatorTTL,
	)
	return nil
}

func buildOperatorManagerAndServer(cfg *cliConfig, scheme *runtime.Scheme, setupLog logr.Logger) (ctrl.Manager, error) {
	tlsOpts := buildOperatorTLSOptions(cfg.enableHTTP2, setupLog)
	webhookServer := buildOperatorWebhookServer(tlsOpts, cfg.webhookCertPath, cfg.webhookCertName, cfg.webhookCertKey, setupLog)
	metricsServerOptions := buildOperatorMetricsOptions(tlsOpts, cfg.metricsAddr, cfg.metricsCertPath, cfg.metricsCertName, cfg.metricsCertKey, cfg.secureMetrics, setupLog)
	return buildOperatorManager(cfg, scheme, &metricsServerOptions, webhookServer)
}

// negotiateProtobuf is defined in cmd/protobuf.go (shared across modes).

func newOperatorGovernance(mgr ctrl.Manager, cfg *cliConfig, setupLog logr.Logger) (operatorGovernance, error) {
	authCfg := buildAuthConfig(cfg.authEnabled, cfg.authBasicUsername, cfg.authBasicPassword, cfg.authBasicPasswordHash,
		cfg.authOIDCIssuerURL, cfg.authOIDCClientID, cfg.authOIDCClientSecret, cfg.authTokenSecret, cfg.authRBACRules, setupLog)

	resolver := governance.NewProjectResolver(mgr.GetClient())
	projectValidator := governance.NewProjectValidator(resolver, governance.NewClusterResolver(mgr.GetClient()), mgr.GetRESTMapper())
	policyEvaluator := governance.NewPolicyEvaluator(mgr.GetClient())

	authz, err := buildOperatorAuthorizer(authCfg, mgr.GetClient())
	if err != nil {
		return operatorGovernance{}, fmt.Errorf("build operator authorizer: %w", err)
	}

	mgrCfg := mgr.GetConfig()
	negotiateProtobuf(mgrCfg)
	k8sClient, err := kubernetes.NewForConfig(mgrCfg)
	if err != nil {
		return operatorGovernance{}, fmt.Errorf("failed to create kubernetes clientset: %w", err)
	}

	rateLimiter := ratelimit.NewControllerRateLimit()
	setupLog.Info("Rate limiting enabled", "globalRate", 100, "perAppRate", 10, "perSourceRate", 5)

	return operatorGovernance{
		authCfg:          authCfg,
		authz:            authz,
		k8sClient:        k8sClient,
		projectValidator: projectValidator,
		policyEvaluator:  policyEvaluator,
		rateLimiter:      rateLimiter,
	}, nil
}

func buildOperatorManager(cfg *cliConfig, scheme *runtime.Scheme, metricsOpts *metricsserver.Options, webhookSrv webhook.Server) (ctrl.Manager, error) {
	restCfg := ctrl.GetConfigOrDie()
	restCfg.QPS = 50
	restCfg.Burst = 100

	leaderElect := cfg.enableLeaderElection
	if cfg.coordinatorMode {
		leaderElect = false
	}

	mgr, err := ctrl.NewManager(restCfg, ctrl.Options{
		Scheme:                 scheme,
		Metrics:                *metricsOpts,
		WebhookServer:          webhookSrv,
		HealthProbeBindAddress: cfg.probeAddr,
		LeaderElection:         leaderElect,
		LeaderElectionID:       "paprika-operator.paprika.io",
		Cache: crcache.Options{
			SyncPeriod: ptr.To(time.Hour),
		},
		Controller: config.Controller{
			CacheSyncTimeout: cfg.cacheSyncTimeout,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to start manager: %w", err)
	}
	return mgr, nil
}

func buildOperatorAuthorizer(cfg auth.Config, c client.Client) (auth.Authorizer, error) {
	if !cfg.Enabled {
		return nil, nil
	}
	authz, err := auth.BuildAuthorizer(cfg, c)
	if err != nil {
		return nil, fmt.Errorf("build authorizer: %w", err)
	}
	return authz, nil
}

func registerDefaultProjectBootstrap(mgr ctrl.Manager, operatorNamespace string) error {
	if err := mgr.Add(manager.RunnableFunc(func(ctx context.Context) error {
		// Run bootstrapping in a goroutine so that manager startup is not blocked
		// while waiting for the local webhook endpoints to become reachable.
		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			bootstrapDefaultProjects(ctx, mgr.GetClient(), operatorNamespace)
		}()
		<-ctx.Done()
		wg.Wait()
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
			if apierrors.IsNotFound(err) {
				log.Info("Skipping default AppProject bootstrap because namespace is missing", "namespace", ns)
				return true, nil
			}
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

func startOperatorUIServer(ctx context.Context, mgr ctrl.Manager, cfg *cliConfig, k8sClient kubernetes.Interface, authCfg auth.Config, projectValidator *governance.ProjectValidator, policyEvaluator *governance.PolicyEvaluator, authz auth.Authorizer, broker *events.Broker, fleetReader fleet.Reader, auditEnabled bool, setupLog logr.Logger) error {
	uiServer, err := buildOperatorUI(ctx, mgr, cfg, k8sClient, authCfg, projectValidator, policyEvaluator, authz, broker, fleetReader, auditEnabled, setupLog)
	if err != nil {
		return fmt.Errorf("build operator UI server: %w", err)
	}
	go func() {
		if srvErr := runHTTPServer(ctx, uiServer, "UI server", setupLog, nil, true); srvErr != nil {
			setupLog.Error(srvErr, "UI server exited with error")
		}
	}()
	return nil
}

func startInlineWebhookServer(ctx context.Context, c client.Client, webhookSecret string, setupLog logr.Logger) error {
	webhookSrv := buildInlineWebhookServer(c, webhookSecret)
	go func() {
		if srvErr := runHTTPServer(ctx, webhookSrv, "inline webhook receiver", setupLog, nil, true); srvErr != nil {
			setupLog.Error(srvErr, "Inline webhook receiver exited with error")
		}
	}()
	return nil
}

func buildInlineWebhookServer(c client.Client, secret string) *http.Server {
	handler := webhookreceiver.NewHandler(c, secret)
	webhookMux := http.NewServeMux()
	webhookMux.Handle("/webhook", handler)
	return &http.Server{
		Addr:              ":8080",
		Handler:           webhookMux,
		ReadHeaderTimeout: 10 * time.Second,
	}
}

func buildOperatorUI(ctx context.Context, mgr ctrl.Manager, cfg *cliConfig, k8sClient kubernetes.Interface, authCfg auth.Config, projectValidator *governance.ProjectValidator, policyEvaluator *governance.PolicyEvaluator, authz auth.Authorizer, broker *events.Broker, fleetReader fleet.Reader, auditEnabled bool, setupLog logr.Logger) (*http.Server, error) {
	authInterceptor, err := auth.Interceptor(ctx, authCfg, mgr.GetClient())
	if err != nil {
		return nil, fmt.Errorf("failed to build auth interceptor: %w", err)
	}

	opts := []apiserver.ServerOption{
		apiserver.WithGovernanceValidator(projectValidator),
		apiserver.WithGovernancePolicyEvaluator(policyEvaluator),
		apiserver.WithFleetIndex(fleetReader),
	}
	if authz != nil {
		opts = append(opts, apiserver.WithAuthorizer(authz))
	}
	if auditEnabled {
		opts = append(opts, apiserver.WithAuditor(audit.NewLogAuditor()))
	}
	opts = append(opts, apiserver.WithK8sClient(k8sClient))
	if dc, dErr := dynamic.NewForConfig(mgr.GetConfig()); dErr == nil {
		opts = append(opts, apiserver.WithDynamicClient(dc))
	}
	opts = append(opts, apiserver.WithRESTMapper(mgr.GetRESTMapper()))
	paprikaServer := apiserver.NewPaprikaServer(mgr.GetClient(), broker, opts...)

	otelInterceptor, err := otelconnect.NewInterceptor()
	if err != nil {
		return nil, fmt.Errorf("otelconnect interceptor: %w", err)
	}

	const maxMsgBytes = 10 * 1024 * 1024 // 10 MiB
	_, connectHandler := v1connect.NewPaprikaServiceHandler(paprikaServer,
		connect.WithInterceptors(otelInterceptor, authInterceptor, paprikaServer.AuditInterceptor()),
		connect.WithReadMaxBytes(maxMsgBytes),
	)

	uiMux := http.NewServeMux()
	uiMux.Handle("/paprika.v1.PaprikaService/", connectHandler)
	uiMux.Handle("/events", apiserver.NewSSEHandler(paprikaServer.Broker()))
	uiMux.Handle("/healthz", healthzHandler(setupLog))
	uiMux.Handle("/readyz", readinessHandler(setupLog, fleetReadyChecker(fleetReader)))
	githubExchangeHandlers, err := buildGitHubActionsTokenExchangeHandlers(ctx, cfg, k8sClient)
	if err != nil {
		return nil, err
	}
	for _, h := range githubExchangeHandlers {
		h(uiMux)
	}
	uiHandler, err := apiserver.UIHandler()
	if err != nil {
		return nil, fmt.Errorf("build UI handler: %w", err)
	}
	uiMux.Handle("/", uiHandler)

	return &http.Server{
		Addr:              cfg.uiAddr,
		Handler:           otelhttp.NewHandler(apiserver.MetricsMiddleware(uiMux), "paprika-http"),
		ReadHeaderTimeout: 10 * time.Second,
	}, nil
}

func buildOperatorTLSOptions(enableHTTP2 bool, setupLog logr.Logger) []func(*tls.Config) {
	if enableHTTP2 {
		return nil
	}
	setupLog.Info("Disabling HTTP/2")
	return []func(*tls.Config){func(c *tls.Config) {
		c.NextProtos = []string{"http/1.1"}
	}}
}

func buildOperatorWebhookServer(tlsOpts []func(*tls.Config), certPath, certName, certKey string, setupLog logr.Logger) webhook.Server {
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

func buildOperatorMetricsOptions(tlsOpts []func(*tls.Config), bindAddr, certPath, certName, certKey string, secure bool, setupLog logr.Logger) metricsserver.Options {
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

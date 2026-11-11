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
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/rest"
	ctrl "sigs.k8s.io/controller-runtime"
	crcache "sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	"github.com/go-logr/logr"

	apiserver "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/audit"
	"github.com/benebsworth/paprika/internal/cache"
	"github.com/benebsworth/paprika/internal/clusterconfig"
	observecontroller "github.com/benebsworth/paprika/internal/controller/observe"
	"github.com/benebsworth/paprika/internal/httpx"
	"github.com/benebsworth/paprika/internal/observability"
	"github.com/benebsworth/paprika/internal/observabilitygateway"
)

// observabilityGatewayRoutePrefix is the mount root of the gateway's public
// surface: the MCP protocol endpoint is served at <prefix>/mcp, the OAuth
// endpoints (authorize, consent, token, register, well-known metadata) at
// <prefix>/…, and the embedded consent page at <prefix>/consent. It is a path
// prefix on the deployment's shared public hostname (the api-server keeps
// serving /mcp there), so no separate DNS name or TLS identity is needed.
const observabilityGatewayRoutePrefix = "/observe"

// runObservabilityGatewayMode runs the observability gateway: the MCP
// surface for querying observability backends (logs, metrics, traces)
// through ObservabilityProvider CRs. It is its own microservice — nothing
// here joins the console's Connect chain; the thirteen registered tools close
// over the connector backend and the MCP server verifies the
// paprika-observability audience so console or fleet-MCP tokens can never be
// replayed against this surface.
func runObservabilityGatewayMode(ctx context.Context, cfg *cliConfig, scheme *runtime.Scheme, setupLog logr.Logger) error {
	capacity, err := prepareObservabilityGateway(cfg, setupLog)
	if err != nil {
		return err
	}
	authCfg := buildAuthConfig(cfg.AuthEnabled, cfg.AuthBasicUsername, cfg.AuthBasicPassword, cfg.AuthBasicPasswordHash,
		cfg.AuthOIDCIssuerURL, cfg.AuthOIDCClientID, cfg.AuthOIDCClientSecret, cfg.AuthOIDCRedirectURL,
		cfg.AuthTokenSecret, cfg.AuthRBACRules, setupLog)

	cacheClient, err := newCacheFromConfig(ctx, cfg.cacheConfig(), setupLog)
	if err != nil {
		return fmt.Errorf("create cache: %w", err)
	}
	defer func() {
		if closeErr := cacheClient.Close(); closeErr != nil {
			setupLog.Error(closeErr, "Failed to close cache")
		}
	}()

	restCfg, err := ctrl.GetConfig()
	if err != nil {
		return fmt.Errorf("get k8s config: %w", err)
	}
	// Every gateway query fans into a Kubernetes read (the provider CR, plus
	// the credentials Secret when one is referenced), so the controller's
	// 50-QPS client ceiling throttles the gateway below its serving
	// capacity. A 200-QPS budget matches the MCP per-subject ceiling the
	// gateway is sized for (50 rps × a small fleet of clients).
	k8sClient, err := client.New(clusterconfig.WithRateLimits(negotiateProtobuf(restCfg), 200, 400), client.Options{Scheme: scheme})
	if err != nil {
		return fmt.Errorf("create k8s client: %w", err)
	}
	k8sClient = namespaceScopedAPIClient(k8sClient, cfg.APINamespace)

	srv, authenticator, usage, backend, err := buildObservabilityServer(ctx, cfg, authCfg, k8sClient, cacheClient, capacity.Budget)
	if err != nil {
		return err
	}

	gwCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Provider discovery rides in the gateway itself, not the pipeline
	// manager: an annotated Service should register its backend even on
	// deployments where only this microservice is installed. The manager is
	// single-replica like the rest of the gateway (leader election is off,
	// matching --leader-elect's default and the chart's RBAC), its metrics
	// listener is disabled because the gateway's own metrics server owns
	// that port, and an async exit cancels the gateway: discovery silently
	// gone while queries still serve is the failure mode this avoids.
	if cfg.ObservabilityDiscoveryEnabled {
		if err := startObservabilityProviderDiscovery(gwCtx, cancel, restCfg, scheme, cfg.APINamespace); err != nil {
			return err
		}
	}

	// The status prober is the writer behind the provider board's STATE
	// column: it re-runs the catalog's per-type health probe against every
	// registered provider on --obs-provider-probe-interval and patches the
	// verdict (state, fixed-sentence reason, observedGeneration, Ready
	// condition) onto each CR's status, so `kubectl get observabilityproviders`
	// and the console show reachability without anyone running a query. It
	// rides the gateway's own client and identity (the gateway pod already
	// holds the observabilityproviders/status RBAC rule), and a zero interval
	// disables status writes entirely.
	if cfg.ObsProviderProbeInterval > 0 {
		prober := observabilitygateway.NewStatusProber(k8sClient,
			observabilitygateway.WithProbeInterval(cfg.ObsProviderProbeInterval))
		go prober.Run(gwCtx)
		setupLog.Info("Provider status prober started", "interval", cfg.ObsProviderProbeInterval.String())
	}

	telemetry := observability.NewTelemetry(gwCtx, observability.ConfigFromEnv())
	defer func() { _ = telemetry.Shutdown(gwCtx) }() //nolint:errcheck // shutdown in defer; error is best-effort
	startGatewaySupportServers(gwCtx, ctx, cfg, setupLog)

	mux := buildObservabilityMux(srv, authenticator, cfg.MCPPublicURL, usage, backend)
	return serveGatewayHTTP(gwCtx, cfg, mux, capacity.Pools)
}

func startObservabilityProviderDiscovery(ctx context.Context, cancel context.CancelFunc, restCfg *rest.Config, scheme *runtime.Scheme, namespace string) error {
	discoveryMgr, err := ctrl.NewManager(clusterconfig.WithRateLimits(negotiateProtobuf(restCfg), 50, 100), ctrl.Options{
		Scheme: scheme, Metrics: metricsserver.Options{BindAddress: "0"},
		Cache: crcache.Options{DefaultNamespaces: apiCacheNamespaceOptions(namespace)},
	})
	if err != nil {
		return fmt.Errorf("create provider-discovery manager: %w", err)
	}
	if err := (&observecontroller.ProviderDiscoveryReconciler{}).SetupWithManager(discoveryMgr); err != nil {
		return fmt.Errorf("setup provider-discovery controller: %w", err)
	}
	go func() {
		if mgrErr := discoveryMgr.Start(ctx); mgrErr != nil {
			log.FromContext(ctx).Error(mgrErr, "Provider-discovery manager exited with error")
			cancel()
		}
	}()
	return nil
}

// prepareObservabilityGateway checks the gateway's startup configuration and
// resolves its query-path capacity, logging the resolved values so an operator
// can read them from the pod log.
func prepareObservabilityGateway(cfg *cliConfig, setupLog logr.Logger) (observabilityCapacity, error) {
	if err := validateObservabilityGatewayConfig(cfg); err != nil {
		return observabilityCapacity{}, err
	}
	capacity, err := resolveObservabilityCapacity(cfg)
	if err != nil {
		return observabilityCapacity{}, err
	}
	setupLog.Info("Observability gateway capacity",
		"queryConcurrency", capacity.Budget.Concurrency,
		"queryProviderConcurrency", capacity.Budget.ProviderConcurrency,
		"queryQueue", capacity.Budget.Queue,
		"queryProviderQueue", capacity.Budget.ProviderQueue,
		"queryQueueWait", capacity.Budget.QueueWait.String(),
		"httpWorkSlots", capacity.Pools.Work,
		"httpCatalogSlots", capacity.Pools.Catalog,
		"httpDashboardSlots", capacity.Pools.Dashboards,
		"httpIntakeSlots", capacity.Pools.Intake,
		"httpAdmissionWait", capacity.Pools.AdmissionWait.String())
	return capacity, nil
}

// observabilityCapacity is the execution budget and HTTP admission pools the
// gateway starts with, resolved from the flags.
type observabilityCapacity struct {
	Budget observabilitygateway.BudgetConfig
	Pools  observabilityHTTPPools
}

// resolveObservabilityCapacity derives the budget and pools from the flags and
// rejects values that cannot work. A pool flag of 0 follows the budget, so the
// two layers stay in step when an operator raises one of them. Each error names
// the flag to change. The function is pure, so the gateway calls it on startup
// and again where it builds the server.
//
//nolint:cyclop // One ordered list of flag checks; splitting it would scatter the messages.
func resolveObservabilityCapacity(cfg *cliConfig) (observabilityCapacity, error) {
	budget := observabilitygateway.BudgetConfig{
		Concurrency:         cfg.ObsQueryConcurrency,
		ProviderConcurrency: cfg.ObsQueryProviderConcurrency,
		Queue:               cfg.ObsQueryQueue,
		ProviderQueue:       cfg.ObsQueryProviderQueue,
		QueueWait:           cfg.ObsQueryQueueWait,
	}
	if budget.Concurrency < 1 {
		return observabilityCapacity{}, fmt.Errorf("--observability-query-concurrency must be >= 1, got %d", budget.Concurrency)
	}
	if budget.ProviderConcurrency == 0 {
		budget.ProviderConcurrency = min(2, budget.Concurrency)
	}
	if budget.ProviderConcurrency < 1 || budget.ProviderConcurrency > budget.Concurrency {
		return observabilityCapacity{}, fmt.Errorf("--observability-query-provider-concurrency must be between 1 and --observability-query-concurrency (%d), got %d; use 0 for min(2, concurrency)", budget.Concurrency, cfg.ObsQueryProviderConcurrency)
	}
	if budget.Queue < 0 {
		return observabilityCapacity{}, fmt.Errorf("--observability-query-queue must be >= 0, got %d", budget.Queue)
	}
	if budget.ProviderQueue < 0 || budget.ProviderQueue > budget.Queue {
		return observabilityCapacity{}, fmt.Errorf("--observability-query-provider-queue must be between 0 and --observability-query-queue (%d), got %d", budget.Queue, budget.ProviderQueue)
	}
	if budget.QueueWait <= 0 || budget.QueueWait >= observabilitygateway.RequestTimeout {
		return observabilityCapacity{}, fmt.Errorf("--observability-query-queue-wait must be > 0 and below the %s request timeout, got %s", observabilitygateway.RequestTimeout, budget.QueueWait)
	}

	pools, err := resolveObservabilityHTTPPools(cfg, budget)
	if err != nil {
		return observabilityCapacity{}, err
	}
	return observabilityCapacity{Budget: budget, Pools: pools}, nil
}

// validateObservabilityHTTPFlags rejects negative pool sizes and an admission
// wait that is negative or longer than the budget's queue wait.
func validateObservabilityHTTPFlags(cfg *cliConfig, budget observabilitygateway.BudgetConfig) error {
	explicit := []struct {
		flag  string
		value int
	}{
		{"observability-http-work-slots", cfg.ObsHTTPWorkSlots},
		{"observability-http-catalog-slots", cfg.ObsHTTPCatalogSlots},
		{"observability-http-dashboard-slots", cfg.ObsHTTPDashboardSlots},
		{"observability-http-intake-slots", cfg.ObsHTTPIntakeSlots},
	}
	for _, e := range explicit {
		if e.value < 0 {
			return fmt.Errorf("--%s must be >= 0 (0 follows the execution budget), got %d", e.flag, e.value)
		}
	}
	if cfg.ObsHTTPAdmissionWait < 0 {
		return fmt.Errorf("--observability-http-admission-wait must be >= 0, got %s", cfg.ObsHTTPAdmissionWait)
	}
	if cfg.ObsHTTPAdmissionWait > budget.QueueWait {
		return fmt.Errorf("--observability-http-admission-wait (%s) must not exceed --observability-query-queue-wait (%s): waiting at the edge longer than the budget would queue is wasted", cfg.ObsHTTPAdmissionWait, budget.QueueWait)
	}
	return nil
}

// resolveObservabilityHTTPPools sizes the HTTP admission pools from the budget.
// The work pool is the budget's admission capacity, its concurrency plus its
// queue, so every request the budget can hold can reach it. A pool larger than
// that would only move the 429 from the budget to the edge. The dashboard
// pool is capped by the budget's concurrency.
func resolveObservabilityHTTPPools(cfg *cliConfig, budget observabilitygateway.BudgetConfig) (observabilityHTTPPools, error) {
	if err := validateObservabilityHTTPFlags(cfg, budget); err != nil {
		return observabilityHTTPPools{}, err
	}
	pools := observabilityHTTPPools{
		Work:          cfg.ObsHTTPWorkSlots,
		Catalog:       cfg.ObsHTTPCatalogSlots,
		Dashboards:    cfg.ObsHTTPDashboardSlots,
		Intake:        cfg.ObsHTTPIntakeSlots,
		AdmissionWait: cfg.ObsHTTPAdmissionWait,
	}
	if pools.Work == 0 {
		pools.Work = budget.Concurrency
	}
	if pools.Catalog == 0 {
		pools.Catalog = pools.Work
	}
	if pools.Dashboards == 0 {
		pools.Dashboards = budget.ProviderConcurrency
	}
	if pools.Intake == 0 {
		pools.Intake = 2 * pools.Work
	}

	admission := budget.Concurrency + budget.Queue
	if pools.Work > admission {
		return observabilityHTTPPools{}, fmt.Errorf("--observability-http-work-slots (%d) exceeds the execution budget's admission capacity (%d = --observability-query-concurrency %d + --observability-query-queue %d)", pools.Work, admission, budget.Concurrency, budget.Queue)
	}
	if pools.Dashboards > budget.Concurrency {
		return observabilityHTTPPools{}, fmt.Errorf("--observability-http-dashboard-slots (%d) must not exceed --observability-query-concurrency (%d)", pools.Dashboards, budget.Concurrency)
	}
	largest := max(pools.Work, pools.Catalog, pools.Dashboards)
	if pools.Intake < largest {
		return observabilityHTTPPools{}, fmt.Errorf("--observability-http-intake-slots (%d) must be at least the largest pool (%d), or body classification refuses requests the pools could admit", pools.Intake, largest)
	}
	return pools, nil
}

// validateObservabilityGatewayConfig fails fast, with the same loudness the
// api-server's MCP config validation uses, on the flags the gateway cannot
// start without: public issuer metadata and authentication remain required.
// Static OAuth configuration may be fully absent for DCR-only operation, and
// auth must be enabled because the authorize/consent surface authenticates
// console users — the alternative would be minting observability tokens for
// anyone.
func validateObservabilityGatewayConfig(cfg *cliConfig) error {
	if err := validateAPINamespace(cfg.APINamespace); err != nil {
		return err
	}
	if cfg.MCPPublicURL == "" {
		return errors.New("observability-gateway: --mcp-public-url is required; it is embedded in RFC 9728/8414 discovery metadata and used as the minted token's issuer")
	}
	if cfg.MCPOAuthClientID == "" && len(cfg.MCPOAuthRedirectURIs) > 0 {
		return errors.New("observability-gateway: --mcp-oauth-client-id is required")
	}
	if len(cfg.MCPOAuthRedirectURIs) == 0 && cfg.MCPOAuthClientID != "" {
		return errors.New("observability-gateway: --mcp-oauth-redirect-uris is required")
	}
	if !cfg.AuthEnabled {
		return errors.New("observability-gateway: --auth-enabled=true is required; the OAuth authorize/consent surface authenticates console users and refuses to run unauthenticated")
	}
	return nil
}

// startGatewaySupportServers brings up the per-mode companions every runner
// in this binary shares: the kubelet health listener, the metrics endpoint,
// and pprof. gwCtx bounds the health server; ctx bounds metrics/pprof, which
// follow the other modes' lifetime convention.
func startGatewaySupportServers(gwCtx, ctx context.Context, cfg *cliConfig, setupLog logr.Logger) {
	healthMux := buildHealthMux(setupLog, healthz.Ping)
	healthSrv := buildHealthProbeServer(healthMux, cfg.ProbeAddr)
	go func() {
		if srvErr := runHTTPServer(gwCtx, healthSrv, "health probe server", setupLog, nil, false, 0); srvErr != nil {
			setupLog.Error(srvErr, "Health probe server exited with error")
		}
	}()
	startMetricsServer(ctx, cfg.MetricsAddr, setupLog)
	startPprofServer(ctx, cfg.PprofAddr, setupLog)
}

// serveGatewayHTTP runs the gateway's public listener until gwCtx ends:
// prior-knowledge h2c on the UI address, optional mTLS via the shared
// PAPRIKA_TLS_CERT/PAPRIKA_TLS_KEY serving config (repo-server precedent).
func serveGatewayHTTP(gwCtx context.Context, cfg *cliConfig, handler http.Handler, pools observabilityHTTPPools) error {
	httpSrv := httpx.WithH2C(&http.Server{
		Addr:              cfg.UIAddr,
		Handler:           limitObservabilityProtocolRequestsWith(handler, pools),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      45 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    apiServerMaxHeaderBytes,
	})
	log.FromContext(gwCtx).Info("Starting observability gateway", "addr", cfg.UIAddr, "publicURL", cfg.MCPPublicURL, "routePrefix", observabilityGatewayRoutePrefix)
	// Use the shared listener so the gateway honors --api-max-conns and
	// drains accepted requests during shutdown, just like the API server.
	return runHTTPServer(gwCtx, httpSrv, "observability gateway", log.FromContext(gwCtx), nil, true, cfg.APIMaxConns)
}

// limitObservabilityProtocolRequests applies the built-in pool sizes with no
// admission wait. Production uses limitObservabilityProtocolRequestsWith and
// the configured pools.
func limitObservabilityProtocolRequests(next http.Handler) http.Handler {
	return limitObservabilityProtocolRequestsWith(next, defaultObservabilityHTTPPools())
}

// Keep the request slot through serialization and the final response write.
// The backend's I/O budget alone releases too early to bound large responses
// retained by slow clients. Metadata and health remain available under load.
// Each pool waits at most pools.AdmissionWait before it answers 429, so a short
// burst is absorbed here and a sustained one still fails fast.
func limitObservabilityProtocolRequestsWith(next http.Handler, pools observabilityHTTPPools) http.Handler {
	active := make(chan struct{}, pools.Work)
	catalog := make(chan struct{}, pools.Catalog)
	// Dashboard orchestration waits on nested data-tool requests. Giving it a
	// separate small pool leaves data slots available and bounds aggregate work.
	dashboards := make(chan struct{}, pools.Dashboards)
	// Bound body classification too: a slow MCP upload must not allocate an
	// unbounded number of readers before it reaches a work pool.
	intake := make(chan struct{}, pools.Intake)
	wait := pools.AdmissionWait
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isObservabilityProtocolRequest(r) {
			next.ServeHTTP(w, r)
			return
		}
		if !admitObservabilityRequest(r.Context(), w, intake, wait) {
			return
		}
		defer func() { <-intake }()
		slots := active
		requestClass := classifyObservabilityProtocolRequest(r)
		switch requestClass {
		case observabilityWorkRequest:
			slots = active
		case observabilityCatalogRequest:
			slots = catalog
		case observabilityDashboardRequest:
			slots = dashboards
		}
		if !admitObservabilityRequest(r.Context(), w, slots, wait) {
			return
		}
		defer func() { <-slots }()
		// Oversized or unclassifiable envelopes may still contain valid small
		// query_dashboard arguments. They must not orchestrate nested work while
		// holding a data-work slot; the tool checks this trusted context marker.
		r = r.WithContext(observabilitygateway.WithDashboardQueryAdmission(r.Context(), requestClass == observabilityDashboardRequest))
		next.ServeHTTP(w, r)
	})
}

// buildObservabilityServer assembles the MCP server and its collaborators:
// the connector backend + tool registry + usage tracker (tools close over
// the backend; no Connect client is configured — these tools never call the
// console API), the two authenticators (paprika-observability for the
// protocol surface, the console stack for authorize/consent), and the
// /observe-shaped MCP server itself. The authenticator is returned alongside
// the server because the usage endpoint mounts on the same mux and must
// verify the same audience.
//
//nolint:cyclop // The gateway constructor assembles and validates its independent collaborators.
func buildObservabilityServer(ctx context.Context, cfg *cliConfig, authCfg auth.Config, k8sClient client.Client, cacheClient *cache.Cache, budget observabilitygateway.BudgetConfig) (*mcp.Server, *auth.SelfSignedAuthenticator, *observabilitygateway.UsageTracker, observabilitygateway.Backend, error) {
	if len(authCfg.TokenSecret) == 0 {
		return nil, nil, nil, nil, errors.New("observability-gateway: a non-empty auth token secret is required (PAPRIKA_AUTH_TOKEN_SECRET); paprika-observability tokens are HMAC-signed with the same secret the console's self-signed authenticator uses")
	}
	if cfg.MCPSessionSecret != "" || cfg.MCPSessionNamespace != "" {
		persistent, err := newMCPSessionCache(ctx, cfg, k8sClient, observabilityGatewayRoutePrefix+"/mcp", authCfg.TokenSecret)
		if err != nil {
			return nil, nil, nil, nil, err
		}
		cacheClient = persistent
	}
	// Provider CRs select a cloud project and may reference credentials. OAuth
	// scope alone must never grant every principal the gateway service account's
	// Kubernetes/cloud visibility. Namespace access follows explicit RBAC;
	// an empty rule set denies access rather than the project compatibility
	// authorizer's empty-project allowance.
	backend := observabilitygateway.NewAuthorizedBackendWithBudget(k8sClient, auth.NewRBACAuthorizer(authCfg.RBACRules), budget)
	registry := mcp.NewRegistry()
	usage := observabilitygateway.NewUsageTracker()
	if err := observabilitygateway.RegisterTools(registry, backend, usage); err != nil {
		return nil, nil, nil, nil, fmt.Errorf("register observability tools: %w", err)
	}
	authenticator, err := auth.NewSelfSignedAuthenticatorForAudience(authCfg.TokenSecret, mcp.ObservabilityTokenAudience, cfg.MCPPublicURL)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("build authenticator: %w", err)
	}
	consoleAuthenticator, err := auth.BuildAuthenticator(ctx, authCfg)
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("build console authenticator: %w", err)
	}
	var auditor audit.Auditor = audit.NoopAuditor{}
	if cfg.AuditLogEnabled {
		auditor = audit.NewLogAuditor()
	}
	supportedScopes, err := registerObservabilityInsights(ctx, registry, usage, authCfg, cfg.MCPPublicURL, auditor)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	clientRegistry, err := newMCPClientRegistry(ctx, cfg, k8sClient, observabilityGatewayRoutePrefix+"/mcp")
	if err != nil {
		return nil, nil, nil, nil, err
	}
	srv, err := mcp.NewServer(mcp.ServerConfig{
		Registry:                     registry,
		Authenticator:                authenticator,
		ConsoleAuthenticator:         consoleAuthenticator,
		Confirmer:                    mcp.NewConfirmer(cacheClient, mcpConfirmationTTL),
		Auditor:                      auditor,
		Cache:                        cacheClient,
		Secret:                       authCfg.TokenSecret,
		PublicURL:                    cfg.MCPPublicURL,
		ClientID:                     cfg.MCPOAuthClientID,
		RedirectURIs:                 cfg.MCPOAuthRedirectURIs,
		AllowDynamicRegistrationOnly: cfg.MCPOAuthClientID == "" && len(cfg.MCPOAuthRedirectURIs) == 0,
		AccessTTL:                    cfg.MCPAccessTokenTTL,
		RefreshTTL:                   cfg.MCPRefreshTokenTTL,
		DynamicClientRegistry:        clientRegistry,
		RoutePrefix:                  observabilityGatewayRoutePrefix,
		ProtocolPath:                 observabilityGatewayRoutePrefix + "/mcp",
		Audience:                     mcp.ObservabilityTokenAudience,
		SupportedScopes:              supportedScopes,
		DisableConsoleResources:      true,
		LinkRequestCancellation:      true,
		// Query tool results are large, highly repetitive JSON; level 3 keeps
		// most of the ratio while cutting the flate CPU several-fold at the
		// gateway's fan-out rates.
		GzipLevel: 3,
		// No Client: these tools close over the connector backend and never
		// call the console Connect API.
	})
	if err != nil {
		return nil, nil, nil, nil, fmt.Errorf("build mcp server: %w", err)
	}
	return srv, authenticator, usage, backend, nil
}

// buildObservabilityMux mounts the gateway's public surface on one mux: the
// MCP protocol handler, the OAuth routes (authorize/consent/token/register +
// prefixed well-known metadata), the embedded consent page, the console's
// API endpoints (the usage tracker snapshot, the provider-type catalog and
// the prospective-provider validate probe — all three behind the shared
// RequireObserveScope middleware, so no statistic, catalog entry or probe
// result is readable with a weaker credential than the tools it supports),
// and /healthz on the serve port (repo-server precedent) so load-balancer
// checks and port-forward-based e2e setups can probe it; the kubelet keeps
// using the dedicated health listener.
func buildObservabilityMux(srv *mcp.Server, authenticator *auth.SelfSignedAuthenticator, publicURL string, usage *observabilitygateway.UsageTracker, backend observabilitygateway.Backend) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle(observabilityGatewayRoutePrefix+"/mcp", srv.Handler())
	srv.RegisterOAuthRoutes(mux)
	mux.Handle(observabilityGatewayRoutePrefix+"/consent", observabilitygateway.ConsentHandler(observabilityGatewayRoutePrefix))
	// The console API endpoints answer the observability management page:
	// the usage board, the provider-type library browser and the onboarding
	// wizard's validation probe. All three are protected exactly like the
	// MCP protocol surface — same authenticator, same audience, then a
	// ScopeObserve requirement.
	gatewayAPI := observabilitygateway.RequireObserveScope(authenticator, publicURL, observabilityGatewayRoutePrefix)
	mux.Handle("GET "+observabilityGatewayRoutePrefix+"/api/usage", usageHandler(authenticator, publicURL, usage))
	mux.Handle("GET "+observabilityGatewayRoutePrefix+"/api/catalog", gatewayAPI(observabilitygateway.CatalogHandler()))
	mux.Handle("GET "+observabilityGatewayRoutePrefix+"/api/catalog/{type}", gatewayAPI(observabilitygateway.CatalogTypeHandler()))
	mux.Handle("POST "+observabilityGatewayRoutePrefix+"/api/validate", gatewayAPI(observabilitygateway.ValidateHandler()))
	mux.Handle("GET "+observabilityGatewayRoutePrefix+"/api/providers", gatewayAPI(observabilitygateway.DashboardProvidersHandler(backend, usage)))
	mux.Handle("POST "+observabilityGatewayRoutePrefix+"/api/query", gatewayAPI(observabilitygateway.DashboardQueryHandler(backend, usage)))
	mux.Handle("POST "+observabilityGatewayRoutePrefix+"/api/explore", gatewayAPI(observabilitygateway.DashboardExploreHandler(backend, usage)))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		if _, err := w.Write([]byte("ok")); err != nil {
			log.FromContext(r.Context()).Error(err, "Failed to write healthz response")
		}
	})
	return mux
}

// usageError is the RFC 6749-shaped error body the gateway's API endpoints
// answer with on auth failures, as the tests decode it. The dialect itself
// is owned by the observabilitygateway package (its shared
// RequireObserveScope middleware) so the usage, catalog and validate
// endpoints all speak it; the description is a fixed sentence, never
// derived from the authenticator's error text.
//
//nolint:tagliatelle // RFC 6749 mandates these exact snake_case field names.
type usageError struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description,omitempty"`
}

// usageHandler serves GET /observe/api/usage, the tracker's snapshot of
// per-tool call counters the console's observability management page reads.
// Protection is the observabilitygateway package's shared RequireObserveScope
// middleware — same authenticator, same audience, same scope gate as the
// catalog and validate endpoints — so no usage statistic is readable with a
// weaker credential than the tools it describes.
//
// 401 means the bearer token was missing, malformed, wrongly audiences or
// wrongly issued; 403 means it was valid but observe-scoped access was not
// granted. Both answer JSON rather than redirecting, because this endpoint
// serves the console's own fetch, not a browser navigation.
func usageHandler(authenticator *auth.SelfSignedAuthenticator, publicURL string, usage *observabilitygateway.UsageTracker) http.Handler {
	return observabilitygateway.RequireObserveScope(authenticator, publicURL, observabilityGatewayRoutePrefix)(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			writeGatewayJSON(w, http.StatusOK, usage.Snapshot())
		}))
}

// writeGatewayJSON is this package's local writeJSON, modeled on the one in
// internal/api/mcp/oauth.go: one content type, one status, then a
// best-effort body — once the status is written the error cannot be
// recovered anyway.
func writeGatewayJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v) //nolint:errcheck // best-effort: the status/headers are already written
}

// Reuse the UI proxy so OAuth authoring cannot bypass human Insights RBAC or
// access storage with the gateway service account's authority.
func registerObservabilityInsights(ctx context.Context, registry *mcp.Registry, usage *observabilitygateway.UsageTracker, cfg auth.Config, publicURL string, auditor audit.Auditor) ([]mcp.Scope, error) {
	scopes := make([]mcp.Scope, 1, 2)
	scopes[0] = mcp.ScopeObserve
	endpoint := os.Getenv("PAPRIKA_INSIGHTS_URL")
	if endpoint == "" {
		return scopes, nil
	}
	if !cfg.Enabled {
		return nil, errors.New("insights MCP authoring requires authentication")
	}
	proxy, err := apiserver.NewInsightsProxy(ctx, cfg, endpoint, os.Getenv("PAPRIKA_INSIGHTS_TOKEN"), apiserver.InsightsProxyOptions{ObservabilityIssuer: publicURL})
	if err != nil {
		return nil, fmt.Errorf("configure Insights authoring proxy: %w", err)
	}
	authoring, err := observabilitygateway.NewInsightsAuthoringClient(proxy, cfg.TokenSecret, publicURL, auditor)
	if err != nil {
		return nil, fmt.Errorf("configure Insights authoring client: %w", err)
	}
	if err := authoring.ConfigureDashboardRenderer(os.Getenv("PAPRIKA_OBSERVE_RENDER_URL"), os.Getenv("PAPRIKA_OBSERVE_RENDER_SECRET")); err != nil {
		return nil, fmt.Errorf("configure dashboard browser renderer: %w", err)
	}
	if err := observabilitygateway.RegisterInsightsTools(registry, authoring, usage); err != nil {
		return nil, fmt.Errorf("configure Insights authoring tools: %w", err)
	}
	return append(scopes, mcp.ScopeInsightsWrite), nil
}

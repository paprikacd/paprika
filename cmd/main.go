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
	"html"
	"io"
	"net"
	"net/http"
	"net/http/pprof"
	"os"
	"reflect"
	"strings"
	"time"

	"connectrpc.com/connect"
	"connectrpc.com/otelconnect"
	"github.com/go-logr/logr"
	mapstructure "github.com/go-viper/mapstructure/v2"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"github.com/spf13/viper"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"golang.org/x/net/netutil"
	"golang.org/x/sync/errgroup"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/component-base/metrics/legacyregistry"
	_ "k8s.io/component-base/metrics/prometheus/restclient" // emit rest_client_* client-go metrics
	ctrl "sigs.k8s.io/controller-runtime"
	crcache "sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/apiutil"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	crmetrics "sigs.k8s.io/controller-runtime/pkg/metrics"

	"golang.org/x/crypto/bcrypt"

	clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
	corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
	featureflagsv1alpha1 "github.com/benebsworth/paprika/api/featureflags/v1alpha1"
	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
	providersv1alpha1 "github.com/benebsworth/paprika/api/providers/v1alpha1"
	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	agentserver "github.com/benebsworth/paprika/internal/agent/server"
	apiserver "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/events"
	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/audit"
	"github.com/benebsworth/paprika/internal/cache"
	"github.com/benebsworth/paprika/internal/clusterconfig"
	"github.com/benebsworth/paprika/internal/dataprovider"
	"github.com/benebsworth/paprika/internal/fleet"
	"github.com/benebsworth/paprika/internal/governance"
	"github.com/benebsworth/paprika/internal/httpx"
	"github.com/benebsworth/paprika/internal/kube"
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
	defaultCacheSyncTimeout  = 2 * time.Minute
	apiCacheDisabledReason   = "fleet queries are unavailable because --api-cache-enabled=false"

	// apiServerMaxHeaderBytes bounds the request line + header bytes the API
	// server (startAPIServer) will read, including the query string —
	// net/http otherwise defaults this to 1MB. Fix round 3, Finding 1: an
	// unauthenticated GET /mcp/authorize with a huge `state` or `scope`
	// query param used to be bounded only by that 1MB default before ever
	// reaching mcp.redirectToConsent's own (much smaller) length checks;
	// this cuts the window an attacker has to push bytes at the server in
	// the first place. 64KB comfortably covers any legitimate request this
	// server handles (large bearer tokens, cookies, long query strings)
	// while being far below the point where it threatens memory or the
	// shared cache.
	apiServerMaxHeaderBytes = 64 * 1024

	// apiServerIdleTimeout closes keep-alive connections after this much
	// idle time. Required pairing with --api-max-conns: without it, 128
	// clients holding idle keep-alive connections would exhaust every
	// listener slot and starve new connections permanently.
	apiServerIdleTimeout = 90 * time.Second
)

func newScheme() *runtime.Scheme {
	scheme := runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))

	utilruntime.Must(pipelinesv1alpha1.AddToScheme(scheme))
	utilruntime.Must(featureflagsv1alpha1.AddToScheme(scheme))
	utilruntime.Must(clustersv1alpha1.AddToScheme(scheme))
	utilruntime.Must(corev1alpha1.AddToScheme(scheme))
	utilruntime.Must(policyv1alpha1.AddToScheme(scheme))
	utilruntime.Must(providersv1alpha1.AddToScheme(scheme))
	utilruntime.Must(rolloutsv1alpha1.AddToScheme(scheme))
	// +kubebuilder:scaffold:scheme
	return scheme
}

// cliConfig is the app config consumed throughout the binary. Every field is
// populated by the viper mapping in newManagerViper: mapstructure tags name
// the viper key, which is the flag name for flag-backed settings and a
// kebab-case key for env-only settings.
type cliConfig struct {
	MetricsAddr        string `mapstructure:"metrics-bind-address"`
	MetricsCertPath    string `mapstructure:"metrics-cert-path"`
	MetricsCertName    string `mapstructure:"metrics-cert-name"`
	MetricsCertKey     string `mapstructure:"metrics-cert-key"`
	WebhookCertPath    string `mapstructure:"webhook-cert-path"`
	WebhookCertName    string `mapstructure:"webhook-cert-name"`
	WebhookCertKey     string `mapstructure:"webhook-cert-key"`
	ProbeAddr          string `mapstructure:"health-probe-bind-address"`
	UIAddr             string `mapstructure:"ui-bind-address"`
	WebhookAddr        string `mapstructure:"webhook-bind-address"`
	PprofAddr          string `mapstructure:"pprof-bind-address"`
	OperatorNamespace  string `mapstructure:"operator-namespace"`
	Mode               string `mapstructure:"mode"`
	K8sAPIServer       string `mapstructure:"k8s-api-server"`
	K8sTokenFile       string `mapstructure:"k8s-token-file"`
	RepoServerAddr     string `mapstructure:"repo-server-addr"`
	RepoWorkDir        string `mapstructure:"repo-workdir"`
	AgentClusterID     string `mapstructure:"agent-cluster-id"`
	WebhookSecret      string `mapstructure:"webhook-secret"`
	AuthRBACRules      string `mapstructure:"auth-rbac-rules"`
	CacheBackend       string `mapstructure:"cache-backend"`
	CacheRedisAddr     string `mapstructure:"cache-redis-addr"`
	CacheRedisPassword string `mapstructure:"cache-redis-password"`
	CacheRedisDB       int    `mapstructure:"cache-redis-db"`
	ShardID            int    `mapstructure:"shard-id"`
	ShardTotal         int    `mapstructure:"shard-total"`
	ShardIDSource      string `mapstructure:"shard-id-source"`
	APIMaxConns        int    `mapstructure:"api-max-conns"`
	AuditLogEnabled    bool   `mapstructure:"audit-enabled"`

	EnableLeaderElection bool `mapstructure:"leader-elect"`
	SecureMetrics        bool `mapstructure:"metrics-secure"`
	EnableHTTP2          bool `mapstructure:"enable-http2"`
	APICacheEnabled      bool `mapstructure:"api-cache-enabled"`

	CacheSyncTimeout      time.Duration `mapstructure:"cache-sync-timeout"`
	AuthEnabled           bool          `mapstructure:"auth-enabled"`
	EnableWebhooks        bool          `mapstructure:"enable-webhooks"`
	AuthBasicUsername     string        `mapstructure:"auth-basic-username"`
	AuthBasicPassword     string        `mapstructure:"auth-basic-password"`
	AuthBasicPasswordHash string        `mapstructure:"auth-basic-password-hash"`
	AuthOIDCIssuerURL     string        `mapstructure:"auth-oidc-issuer-url"`
	AuthOIDCClientID      string        `mapstructure:"auth-oidc-client-id"`
	AuthOIDCClientSecret  string        `mapstructure:"auth-oidc-client-secret"`
	AuthOIDCRedirectURL   string        `mapstructure:"auth-oidc-redirect-url"`
	AuthTokenSecret       string        `mapstructure:"auth-token-secret"`

	GitHubActionsTokenExchangeEnabled                 bool          `mapstructure:"github-actions-token-exchange-enabled"`
	GitHubActionsTokenExchangeAudience                string        `mapstructure:"github-actions-token-exchange-audience"`
	GitHubActionsTokenExchangeRepository              string        `mapstructure:"github-actions-token-exchange-repository"`
	GitHubActionsTokenExchangeEnvironment             string        `mapstructure:"github-actions-token-exchange-environment"`
	GitHubActionsTokenExchangeSubject                 string        `mapstructure:"github-actions-token-exchange-subject"`
	GitHubActionsTokenExchangeAllowedEventNames       []string      `mapstructure:"github-actions-token-exchange-allowed-event-names"`
	GitHubActionsTokenExchangeRef                     string        `mapstructure:"github-actions-token-exchange-ref"`
	GitHubActionsTokenExchangeAllowedWorkflowRefs     []string      `mapstructure:"github-actions-token-exchange-allowed-workflow-refs"`
	GitHubActionsTokenExchangeJobWorkflowRef          string        `mapstructure:"github-actions-token-exchange-job-workflow-ref"`
	GitHubActionsTokenExchangeServiceAccountNamespace string        `mapstructure:"github-actions-token-exchange-service-account-namespace"`
	GitHubActionsTokenExchangeServiceAccountName      string        `mapstructure:"github-actions-token-exchange-service-account-name"`
	GitHubActionsTokenExchangeTTL                     time.Duration `mapstructure:"github-actions-token-exchange-token-ttl"`

	CoordinatorMode      bool          `mapstructure:"coordinator-mode"`
	CoordinatorHeartbeat time.Duration `mapstructure:"coordinator-heartbeat"`
	CoordinatorTTL       time.Duration `mapstructure:"coordinator-ttl"`

	AppMaxConcurrentReconciles      int           `mapstructure:"application-max-concurrent-reconciles"`
	ReleaseMaxConcurrentReconciles  int           `mapstructure:"release-max-concurrent-reconciles"`
	StageMaxConcurrentReconciles    int           `mapstructure:"stage-max-concurrent-reconciles"`
	PipelineMaxConcurrentReconciles int           `mapstructure:"pipeline-max-concurrent-reconciles"`
	AppTransientRequeue             time.Duration `mapstructure:"application-transient-requeue"`
	AppSourceResolveTTL             time.Duration `mapstructure:"application-source-resolve-ttl"`
	CacheResyncPeriod               time.Duration `mapstructure:"cache-resync-period"`
	ReconcileGlobalRate             float64       `mapstructure:"reconcile-global-rate"`
	ReconcileGlobalBurst            int           `mapstructure:"reconcile-global-burst"`
	ReconcileAppRate                float64       `mapstructure:"reconcile-app-rate"`
	ReconcileAppBurst               int           `mapstructure:"reconcile-app-burst"`

	MCPEnabled           bool          `mapstructure:"mcp-enabled"`
	MCPBindAddress       string        `mapstructure:"mcp-bind-address"`
	MCPAccessTokenTTL    time.Duration `mapstructure:"mcp-access-token-ttl"`
	MCPRefreshTokenTTL   time.Duration `mapstructure:"mcp-refresh-token-ttl"`
	MCPOAuthClientID     string        `mapstructure:"mcp-oauth-client-id"`
	MCPOAuthRedirectURIs []string      `mapstructure:"mcp-oauth-redirect-uris"`
	MCPPublicURL         string        `mapstructure:"mcp-public-url"`

	// ZapOptions is bound directly by the zap flag set, not through viper.
	ZapOptions zap.Options `mapstructure:"-"`
}

func main() {
	if err := run(ctrl.SetupSignalHandler(), os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		if _, printErr := fmt.Fprintln(os.Stderr, "Failed to start:", err); printErr != nil {
			os.Exit(2)
		}
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	//nolint:contextcheck // ctx reaches start via ExecuteContext -> cmd.Context()
	cmd, _, _ := newManagerCommand(startManager)
	cmd.SetArgs(args)
	cmd.SetIn(stdin)
	cmd.SetOut(stdout)
	cmd.SetErr(stderr)
	if err := cmd.ExecuteContext(ctx); err != nil {
		return fmt.Errorf("execute command: %w", err)
	}
	return nil
}

// newManagerCommand builds the cobra command tree. The root command runs
// --mode dispatch (backward compatible with the pre-cobra invocation); the
// mode subcommands are the same modes expressed idiomatically. All flags are
// persistent on the root so `manager api --metrics-...` parses identically to
// `manager --mode=api --metrics-...`. start is the post-config bootstrap,
// injected so tests can observe the resolved config without booting servers.
func newManagerCommand(start func(context.Context, *cliConfig) error) (*cobra.Command, *cliConfig, *viper.Viper) {
	cfg := &cliConfig{ZapOptions: zap.Options{Development: false}}
	v := newManagerViper()

	root := &cobra.Command{
		Use:           "manager",
		Short:         "Paprika manager — operator, API, webhook, repo-server and agent modes",
		SilenceUsage:  true,
		SilenceErrors: true,
		Args:          cobra.NoArgs,
		PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
			return loadManagerConfig(cmd, v, cfg)
		},
		RunE: func(cmd *cobra.Command, _ []string) error {
			return start(cmd.Context(), cfg)
		},
	}

	registerManagerFlags(root.PersistentFlags(), &cfg.ZapOptions)
	if err := v.BindPFlags(root.PersistentFlags()); err != nil {
		panic(fmt.Errorf("bind flags: %w", err))
	}

	for _, mode := range []string{"operator", "api", "webhook", "repo-server", "agent"} {
		mode := mode
		root.AddCommand(&cobra.Command{
			Use:   mode,
			Short: fmt.Sprintf("Run in %s mode (equivalent to --mode=%s)", mode, mode),
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				cfg.Mode = mode
				return start(cmd.Context(), cfg)
			},
		})
	}
	return root, cfg, v
}

// startManager is the shared post-config bootstrap for every mode.
func startManager(ctx context.Context, cfg *cliConfig) error {
	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&cfg.ZapOptions)))
	setupLog := ctrl.Log.WithName("setup")
	scheme := newScheme()

	if err := metrics.RegisterCollectors(crmetrics.Registry); err != nil {
		return fmt.Errorf("register metrics collectors: %w", err)
	}

	return dispatchMode(ctx, cfg, scheme, setupLog)
}

// loadManagerConfig resolves the merged configuration onto cfg. Precedence
// (highest first): explicit flag, environment variable, --config file,
// flag/viper default.
func loadManagerConfig(_ *cobra.Command, v *viper.Viper, cfg *cliConfig) error {
	if configFile := v.GetString("config"); configFile != "" {
		v.SetConfigFile(configFile)
		if err := v.ReadInConfig(); err != nil {
			return fmt.Errorf("read config file %q: %w", configFile, err)
		}
	}
	if err := v.Unmarshal(cfg, viper.DecodeHook(mapstructure.ComposeDecodeHookFunc(
		mapstructure.StringToTimeDurationHookFunc(),
		stringToTrimmedSliceHook(","),
	))); err != nil {
		return fmt.Errorf("decode config: %w", err)
	}
	return nil
}

// stringToTrimmedSliceHook decodes a comma-separated string (from env vars
// or scalar YAML values) into []string, trimming whitespace and dropping
// empty elements — matching the historical commaSeparatedValues behavior.
func stringToTrimmedSliceHook(sep string) mapstructure.DecodeHookFunc {
	return func(from, to reflect.Type, data interface{}) (interface{}, error) {
		if from.Kind() != reflect.String ||
			to.Kind() != reflect.Slice || to.Elem().Kind() != reflect.String {
			return data, nil
		}
		raw, ok := data.(string)
		if !ok {
			return data, nil
		}
		if strings.TrimSpace(raw) == "" {
			return []string{}, nil
		}
		var out []string
		for part := range strings.SplitSeq(raw, sep) {
			if part = strings.TrimSpace(part); part != "" {
				out = append(out, part)
			}
		}
		return out, nil
	}
}

// parseManagerConfig is the test-only path: parse args and resolve config
// without executing the command tree (which would start a server).
func parseManagerConfig(args []string, stderr io.Writer) (*cliConfig, error) {
	cmd, cfg, v := newManagerCommand(startManager)
	cmd.SetErr(stderr)
	if err := cmd.ParseFlags(args); err != nil {
		return nil, fmt.Errorf("parse flags: %w", err)
	}
	if err := loadManagerConfig(cmd, v, cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

func dispatchMode(ctx context.Context, cfg *cliConfig, scheme *runtime.Scheme, setupLog logr.Logger) error {
	if err := validateMode(cfg.Mode); err != nil {
		return fmt.Errorf("validate mode: %w", err)
	}
	if err := validateCoordinatorConfig(cfg); err != nil {
		return err
	}
	if err := validateControllerTuning(cfg); err != nil {
		return err
	}

	switch cfg.Mode {
	case "agent":
		return runAgentMode(ctx, cfg.UIAddr, cfg.ProbeAddr, cfg.AgentClusterID, cfg.MetricsAddr, cfg.PprofAddr, setupLog)
	case "repo-server":
		return runRepoServerMode(ctx, cfg.UIAddr, cfg.ProbeAddr, cfg.RepoWorkDir, cfg.MetricsAddr, cfg.PprofAddr, scheme, setupLog, cfg.cacheConfig(), nil, nil)
	case "api":
		return runAPIMode(ctx, cfg, scheme, setupLog, nil)
	case "webhook":
		return runWebhookMode(ctx, cfg, cfg.WebhookAddr, cfg.ProbeAddr, cfg.WebhookSecret, scheme, setupLog, cfg.cacheConfig())
	default:
		return runOperatorMode(ctx, cfg, scheme, setupLog)
	}
}

func (cfg *cliConfig) cacheConfig() cache.Config {
	backend := cfg.CacheBackend
	if backend == "" {
		backend = cache.BackendMemory
	}
	addr := cfg.CacheRedisAddr
	if addr == "" {
		addr = defaultRedisAddr
	}
	return cache.Config{
		Backend:       backend,
		RedisAddr:     addr,
		RedisPassword: cfg.CacheRedisPassword,
		RedisDB:       cfg.CacheRedisDB,
	}
}

func (cfg *cliConfig) shardFilter() *sharding.Filter {
	return sharding.NewFilter(cfg.ShardID, cfg.ShardTotal)
}

func validateMode(mode string) error {
	if mode != "operator" && mode != "api" && mode != "webhook" && mode != "repo-server" && mode != "agent" {
		return fmt.Errorf("invalid mode: %s (must be 'operator', 'api', 'webhook', 'repo-server', or 'agent')", mode)
	}
	return nil
}

// registerControllerTuningFlags exposes reconcile-rate knobs: worker
// concurrency per controller, the transient requeue used by in-flight
// Application states, the informer full-resync period, and the reconcile
// token-bucket limits. Steady-state polling stays per-application via
// spec.source.pollInterval.
func registerControllerTuningFlags(fs *pflag.FlagSet) {
	fs.Int("application-max-concurrent-reconciles", 8,
		"Maximum parallel Application reconciles. Reconciles are cached-read and diff "+
			"dominated; a wider pool drains burst resyncs without queue delay.")
	fs.Int("release-max-concurrent-reconciles", 5,
		"Maximum parallel Release reconciles.")
	fs.Int("stage-max-concurrent-reconciles", 3,
		"Maximum parallel Stage reconciles.")
	fs.Int("pipeline-max-concurrent-reconciles", 3,
		"Maximum parallel Pipeline reconciles.")
	fs.Duration("application-transient-requeue", 5*time.Second,
		"Requeue interval for in-flight Application states (pending, building, releasing) "+
			"and the steady-state poll fallback when spec.source.pollInterval is unset.")
	fs.Duration("application-source-resolve-ttl", time.Minute,
		"How long a source resolve (git fetch) result is reused by the steady-state "+
			"application poll. 0 resolves the source on every poll. Sync triggers "+
			"always bypass the cache.")
	fs.Duration("cache-resync-period", time.Hour,
		"Full resync period for the manager's informer cache.")
	fs.Float64("reconcile-global-rate", 100,
		"Global reconcile token-bucket refill rate (reconciles/sec). <=0 disables "+
			"reconcile rate limiting entirely.")
	fs.Int("reconcile-global-burst", 200,
		"Global reconcile token-bucket burst size.")
	fs.Float64("reconcile-app-rate", 10,
		"Per-application reconcile token-bucket refill rate (reconciles/sec).")
	fs.Int("reconcile-app-burst", 20,
		"Per-application reconcile token-bucket burst size.")
}

// controllerTuning carries the reconcile-rate flags into the controller setup
// chain without growing every setup signature.
type controllerTuning struct {
	appMaxConcurrent      int
	releaseMaxConcurrent  int
	stageMaxConcurrent    int
	pipelineMaxConcurrent int
	appTransientRequeue   time.Duration
	appSourceResolveTTL   time.Duration
}

// validateControllerTuning rejects values that would wedge or thrash the
// reconcile loops: zero workers, a poll interval too tight to be sane, or a
// rate limiter that can never refill.
func validateControllerTuning(cfg *cliConfig) error {
	concurrencies := map[string]int{
		"application-max-concurrent-reconciles": cfg.AppMaxConcurrentReconciles,
		"release-max-concurrent-reconciles":     cfg.ReleaseMaxConcurrentReconciles,
		"stage-max-concurrent-reconciles":       cfg.StageMaxConcurrentReconciles,
		"pipeline-max-concurrent-reconciles":    cfg.PipelineMaxConcurrentReconciles,
	}
	for flag, v := range concurrencies {
		if v < 1 {
			return fmt.Errorf("--%s must be >= 1, got %d", flag, v)
		}
	}
	durations := map[string][2]time.Duration{
		"application-transient-requeue":  {time.Second, 24 * time.Hour},
		"application-source-resolve-ttl": {0, 24 * time.Hour},
		"cache-resync-period":            {time.Minute, 1<<63 - 1},
	}
	values := map[string]time.Duration{
		"application-transient-requeue":  cfg.AppTransientRequeue,
		"application-source-resolve-ttl": cfg.AppSourceResolveTTL,
		"cache-resync-period":            cfg.CacheResyncPeriod,
	}
	for flag, bounds := range durations {
		if v := values[flag]; v < bounds[0] || v > bounds[1] {
			return fmt.Errorf("--%s must be in [%s, %s], got %s", flag, bounds[0], bounds[1], v)
		}
	}
	if cfg.ReconcileGlobalBurst < 1 || cfg.ReconcileAppBurst < 1 {
		return fmt.Errorf("reconcile rate-limit bursts must be >= 1 (global=%d, app=%d)", cfg.ReconcileGlobalBurst, cfg.ReconcileAppBurst)
	}
	if cfg.ReconcileGlobalRate > 0 && cfg.ReconcileAppRate <= 0 {
		return fmt.Errorf("--reconcile-app-rate must be > 0 when rate limiting is enabled, got %v", cfg.ReconcileAppRate)
	}
	return nil
}

func (cfg *cliConfig) tuning() controllerTuning {
	return controllerTuning{
		appMaxConcurrent:      cfg.AppMaxConcurrentReconciles,
		releaseMaxConcurrent:  cfg.ReleaseMaxConcurrentReconciles,
		stageMaxConcurrent:    cfg.StageMaxConcurrentReconciles,
		pipelineMaxConcurrent: cfg.PipelineMaxConcurrentReconciles,
		appTransientRequeue:   cfg.AppTransientRequeue,
		appSourceResolveTTL:   cfg.AppSourceResolveTTL,
	}
}

func registerCoordinatorFlags(fs *pflag.FlagSet) {
	fs.Bool("coordinator-mode", false,
		"Enable Redis-backed coordinator for active-active sharding (requires PAPRIKA_REDIS_ADDR). "+
			"Each replica processes a subset of namespaces via consistent hash ring.")
	fs.Duration("coordinator-heartbeat", 15*time.Second,
		"Coordinator heartbeat interval. How often replicas refresh their registration.")
	fs.Duration("coordinator-ttl", 30*time.Second,
		"Coordinator heartbeat TTL. Must be greater than --coordinator-heartbeat. "+
			"Stale replicas are removed after this duration.")
}

func validateCoordinatorConfig(cfg *cliConfig) error {
	if !cfg.CoordinatorMode {
		return nil
	}
	if cfg.CacheRedisAddr == "" {
		return errors.New("--coordinator-mode requires PAPRIKA_REDIS_ADDR environment variable")
	}
	if cfg.CoordinatorHeartbeat >= cfg.CoordinatorTTL {
		return fmt.Errorf("--coordinator-heartbeat (%v) must be less than --coordinator-ttl (%v)", cfg.CoordinatorHeartbeat, cfg.CoordinatorTTL)
	}
	return nil
}

// newManagerViper wires the config resolution for cliConfig. Flag names are
// the viper keys; every flag automatically answers to the conventional
// PAPRIKA_<FLAG_NAME> env var via AutomaticEnv, and env-only keys (no flag
// equivalent) plus env vars whose names predate that convention are bound
// explicitly below.
func newManagerViper() *viper.Viper {
	v := viper.New()
	v.SetEnvPrefix("PAPRIKA")
	v.SetEnvKeyReplacer(strings.NewReplacer("-", "_"))
	v.AutomaticEnv()

	// Env-only keys whose PAPRIKA_<key> env name matches the convention —
	// a bare BindEnv resolves them via the prefix.
	for _, key := range []string{
		"webhook-secret",
		"auth-rbac-rules",
		"cache-backend",
		"audit-enabled",
		"shard-id",
		"shard-total",
		"mcp-public-url",
		"github-actions-token-exchange-enabled",
		"github-actions-token-exchange-audience",
		"github-actions-token-exchange-repository",
		"github-actions-token-exchange-environment",
		"github-actions-token-exchange-subject",
		"github-actions-token-exchange-allowed-event-names",
		"github-actions-token-exchange-ref",
		"github-actions-token-exchange-allowed-workflow-refs",
		"github-actions-token-exchange-job-workflow-ref",
		"github-actions-token-exchange-service-account-namespace",
		"github-actions-token-exchange-service-account-name",
		"github-actions-token-exchange-token-ttl",
	} {
		if err := v.BindEnv(key); err != nil {
			panic(fmt.Errorf("bind env %s: %w", key, err))
		}
	}

	// Keys whose legacy env names deviate from the convention. Each binding
	// lists the legacy name first, then the conventional name, so both work.
	for key, envs := range map[string][]string{
		"auth-oidc-client-secret": {"PAPRIKA_OIDC_CLIENT_SECRET", "PAPRIKA_AUTH_OIDC_CLIENT_SECRET"},
		"auth-oidc-redirect-url":  {"PAPRIKA_OIDC_REDIRECT_URL", "PAPRIKA_AUTH_OIDC_REDIRECT_URL"},
		"enable-webhooks":         {"ENABLE_WEBHOOKS", "PAPRIKA_ENABLE_WEBHOOKS"},
		"cache-redis-addr":        {"PAPRIKA_REDIS_ADDR", "PAPRIKA_CACHE_REDIS_ADDR"},
		"cache-redis-password":    {"PAPRIKA_REDIS_PASSWORD", "PAPRIKA_CACHE_REDIS_PASSWORD"},
		"cache-redis-db":          {"PAPRIKA_REDIS_DB", "PAPRIKA_CACHE_REDIS_DB"},
		// shard-id-source is the pod's shard identity label: the explicit
		// PAPRIKA_SHARD_ID assignment wins, then the pod name.
		"shard-id-source": {"PAPRIKA_SHARD_ID", "POD_NAME", "PAPRIKA_SHARD_ID_SOURCE"},
	} {
		if err := v.BindEnv(append([]string{key}, envs...)...); err != nil {
			panic(fmt.Errorf("bind env %s: %w", key, err))
		}
	}

	v.SetDefault("enable-webhooks", true)
	v.SetDefault("cache-backend", cache.BackendMemory)
	v.SetDefault("github-actions-token-exchange-token-ttl", 15*time.Minute)
	return v
}

// registerManagerFlags defines every manager flag on the cobra flag set.
// Values are not bound into cliConfig here — viper resolves the merged
// flag/env/config-file value per key and Unmarshal maps it onto cliConfig.
func registerManagerFlags(fs *pflag.FlagSet, zapOpts *zap.Options) {
	fs.String("config", "",
		"Path to an optional YAML config file using flag-name keys (e.g. metrics-bind-address: :8443). "+
			"Explicit flags and environment variables override the file.")
	fs.String("metrics-bind-address", "0", "The address the metrics endpoint binds to. "+
		"Use :8443 for HTTPS or :8080 for HTTP, or leave as 0 to disable the metrics service.")
	fs.String("health-probe-bind-address", ":8081", "The address the probe endpoint binds to.")
	fs.String("pprof-bind-address", "", "The address the pprof debug endpoint binds to "+
		"(e.g. :6060 serves /debug/pprof/*). Empty disables it. Off by default because it "+
		"exposes heap, goroutine and execution-trace internals; enable only for profiling.")
	fs.Bool("leader-elect", false,
		"Enable leader election for controller manager. "+
			"Enabling this will ensure there is only one active controller manager.")
	fs.Duration("cache-sync-timeout", 2*time.Minute,
		"Maximum time to wait for caches to sync on startup before exiting. "+
			"Default 2m; raise this for large clusters or many CRDs (e.g. 5m) to avoid "+
			"CrashLoopBackOff due to slow initial list calls on small API servers.")
	fs.Bool("api-cache-enabled", true,
		"Enable the informer-backed API client cache. Set false only for local tests or emergency debugging.")
	registerCoordinatorFlags(fs)
	fs.Bool("metrics-secure", true,
		"If set, the metrics endpoint is served securely via HTTPS. Use --metrics-secure=false to use HTTP instead.")
	fs.String("webhook-cert-path", "", "The directory that contains the webhook certificate.")
	fs.String("webhook-cert-name", "tls.crt", "The name of the webhook certificate file.")
	fs.String("webhook-cert-key", "tls.key", "The name of the webhook key file.")
	fs.String("metrics-cert-path", "",
		"The directory that contains the metrics server certificate.")
	fs.String("metrics-cert-name", "tls.crt", "The name of the metrics server certificate file.")
	fs.String("metrics-cert-key", "tls.key", "The name of the metrics server key file.")
	fs.Bool("enable-http2", false,
		"If set, HTTP/2 will be enabled for the metrics and webhook servers")
	fs.String("operator-namespace", "paprika-system",
		"The namespace where the operator runs (used for manifest snapshots and step jobs).")
	fs.String("ui-bind-address", ":3000",
		"The address the UI dashboard server binds to.")
	fs.Int("api-max-conns", 128,
		"Maximum number of concurrent TCP connections the UI/API server accepts. "+
			"Bounds connection and in-flight request memory on small pods; excess "+
			"connections wait in the kernel accept queue. 0 disables the limit.")
	registerControllerTuningFlags(fs)
	fs.String("mode", "operator",
		"Running mode: 'operator' (controllers + API), 'api' (API server only), 'webhook' (webhook receiver only), 'repo-server' (repo server only), or 'agent' (in-cluster agent). "+
			"The mode subcommands are equivalent: 'manager api' == 'manager --mode=api'.")
	fs.String("k8s-api-server", "",
		"Kubernetes API server URL. Only used in 'api' mode.")
	fs.String("k8s-token-file", "",
		"Path to Kubernetes service account token. Only used in 'api' mode.")
	fs.String("webhook-bind-address", ":8080",
		"The address the webhook receiver binds to. Only used in 'webhook' mode.")
	registerRepoServerFlags(fs)
	fs.String("agent-cluster-id", "",
		"Cluster ID for the in-cluster agent. Only used in 'agent' mode.")
	fs.Bool("auth-enabled", false,
		"Enable authentication and authorization for the API server.")
	fs.String("auth-basic-username", "",
		"Basic auth username. Only used when --auth-enabled=true.")
	fs.String("auth-basic-password", "",
		"Basic auth plain-text password (deprecated: use --auth-basic-password-hash instead).")
	fs.String("auth-basic-password-hash", "",
		"Basic auth SHA-256 password hash (hex). Only used when --auth-enabled=true.")
	fs.String("auth-oidc-issuer-url", "",
		"OIDC issuer URL. Only used when --auth-enabled=true.")
	fs.String("auth-oidc-client-id", "",
		"OIDC client ID. Only used when --auth-enabled=true.")
	fs.String("auth-oidc-client-secret", "",
		"OIDC client secret. Prefer setting via PAPRIKA_OIDC_CLIENT_SECRET env var to avoid process-list exposure.")
	fs.String("auth-oidc-redirect-url", "",
		"OIDC redirect URL. Only used when --auth-enabled=true.")
	fs.String("auth-token-secret", "",
		"Secret key for signing self-issued auth tokens. Required for basic auth login flow. "+
			"Prefer setting via PAPRIKA_AUTH_TOKEN_SECRET env var.")
	registerMCPFlags(fs)

	zapFlags := flag.NewFlagSet("zap", flag.ContinueOnError)
	zapOpts.BindFlags(zapFlags)
	fs.AddGoFlagSet(zapFlags)
}

// registerMCPFlags registers the six --mcp-* flags.
//
// mcpPublicURL is deliberately not a --mcp-* flag: the design spec's
// configuration table lists exactly six, none of them a public/external base
// URL. It is still required (NewServer validates it as an absolute URL,
// embedded verbatim in RFC 9728/8414 discovery metadata, and used as the
// minted token's "iss" claim), so it is sourced as the env-only
// PAPRIKA_MCP_PUBLIC_URL config key. It deliberately has NO default: a
// loopback fallback would let a misconfigured production deployment silently
// advertise "http://localhost:..." as its authorization server to every MCP
// client and mint tokens claiming to be issued by it — exactly the kind of
// fail-open behavior the rest of this MCP config (--mcp-enabled without
// auth, empty TokenSecret, empty ClientID) refuses to allow. Callers MUST
// set PAPRIKA_MCP_PUBLIC_URL to the real externally-reachable URL (behind
// TLS/ingress); validateMCPConfig rejects --mcp-enabled=true when it is
// unset.
func registerMCPFlags(fs *pflag.FlagSet) {
	fs.Bool("mcp-enabled", false,
		"Enable the MCP (Model Context Protocol) server, exposing fleet tools to MCP clients. "+
			"Off by default: this is the first surface that lets a language model mutate fleet state, "+
			"and it refuses to start unless --auth-enabled=true.")
	fs.String("mcp-bind-address", ":8090",
		"Address advertised for the MCP server. Routes are mounted on the same shared API mux as "+
			"the rest of the API server, not a separate listener; this flag is retained for the "+
			"deployment-facing address it documents.")
	fs.Duration("mcp-access-token-ttl", 24*time.Hour,
		"MCP OAuth access token lifetime.")
	fs.Duration("mcp-refresh-token-ttl", 720*time.Hour,
		"MCP OAuth refresh token lifetime.")
	fs.String("mcp-oauth-client-id", "",
		"Statically registered OAuth client ID accepted by the MCP authorization server. Required "+
			"when --mcp-enabled=true.")
	fs.StringSlice("mcp-oauth-redirect-uris", nil,
		"Comma-separated exact-match allowlist of OAuth redirect URIs accepted by the MCP "+
			"authorization server. Required when --mcp-enabled=true.")
}

func registerRepoServerFlags(fs *pflag.FlagSet) {
	fs.String("repo-server-addr", "",
		"Address of the repo server. When set, controllers delegate source resolution/rendering to it.")
	fs.String("repo-workdir", "",
		"Working directory for the repo server. Only used in 'repo-server' mode.")
}

func buildAPIServerOptions(
	authCfg auth.Config,
	authzReader client.Reader,
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
		authz, err := auth.BuildAuthorizer(authCfg, authzReader)
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
		if mapper, err := apiutil.NewDynamicRESTMapper(restConfig, nil); err == nil {
			opts = append(opts, apiserver.WithRESTMapper(mapper))
		}
	}
	return opts, nil
}

type apiCacheLifecycle interface {
	Start(context.Context) error
	WaitForCacheSync(context.Context) bool
}

type fleetRuntimeLifecycle interface {
	Start(context.Context) error
	WaitReady(context.Context) error
}

// runFleetCacheLifecycle owns the cache, fleet runtime, and main API server
// under one cancelable error group. The main API does not start until the
// cache has synced and the initial fleet snapshot has been installed.
func runFleetCacheLifecycle(
	ctx context.Context,
	apiCache apiCacheLifecycle,
	fleetRuntime fleetRuntimeLifecycle,
	syncTimeout time.Duration,
	serve func(context.Context) error,
) error {
	if syncTimeout <= 0 {
		syncTimeout = defaultCacheSyncTimeout
	}
	lifecycleCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	group, groupCtx := errgroup.WithContext(lifecycleCtx)
	group.Go(func() error {
		return runLifecycleComponent(groupCtx, "API informer cache", apiCache.Start)
	})
	group.Go(func() error {
		return runLifecycleComponent(groupCtx, "fleet runtime", fleetRuntime.Start)
	})

	started := time.Now()
	syncCtx, syncCancel := context.WithTimeout(groupCtx, syncTimeout)
	if ok := apiCache.WaitForCacheSync(syncCtx); !ok {
		syncErr := syncCtx.Err()
		if syncErr == nil {
			syncErr = errors.New("cache sync failed")
		}
		syncCancel()
		cancel()
		return errors.Join(fmt.Errorf("sync API informer cache within %s: %w", syncTimeout, syncErr), group.Wait())
	}
	metrics.APICacheSyncDuration.Record(groupCtx, time.Since(started).Milliseconds())
	if err := fleetRuntime.WaitReady(syncCtx); err != nil {
		syncCancel()
		cancel()
		return errors.Join(fmt.Errorf("initialize fleet index: %w", err), group.Wait())
	}
	syncCancel()

	group.Go(func() error {
		return runLifecycleComponent(groupCtx, "API server", serve)
	})
	if err := group.Wait(); err != nil {
		return fmt.Errorf("run API lifecycle: %w", err)
	}
	return nil
}

func runLifecycleComponent(
	ctx context.Context,
	name string,
	start func(context.Context) error,
) error {
	if err := start(ctx); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	if ctx.Err() == nil {
		return fmt.Errorf("%s stopped unexpectedly", name)
	}
	return nil
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
	fleetRuntime, err := prepareStandaloneFleetRuntime(apiCtx, clients, scheme)
	if err != nil {
		return err
	}

	broker, err := newBrokerFromConfig(apiCtx, cfg.cacheConfig(), setupLog)
	if err != nil {
		return fmt.Errorf("create event broker: %w", err)
	}
	defer broker.Close()

	paprikaServer, connectHandler, err := buildConnectHandler(clients.client, clients.k8sClient, clients.restConfig, broker, clients.fleetReader, clients.authCfg, clients.authzReader, clients.interceptor, cfg, setupLog)
	if err != nil {
		return err
	}

	extraMuxHandlers, mcpCache, err := buildAPIExtraMuxHandlers(apiCtx, cfg, connectHandler, clients, setupLog)
	defer closeMCPCacheIfPresent(mcpCache, setupLog)
	if err != nil {
		return err
	}

	ready := fleetReadyChecker(clients.fleetReader)
	mux, muxErr := buildAPIMux(connectHandler, paprikaServer.Broker(), setupLog, ready, extraMuxHandlers...)
	if muxErr != nil {
		return fmt.Errorf("build API mux: %w", muxErr)
	}
	wrappedHandler := otelhttp.NewHandler(apiserver.MetricsMiddleware(mux), "paprika-http")
	healthMux := buildHealthMux(setupLog, ready)

	healthSrv := buildHealthProbeServer(healthMux, cfg.ProbeAddr)
	go func() {
		if srvErr := runHTTPServer(apiCtx, healthSrv, "health probe server", setupLog, probeAddrCh, false, 0); srvErr != nil {
			setupLog.Error(srvErr, "Health probe server exited with error")
		}
	}()

	startMetricsServer(apiCtx, cfg.MetricsAddr, setupLog)
	startPprofServer(apiCtx, cfg.PprofAddr, setupLog)

	if clients.cacheBundle == nil {
		return startAPIServer(apiCtx, wrappedHandler, cfg.UIAddr, cfg.APIMaxConns, setupLog)
	}
	return runFleetCacheLifecycle(
		apiCtx,
		clients.cacheBundle.Cache,
		fleetRuntime,
		cfg.CacheSyncTimeout,
		func(ctx context.Context) error {
			setupLog.Info("API informer cache and fleet index ready")
			return startAPIServer(ctx, wrappedHandler, cfg.UIAddr, cfg.APIMaxConns, setupLog)
		},
	)
}

// buildAPIExtraMuxHandlers assembles the registrars mounted onto the shared
// API mux alongside the Connect handler — auth, the GitHub Actions token
// exchange, and (when enabled) MCP — split out of runAPIMode to keep that
// function under the repo's cyclop budget.
//
// It also returns the MCP cache it creates (nil when MCP is disabled) so
// the caller can close it on shutdown — this function only builds the
// handlers that reference the cache, it does not own the server's
// lifetime, so it must not close the cache itself.
func buildAPIExtraMuxHandlers(
	apiCtx context.Context,
	cfg *cliConfig,
	connectHandler http.Handler,
	clients *apiClients,
	setupLog logr.Logger,
) ([]func(*http.ServeMux), *cache.Cache, error) {
	extraMuxHandlers, err := buildAuthHandlers(apiCtx, clients.authCfg)
	if err != nil {
		return nil, nil, err
	}
	githubExchangeHandlers, err := buildGitHubActionsTokenExchangeHandlers(apiCtx, cfg, clients.k8sClient)
	if err != nil {
		return nil, nil, err
	}
	extraMuxHandlers = append(extraMuxHandlers, githubExchangeHandlers...)

	var mcpCache *cache.Cache
	if cfg.MCPEnabled {
		mcpCache, err = newCacheFromConfig(apiCtx, cfg.cacheConfig(), setupLog)
		if err != nil {
			return nil, nil, fmt.Errorf("create MCP cache: %w", err)
		}
	}
	mcpHandlers, err := buildMCPHandlers(apiCtx, cfg, connectHandler, clients.authCfg, mcpCache)
	if err != nil {
		return nil, mcpCache, err
	}
	return append(extraMuxHandlers, mcpHandlers...), mcpCache, nil
}

// closeMCPCacheIfPresent closes the MCP cache built by
// buildAPIExtraMuxHandlers, if any (mcpCache is nil whenever MCP is
// disabled, or when buildAPIExtraMuxHandlers failed before creating one).
// Split out of runAPIMode, and always deferred unconditionally, so the
// nil check does not add a branch to runAPIMode itself and push it over
// the repo's cyclop budget.
func closeMCPCacheIfPresent(mcpCache *cache.Cache, setupLog logr.Logger) {
	if mcpCache == nil {
		return
	}
	if closeErr := mcpCache.Close(); closeErr != nil {
		setupLog.Error(closeErr, "Failed to close MCP cache")
	}
}

func prepareStandaloneFleetRuntime(
	ctx context.Context,
	clients *apiClients,
	scheme *runtime.Scheme,
) (*fleet.Runtime, error) {
	if clients.cacheBundle == nil {
		return nil, nil
	}
	fleetIndex := fleet.NewIndex()
	fleetStore := fleet.NewCacheStore(clients.cacheBundle.Cache, scheme)
	fleetRuntime, err := fleet.NewRuntime(clients.cacheBundle.Cache, fleetStore, fleetIndex)
	if err != nil {
		return nil, fmt.Errorf("build fleet index runtime: %w", err)
	}
	if err = fleetRuntime.Register(ctx); err != nil {
		return nil, fmt.Errorf("register fleet index informers: %w", err)
	}
	clients.fleetReader = fleetRuntime.Reader()
	return fleetRuntime, nil
}

type apiClients struct {
	client      client.Client
	k8sClient   kubernetes.Interface
	restConfig  *rest.Config
	authCfg     auth.Config
	authzReader client.Reader
	interceptor connect.Interceptor
	cacheBundle *apiCacheBundle
	fleetReader fleet.Reader
}

func buildAPIClients(ctx context.Context, cfg *cliConfig, scheme *runtime.Scheme, setupLog logr.Logger) (*apiClients, error) {
	config, err := buildAPIConfig(cfg.K8sAPIServer, cfg.K8sTokenFile)
	if err != nil {
		return nil, fmt.Errorf("build API config: %w", err)
	}

	var (
		apiClient   client.Client
		cacheBundle *apiCacheBundle
		fleetReader fleet.Reader
	)
	if cfg.APICacheEnabled {
		cacheBundle, err = createAPICacheBundle(ctx, config, scheme)
		if cacheBundle != nil {
			apiClient = cacheBundle.Client
		}
	} else {
		setupLog.Info("API informer cache disabled; using direct Kubernetes client")
		apiClient, err = createAPIClient(config, scheme)
		fleetReader = fleet.NewUnavailableReader(apiCacheDisabledReason)
	}
	if err != nil {
		return nil, fmt.Errorf("create API client: %w", err)
	}

	k8sClient, err := createK8sClient(config)
	if err != nil {
		return nil, err
	}

	authCfg := buildAuthConfig(cfg.AuthEnabled, cfg.AuthBasicUsername, cfg.AuthBasicPassword, cfg.AuthBasicPasswordHash,
		cfg.AuthOIDCIssuerURL, cfg.AuthOIDCClientID, cfg.AuthOIDCClientSecret, cfg.AuthOIDCRedirectURL,
		cfg.AuthTokenSecret, cfg.AuthRBACRules, setupLog)
	// Prefer the informer cache for authorization reads so ProjectAuthorizer
	// can resolve AppProjects straight from the informer store instead of a
	// deep copy per check — this lookup runs per candidate per request.
	authzReader := client.Reader(apiClient)
	if cacheBundle != nil {
		authzReader = cacheBundle.Cache
	}
	authInterceptor, err := auth.Interceptor(ctx, authCfg, authzReader)
	if err != nil {
		return nil, fmt.Errorf("failed to build auth interceptor: %w", err)
	}

	return &apiClients{
		client:      apiClient,
		k8sClient:   k8sClient,
		restConfig:  config,
		authCfg:     authCfg,
		authzReader: authzReader,
		interceptor: authInterceptor,
		cacheBundle: cacheBundle,
		fleetReader: fleetReader,
	}, nil
}

func buildConnectHandler(apiClient client.Client, k8sClient kubernetes.Interface, restConfig *rest.Config, broker *events.Broker, fleetReader fleet.Reader, authCfg auth.Config, authzReader client.Reader, authInterceptor connect.Interceptor, cfg *cliConfig, setupLog logr.Logger) (*apiserver.PaprikaServer, http.Handler, error) {
	resolver := governance.NewProjectResolver(apiClient)
	projectValidator := governance.NewProjectValidator(resolver, governance.NewClusterResolver(apiClient), nil)
	policyEvaluator := governance.NewPolicyEvaluator(apiClient)

	opts, err := buildAPIServerOptions(authCfg, authzReader, k8sClient, cfg.AuditLogEnabled, projectValidator, policyEvaluator, restConfig)
	if err != nil {
		return nil, nil, err
	}
	opts = append(opts, apiserver.WithFleetIndex(fleetReader))
	capacityRegistry, err := buildCapacityRegistry(apiClient)
	if err != nil {
		return nil, nil, err
	}
	opts = append(opts,
		apiserver.WithCapacityProviders(capacityRegistry),
		apiserver.WithControlPlaneNamespace(cfg.OperatorNamespace),
	)
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

// buildCapacityRegistry registers the capacity providers this build ships.
//
// Both read a cluster through the same two seams: one client cache, so a
// fleet's connection pools stay warm across requests, and one cluster config
// resolver, so a read scoped to a remote fleet cluster is served from that
// cluster's own credentials rather than from the control plane's. A provider
// registered here is still inert until an operator binds it — a CapacityProvider
// plus a DataProviderBinding — which is what keeps "installed" and "configured"
// different facts.
func buildCapacityRegistry(apiClient client.Client) (*dataprovider.Registry, error) {
	clients := kube.NewClients()
	configs := clusterconfig.NewResolver(apiClient)

	registry := dataprovider.NewRegistry()
	for _, source := range []dataprovider.CapacitySource{
		dataprovider.NewKubernetesCapacity(clients, configs),
		dataprovider.NewMetricsServer(clients, configs),
	} {
		if err := registry.RegisterCapacity(source); err != nil {
			return nil, fmt.Errorf("registering capacity provider: %w", err)
		}
	}

	return registry, nil
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

func buildGitHubActionsTokenExchangeHandlers(ctx context.Context, cfg *cliConfig, k8sClient kubernetes.Interface) ([]func(*http.ServeMux), error) {
	if !cfg.GitHubActionsTokenExchangeEnabled {
		return nil, nil
	}
	verifier, err := apiserver.NewGitHubActionsTokenVerifier(ctx, cfg.GitHubActionsTokenExchangeAudience)
	if err != nil {
		return nil, fmt.Errorf("create GitHub Actions token verifier: %w", err)
	}
	handler := apiserver.NewGitHubActionsTokenExchangeHandler(&apiserver.GitHubActionsTokenExchangeConfig{
		Audience:                cfg.GitHubActionsTokenExchangeAudience,
		Repository:              cfg.GitHubActionsTokenExchangeRepository,
		Environment:             cfg.GitHubActionsTokenExchangeEnvironment,
		Subject:                 cfg.GitHubActionsTokenExchangeSubject,
		AllowedEventNames:       cfg.GitHubActionsTokenExchangeAllowedEventNames,
		Ref:                     cfg.GitHubActionsTokenExchangeRef,
		AllowedWorkflowRefs:     cfg.GitHubActionsTokenExchangeAllowedWorkflowRefs,
		JobWorkflowRef:          cfg.GitHubActionsTokenExchangeJobWorkflowRef,
		ServiceAccountNamespace: cfg.GitHubActionsTokenExchangeServiceAccountNamespace,
		ServiceAccountName:      cfg.GitHubActionsTokenExchangeServiceAccountName,
		ServiceAccountTokenTTL:  cfg.GitHubActionsTokenExchangeTTL,
	}, verifier, apiserver.NewKubernetesServiceAccountTokenIssuer(k8sClient))

	return []func(*http.ServeMux){
		func(mux *http.ServeMux) {
			mux.Handle("/auth/github-actions/token", handler)
		},
	}, nil
}

// mcpConfirmationTTL is the two-phase destructive-write confirmation
// window, fixed by the design spec at 60s
// (docs/superpowers/specs/2026-09-11-mcp-server-design.md).
const mcpConfirmationTTL = 60 * time.Second

// buildMCPHandlers builds the MCP server's registrars, matching
// buildAuthHandlers' shape so it slots into runAPIMode's extraMuxHandlers
// alongside it. It returns nothing when MCP is disabled (the default,
// TestBuildMCPHandlersReturnsNothingWhenDisabled) and fails loudly rather
// than start MCP without authentication (TestBuildMCPHandlersRequiresAuthEnabled).
//
// Two further checks close carry-forwards from Task 13's review
// (task-15-report.md, CF1 and CF2):
//
//   - CF1: mcp.ServerConfig.Client is deliberately not part of
//     mcp.NewServer's own required-field validation — a server built
//     without one still serves tools/list and the unauthenticated-401 path,
//     it only fails a tools/call, cleanly (see ServerConfig.Client's doc
//     comment). That is the right behaviour for a package that must support
//     Client-less tests, but a PRODUCTION server built here must always
//     carry a real one, or the whole tool surface silently never works.
//     This function always constructs one over connectHandler.
//   - CF2: nothing in the mcp package enforces that its HMAC Secret is the
//     SAME secret the console API's self-signed authenticator validates
//     against. If auth is enabled via OIDC/basic auth alone with no
//     TokenSecret configured, buildAuthnAuthz (internal/api/auth) never
//     builds a self-signed authenticator at all, and every MCP token this
//     server mints — and every bearer /mcp/authorize needs — would be
//     unverifiable. This function asserts authCfg.TokenSecret is non-empty
//     and passes exactly that slice as ServerConfig.Secret.
//
// validateMCPConfig runs buildMCPHandlers' fail-closed preconditions, split
// out to keep buildMCPHandlers itself under the repo's cyclop budget. Every
// check here returns a startup error rather than letting the MCP server run
// in a shape that would silently misbehave (unauthenticated, unverifiable
// tokens, or no cache for confirmations/authorization codes).
func validateMCPConfig(cfg *cliConfig, authCfg auth.Config, mcpCache *cache.Cache) error {
	if !authCfg.Enabled {
		return errors.New("mcp: --mcp-enabled requires --auth-enabled=true; " +
			"refusing to serve an unauthenticated MCP surface")
	}
	if len(authCfg.TokenSecret) == 0 {
		return errors.New("mcp: --mcp-enabled requires a non-empty auth token secret " +
			"(--auth-token-secret / PAPRIKA_AUTH_TOKEN_SECRET); the MCP server signs and verifies " +
			"tokens with the same secret the console API's self-signed authenticator uses")
	}
	if cfg.MCPOAuthClientID == "" {
		return errors.New("mcp: --mcp-oauth-client-id is required when --mcp-enabled=true")
	}
	if len(cfg.MCPOAuthRedirectURIs) == 0 {
		return errors.New("mcp: --mcp-oauth-redirect-uris is required when --mcp-enabled=true")
	}
	if cfg.MCPPublicURL == "" {
		return errors.New("mcp: PAPRIKA_MCP_PUBLIC_URL is required when --mcp-enabled=true; " +
			"it is embedded in RFC 9728/8414 discovery metadata and used as the minted token's " +
			"issuer, so it must be set explicitly to the real externally-reachable URL rather than " +
			"silently defaulting to a loopback address")
	}
	if mcpCache == nil {
		return errors.New("mcp: no cache configured; the MCP server requires one for " +
			"confirmations, authorization codes, and refresh tokens")
	}
	return nil
}

func buildMCPHandlers(
	ctx context.Context,
	cfg *cliConfig,
	connectHandler http.Handler,
	authCfg auth.Config,
	mcpCache *cache.Cache,
) ([]func(*http.ServeMux), error) {
	if !cfg.MCPEnabled {
		return nil, nil
	}
	if err := validateMCPConfig(cfg, authCfg, mcpCache); err != nil {
		return nil, err
	}

	authenticator, err := auth.NewSelfSignedAuthenticatorForAudience(authCfg.TokenSecret, mcp.MCPTokenAudience, "")
	if err != nil {
		return nil, fmt.Errorf("mcp: build authenticator: %w", err)
	}

	// consoleAuthenticator authenticates the OAuth authorize/consent surface
	// (GET /mcp/authorize, POST /mcp/authorize/consent) as a console user —
	// the same Google OIDC + Paprika self-signed stack the console API
	// itself uses (auth.BuildAuthenticator), never the MCP-audience-only
	// authenticator above. Using that one here would be circular: the only
	// thing that ever mints an MCP-audience token is /mcp/token, which
	// itself requires a code /mcp/authorize issues — no client could ever
	// complete the flow. See mcp.ServerConfig.ConsoleAuthenticator's doc
	// comment for the full rationale.
	consoleAuthenticator, err := auth.BuildAuthenticator(ctx, authCfg)
	if err != nil {
		return nil, fmt.Errorf("mcp: build console authenticator: %w", err)
	}

	registry := mcp.NewRegistry()
	if regErr := mcp.RegisterReadTools(registry); regErr != nil {
		return nil, fmt.Errorf("mcp: register read tools: %w", regErr)
	}
	if regErr := mcp.RegisterWriteTools(registry); regErr != nil {
		return nil, fmt.Errorf("mcp: register write tools: %w", regErr)
	}

	// mcpClient re-enters connectHandler — the SAME otel -> auth -> audit ->
	// PaprikaServer chain that serves console requests — over an in-memory
	// RoundTripper rather than a network call. See the package doc for why:
	// this is what keeps MCP from needing its own, second authorization path.
	mcpClient := v1connect.NewPaprikaServiceClient(
		&http.Client{Transport: mcp.NewInProcessTransport(connectHandler)},
		"http://mcp-in-process",
	)

	var auditor audit.Auditor = audit.NoopAuditor{}
	if cfg.AuditLogEnabled {
		auditor = audit.NewLogAuditor()
	}

	srv, err := mcp.NewServer(mcp.ServerConfig{
		Registry:             registry,
		Authenticator:        authenticator,
		ConsoleAuthenticator: consoleAuthenticator,
		Confirmer:            mcp.NewConfirmer(mcpCache, mcpConfirmationTTL),
		Auditor:              auditor,
		Cache:                mcpCache,
		Secret:               authCfg.TokenSecret,
		PublicURL:            cfg.MCPPublicURL,
		ClientID:             cfg.MCPOAuthClientID,
		RedirectURIs:         cfg.MCPOAuthRedirectURIs,
		AccessTTL:            cfg.MCPAccessTokenTTL,
		RefreshTTL:           cfg.MCPRefreshTokenTTL,
		Client:               mcpClient,
	})
	if err != nil {
		return nil, fmt.Errorf("mcp: build server: %w", err)
	}

	return []func(*http.ServeMux){
		func(mux *http.ServeMux) {
			mux.Handle("/mcp", srv.Handler())
		},
		srv.RegisterOAuthRoutes,
	}, nil
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
	config = clusterconfig.WithClientRateLimits(config)

	apiClient, err := createAPIClient(config, scheme)
	if err != nil {
		return fmt.Errorf("create API client: %w", err)
	}

	inv := buildWebhookCacheInvalidator(whCtx, cacheCfg, setupLog)

	var repoClient *reposerverclient.Client
	if cfg.RepoServerAddr != "" {
		repoClient = reposerverclient.New(cfg.RepoServerAddr)
	}
	handler := webhookreceiver.NewHandlerWithCacheAndRepo(apiClient, webhookSecret, inv, repoClient)

	mux := http.NewServeMux()
	mux.Handle("/webhook", handler)
	mux.Handle("/healthz", healthzHandler(setupLog))
	mux.Handle("/readyz", healthzHandler(setupLog))

	healthMux := buildHealthMux(setupLog, healthz.Ping)
	healthSrv := buildHealthProbeServer(healthMux, probeAddr)
	go func() {
		if srvErr := runHTTPServer(whCtx, healthSrv, "health probe server", setupLog, nil, false, 0); srvErr != nil {
			setupLog.Error(srvErr, "Health probe server exited with error")
		}
	}()

	startMetricsServer(ctx, cfg.MetricsAddr, setupLog)
	startPprofServer(ctx, cfg.PprofAddr, setupLog)

	server := &http.Server{
		Addr:              webhookAddr,
		Handler:           mux,
		ReadHeaderTimeout: defaultReadHeaderTimeout,
		IdleTimeout:       apiServerIdleTimeout,
	}
	return runHTTPServer(whCtx, server, "webhook receiver", setupLog, nil, true, 0)
}

func runRepoServerMode(ctx context.Context, addr, probeAddr, workDir, metricsAddr, pprofAddr string, scheme *runtime.Scheme, setupLog logr.Logger, cacheCfg cache.Config, probeAddrCh chan<- string, k8sClient client.Client) error {
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
		k8sClient, err = client.New(clusterconfig.WithClientRateLimits(negotiateProtobuf(cfg)), client.Options{Scheme: scheme})
		if err != nil {
			return fmt.Errorf("create k8s client: %w", err)
		}
	}

	srv := reposerver.NewServerWithClient(workDir, c, k8sClient)

	rsCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	telemetry := observability.NewTelemetry(rsCtx, observability.ConfigFromEnv())
	defer func() { _ = telemetry.Shutdown(rsCtx) }() //nolint:errcheck // shutdown in defer; error is best-effort

	healthMux := buildHealthMux(setupLog, healthz.Ping)
	healthSrv := buildHealthProbeServer(healthMux, probeAddr)
	go func() {
		if srvErr := runHTTPServer(rsCtx, healthSrv, "health probe server", setupLog, probeAddrCh, false, 0); srvErr != nil {
			setupLog.Error(srvErr, "Health probe server exited with error")
		}
	}()

	startMetricsServer(ctx, metricsAddr, setupLog)
	startPprofServer(ctx, pprofAddr, setupLog)

	if err := srv.Run(rsCtx, addr); err != nil {
		return fmt.Errorf("repo server run: %w", err)
	}
	return nil
}

func runAgentMode(ctx context.Context, addr, probeAddr, clusterID, metricsAddr, pprofAddr string, setupLog logr.Logger) error {
	if clusterID == "" {
		clusterID = "default"
	}

	cfg, err := rest.InClusterConfig()
	if err != nil {
		return fmt.Errorf("load in-cluster config: %w", err)
	}
	cfg = clusterconfig.WithClientRateLimits(cfg)

	srv, err := agentserver.NewServer(clusterID, cfg)
	if err != nil {
		return fmt.Errorf("create agent server: %w", err)
	}

	agentCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	telemetry := observability.NewTelemetry(agentCtx, observability.ConfigFromEnv())
	defer func() { _ = telemetry.Shutdown(agentCtx) }() //nolint:errcheck // shutdown in defer; error is best-effort

	healthMux := buildHealthMux(setupLog, healthz.Ping)
	healthSrv := buildHealthProbeServer(healthMux, probeAddr)
	go func() {
		if srvErr := runHTTPServer(agentCtx, healthSrv, "health probe server", setupLog, nil, false, 0); srvErr != nil {
			setupLog.Error(srvErr, "Health probe server exited with error")
		}
	}()

	startMetricsServer(ctx, metricsAddr, setupLog)
	startPprofServer(ctx, pprofAddr, setupLog)

	if err := srv.Run(agentCtx, addr); err != nil {
		return fmt.Errorf("agent server run: %w", err)
	}
	return nil
}

// client-go's default rate limit (5 QPS / 10 burst) is tuned for a quiet
// controller; the API server issues uncached reads and writes per request and
// needs the same headroom operator mode sets on its manager config.
const (
	apiClientQPS   = 50
	apiClientBurst = 100
)

func buildAPIConfig(k8sAPIServer, k8sTokenFile string) (*rest.Config, error) {
	if k8sAPIServer == "" {
		config, err := rest.InClusterConfig()
		if err != nil {
			return nil, fmt.Errorf("get in-cluster config (use --k8s-api-server): %w", err)
		}
		return negotiateProtobuf(withAPIRateLimits(config)), nil
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
	return negotiateProtobuf(withAPIRateLimits(cfg)), nil
}

func withAPIRateLimits(cfg *rest.Config) *rest.Config {
	cfg.QPS = apiClientQPS
	cfg.Burst = apiClientBurst
	return cfg
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

type apiCacheBundle struct {
	Cache  crcache.Cache
	Client client.Client
}

// createAPICacheBundle constructs and warms the standalone API cache without
// starting it. Callers must register every informer handler before taking
// ownership of Cache.Start.
func createAPICacheBundle(ctx context.Context, config *rest.Config, scheme *runtime.Scheme) (*apiCacheBundle, error) {
	apiCache, err := crcache.New(config, crcache.Options{
		Scheme:           scheme,
		DefaultTransform: crcache.TransformStripManagedFields(),
	})
	if err != nil {
		return nil, fmt.Errorf("create k8s cache: %w", err)
	}

	warmObjects := []client.Object{
		&pipelinesv1alpha1.Application{},
		&pipelinesv1alpha1.ApplicationSet{},
		&pipelinesv1alpha1.Pipeline{},
		&pipelinesv1alpha1.Release{},
		&pipelinesv1alpha1.Stage{},
		&pipelinesv1alpha1.NotificationConfig{},
		&pipelinesv1alpha1.AnalysisRun{},
		&pipelinesv1alpha1.Artifact{},
		&policyv1alpha1.Policy{},
		&rolloutsv1alpha1.Rollout{},
		&corev1alpha1.AppProject{},
		&corev1alpha1.Repository{},
		&clustersv1alpha1.Cluster{},
		&featureflagsv1alpha1.FeatureFlag{},
		&featureflagsv1alpha1.FeatureFlagBinding{},
	}
	for _, obj := range warmObjects {
		if _, informerErr := apiCache.GetInformer(ctx, obj); informerErr != nil {
			return nil, fmt.Errorf("create informer for %T: %w", obj, informerErr)
		}
	}

	apiClient, err := client.New(config, client.Options{
		Scheme: scheme,
		Cache: &client.CacheOptions{
			Reader: apiCache,
			// Reads of types outside the warmed set would otherwise lazily
			// start cluster-wide informers at request time — a Secret informer
			// caches every Secret in the cluster for what is a keyed GET of a
			// kubeconfig ref, and a ConfigMap informer does the same for the
			// occasional artifact lookup. Route both straight to the API.
			DisableFor: []client.Object{
				&corev1.Secret{},
				&corev1.ConfigMap{},
			},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("create cache-backed k8s client: %w", err)
	}
	return &apiCacheBundle{Cache: apiCache, Client: apiClient}, nil
}

func createK8sClient(config *rest.Config) (kubernetes.Interface, error) {
	k8sClient, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("create k8s clientset: %w", err)
	}
	return k8sClient, nil
}

func buildAPIMux(
	connectHandler http.Handler,
	_ *events.Broker,
	log logr.Logger,
	ready healthz.Checker,
	extraHandlers ...func(*http.ServeMux),
) (*http.ServeMux, error) {
	mux := http.NewServeMux()
	mux.Handle("/paprika.v1.PaprikaService/", connectHandler)
	// Raw browser SSE is intentionally disabled until an authorized WatchEvents
	// transport is available. Keep the exact route fail-closed so the UI catch-all
	// cannot accidentally serve index.html with a 200 response.
	mux.Handle("/events", http.NotFoundHandler())
	mux.Handle("/healthz", healthzHandler(log))
	mux.Handle("/readyz", readinessHandler(log, ready))
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

func buildHealthMux(log logr.Logger, ready healthz.Checker) *http.ServeMux {
	healthMux := http.NewServeMux()
	healthMux.Handle("/healthz", healthzHandler(log))
	healthMux.Handle("/readyz", readinessHandler(log, ready))
	return healthMux
}

func fleetReadyChecker(reader fleet.Reader) healthz.Checker {
	return func(_ *http.Request) error {
		if reader == nil {
			return errors.New("fleet reader is not configured")
		}
		return reader.CheckReady()
	}
}

func readinessHandler(log logr.Logger, check healthz.Checker) http.HandlerFunc {
	if check == nil {
		check = healthz.Ping
	}
	return func(w http.ResponseWriter, req *http.Request) {
		if err := check(req); err != nil {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusServiceUnavailable)
			// #nosec G705 -- readiness errors are HTML-escaped and served as plain text.
			if _, writeErr := fmt.Fprintln(w, html.EscapeString(err.Error())); writeErr != nil {
				log.Error(writeErr, "Failed to write readiness response")
			}
			return
		}
		healthzHandler(log)(w, req)
	}
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
	// The restclient blank import makes client-go emit rest_client_* metrics
	// (request latency, rate-limiter wait, transport cache stats) into the
	// component-base legacy registry — gather it alongside ours so /metrics
	// shows how hard Kubernetes API calls are being throttled. The legacy
	// registry also carries go_*/process_* collectors that our registry
	// already emits, so only the rest_client_* families pass through.
	mux.Handle("/metrics", promhttp.HandlerFor(
		prometheus.Gatherers{
			crmetrics.Registry,
			metrics.PrefixGatherer(legacyregistry.DefaultGatherer, "rest_client_"),
		},
		promhttp.HandlerOpts{},
	))
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

// startPprofServer serves the net/http/pprof handlers on their own listener,
// gated by --pprof-bind-address. The handlers expose heap, goroutine, mutex,
// block and execution-trace internals, so the listener is unauthenticated and
// must stay off in anything but a deliberate profiling session. Disabled when
// addr is empty.
func startPprofServer(ctx context.Context, addr string, setupLog logr.Logger) {
	if addr == "" {
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: defaultReadHeaderTimeout,
	}
	go func() {
		setupLog.Info("Starting pprof server", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			setupLog.Error(err, "pprof server exited with error")
		}
	}()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), serverShutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			setupLog.Error(err, "Failed to shutdown pprof server")
		}
	}()
}

func startAPIServer(ctx context.Context, handler http.Handler, uiAddr string, maxConns int, log logr.Logger) error {
	server := httpx.WithH2C(&http.Server{
		Addr:              uiAddr,
		Handler:           handler,
		ReadHeaderTimeout: defaultReadHeaderTimeout,
		IdleTimeout:       apiServerIdleTimeout,
		MaxHeaderBytes:    apiServerMaxHeaderBytes,
	})
	return runHTTPServer(ctx, server, "API server", log, nil, true, maxConns)
}

func runHTTPServer(ctx context.Context, srv *http.Server, name string, log logr.Logger, boundAddrCh chan<- string, useMTLS bool, maxConns int) error {
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
	if maxConns > 0 {
		ln = netutil.LimitListener(ln, maxConns)
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

func buildAuthConfig(enabled bool, basicUsername, basicPassword, basicPasswordHash, oidcIssuerURL, oidcClientID, oidcClientSecret, oidcRedirectURL, tokenSecret, rbacRules string, log logr.Logger) auth.Config {
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
			RedirectURL:  oidcRedirectURL,
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

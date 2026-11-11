package main

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway"
)

// Defaults must equal the values the gateway ran with before the flags existed.
func TestObservabilityCapacityDefaultsMatchBuiltIns(t *testing.T) {
	cfg, err := parseManagerConfig([]string{"--mode=observability-gateway"}, &bytes.Buffer{})
	require.NoError(t, err)

	capacity, err := resolveObservabilityCapacity(cfg)
	require.NoError(t, err)

	assert.Equal(t, observabilitygateway.BudgetConfig{
		Concurrency:         4,
		ProviderConcurrency: 2,
		Queue:               32,
		ProviderQueue:       8,
		QueueWait:           5 * time.Second,
	}, capacity.Budget)
	assert.Equal(t, observabilitygateway.DefaultBudgetConfig(), capacity.Budget)
	assert.Equal(t, observabilityHTTPPools{Work: 4, Catalog: 4, Dashboards: 2, Intake: 8, AdmissionWait: time.Second}, capacity.Pools)

	builtIn := defaultObservabilityHTTPPools()
	assert.Equal(t, builtIn.Work, capacity.Pools.Work)
	assert.Equal(t, builtIn.Catalog, capacity.Pools.Catalog)
	assert.Equal(t, builtIn.Dashboards, capacity.Pools.Dashboards)
	assert.Equal(t, builtIn.Intake, capacity.Pools.Intake)
}

func TestObservabilityCapacityFlagsParse(t *testing.T) {
	cfg, err := parseManagerConfig([]string{
		"--observability-query-concurrency=8",
		"--observability-query-provider-concurrency=4",
		"--observability-query-queue=16",
		"--observability-query-provider-queue=4",
		"--observability-query-queue-wait=3s",
		"--observability-http-work-slots=10",
		"--observability-http-catalog-slots=6",
		"--observability-http-dashboard-slots=3",
		"--observability-http-intake-slots=20",
		"--observability-http-admission-wait=750ms",
	}, &bytes.Buffer{})
	require.NoError(t, err)

	capacity, err := resolveObservabilityCapacity(cfg)
	require.NoError(t, err)
	assert.Equal(t, observabilitygateway.BudgetConfig{Concurrency: 8, ProviderConcurrency: 4, Queue: 16, ProviderQueue: 4, QueueWait: 3 * time.Second}, capacity.Budget)
	assert.Equal(t, observabilityHTTPPools{Work: 10, Catalog: 6, Dashboards: 3, Intake: 20, AdmissionWait: 750 * time.Millisecond}, capacity.Pools)
}

func TestObservabilityCapacityPoolsFollowBudget(t *testing.T) {
	cases := []struct {
		name   string
		budget observabilitygateway.BudgetConfig
		want   observabilityHTTPPools
	}{
		{
			name:   "defaults",
			budget: observabilitygateway.DefaultBudgetConfig(),
			want:   observabilityHTTPPools{Work: 4, Catalog: 4, Dashboards: 2, Intake: 8, AdmissionWait: time.Second},
		},
		{
			name:   "raised concurrency raises every derived pool",
			budget: observabilitygateway.BudgetConfig{Concurrency: 6, ProviderConcurrency: 2, Queue: 32, ProviderQueue: 8, QueueWait: 5 * time.Second},
			want:   observabilityHTTPPools{Work: 6, Catalog: 6, Dashboards: 2, Intake: 12, AdmissionWait: time.Second},
		},
		{
			name:   "single slot budget",
			budget: observabilitygateway.BudgetConfig{Concurrency: 1, ProviderConcurrency: 1, Queue: 0, ProviderQueue: 0, QueueWait: 5 * time.Second},
			want:   observabilityHTTPPools{Work: 1, Catalog: 1, Dashboards: 1, Intake: 2, AdmissionWait: time.Second},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := &cliConfig{
				ObsQueryConcurrency:         tc.budget.Concurrency,
				ObsQueryProviderConcurrency: tc.budget.ProviderConcurrency,
				ObsQueryQueue:               tc.budget.Queue,
				ObsQueryProviderQueue:       tc.budget.ProviderQueue,
				ObsQueryQueueWait:           tc.budget.QueueWait,
				ObsHTTPAdmissionWait:        time.Second,
			}
			capacity, err := resolveObservabilityCapacity(cfg)
			require.NoError(t, err)
			assert.Equal(t, tc.want, capacity.Pools)
		})
	}
}

func TestObservabilityCapacityProviderConcurrencyZeroMeansMinTwoConcurrency(t *testing.T) {
	cfg := defaultCapacityConfig()
	cfg.ObsQueryConcurrency = 1
	cfg.ObsQueryProviderConcurrency = 0
	capacity, err := resolveObservabilityCapacity(cfg)
	require.NoError(t, err)
	assert.Equal(t, 1, capacity.Budget.ProviderConcurrency)
}

func TestObservabilityCapacityValidationRejectsNonsense(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*cliConfig)
		flag   string
	}{
		{"zero concurrency", func(c *cliConfig) { c.ObsQueryConcurrency = 0 }, "--observability-query-concurrency must be between 1 and 1024, got 0"},
		{"negative concurrency", func(c *cliConfig) { c.ObsQueryConcurrency = -3 }, "--observability-query-concurrency must be between 1 and 1024, got -3"},
		{"provider concurrency above global", func(c *cliConfig) { c.ObsQueryProviderConcurrency = 5 }, "--observability-query-provider-concurrency must be between 1 and"},
		{"negative provider concurrency", func(c *cliConfig) { c.ObsQueryProviderConcurrency = -1 }, "--observability-query-provider-concurrency must be between 1 and"},
		{"negative queue", func(c *cliConfig) { c.ObsQueryQueue = -1 }, "--observability-query-queue must be between 0 and 65536, got -1"},
		{"provider queue above global queue", func(c *cliConfig) { c.ObsQueryQueue = 4; c.ObsQueryProviderQueue = 8 }, "--observability-query-provider-queue must be between 0 and --observability-query-queue (4)"},
		{"zero queue wait", func(c *cliConfig) { c.ObsQueryQueueWait = 0 }, "--observability-query-queue-wait must be above 0 and below the 30s request timeout"},
		{"queue wait equal to request timeout", func(c *cliConfig) { c.ObsQueryQueueWait = 30 * time.Second }, "--observability-query-queue-wait must be above 0 and below the 30s request timeout"},
		{"queue wait above request timeout", func(c *cliConfig) { c.ObsQueryQueueWait = 45 * time.Second }, "--observability-query-queue-wait must be above 0 and below the 30s request timeout, got 45s"},
		{"negative admission wait", func(c *cliConfig) { c.ObsHTTPAdmissionWait = -time.Second }, "--observability-http-admission-wait must be >= 0"},
		{"admission wait above budget queue wait", func(c *cliConfig) { c.ObsHTTPAdmissionWait = 6 * time.Second }, "--observability-http-admission-wait must be at most 5s"},
		{"negative work pool", func(c *cliConfig) { c.ObsHTTPWorkSlots = -1 }, "--observability-http-work-slots must be between 0 and 65536, got -1"},
		{"negative catalog pool", func(c *cliConfig) { c.ObsHTTPCatalogSlots = -1 }, "--observability-http-catalog-slots must be between 0 and 65536, got -1"},
		{"negative dashboard pool", func(c *cliConfig) { c.ObsHTTPDashboardSlots = -1 }, "--observability-http-dashboard-slots must be between 0 and 65536, got -1"},
		{"negative intake pool", func(c *cliConfig) { c.ObsHTTPIntakeSlots = -1 }, "--observability-http-intake-slots must be between 0 and 65536, got -1"},
		{"work pool above budget admission capacity", func(c *cliConfig) { c.ObsHTTPWorkSlots = 37 }, "--observability-http-work-slots (37) exceeds the execution budget's admission capacity (36 = --observability-query-concurrency 4 + --observability-query-queue 32)"},
		{"dashboard pool above budget concurrency", func(c *cliConfig) { c.ObsHTTPDashboardSlots = 5 }, "--observability-http-dashboard-slots (5) must not exceed --observability-query-concurrency (4)"},
		{"query concurrency overflow is reported against its own flag", func(c *cliConfig) { c.ObsQueryConcurrency = 1 << 62 }, "--observability-query-concurrency must be between 1 and 1024, got 4611686018427387904"},
		{"pool overflow is reported against its own flag", func(c *cliConfig) { c.ObsHTTPIntakeSlots = 1 << 40 }, "--observability-http-intake-slots must be between 0 and 65536"},
		{"admission and queue waits exceed the write timeout", func(c *cliConfig) { c.ObsQueryQueueWait = 9 * time.Second; c.ObsHTTPAdmissionWait = 5 * time.Second }, "must stay below the 45s HTTP write timeout"},
		{"29.999s admission wait", func(c *cliConfig) {
			c.ObsQueryQueueWait = 29999 * time.Millisecond
			c.ObsHTTPAdmissionWait = 29999 * time.Millisecond
		}, "--observability-http-admission-wait must be at most 5s"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := defaultCapacityConfig()
			tc.mutate(cfg)
			_, err := resolveObservabilityCapacity(cfg)
			require.Error(t, err)
			assert.True(t, strings.Contains(err.Error(), tc.flag), "error %q does not contain %q", err, tc.flag)
		})
	}
}

// Intake is held only while a body is read, so intake below the work pool is a
// valid, if slow, configuration rather than a deadlock.
func TestObservabilityCapacityAcceptsSmallIntake(t *testing.T) {
	cfg := defaultCapacityConfig()
	cfg.ObsHTTPWorkSlots = 10
	cfg.ObsHTTPIntakeSlots = 1
	capacity, err := resolveObservabilityCapacity(cfg)
	require.NoError(t, err)
	assert.Equal(t, 1, capacity.Pools.Intake)
}

func TestObservabilityCapacityAcceptsBudgetExactlyAtAdmissionCapacity(t *testing.T) {
	cfg := defaultCapacityConfig()
	cfg.ObsHTTPWorkSlots = 36
	capacity, err := resolveObservabilityCapacity(cfg)
	require.NoError(t, err)
	assert.Equal(t, 36, capacity.Pools.Work)
}

func TestObservabilityCapacityRejectsZeroConfig(t *testing.T) {
	// A zero-valued cliConfig (as built by tests) is not a valid capacity: the
	// resolver refuses it so a missing flag can never start a gateway with no slots.
	_, err := resolveObservabilityCapacity(&cliConfig{})
	require.Error(t, err)
}

func defaultCapacityConfig() *cliConfig {
	return &cliConfig{
		ObsQueryConcurrency:         4,
		ObsQueryProviderConcurrency: 2,
		ObsQueryQueue:               32,
		ObsQueryProviderQueue:       8,
		ObsQueryQueueWait:           5 * time.Second,
		ObsHTTPAdmissionWait:        time.Second,
	}
}

// The dashboard pool is min(2, query concurrency). It must not follow the
// per-provider flag, so a per-provider limit of 1 does not serialise dashboards.
func TestObservabilityCapacityDashboardPoolIndependentOfProviderFlag(t *testing.T) {
	pools := productionAdmissionPools(t, "--observability-query-provider-concurrency=1")
	assert.Equal(t, 2, pools.Dashboards)

	pools = productionAdmissionPools(t, "--observability-query-concurrency=8")
	assert.Equal(t, 2, pools.Dashboards)
	assert.Equal(t, 8, pools.Work)
	assert.Equal(t, 16, pools.Intake)
}

// The startup log names where each derived value came from, so an operator can
// tell an explicit flag from a rule.
func TestObservabilityCapacitySourcesRecordDerivation(t *testing.T) {
	cfg, err := parseManagerConfig([]string{"--mode=observability-gateway", "--observability-http-work-slots=6"}, &bytes.Buffer{})
	require.NoError(t, err)
	capacity, err := resolveObservabilityCapacity(cfg)
	require.NoError(t, err)
	assert.Equal(t, "explicit", capacity.Sources.Work)
	assert.Equal(t, "follows the work pool", capacity.Sources.Catalog)
	assert.Equal(t, "min(2, --observability-query-concurrency)", capacity.Sources.Dashboards)
	assert.Equal(t, "2 x work pool", capacity.Sources.Intake)
	assert.Equal(t, "min(2, --observability-query-concurrency)", capacity.Sources.ProviderConcurrency)
}

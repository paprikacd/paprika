package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
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
		{"zero concurrency", func(c *cliConfig) { c.ObsQueryConcurrency = 0 }, "--observability-query-concurrency must be >= 1, got 0"},
		{"negative concurrency", func(c *cliConfig) { c.ObsQueryConcurrency = -3 }, "--observability-query-concurrency must be >= 1, got -3"},
		{"provider concurrency above global", func(c *cliConfig) { c.ObsQueryProviderConcurrency = 5 }, "--observability-query-provider-concurrency must be between 1 and"},
		{"negative provider concurrency", func(c *cliConfig) { c.ObsQueryProviderConcurrency = -1 }, "--observability-query-provider-concurrency must be between 1 and"},
		{"negative queue", func(c *cliConfig) { c.ObsQueryQueue = -1 }, "--observability-query-queue must be >= 0"},
		{"provider queue above global queue", func(c *cliConfig) { c.ObsQueryQueue = 4; c.ObsQueryProviderQueue = 8 }, "--observability-query-provider-queue must be between 0 and --observability-query-queue (4)"},
		{"zero queue wait", func(c *cliConfig) { c.ObsQueryQueueWait = 0 }, "--observability-query-queue-wait must be > 0 and below the 30s request timeout"},
		{"queue wait equal to request timeout", func(c *cliConfig) { c.ObsQueryQueueWait = 30 * time.Second }, "--observability-query-queue-wait must be > 0 and below the 30s request timeout"},
		{"queue wait above request timeout", func(c *cliConfig) { c.ObsQueryQueueWait = 45 * time.Second }, "--observability-query-queue-wait must be > 0 and below the 30s request timeout, got 45s"},
		{"negative admission wait", func(c *cliConfig) { c.ObsHTTPAdmissionWait = -time.Second }, "--observability-http-admission-wait must be >= 0"},
		{"admission wait above budget queue wait", func(c *cliConfig) { c.ObsHTTPAdmissionWait = 6 * time.Second }, "--observability-http-admission-wait (6s) must not exceed --observability-query-queue-wait (5s)"},
		{"negative work pool", func(c *cliConfig) { c.ObsHTTPWorkSlots = -1 }, "--observability-http-work-slots must be >= 0"},
		{"negative catalog pool", func(c *cliConfig) { c.ObsHTTPCatalogSlots = -1 }, "--observability-http-catalog-slots must be >= 0"},
		{"negative dashboard pool", func(c *cliConfig) { c.ObsHTTPDashboardSlots = -1 }, "--observability-http-dashboard-slots must be >= 0"},
		{"negative intake pool", func(c *cliConfig) { c.ObsHTTPIntakeSlots = -1 }, "--observability-http-intake-slots must be >= 0"},
		{"work pool above budget admission capacity", func(c *cliConfig) { c.ObsHTTPWorkSlots = 37 }, "--observability-http-work-slots (37) exceeds the execution budget's admission capacity (36 = --observability-query-concurrency 4 + --observability-query-queue 32)"},
		{"dashboard pool above budget concurrency", func(c *cliConfig) { c.ObsHTTPDashboardSlots = 5 }, "--observability-http-dashboard-slots (5) must not exceed --observability-query-concurrency (4)"},
		{"intake below largest pool", func(c *cliConfig) { c.ObsHTTPWorkSlots = 10; c.ObsHTTPIntakeSlots = 3 }, "--observability-http-intake-slots (3) must be at least the largest pool (10)"},
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

// The admission wait holds a slot request for a bounded time, then sends 429
// with Retry-After: 1 and no-store, as before.
func TestAdmitObservabilityRequestWaitsThenRejects(t *testing.T) {
	slots := make(chan struct{}, 1)
	slots <- struct{}{}

	rec := httptest.NewRecorder()
	start := time.Now()
	ok := admitObservabilityRequest(t.Context(), rec, slots, 30*time.Millisecond)
	elapsed := time.Since(start)

	assert.False(t, ok)
	assert.GreaterOrEqual(t, elapsed, 30*time.Millisecond)
	assert.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Equal(t, "1", rec.Header().Get("Retry-After"))
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
}

func TestAdmitObservabilityRequestWaitAdmitsWhenSlotFrees(t *testing.T) {
	slots := make(chan struct{}, 1)
	slots <- struct{}{}
	go func() {
		time.Sleep(20 * time.Millisecond)
		<-slots
	}()

	rec := httptest.NewRecorder()
	assert.True(t, admitObservabilityRequest(t.Context(), rec, slots, time.Second))
	assert.Empty(t, rec.Header().Get("Retry-After"))
	assert.Equal(t, 1, len(slots))
}

func TestAdmitObservabilityRequestZeroWaitFailsFast(t *testing.T) {
	slots := make(chan struct{}, 1)
	slots <- struct{}{}

	rec := httptest.NewRecorder()
	start := time.Now()
	assert.False(t, admitObservabilityRequest(t.Context(), rec, slots, 0))
	assert.Less(t, time.Since(start), 20*time.Millisecond)
	assert.Equal(t, http.StatusTooManyRequests, rec.Code)
}

func TestAdmitObservabilityRequestStopsWaitingWhenClientGoes(t *testing.T) {
	slots := make(chan struct{}, 1)
	slots <- struct{}{}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	rec := httptest.NewRecorder()
	start := time.Now()
	assert.False(t, admitObservabilityRequest(ctx, rec, slots, time.Minute))
	assert.Less(t, time.Since(start), time.Second)
}

// Through the real handler: with one work slot, a second request waits for the
// first and is served once it frees. With no wait it gets 429 at once.
func TestLimitObservabilityProtocolRequestsWaitsForWorkSlot(t *testing.T) {
	for _, tc := range []struct {
		name     string
		wait     time.Duration
		wantCode int
	}{
		{"with wait the second request is admitted", 2 * time.Second, http.StatusOK},
		{"without wait the second request is rejected", 0, http.StatusTooManyRequests},
	} {
		t.Run(tc.name, func(t *testing.T) {
			entered := make(chan struct{}, 2)
			release := make(chan struct{})
			handler := limitObservabilityProtocolRequestsWith(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				entered <- struct{}{}
				<-release
				w.WriteHeader(http.StatusOK)
			}), observabilityHTTPPools{Work: 1, Catalog: 1, Dashboards: 1, Intake: 4, AdmissionWait: tc.wait})

			first := httptest.NewRecorder()
			firstDone := make(chan struct{})
			go func() {
				defer close(firstDone)
				handler.ServeHTTP(first, mcpPostRequest(t))
			}()
			<-entered

			second := httptest.NewRecorder()
			secondDone := make(chan struct{})
			go func() {
				defer close(secondDone)
				handler.ServeHTTP(second, mcpPostRequest(t))
			}()
			if tc.wait == 0 {
				<-secondDone
			} else {
				// Free the first slot while the second is still waiting for it.
				time.Sleep(30 * time.Millisecond)
				close(release)
				<-secondDone
			}
			assert.Equal(t, tc.wantCode, second.Code)
			if tc.wantCode == http.StatusTooManyRequests {
				assert.Equal(t, "1", second.Header().Get("Retry-After"))
			}
			if tc.wait == 0 {
				close(release)
			}
			<-firstDone
			assert.Equal(t, http.StatusOK, first.Code)
		})
	}
}

func mcpPostRequest(t *testing.T) *http.Request {
	req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, observabilityGatewayRoutePrefix+"/mcp", strings.NewReader("not json"))
	req.Header.Set("Content-Type", "application/json")
	return req
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

package insights

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The defaults are the admission sizes Insights always had, so a config that sets
// no capacity behaves as before.
func TestCapacityDefaultsMatchTheHistoricalPools(t *testing.T) {
	got := Capacity{}.withDefaults()
	assert.Equal(t, Capacity{QueryConcurrency: 16, QueryQueue: 64, QueryWait: 2 * time.Second, CatalogConcurrency: 4, CatalogQueue: 16, CatalogWait: 5 * time.Second, DashboardQueryParallelism: 2}, got)
	require.NoError(t, got.validate(defaultQueryBudget))
}

func TestCapacityValidationRejectsOutOfRangeValues(t *testing.T) {
	budget := defaultQueryBudget
	for name, c := range map[string]Capacity{
		"a negative query queue":                        {QueryQueue: -1},
		"too many query executions":                     {QueryConcurrency: maxCapacityCount + 1},
		"too many catalog waiters":                      {CatalogQueue: maxCapacityCount + 1},
		"a sub-millisecond query wait":                  {QueryWait: time.Microsecond},
		"a negative catalog wait":                       {CatalogWait: -time.Second},
		"a dashboard parallelism above four":            {DashboardQueryParallelism: 5},
		"a negative dashboard parallelism":              {DashboardQueryParallelism: -1},
		"two waits that exceed the query budget":        {QueryWait: 15 * time.Second, CatalogWait: 10 * time.Second},
		"two waits that reach the query budget exactly": {QueryWait: 17 * time.Second, CatalogWait: 5 * time.Second},
	} {
		t.Run(name, func(t *testing.T) {
			require.Error(t, c.withDefaults().validate(budget))
		})
	}
	require.NoError(t, Capacity{QueryWait: 16 * time.Second, CatalogWait: 5 * time.Second}.withDefaults().validate(budget), "two waits just under the budget are valid")
	for _, parallelism := range []int{1, 4} {
		require.NoError(t, Capacity{DashboardQueryParallelism: parallelism}.withDefaults().validate(budget), "parallelism %d is valid", parallelism)
	}
}

// NewServer sizes its pools and reports the effective capacity.
func TestNewServerSizesItsPoolsFromCapacity(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	require.NoError(t, err)
	s, err := NewServer(Config{Token: testToken, Capacity: &Capacity{QueryConcurrency: 3, QueryQueue: 5, QueryWait: 7 * time.Second, CatalogConcurrency: 2, CatalogQueue: 9, CatalogWait: 4 * time.Second, DashboardQueryParallelism: 3}}, store)
	require.NoError(t, err)
	assert.Equal(t, 3, s.dashboardParallelism)
	assert.Equal(t, 2, cap(s.dashboardExtra.slots), "the process shares parallelism minus one extra slots")
	assert.Equal(t, 3, cap(s.queries))
	assert.Equal(t, 5, cap(s.queryWaiting))
	assert.Equal(t, 7*time.Second, s.queryWaitTimeout)
	assert.Equal(t, 2, cap(s.catalogPhases))
	assert.Equal(t, 9, cap(s.catalogWaiting))
	assert.Equal(t, 4*time.Second, s.catalogWaitTimeout)
	assert.Equal(t, Capacity{QueryConcurrency: 3, QueryQueue: 5, QueryWait: 7 * time.Second, CatalogConcurrency: 2, CatalogQueue: 9, CatalogWait: 4 * time.Second, DashboardQueryParallelism: 3}, s.Capacity())
	defaults, err := NewServer(Config{Token: testToken}, store)
	require.NoError(t, err)
	assert.Equal(t, Capacity{}.withDefaults(), defaults.Capacity(), "without a capacity the defaults apply")
}

func TestNewServerRefusesAnInvalidCapacity(t *testing.T) {
	store, err := OpenStore(t.TempDir())
	require.NoError(t, err)
	_, err = NewServer(Config{Token: testToken, Capacity: &Capacity{QueryWait: 20 * time.Second, CatalogWait: 5 * time.Second}}, store)
	require.Error(t, err, "the waits of one shared query must fit in its budget")
}

// A catalog refusal names the wait its pool's observed hold time implies.
func TestCatalogRefusalRetryAfterFollowsItsPool(t *testing.T) {
	s := singleSlotService(t)
	s.catalogHold.Observe(3 * time.Second)
	recorder := httptest.NewRecorder()
	s.writeCatalogAdmissionError(recorder, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", http.NoBody), &Query{Kind: "metrics"}, errCatalogBusy)
	require.Equal(t, http.StatusTooManyRequests, recorder.Code)
	assert.Equal(t, "3", recorder.Header().Get("Retry-After"))
}

// A query refused for its execution pool names that pool's computed wait.
func TestQueryCapacityRefusalRetryAfterFollowsItsPool(t *testing.T) {
	s := singleSlotService(t)
	s.queryHold.Observe(6 * time.Second)
	recorder := httptest.NewRecorder()
	writeQueryFailure(recorder, s.queryCapacityRefusal(context.Background()), nil)
	require.Equal(t, http.StatusTooManyRequests, recorder.Code)
	assert.Equal(t, "6", recorder.Header().Get("Retry-After"))

	// With 16 slots the same average spreads over the pool: the floor applies.
	wide, _ := testService(t)
	wide.queryHold.Observe(6 * time.Second)
	recorder = httptest.NewRecorder()
	writeQueryFailure(recorder, wide.queryCapacityRefusal(context.Background()), nil)
	assert.Equal(t, "1", recorder.Header().Get("Retry-After"), "one request ahead over sixteen slots takes less than one average")
}

// singleSlotService is a service whose query and catalog pools each have one
// slot and no waiters, so a refusal's hint is one average hold time.
func singleSlotService(t *testing.T) *Server {
	t.Helper()
	store, err := OpenStore(t.TempDir())
	require.NoError(t, err)
	s, err := NewServer(Config{Token: testToken, Capacity: &Capacity{QueryConcurrency: 1, QueryQueue: 1, CatalogConcurrency: 1, CatalogQueue: 1}}, store)
	require.NoError(t, err)
	return s
}

// The gateway's own delay wins over the local estimate.
func TestGatewayRetryAfterWinsOverLocalEstimate(t *testing.T) {
	s, _ := testService(t)
	s.queryHold.Observe(6 * time.Second)
	recorder := httptest.NewRecorder()
	writeQueryFailure(recorder, &observeError{status: http.StatusTooManyRequests, message: "busy", retryAfter: 4}, nil)
	assert.Equal(t, "4", recorder.Header().Get("Retry-After"))
}

// A busy listing without a gateway delay takes the catalog pool's estimate; a
// gateway delay still wins over it.
func TestBusyListingRetryAfterFollowsTheCatalogEstimate(t *testing.T) {
	busy := &observeError{status: http.StatusTooManyRequests, message: "busy"}
	assert.Equal(t, 6, sharedCatalogFailureFor(busy, 6).RetryAfter, "the local estimate applies")
	assert.Equal(t, 1, sharedCatalogFailureFor(busy, 0).RetryAfter, "with no estimate, the one-second floor applies")
	withDelay := &observeError{status: http.StatusTooManyRequests, message: "busy", retryAfter: 3}
	assert.Equal(t, 3, sharedCatalogFailureFor(withDelay, 6).RetryAfter, "a gateway delay wins")
}

// A catalog refusal that never got a phase took no capacity, so it records no hold.
func TestCatalogBusyRefusalDoesNotRecordCatalogHold(t *testing.T) {
	s := singleSlotService(t)
	s.catalogPhases <- struct{}{}
	s.catalogWaiting <- struct{}{}
	recorder := httptest.NewRecorder()
	r := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/", http.NoBody)
	_, _, ok := s.admitAndResolveShared(recorder, r, &Query{Kind: "metrics", ProviderID: "observability/none"})
	require.False(t, ok)
	require.Equal(t, http.StatusTooManyRequests, recorder.Code)
	require.Zero(t, s.catalogHold.Average(), "no phase was taken, so there is no catalog hold to record")
}

// A request that holds a catalog phase while its query admission is refused still
// occupied the phase, so its time counts toward the catalog hold. Without that
// the hint for a busy catalog would ignore the admission wait a phase includes.
func TestRefusedAdmissionAfterPhaseRecordsCatalogHold(t *testing.T) {
	s := singleSlotService(t)
	s.queries <- struct{}{}
	s.queryWaiting <- struct{}{}
	recorder := httptest.NewRecorder()
	r := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/", http.NoBody)
	_, _, ok := s.admitAndResolveShared(recorder, r, &Query{Kind: "metrics", ProviderID: "observability/none"})
	require.False(t, ok)
	require.Equal(t, http.StatusTooManyRequests, recorder.Code)
	require.Positive(t, s.catalogHold.Average(), "the phase was held until the refusal, so its hold is recorded")
	require.Empty(t, s.catalogPhases, "the phase is released once the refusal is answered")
}

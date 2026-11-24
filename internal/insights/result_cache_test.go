package insights

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// fakeResultMetrics records evictions and the last usage the cache reported.
type fakeResultMetrics struct {
	mu        sync.Mutex
	evictions map[string]int
	bytes     int
	entries   int
}

func newFakeResultMetrics() *fakeResultMetrics {
	return &fakeResultMetrics{evictions: map[string]int{}}
}

func (m *fakeResultMetrics) lookup(string, string, string) {}

func (m *fakeResultMetrics) evicted(reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.evictions[reason]++
}

func (m *fakeResultMetrics) usage(bytes, entries int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.bytes, m.entries = bytes, entries
}

// fakeClock is a clock the tests move by hand.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func newTestResultCache(t *testing.T, maxBytes int) (*resultCache, *fakeResultMetrics, *fakeClock) {
	t.Helper()
	clock := &fakeClock{now: time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)}
	metrics := newFakeResultMetrics()
	c := newResultCache(maxBytes, metrics, clock.Now)
	require.NotNil(t, c)
	return c, metrics, clock
}

// seriesResult returns a small result whose value is v, so tests can tell results apart.
func seriesResult(v float64) *QueryResult {
	value := v
	return &QueryResult{Series: []Series{{Name: "requests", Labels: map[string]string{"job": "api"}, Points: []Point{{Timestamp: 1, Value: &value}}}}}
}

// leadOrFail claims key and requires that the caller becomes the leader.
func leadOrFail(t *testing.T, c *resultCache, key string) *resultFlight {
	t.Helper()
	hit, join, lead := c.claim(key)
	require.Nil(t, hit)
	require.Nil(t, join)
	require.NotNil(t, lead)
	return lead
}

func TestResultCacheDisabledWithoutBudget(t *testing.T) {
	t.Parallel()
	require.Nil(t, newResultCache(0, newFakeResultMetrics(), nil))
	require.Nil(t, newResultCache(-1, newFakeResultMetrics(), nil))
}

func TestResultCacheHitsWithinTTLAndExpires(t *testing.T) {
	t.Parallel()
	c, _, clock := newTestResultCache(t, 16<<20)
	key := "k"
	lead := leadOrFail(t, c, key)
	c.complete(key, "local", lead, seriesResult(7), "exec-1", nil, true)

	hit, join, flight := c.claim(key)
	require.NotNil(t, hit)
	require.Nil(t, join)
	require.Nil(t, flight)
	require.Equal(t, "exec-1", hit.executionID)
	require.Equal(t, 7.0, *hit.result.Series[0].Points[0].Value)

	clock.Advance(resultCacheTTL - time.Millisecond)
	require.NotNil(t, first(c.claim(key)), "still served just before the TTL")

	clock.Advance(time.Millisecond)
	hit, join, flight = c.claim(key)
	require.Nil(t, hit, "an entry is not served at its TTL")
	require.Nil(t, join)
	require.NotNil(t, flight, "an expired entry makes the caller the leader again")
}

// first returns the hit of a claim, so a test can assert on it inline.
func first(hit *resultEntry, _, _ *resultFlight) *resultEntry { return hit }

func TestResultCacheEvictsLeastRecentlyUsedByBytes(t *testing.T) {
	t.Parallel()
	cost := resultCost(seriesResult(0))
	// Room for two entries of this cost, but not three.
	c, metrics, _ := newTestResultCache(t, 2*cost+cost/2)
	for _, key := range []string{"a", "b"} {
		c.complete(key, "local", leadOrFail(t, c, key), seriesResult(1), "e", nil, true)
	}
	// Touch "a" so "b" is the least recently used.
	require.NotNil(t, first(c.claim("a")))
	c.complete("c", "local", leadOrFail(t, c, "c"), seriesResult(1), "e", nil, true)

	require.NotNil(t, first(c.claim("a")), "a recently used entry stays")
	require.NotNil(t, first(c.claim("c")))
	require.Nil(t, first(c.claim("b")), "the least recently used entry is evicted")
	require.Equal(t, 1, metrics.evictions["capacity"])
	require.LessOrEqual(t, metrics.bytes, 2*cost+cost/2)
}

func TestResultCacheBoundsEntryCount(t *testing.T) {
	t.Parallel()
	c, metrics, _ := newTestResultCache(t, 1<<30)
	for i := range resultCacheMaxEntries + 1 {
		key := fmt.Sprintf("k%d", i)
		c.complete(key, "local", leadOrFail(t, c, key), seriesResult(1), "e", nil, true)
	}
	require.Equal(t, resultCacheMaxEntries, metrics.entries)
	require.Equal(t, 1, metrics.evictions["capacity"])
	require.Nil(t, first(c.claim("k0")), "the oldest entry is the one evicted by the count bound")
}

func TestResultCacheRefusesOversizeEntries(t *testing.T) {
	t.Parallel()
	c, metrics, _ := newTestResultCache(t, 16<<20)
	big := &QueryResult{Series: []Series{{Name: strings.Repeat("n", resultCacheMaxEntryBytes+1)}}}
	c.complete("big", "local", leadOrFail(t, c, "big"), big, "e", nil, true)
	require.Nil(t, first(c.claim("big")), "an entry over one megabyte is not stored")
	require.Equal(t, 1, metrics.evictions["oversize"])
	require.Zero(t, metrics.entries)
}

func TestResultCacheJoinerReceivesTheLeadersValue(t *testing.T) {
	t.Parallel()
	c, _, _ := newTestResultCache(t, 16<<20)
	lead := leadOrFail(t, c, "k")
	hit, join, flight := c.claim("k")
	require.Nil(t, hit)
	require.Nil(t, flight)
	require.NotNil(t, join, "a second caller joins the flight in progress")

	done := make(chan *resultEntry, 1)
	go func() {
		entry, err := join.wait(t.Context())
		if err != nil {
			t.Errorf("join.wait: %v", err)
		}
		done <- entry
	}()
	c.complete("k", "local", lead, seriesResult(42), "exec-9", nil, false)
	entry := <-done
	require.Equal(t, 42.0, *entry.result.Series[0].Points[0].Value)
	require.Equal(t, "exec-9", entry.executionID)
	require.Nil(t, first(c.claim("k")), "a result that is not kept is shared with joiners only")
}

func TestResultCacheRecoversAfterACanceledLeader(t *testing.T) {
	t.Parallel()
	c, _, _ := newTestResultCache(t, 16<<20)
	lead := leadOrFail(t, c, "k")
	_, join, _ := c.claim("k")
	require.NotNil(t, join)

	c.complete("k", "local", lead, nil, "", context.Canceled, true)
	_, err := join.wait(t.Context())
	require.ErrorIs(t, err, context.Canceled, "joiners see the leader's cancellation, so they can re-claim")

	// The flight is gone and nothing was stored, so the next caller leads a fresh execution.
	leadOrFail(t, c, "k")
}

func TestResultCacheSharesAProviderErrorWithJoinersButStoresNothing(t *testing.T) {
	t.Parallel()
	c, _, _ := newTestResultCache(t, 16<<20)
	lead := leadOrFail(t, c, "k")
	_, join, _ := c.claim("k")
	providerErr := errors.New("provider failed")
	c.complete("k", "local", lead, nil, "", providerErr, true)
	_, err := join.wait(t.Context())
	require.ErrorIs(t, err, providerErr)
	require.Nil(t, first(c.claim("k")), "an error is never stored")
}

func TestResultCacheWaitHonoursItsContext(t *testing.T) {
	t.Parallel()
	c, _, _ := newTestResultCache(t, 16<<20)
	leadOrFail(t, c, "k")
	_, join, _ := c.claim("k")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := join.wait(ctx)
	require.ErrorIs(t, err, context.Canceled)
}

func TestResultCacheForgetProviderDropsOnlyItsEntries(t *testing.T) {
	t.Parallel()
	c, metrics, _ := newTestResultCache(t, 16<<20)
	c.complete("a", "prom-a", leadOrFail(t, c, "a"), seriesResult(1), "e", nil, true)
	c.complete("b", "prom-b", leadOrFail(t, c, "b"), seriesResult(1), "e", nil, true)
	c.forgetProvider("prom-a")
	require.Nil(t, first(c.claim("a")))
	require.NotNil(t, first(c.claim("b")))
	require.Equal(t, 1, metrics.evictions["invalidated"])
}

func TestResultCacheStoresWithoutDiagnostics(t *testing.T) {
	t.Parallel()
	c, _, _ := newTestResultCache(t, 16<<20)
	r := seriesResult(3)
	r.Diagnostics = &QueryDiagnostics{}
	c.put("k", "local", r, "exec")
	hit := first(c.claim("k"))
	require.NotNil(t, hit)
	require.Nil(t, hit.result.Diagnostics, "a receipt describes one request and is never replayed")
}

func TestKeepableRules(t *testing.T) {
	t.Parallel()
	now := time.Unix(1_700_000_100, 0)
	pastEnd := &Query{End: 1_700_000_000}
	liveEnd := &Query{End: 1_700_000_200}
	rowLimit := &QueryResult{Truncated: true, Truncation: &QueryTruncation{Reason: "row_limit", Limit: 10}}
	partial := &QueryResult{Truncated: true, Truncation: &QueryTruncation{Reason: "partial"}}
	require.False(t, keepable(nil, pastEnd, now))
	require.True(t, keepable(&QueryResult{}, pastEnd, now))
	require.True(t, keepable(rowLimit, pastEnd, now), "a row limit is what the query asked for")
	require.False(t, keepable(partial, pastEnd, now), "a partial response is never kept")
	require.False(t, keepable(&QueryResult{}, liveEnd, now), "a window that reaches the present moves, so it is not kept")
}

func TestResultKeyAndScope(t *testing.T) {
	t.Parallel()
	q := &Query{ProviderID: "observe-x", Kind: "metrics", Query: "up", Start: 1, End: 2, Step: 1}
	same := *q
	require.Equal(t, resultKey("local", q), resultKey("local", &same))
	require.NotEqual(t, resultKey("local", q), resultKey("other", q), "a different authorization scope never shares a key")
	other := *q
	other.Query = "down"
	require.NotEqual(t, resultKey("local", q), resultKey("local", &other))

	require.Equal(t, "local", resultScope(&providerClient{}))
	require.Equal(t, "", resultScope(&providerClient{remote: &observeProvider{}}), "a shared provider with no scope is not shared")
	require.Equal(t, strings.Repeat("a", 64), resultScope(&providerClient{remote: &observeProvider{scope: strings.Repeat("a", 64)}}))
}

// Callers that share a scope share one execution, and callers with different scopes never do.
// An empty scope is never keyed: resultScope returns "" and the caller must bypass the cache.
func TestResultCacheCallersWithDifferentScopesNeverShare(t *testing.T) {
	t.Parallel()
	c, _, _ := newTestResultCache(t, 16<<20)
	q := &Query{ProviderID: "observe-x", Kind: "metrics", Query: "up", Start: 1, End: 2, Step: 1}
	alice := resultKey(strings.Repeat("a", 64), q)
	bob := resultKey(strings.Repeat("b", 64), q)
	c.complete(alice, "observe-x", leadOrFail(t, c, alice), seriesResult(1), "exec-alice", nil, true)
	hit, join, lead := c.claim(bob)
	require.Nil(t, hit, "bob must not be served alice's result")
	require.Nil(t, join)
	require.NotNil(t, lead, "bob leads his own execution")
	c.complete(bob, "observe-x", lead, seriesResult(2), "exec-bob", nil, true)
}

// A refresh that bypasses the cache must never be answered from it: the bypass goes
// straight to a leader and does not look up the stored entry.
func TestResultCacheRefreshBypassNeverServesCachedData(t *testing.T) {
	t.Parallel()
	c, _, _ := newTestResultCache(t, 16<<20)
	c.complete("k", "local", leadOrFail(t, c, "k"), seriesResult(1), "old", nil, true)
	// The caller on a refresh does not call claim. It runs its own execution and stores the outcome.
	c.put("k", "local", seriesResult(2), "new")
	hit := first(c.claim("k"))
	require.NotNil(t, hit)
	require.Equal(t, 2.0, *hit.result.Series[0].Points[0].Value, "after a refresh the next caller sees the refreshed result")
	require.Equal(t, "new", hit.executionID)
}

func TestResultCacheRaceHasOneLeaderAndSharedValue(t *testing.T) {
	t.Parallel()
	c, _, _ := newTestResultCache(t, 16<<20)
	const callers = 64
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		leaders []*resultFlight
		joiners []*resultFlight
	)
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			hit, join, lead := c.claim("shared")
			mu.Lock()
			defer mu.Unlock()
			switch {
			case hit != nil:
			case join != nil:
				joiners = append(joiners, join)
			case lead != nil:
				leaders = append(leaders, lead)
			}
		}()
	}
	wg.Wait()
	require.Len(t, leaders, 1, "exactly one caller executes")
	c.complete("shared", "local", leaders[0], seriesResult(5), "exec", nil, true)

	var waiters sync.WaitGroup
	for _, join := range joiners {
		waiters.Add(1)
		go func() {
			defer waiters.Done()
			entry, err := join.wait(t.Context())
			if err != nil || *entry.result.Series[0].Points[0].Value != 5 {
				t.Errorf("joiner got %v, %v", entry, err)
			}
		}()
	}
	waiters.Wait()
	require.Equal(t, callers-1, len(joiners))
}

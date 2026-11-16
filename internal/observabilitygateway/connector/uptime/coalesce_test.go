package uptime

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"weak"

	"github.com/go-logr/logr/funcr"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector/httphelp"
)

// fakeClock drives cache expiry deterministically. Tests install it before
// any goroutine uses the caches.
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

// isolateCaches swaps in empty read and token caches on a fake clock and
// restores the package defaults when the test ends.
func isolateCaches(t *testing.T) *fakeClock {
	t.Helper()
	clock := &fakeClock{now: time.Date(2026, 11, 15, 9, 0, 0, 0, time.UTC)}
	oldReads, oldTokens := reads, tokens
	reads = newCoalescer[[]byte](maxCachedEntries, func(body []byte) int { return len(body) })
	reads.now = clock.Now
	tokens = newCoalescer[string](maxCachedEntries, func(token string) int { return len(token) })
	tokens.now = clock.Now
	t.Cleanup(func() { reads, tokens = oldReads, oldTokens })
	return clock
}

// sloQueries are six distinct dashboard queries that all issue the same
// GetSLODashboard{windowDays:30} upstream call.
var sloQueries = []string{
	`{"operation":"slo","args":{"windowDays":30}}`,
	`{"operation":"slo","args":{"windowDays":30,"breachedOnly":true}}`,
	`{"operation":"slo_summary","args":{"windowDays":30}}`,
	`{"operation":"slo","args":{"windowDays":30,"limit":5}}`,
	`{"operation":"slo","args":{"windowDays":30,"limit":10}}`,
	`{"operation":"slo_summary"}`,
}

// countingUptime serves the SLO procedure after delay and counts upstream calls.
func countingUptime(t *testing.T, delay time.Duration, status int) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		select {
		case <-time.After(delay):
		case <-r.Context().Done():
			return
		}
		if status != http.StatusOK {
			w.WriteHeader(status)
			return
		}
		writeJSON(t, w, `{"services":[{"serviceId":"`+testService+`","serviceName":"Checkout","slaTarget":99.9,"currentUptime":99.95,"totalChecks":10,"failedChecks":0}]}`)
	}))
	t.Cleanup(server.Close)
	return server, &calls
}

func runQueries(t *testing.T, endpoint string, queries []string, credentials []string) []*connector.QueryResult {
	t.Helper()
	results := make([]*connector.QueryResult, len(queries))
	errs := make([]error, len(queries))
	var wg sync.WaitGroup
	for i, expression := range queries {
		wg.Add(1)
		go func(i int, expression string) {
			defer wg.Done()
			req := testRequest(t, endpoint, expression)
			if credentials != nil {
				req.Credentials = []byte(credentials[i])
			}
			results[i], errs[i] = New().Query(context.Background(), req)
		}(i, expression)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("query %d: %v", i, err)
		}
	}
	return results
}

func TestSixIdenticalConcurrentQueriesMakeOneUpstreamRequest(t *testing.T) {
	isolateCaches(t)
	server, calls := countingUptime(t, 200*time.Millisecond, http.StatusOK)
	start := time.Now()
	results := runQueries(t, server.URL, sloQueries, nil)
	elapsed := time.Since(start)
	for i, result := range results {
		if result.State != connector.StateOK {
			t.Fatalf("query %d state = %s", i, result.State)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("upstream calls = %d, want 1", got)
	}
	if elapsed > time.Second {
		t.Fatalf("six queries took %s; want about one upstream delay", elapsed)
	}
}

func TestIdenticalReadsWithinTTLAreServedFromCache(t *testing.T) {
	clock := isolateCaches(t)
	server, calls := countingUptime(t, 0, http.StatusOK)
	runQueries(t, server.URL, sloQueries[:1], nil)
	clock.Advance(14 * time.Second)
	runQueries(t, server.URL, sloQueries[:1], nil)
	if got := calls.Load(); got != 1 {
		t.Fatalf("upstream calls within TTL = %d, want 1", got)
	}
}

func TestReadCacheTTLExpires(t *testing.T) {
	clock := isolateCaches(t)
	server, calls := countingUptime(t, 0, http.StatusOK)
	runQueries(t, server.URL, sloQueries[:1], nil)
	clock.Advance(readCacheTTL)
	runQueries(t, server.URL, sloQueries[:1], nil)
	if got := calls.Load(); got != 2 {
		t.Fatalf("upstream calls after TTL = %d, want 2", got)
	}
}

func TestDifferentCredentialsMakeSeparateRequests(t *testing.T) {
	isolateCaches(t)
	server, calls := countingUptime(t, 0, http.StatusOK)
	credentials := []string{"bearer-tenant-a", "bearer-tenant-b"}
	runQueries(t, server.URL, sloQueries[:2], credentials)
	if got := calls.Load(); got != 2 {
		t.Fatalf("upstream calls for two credentials = %d, want 2", got)
	}
}

func TestDifferentBodiesMakeSeparateRequests(t *testing.T) {
	isolateCaches(t)
	server, calls := countingUptime(t, 0, http.StatusOK)
	other := `{"operation":"slo","args":{"windowDays":90}}`
	runQueries(t, server.URL, []string{sloQueries[0], other}, nil)
	if got := calls.Load(); got != 2 {
		t.Fatalf("upstream calls for two windows = %d, want 2", got)
	}
}

func TestErrorsAreNotCached(t *testing.T) {
	isolateCaches(t)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		writeJSON(t, w, `{"services":[]}`)
	}))
	defer server.Close()
	first, err := New().Query(context.Background(), testRequest(t, server.URL, sloQueries[0]))
	if err != nil || first.State != connector.StateError {
		t.Fatalf("first result = %#v, %v; want error state", first, err)
	}
	second, err := New().Query(context.Background(), testRequest(t, server.URL, sloQueries[0]))
	if err != nil || second.State != connector.StateOK {
		t.Fatalf("second result = %#v, %v; want OK after a failed read", second, err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("upstream calls = %d, want 2 (error must not be cached)", got)
	}
}

func TestCancelledWaiterDoesNotCancelOthers(t *testing.T) {
	isolateCaches(t)
	release := make(chan struct{})
	var calls atomic.Int32
	reached := make(chan struct{}, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		reached <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		writeJSON(t, w, `{"services":[]}`)
	}))
	defer server.Close()
	var releaseOnce sync.Once
	releaseAll := func() { releaseOnce.Do(func() { close(release) }) }
	defer releaseAll()

	patient := make(chan *connector.QueryResult, 1)
	patientErr := make(chan error, 1)
	go func() {
		result, err := New().Query(context.Background(), testRequest(t, server.URL, sloQueries[0]))
		patient <- result
		patientErr <- err
	}()
	<-reached

	impatientCtx, cancel := context.WithCancel(context.Background())
	impatient := make(chan *connector.QueryResult, 1)
	go func() {
		result, _ := New().Query(impatientCtx, testRequest(t, server.URL, sloQueries[0]))
		impatient <- result
	}()
	// Give the second caller time to join the in-flight read before it leaves.
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case result := <-impatient:
		if result == nil || result.State != connector.StateError {
			t.Fatalf("cancelled waiter result = %#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled waiter did not return")
	}

	releaseAll()
	if result := <-patient; result == nil || result.State != connector.StateOK {
		t.Fatalf("remaining waiter result = %#v", result)
	}
	if err := <-patientErr; err != nil {
		t.Fatal(err)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("upstream calls = %d, want 1", got)
	}
}

func TestCoalescerBoundsEntriesAndEvictsLeastRecentlyUsed(t *testing.T) {
	clock := &fakeClock{now: time.Unix(0, 0)}
	c := newCoalescer[string](2, func(value string) int { return len(value) })
	c.now = clock.Now
	fetch := func(value string) func(context.Context) (string, time.Duration, error) {
		return func(context.Context) (string, time.Duration, error) { return value, time.Minute, nil }
	}
	ctx := context.Background()
	for _, key := range []string{"a", "b"} {
		if _, err := c.do(ctx, "test", key, time.Second, fetch(key)); err != nil {
			t.Fatal(err)
		}
	}
	// Touch "a" so "b" becomes the least recently used entry.
	if _, err := c.do(ctx, "test", "a", time.Second, fetch("unused")); err != nil {
		t.Fatal(err)
	}
	if _, err := c.do(ctx, "test", "c", time.Second, fetch("c")); err != nil {
		t.Fatal(err)
	}
	if len(c.entries) != 2 {
		t.Fatalf("entries = %d, want bound of 2", len(c.entries))
	}
	var fetches atomic.Int32
	counted := func(value string) func(context.Context) (string, time.Duration, error) {
		return func(context.Context) (string, time.Duration, error) {
			fetches.Add(1)
			return value, time.Minute, nil
		}
	}
	// "b" was least recently used, so it was evicted and must be fetched again.
	if _, err := c.do(ctx, "test", "b", time.Second, counted("b")); err != nil {
		t.Fatal(err)
	}
	if fetches.Load() != 1 {
		t.Fatal("least recently used entry was not evicted")
	}
	// Refetching "b" pushed out "a", the least recently used entry at that
	// point. "c" was inserted after "a" and is still kept, so it is a hit.
	if _, err := c.do(ctx, "test", "c", time.Second, counted("c")); err != nil {
		t.Fatal(err)
	}
	if fetches.Load() != 1 {
		t.Fatal("most recently inserted entry was evicted")
	}
}

func TestCoalescerKeepsNothingForErrorsOrZeroTTL(t *testing.T) {
	c := newCoalescer[int](maxCachedEntries, func(int) int { return 1 })
	var calls atomic.Int32
	failing := func(context.Context) (int, time.Duration, error) {
		calls.Add(1)
		return 0, time.Minute, context.DeadlineExceeded
	}
	for range 2 {
		if _, err := c.do(context.Background(), "test", "k", time.Second, failing); err == nil {
			t.Fatal("error not returned")
		}
	}
	unkept := func(context.Context) (int, time.Duration, error) {
		calls.Add(1)
		return 1, 0, nil
	}
	for range 2 {
		if _, err := c.do(context.Background(), "test", "z", time.Second, unkept); err != nil {
			t.Fatal(err)
		}
	}
	if got := calls.Load(); got != 4 {
		t.Fatalf("fetch calls = %d, want 4", got)
	}
}

func TestFirebaseTokenIsReusedUntilNearExpiry(t *testing.T) {
	clock := isolateCaches(t)
	var refreshes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := refreshes.Add(1)
		writeJSON(t, w, `{"id_token":"token-`+strconv.Itoa(int(n))+`","expires_in":"3600"}`)
	}))
	defer server.Close()
	client := tokenTestClient(t, server)
	raw := []byte(`{"apiKey":"key-near-expiry","refreshToken":"refresh-near-expiry"}`)

	token, err := bearerCredential(context.Background(), raw, client)
	if err != nil || token != "token-1" {
		t.Fatalf("first token = %q, %v", token, err)
	}
	// Still inside the refresh margin's safe window: the token is reused.
	clock.Advance(time.Hour - tokenRefreshMargin - time.Second)
	token, err = bearerCredential(context.Background(), raw, client)
	if err != nil || token != "token-1" || refreshes.Load() != 1 {
		t.Fatalf("token reused before margin = %q after %d refreshes, %v", token, refreshes.Load(), err)
	}
	// Two seconds later the token is inside the margin, so it is refreshed.
	clock.Advance(2 * time.Second)
	token, err = bearerCredential(context.Background(), raw, client)
	if err != nil || token != "token-2" || refreshes.Load() != 2 {
		t.Fatalf("token not refreshed near expiry = %q after %d refreshes, %v", token, refreshes.Load(), err)
	}
}

func TestConcurrentFirebaseRefreshesShareOneRequest(t *testing.T) {
	isolateCaches(t)
	var refreshes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		refreshes.Add(1)
		time.Sleep(100 * time.Millisecond)
		writeJSON(t, w, `{"id_token":"shared-token","expires_in":"3600"}`)
	}))
	defer server.Close()
	client := tokenTestClient(t, server)
	raw := []byte(`{"apiKey":"key-shared","refreshToken":"refresh-shared"}`)
	var wg sync.WaitGroup
	for range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if token, err := bearerCredential(context.Background(), raw, client); err != nil || token != "shared-token" {
				t.Errorf("token = %q, %v", token, err)
			}
		}()
	}
	wg.Wait()
	if got := refreshes.Load(); got != 1 {
		t.Fatalf("refreshes = %d, want 1", got)
	}
}

func TestReadKeySeparatesCredentialsAndHeaders(t *testing.T) {
	base := backend{config: &config{Config: httphelp.Config{Endpoint: "https://example.invalid", Headers: map[string]string{"X-Scope-OrgID": "tenant"}}}, identity: credentialIdentity([]byte("bearer-a"))}
	body := []byte(`{"orgId":"x"}`)
	key, err := base.readKey("https://example.invalid/rpc", body)
	if err != nil {
		t.Fatal(err)
	}
	if len(key) != 64 || strings.Contains(key, "bearer-a") {
		t.Fatalf("read key %q has unexpected shape", key)
	}
	other := base
	other.identity = credentialIdentity([]byte("bearer-b"))
	if otherKey, _ := other.readKey("https://example.invalid/rpc", body); otherKey == key {
		t.Fatal("different credentials produced the same read key")
	}
	headers := base
	headers.config = &config{Config: httphelp.Config{Endpoint: "https://example.invalid", Headers: map[string]string{"X-Scope-OrgID": "tenant-2"}}}
	if headerKey, _ := headers.readKey("https://example.invalid/rpc", body); headerKey == key {
		t.Fatal("different tenant headers produced the same read key")
	}
}

// The first caller starts the shared read and then cancels. A later waiter
// with a live context must still receive the result: the read must not run on
// the first caller's context.
func TestFirstCallerCancelDoesNotFailLaterWaiter(t *testing.T) {
	isolateCaches(t)
	release := make(chan struct{})
	reached := make(chan struct{}, 4)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		reached <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		writeJSON(t, w, `{"services":[]}`)
	}))
	defer server.Close()
	var once sync.Once
	releaseAll := func() { once.Do(func() { close(release) }) }
	defer releaseAll()

	originCtx, cancelOrigin := context.WithCancel(context.Background())
	origin := make(chan *connector.QueryResult, 1)
	go func() {
		result, _ := New().Query(originCtx, testRequest(t, server.URL, sloQueries[0]))
		origin <- result
	}()
	<-reached
	later := make(chan *connector.QueryResult, 1)
	go func() {
		result, _ := New().Query(context.Background(), testRequest(t, server.URL, sloQueries[0]))
		later <- result
	}()
	time.Sleep(100 * time.Millisecond)
	cancelOrigin()
	if result := <-origin; result == nil || result.State != connector.StateError {
		t.Fatalf("cancelled origin result = %#v", result)
	}
	releaseAll()
	if result := <-later; result == nil || result.State != connector.StateOK {
		t.Fatalf("later waiter result = %#v; the first caller's cancellation failed it", result)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("upstream calls = %d, want 1", got)
	}
}

// The shared read is bounded by its own timeout, not by any caller's context.
func TestSharedFetchIsBoundedByTimeout(t *testing.T) {
	c := newCoalescer[int](maxCachedEntries, func(int) int { return 1 })
	start := time.Now()
	_, err := c.do(context.Background(), "test", "slow", 50*time.Millisecond, func(ctx context.Context) (int, time.Duration, error) {
		select {
		case <-ctx.Done():
			return 0, 0, ctx.Err()
		case <-time.After(5 * time.Second):
			return 1, time.Minute, nil
		}
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("shared fetch error = %v, want deadline exceeded", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("shared fetch ran %s; the 50ms timeout did not bound it", elapsed)
	}
}

func TestEndedCallerDoesNotStartFetch(t *testing.T) {
	c := newCoalescer[int](maxCachedEntries, func(int) int { return 1 })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	// The fetch blocks until the test ends, so a fetch that wrongly starts is
	// visible at once without relying on a goroutine finishing first.
	gate := make(chan struct{})
	t.Cleanup(func() { close(gate) })
	started := make(chan struct{}, 1)
	_, err := c.do(ctx, "test", "k", time.Second, func(context.Context) (int, time.Duration, error) {
		started <- struct{}{}
		<-gate
		return 1, time.Minute, nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context canceled", err)
	}
	select {
	case <-started:
		t.Fatal("an ended caller started a fetch")
	case <-time.After(200 * time.Millisecond):
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.inflight) != 0 {
		t.Fatalf("in-flight reads = %d, want 0", len(c.inflight))
	}
}

// A 200 whose body has the wrong shape is an error for every caller and is
// never kept, so the next query reaches the upstream again.
func TestWrongShapedBodyIsNotCached(t *testing.T) {
	isolateCaches(t)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			writeJSON(t, w, `{"services":"temporarily unavailable"}`)
			return
		}
		writeJSON(t, w, `{"services":[]}`)
	}))
	defer server.Close()
	first, err := New().Query(context.Background(), testRequest(t, server.URL, sloQueries[0]))
	if err != nil || first.State != connector.StateError {
		t.Fatalf("wrong-shaped body result = %#v, %v; want error state", first, err)
	}
	second, err := New().Query(context.Background(), testRequest(t, server.URL, sloQueries[0]))
	if err != nil || second.State != connector.StateOK {
		t.Fatalf("second result = %#v, %v; want OK", second, err)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("upstream calls = %d, want 2", got)
	}
}

func TestExpiredEntriesAreDroppedOnNextAccessOrInsert(t *testing.T) {
	clock := &fakeClock{now: time.Unix(0, 0)}
	c := newCoalescer[string](maxCachedEntries, func(value string) int { return len(value) })
	c.now = clock.Now
	ctx := context.Background()
	if _, err := c.do(ctx, "test", "short", time.Second, func(context.Context) (string, time.Duration, error) {
		return "value", time.Minute, nil
	}); err != nil {
		t.Fatal(err)
	}
	clock.Advance(2 * time.Minute)
	// An expired key is not served, and its value is dropped on this access.
	var fetches atomic.Int32
	if _, err := c.do(ctx, "test", "short", time.Second, func(context.Context) (string, time.Duration, error) {
		fetches.Add(1)
		return "fresh", time.Minute, nil
	}); err != nil {
		t.Fatal(err)
	}
	if fetches.Load() != 1 {
		t.Fatal("expired value was served")
	}
	// Another insert drops any other expired value, so nothing expired remains.
	if _, err := c.do(ctx, "test", "stale", time.Second, func(context.Context) (string, time.Duration, error) {
		return "old", time.Minute, nil
	}); err != nil {
		t.Fatal(err)
	}
	clock.Advance(2 * time.Minute)
	if _, err := c.do(ctx, "test", "next", time.Second, func(context.Context) (string, time.Duration, error) {
		return "new", time.Minute, nil
	}); err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) != 1 || c.bytes != len("new") {
		t.Fatalf("kept after expiry: %d entries, %d bytes; want only the newest value", len(c.entries), c.bytes)
	}
}

// Values are bounded by bytes as well as count, and an oversized value is
// returned to its caller but never kept.
func TestCoalescerBoundsBytesAndSkipsOversizedValues(t *testing.T) {
	clock := &fakeClock{now: time.Unix(0, 0)}
	c := newCoalescer[[]byte](maxCachedEntries, func(value []byte) int { return len(value) })
	c.now = clock.Now
	block := make([]byte, 200<<10)
	for i := range 60 {
		key := strconv.Itoa(i)
		if _, err := c.do(context.Background(), "test", key, time.Second, func(context.Context) ([]byte, time.Duration, error) {
			return block, time.Minute, nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	if c.bytes > c.maxBytes || c.bytes != len(c.entries)*len(block) {
		t.Fatalf("bytes = %d over %d entries, budget %d", c.bytes, len(c.entries), c.maxBytes)
	}
	var fetches atomic.Int32
	big := make([]byte, maxEntryBytes+1)
	for range 2 {
		if _, err := c.do(context.Background(), "test", "big", time.Second, func(context.Context) ([]byte, time.Duration, error) {
			fetches.Add(1)
			return big, time.Minute, nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	if got := fetches.Load(); got != 2 {
		t.Fatalf("oversized value fetches = %d, want 2 (not kept)", got)
	}
}

// Dropping a rejected token makes the next query refresh it.
func TestForgetDropsKeptValue(t *testing.T) {
	c := newCoalescer[string](maxCachedEntries, func(value string) int { return len(value) })
	var fetches atomic.Int32
	fetch := func(context.Context) (string, time.Duration, error) {
		fetches.Add(1)
		return "token", time.Minute, nil
	}
	for range 2 {
		if _, err := c.do(context.Background(), "test", "k", time.Second, fetch); err != nil {
			t.Fatal(err)
		}
		c.forget("k")
	}
	if got := fetches.Load(); got != 2 {
		t.Fatalf("fetches = %d, want 2 after forget", got)
	}
}

// Two Firebase credentials must each get their own ID token, never one
// tenant's token served to another.
func TestFirebaseTokensAreSeparatedByCredential(t *testing.T) {
	isolateCaches(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		writeJSON(t, w, `{"id_token":"token-for-`+r.PostForm.Get("refresh_token")+`","expires_in":"3600"}`)
	}))
	defer server.Close()
	client := tokenTestClient(t, server)
	a, errA := bearerCredential(context.Background(), []byte(`{"apiKey":"shared-key","refreshToken":"tenant-a"}`), client)
	b, errB := bearerCredential(context.Background(), []byte(`{"apiKey":"shared-key","refreshToken":"tenant-b"}`), client)
	if errA != nil || errB != nil || a != "token-for-tenant-a" || b != "token-for-tenant-b" {
		t.Fatalf("tokens a=%q (%v) b=%q (%v)", a, errA, b, errB)
	}
}

// Membership is checked on every reliability read, not from the read cache: a
// services read kept a moment earlier must not admit a revoked caller.
func TestReliabilityMembershipIsNotServedFromCache(t *testing.T) {
	isolateCaches(t)
	var services, reports atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case servicesRPC:
			if services.Add(1) > 1 {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			writeJSON(t, w, `{"services":[]}`)
		case reliabilityRPC:
			reports.Add(1)
			writeJSON(t, w, `{"latestReport":null}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	if result, err := New().Query(context.Background(), testRequest(t, server.URL, `{"operation":"services","args":{"limit":1}}`)); err != nil || result.State != connector.StateOK {
		t.Fatalf("services read = %#v, %v", result, err)
	}
	result, err := New().Query(context.Background(), testRequest(t, server.URL, `{"operation":"reliability_summary"}`))
	if err != nil || result.State != connector.StateForbidden {
		t.Fatalf("revoked reliability read = %#v, %v; want Forbidden", result, err)
	}
	if got := reports.Load(); got != 0 {
		t.Fatalf("report reads = %d, want 0 after the membership refusal", got)
	}
}

// eventually polls cond until it holds or two seconds pass.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// When the last waiter leaves, the shared fetch is cancelled, its goroutine
// exits, and the flight is forgotten so a later caller starts a fresh fetch.
func TestLastWaiterLeavingStopsFetchAndForgetsFlight(t *testing.T) {
	c := newCoalescer[int](maxCachedEntries, func(int) int { return 1 })
	var running atomic.Int32
	started := make(chan struct{}, 1)
	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() {
		_, err := c.do(ctx, "test", "k", time.Minute, func(fetchCtx context.Context) (int, time.Duration, error) {
			running.Add(1)
			defer running.Add(-1)
			started <- struct{}{}
			<-fetchCtx.Done()
			return 0, 0, fetchCtx.Err()
		})
		errc <- err
	}()
	<-started
	cancel()
	if err := <-errc; !errors.Is(err, context.Canceled) {
		t.Fatalf("waiter error = %v, want context canceled", err)
	}
	eventually(t, "the cancelled fetch to exit", func() bool { return running.Load() == 0 })
	c.mu.Lock()
	inflight := len(c.inflight)
	c.mu.Unlock()
	if inflight != 0 {
		t.Fatalf("in-flight reads after the last waiter left = %d, want 0", inflight)
	}
	value, err := c.do(context.Background(), "test", "k", time.Minute, func(context.Context) (int, time.Duration, error) {
		return 7, time.Minute, nil
	})
	if err != nil || value != 7 {
		t.Fatalf("later caller = %d, %v; want a fresh fetch", value, err)
	}
}

// The upstream request itself is cancelled once every waiter has left. While
// one waiter remains, the request keeps running.
func TestLastWaiterLeavingCancelsUpstreamRequest(t *testing.T) {
	isolateCaches(t)
	reached := make(chan struct{}, 4)
	cancelled := make(chan struct{}, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The server only notices a client disconnect once the request body is
		// consumed, so drain it before waiting on the request context.
		_, _ = io.Copy(io.Discard, r.Body)
		reached <- struct{}{}
		select {
		case <-r.Context().Done():
			cancelled <- struct{}{}
		case <-time.After(10 * time.Second):
			writeJSON(t, w, `{"services":[]}`)
		}
	}))
	defer server.Close()

	ctxA, cancelA := context.WithCancel(context.Background())
	ctxB, cancelB := context.WithCancel(context.Background())
	defer cancelB()
	done := make(chan *connector.QueryResult, 2)
	for _, ctx := range []context.Context{ctxA, ctxB} {
		go func() {
			result, _ := New().Query(ctx, testRequest(t, server.URL, sloQueries[0]))
			done <- result
		}()
	}
	<-reached
	time.Sleep(100 * time.Millisecond) // let the second waiter join the same read
	cancelA()
	select {
	case <-cancelled:
		t.Fatal("upstream request was cancelled while a waiter remained")
	case <-time.After(200 * time.Millisecond):
	}
	cancelB()
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request was not cancelled after the last waiter left")
	}
	for range 2 {
		if result := <-done; result == nil || result.State != connector.StateError {
			t.Fatalf("cancelled waiter result = %#v", result)
		}
	}
	if got := len(reached); got != 0 {
		t.Fatalf("unexpected extra upstream requests: %d", got)
	}
}

// A value removed by eviction is no longer reachable, so its memory can be
// reclaimed. Expired and evicted values are not held by any timer.
type blob struct{ data []byte }

func storeBlob(t *testing.T, c *coalescer[*blob], key string) weak.Pointer[blob] {
	t.Helper()
	b := &blob{data: make([]byte, 100<<10)}
	if _, err := c.do(context.Background(), "test", key, time.Second, func(context.Context) (*blob, time.Duration, error) {
		return b, time.Hour, nil
	}); err != nil {
		t.Fatal(err)
	}
	return weak.Make(b)
}

func TestEvictedValueIsNoLongerReferenced(t *testing.T) {
	c := newCoalescer[*blob](2, func(b *blob) int { return len(b.data) })
	evicted := storeBlob(t, c, "a")
	storeBlob(t, c, "b")
	storeBlob(t, c, "c") // the count bound of 2 evicts "a"
	for range 5 {
		if evicted.Value() == nil {
			break
		}
		runtime.GC()
	}
	if evicted.Value() != nil {
		t.Fatal("evicted value is still reachable from the cache")
	}
	runtime.KeepAlive(c)
}

// Every setting that changes which upstream answers, or how it is trusted, is
// part of the read key. Two providers that differ in any of them never share a
// kept or in-flight read.
func TestReadKeyCoversEverySettingThatChangesTheUpstream(t *testing.T) {
	type input struct {
		endpoint string
		headers  map[string]string
		insecure bool
		identity string
		body     string
	}
	base := input{
		endpoint: "https://uptime.example.com",
		headers:  map[string]string{"X-Scope-OrgID": "tenant"},
		identity: credentialIdentity([]byte("bearer-a")),
		body:     `{"orgId":"x"}`,
	}
	keyOf := func(in input) string {
		b := backend{config: &config{Config: httphelp.Config{Endpoint: in.endpoint, Headers: in.headers, InsecureSkipTLS: in.insecure}}, identity: in.identity}
		key, err := b.readKey(in.endpoint+"/rpc", []byte(in.body))
		if err != nil {
			t.Fatal(err)
		}
		return key
	}
	baseKey := keyOf(base)
	if len(baseKey) != 64 || strings.Contains(baseKey, "bearer-a") {
		t.Fatalf("read key %q has unexpected shape", baseKey)
	}
	mutants := map[string]func(*input){
		"endpoint":     func(in *input) { in.endpoint = "https://other.example.com" },
		"header value": func(in *input) { in.headers = map[string]string{"X-Scope-OrgID": "tenant-2"} },
		"header name":  func(in *input) { in.headers = map[string]string{"X-Other": "tenant"} },
		"insecure TLS": func(in *input) { in.insecure = true },
		"credential":   func(in *input) { in.identity = credentialIdentity([]byte("bearer-b")) },
		"body":         func(in *input) { in.body = `{"orgId":"y"}` },
	}
	for name, mutate := range mutants {
		in := base
		mutate(&in)
		if keyOf(in) == baseKey {
			t.Errorf("changing %s did not change the read key", name)
		}
	}
}

// Two providers with the same endpoint and credential but different TLS
// settings never share a result.
func TestInsecureTLSProviderDoesNotShareReadsWithStrictProvider(t *testing.T) {
	isolateCaches(t)
	server, calls := countingUptime(t, 0, http.StatusOK)
	strict := testRequest(t, server.URL, sloQueries[0])
	insecure := testRequest(t, server.URL, sloQueries[0])
	insecure.Config = []byte(`{"endpoint":"` + server.URL + `","orgId":"` + testOrg + `","insecureSkipTLS":true}`)
	for _, req := range []connector.QueryRequest{strict, insecure} {
		if result, err := New().Query(context.Background(), req); err != nil || result.State != connector.StateOK {
			t.Fatalf("query = %#v, %v", result, err)
		}
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("upstream calls = %d, want 2 (TLS settings must separate reads)", got)
	}
}

// A rejected Firebase ID token is dropped, so the next query refreshes it
// rather than sending the rejected token again.
func TestRejectedTokenIsForgottenSoNextQueryRefreshes(t *testing.T) {
	isolateCaches(t)
	var refreshes atomic.Int32
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := refreshes.Add(1)
		writeJSON(t, w, `{"id_token":"token-`+strconv.Itoa(int(n))+`","expires_in":"3600"}`)
	}))
	defer tokenServer.Close()
	tokenClient := tokenTestClient(t, tokenServer)
	oldClient := newCredentialClient
	newCredentialClient = func() *http.Client { return tokenClient }
	t.Cleanup(func() { newCredentialClient = oldClient })

	var mu sync.Mutex
	var authorizations []string
	var uptimeCalls atomic.Int32
	uptime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		authorizations = append(authorizations, r.Header.Get("Authorization"))
		mu.Unlock()
		if uptimeCalls.Add(1) == 1 {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		writeJSON(t, w, `{"services":[]}`)
	}))
	defer uptime.Close()

	req := testRequest(t, uptime.URL, sloQueries[0])
	req.Credentials = []byte(`{"apiKey":"key-forget","refreshToken":"refresh-forget"}`)
	first, err := New().Query(context.Background(), req)
	if err != nil || first.State != connector.StateForbidden {
		t.Fatalf("rejected query = %#v, %v; want Forbidden", first, err)
	}
	second, err := New().Query(context.Background(), req)
	if err != nil || second.State != connector.StateOK {
		t.Fatalf("second query = %#v, %v; want OK", second, err)
	}
	if got := refreshes.Load(); got != 2 {
		t.Fatalf("token refreshes = %d, want 2 (the rejected token must be dropped)", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(authorizations) != 2 || authorizations[1] != "Bearer token-2" {
		t.Fatalf("authorizations = %v, want the second query to send token-2", authorizations)
	}
}

// logSink collects the lines a funcr logger writes, for assertions.
type logSink struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (s *logSink) write(prefix, args string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.buf.WriteString(prefix + " " + args + "\n")
}

func (s *logSink) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

// An oversized value is skipped at V(1): it is logged with its operation,
// size and limit, and the log never carries the body.
func TestOversizeSkipIsLoggedAtVerbosityOneWithoutBody(t *testing.T) {
	const marker = "SECRET-BODY-MARKER"
	body := append([]byte(marker), make([]byte, maxEntryBytes)...)
	for _, verbosity := range []int{0, 1} {
		logs := &logSink{}
		c := newCoalescer[[]byte](maxCachedEntries, func(body []byte) int { return len(body) })
		c.log = funcr.New(logs.write, funcr.Options{Verbosity: verbosity})
		if _, err := c.do(context.Background(), "test-operation", "big", time.Second, func(context.Context) ([]byte, time.Duration, error) {
			return body, time.Minute, nil
		}); err != nil {
			t.Fatal(err)
		}
		out := logs.String()
		if verbosity == 0 {
			if out != "" {
				t.Fatalf("verbosity 0 logged %q; the skip must be V(1)", out)
			}
			continue
		}
		for _, want := range []string{
			"uptime read over the cache size limit was not kept",
			`"operation"="test-operation"`,
			`"bytes"=` + strconv.Itoa(len(body)),
			`"limit"=` + strconv.Itoa(maxEntryBytes),
		} {
			if !strings.Contains(out, want) {
				t.Fatalf("skip log missing %q:\n%s", want, out)
			}
		}
		if strings.Contains(out, marker) {
			t.Fatalf("skip log carries body bytes:\n%s", out)
		}
	}
}

// A panicking shared fetch fails every waiter with an error, nothing is kept,
// the panic value and stack are logged at error level, and the process survives.
func TestPanickingFetchFailsEveryWaiterAndIsLogged(t *testing.T) {
	c := newCoalescer[int](maxCachedEntries, func(int) int { return 1 })
	logs := &logSink{}
	c.log = funcr.New(logs.write, funcr.Options{Verbosity: 0})
	release := make(chan struct{})
	var fetches atomic.Int32
	const waiters = 3
	errs := make(chan error, waiters)
	for range waiters {
		go func() {
			_, err := c.do(context.Background(), "test-operation", "k", time.Minute, func(context.Context) (int, time.Duration, error) {
				fetches.Add(1)
				<-release
				panic("boom-from-fetch")
			})
			errs <- err
		}()
	}
	eventually(t, "every waiter joined the panicking flight", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		f := c.inflight["k"]
		return f != nil && f.refs == waiters
	})
	close(release)
	for range waiters {
		if err := <-errs; !errors.Is(err, errReadPanicked) {
			t.Fatalf("waiter error = %v, want the panic error", err)
		}
	}
	if got := fetches.Load(); got != 1 {
		t.Fatalf("fetches = %d, want 1 shared fetch", got)
	}
	out := logs.String()
	for _, want := range []string{"uptime read panicked", "boom-from-fetch", `"operation"="test-operation"`, "goroutine "} {
		if !strings.Contains(out, want) {
			t.Fatalf("panic log missing %q:\n%s", want, out)
		}
	}
	value, err := c.do(context.Background(), "test-operation", "k", time.Minute, func(context.Context) (int, time.Duration, error) {
		return 5, time.Minute, nil
	})
	if err != nil || value != 5 {
		t.Fatalf("after the panic = %d, %v; the failed flight must not be kept", value, err)
	}
}

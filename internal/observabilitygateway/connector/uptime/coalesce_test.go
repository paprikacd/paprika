package uptime

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

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
		if _, err := c.do(ctx, key, time.Second, fetch(key)); err != nil {
			t.Fatal(err)
		}
	}
	// Touch "a" so "b" becomes the least recently used entry.
	if _, err := c.do(ctx, "a", time.Second, fetch("unused")); err != nil {
		t.Fatal(err)
	}
	if _, err := c.do(ctx, "c", time.Second, fetch("c")); err != nil {
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
	if _, err := c.do(ctx, "b", time.Second, counted("b")); err != nil {
		t.Fatal(err)
	}
	if fetches.Load() != 1 {
		t.Fatal("least recently used entry was not evicted")
	}
	// Refetching "b" pushed out "a", the least recently used entry at that
	// point. "c" was inserted after "a" and is still kept, so it is a hit.
	if _, err := c.do(ctx, "c", time.Second, counted("c")); err != nil {
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
		if _, err := c.do(context.Background(), "k", time.Second, failing); err == nil {
			t.Fatal("error not returned")
		}
	}
	unkept := func(context.Context) (int, time.Duration, error) {
		calls.Add(1)
		return 1, 0, nil
	}
	for range 2 {
		if _, err := c.do(context.Background(), "z", time.Second, unkept); err != nil {
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
	_, err := c.do(context.Background(), "slow", 50*time.Millisecond, func(ctx context.Context) (int, time.Duration, error) {
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

// A caller that arrives with its context already ended does not start a read.
func TestEndedCallerDoesNotStartFetch(t *testing.T) {
	c := newCoalescer[int](maxCachedEntries, func(int) int { return 1 })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var fetches atomic.Int32
	_, err := c.do(ctx, "k", time.Second, func(context.Context) (int, time.Duration, error) {
		fetches.Add(1)
		return 1, time.Minute, nil
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context canceled", err)
	}
	if got := fetches.Load(); got != 0 {
		t.Fatalf("fetches = %d, want 0", got)
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

// Entries leave memory when they expire, even if no later query asks for them.
func TestExpiredEntriesAreRemovedWithoutAccess(t *testing.T) {
	c := newCoalescer[string](maxCachedEntries, func(value string) int { return len(value) })
	ctx := context.Background()
	if _, err := c.do(ctx, "short", time.Second, func(context.Context) (string, time.Duration, error) {
		return "value", 20 * time.Millisecond, nil
	}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.entries) != 0 || c.bytes != 0 {
		t.Fatalf("expired entries kept: %d entries, %d bytes", len(c.entries), c.bytes)
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
		if _, err := c.do(context.Background(), key, time.Second, func(context.Context) ([]byte, time.Duration, error) {
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
		if _, err := c.do(context.Background(), "big", time.Second, func(context.Context) ([]byte, time.Duration, error) {
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
		if _, err := c.do(context.Background(), "k", time.Second, fetch); err != nil {
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

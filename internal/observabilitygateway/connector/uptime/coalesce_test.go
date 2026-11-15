package uptime

import (
	"context"
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
	reads = newCoalescer[[]byte](maxCachedEntries)
	reads.now = clock.Now
	tokens = newCoalescer[string](maxCachedEntries)
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
	c := newCoalescer[string](2)
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
	c := newCoalescer[int](maxCachedEntries)
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

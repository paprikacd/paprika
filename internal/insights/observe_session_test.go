package insights

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// observeWireCounts observes the MCP wire without changing the fixtures: each
// initialize request opens one session, and each tools/call names its tool.
type observeWireCounts struct {
	mu         sync.Mutex
	operations map[string]int
}

func (c *observeWireCounts) count(key string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.operations[key]
}

// posts counts every JSON-RPC message the gateway received, including the
// initialize handshake, the initialized notification and discovery.
func (c *observeWireCounts) posts() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	total := 0
	for key, n := range c.operations {
		if strings.HasPrefix(key, "method:") {
			total += n
		}
	}
	return total
}

func (c *observeWireCounts) record(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.operations[key]++
}

type observeRoundTripFunc func(*http.Request) (*http.Response, error)

func (f observeRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func countObserveWire(s *Server) *observeWireCounts {
	counts := &observeWireCounts{operations: make(map[string]int)}
	base := s.observe.client.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	s.observe.client.Transport = observeRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Body != nil {
			body, err := io.ReadAll(r.Body)
			_ = r.Body.Close()
			if err != nil {
				return nil, err
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			var message struct {
				Method string `json:"method"`
				Params struct {
					Name string `json:"name"`
				} `json:"params"`
			}
			if json.Unmarshal(body, &message) == nil && message.Method != "" {
				counts.record("method:" + message.Method)
				switch {
				case message.Method == "initialize":
					counts.record("session")
				case message.Method == "tools/call":
					counts.record("tool:" + message.Params.Name)
				}
			}
		}
		return base.RoundTrip(r)
	})
	return counts
}

// observeCatalogAndQueryGateway serves a two-provider catalog and an OK metrics
// result. The catalog status lets a test simulate gateway saturation.
func observeCatalogAndQueryGateway(t *testing.T, catalogStatus int) *httptest.Server {
	t.Helper()
	return observeMCPTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/list_observability_providers":
			if catalogStatus != http.StatusOK {
				writeJSON(w, catalogStatus, map[string]any{"error": "catalog saturated"})
				return
			}
			writeJSON(w, 200, map[string]any{"providers": []observeCatalogProvider{{Name: "prod/prom", Namespace: "prod", Type: "prometheus"}}})
		case "/query_metrics":
			writeJSON(w, 200, map[string]any{"state": "OK", "data": json.RawMessage(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"service":"api"},"values":[[1700000000.25,"4.25"]]}]}}`)})
		default:
			t.Errorf("unexpected gateway path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func TestObserveWidgetQueryUsesOneMCPSession(t *testing.T) {
	gateway := observeCatalogAndQueryGateway(t, http.StatusOK)
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)
	counts := countObserveWire(s)
	w := request(t, s.Handler(), http.MethodPost, "/api/query", observeQueryBody(t, "prod/prom", "metrics"), observeHeaders("alice"))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	// One session carries both the catalog listing and the data call.
	assert.Equal(t, 1, counts.count("session"), "MCP sessions per widget query")
	assert.Equal(t, 1, counts.count("tool:list_observability_providers"), "catalog listings per widget query")
	assert.Equal(t, 1, counts.count("tool:query_metrics"), "data calls per widget query")
	assert.Zero(t, len(s.queries), "admission slot leaked")
}

func TestObserveCatalogBusyIsRetryableAndReleasesAdmission(t *testing.T) {
	gateway := observeCatalogAndQueryGateway(t, http.StatusTooManyRequests)
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)
	counts := countObserveWire(s)
	w := request(t, s.Handler(), http.MethodPost, "/api/query", observeQueryBody(t, "prod/prom", "metrics"), observeHeaders("alice"))
	assert.Equal(t, http.StatusTooManyRequests, w.Code, w.Body.String())
	assert.Equal(t, "1", w.Header().Get("Retry-After"))
	assert.Contains(t, w.Body.String(), "too many active observability requests; retry shortly")
	assert.Zero(t, counts.count("tool:query_metrics"), "data call after a failed catalog listing")
	assert.Zero(t, len(s.queries), "admission slot leaked after a catalog 429")
}

func TestObserveQueryAdmissionPrecedesCatalogResolution(t *testing.T) {
	gateway := observeCatalogAndQueryGateway(t, http.StatusOK)
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)
	s.queryWaitTimeout = time.Millisecond
	counts := countObserveWire(s)
	// Saturate Insights query admission; the catalog must not be consulted for work that is rejected.
	for range cap(s.queries) {
		s.queries <- struct{}{}
	}
	w := request(t, s.Handler(), http.MethodPost, "/api/query", observeQueryBody(t, "prod/prom", "metrics"), observeHeaders("alice"))
	assert.Equal(t, http.StatusTooManyRequests, w.Code, w.Body.String())
	assert.Equal(t, "1", w.Header().Get("Retry-After"))
	assert.Zero(t, counts.count("session"), "saturated admission opened an MCP session")
	assert.Zero(t, counts.count("tool:list_observability_providers"), "saturated admission listed the catalog")
	for range cap(s.queries) {
		<-s.queries
	}
	w = request(t, s.Handler(), http.MethodPost, "/api/query", observeQueryBody(t, "prod/prom", "metrics"), observeHeaders("alice"))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, 1, counts.count("tool:list_observability_providers"))
	assert.Zero(t, len(s.queries), "admission slot leaked")
}

func TestObserveRequestScopeSharesOneSessionAndCatalogAcrossOperations(t *testing.T) {
	gateway := observeCatalogAndQueryGateway(t, http.StatusOK)
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)
	counts := countObserveWire(s)
	reference := observeProviderID("prod/prom")
	handler := s.scopeObserveSessions(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A dashboard resolves and queries the same shared provider repeatedly.
		for range 3 {
			p, err := s.resolveProvider(r, reference)
			if err != nil {
				t.Errorf("resolve: %v", err)
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			if _, err := p.query(r.Context(), &Query{ProviderID: reference, Kind: "metrics", Query: "up", Start: 1, End: 2, Step: 1}); err != nil {
				t.Errorf("query: %v", err)
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	w := request(t, handler, http.MethodPost, "/", nil, observeHeaders("alice"))
	require.Equal(t, http.StatusNoContent, w.Code, w.Body.String())
	assert.Equal(t, 1, counts.count("session"))
	assert.Equal(t, 1, counts.count("tool:list_observability_providers"))
	assert.Equal(t, 3, counts.count("tool:query_metrics"))
}

func TestObserveFailedOperationDoesNotPoisonRequestSession(t *testing.T) {
	var queries atomic.Int32
	gateway := observeMCPTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/list_observability_providers" {
			writeJSON(w, 200, map[string]any{"providers": []observeCatalogProvider{{Name: "prod/prom", Namespace: "prod", Type: "prometheus"}}})
			return
		}
		if queries.Add(1) == 1 {
			writeJSON(w, http.StatusTooManyRequests, map[string]any{"state": "Error"})
			return
		}
		writeJSON(w, 200, map[string]any{"state": "OK", "data": json.RawMessage(`{"status":"success","data":{"resultType":"matrix","result":[]}}`)})
	}))
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)
	counts := countObserveWire(s)
	reference := observeProviderID("prod/prom")
	var busy, recovered error
	handler := s.scopeObserveSessions(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, err := s.resolveProvider(r, reference)
		if err != nil {
			t.Errorf("resolve: %v", err)
			return
		}
		query := &Query{ProviderID: reference, Kind: "metrics", Query: "up", Start: 1, End: 2, Step: 1}
		_, busy = p.query(r.Context(), query)
		_, recovered = p.query(r.Context(), query)
		w.WriteHeader(http.StatusNoContent)
	}))
	w := request(t, handler, http.MethodPost, "/", nil, observeHeaders("alice"))
	require.Equal(t, http.StatusNoContent, w.Code)
	var failure *observeError
	require.ErrorAs(t, busy, &failure)
	assert.Equal(t, http.StatusTooManyRequests, failure.status)
	require.NoError(t, recovered, "a failed operation must not break later operations in the same request")
	assert.Equal(t, 1, counts.count("tool:list_observability_providers"), "the catalog outcome, success or failure, is memoized for the request")
	assert.Equal(t, 2, counts.count("session"), "the failed session is replaced, not reused")
}

// The unscoped path is the pre-change wire shape: every operation opens its own
// session. The served path shares one session across the same operations.
func TestObserveWidgetQueryWireCostBeforeAndAfterSharing(t *testing.T) {
	gateway := observeCatalogAndQueryGateway(t, http.StatusOK)
	defer gateway.Close()
	reference := observeProviderID("prod/prom")
	query := &Query{ProviderID: reference, Kind: "metrics", Query: "up", Start: 1, End: 2, Step: 1}

	t.Run("unscoped operations open a session each", func(t *testing.T) {
		s := observeTestService(t, gateway.URL)
		counts := countObserveWire(s)
		ctx := t.Context()
		providers, err := s.observe.providers(ctx, "alice")
		require.NoError(t, err)
		require.Len(t, providers, 1)
		p := &providerClient{public: providers[0], metadataCache: make(map[string]metadataCacheEntry), remote: &observeProvider{gateway: s.observe, token: "alice", reference: providers[0].ProviderRef}}
		_, err = p.query(ctx, query)
		require.NoError(t, err)
		assert.Equal(t, 2, counts.count("session"))
		assert.Equal(t, 1, counts.count("tool:list_observability_providers"))
		assert.Equal(t, 1, counts.count("tool:query_metrics"))
		// Each session: server/discover probe, initialize, initialized, tools/list.
		assert.Equal(t, 2, counts.count("method:server/discover"))
		assert.Equal(t, 10, counts.posts(), "POSTs for one widget query before sharing")
	})

	t.Run("a served widget query shares one session", func(t *testing.T) {
		s := observeTestService(t, gateway.URL)
		counts := countObserveWire(s)
		w := request(t, s.Handler(), http.MethodPost, "/api/query", observeQueryBody(t, "prod/prom", "metrics"), observeHeaders("alice"))
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		assert.Equal(t, 1, counts.count("session"))
		assert.Equal(t, 1, counts.count("tool:list_observability_providers"))
		assert.Equal(t, 1, counts.count("tool:query_metrics"))
		assert.Equal(t, 1, counts.count("method:server/discover"))
		assert.Equal(t, 6, counts.posts(), "POSTs for one widget query after sharing")
	})
}

// observeHeldGateway serves the catalog and metrics fixtures, but holds a
// listing or a query until its gate closes or its request is canceled.
func observeHeldGateway(t *testing.T, holdCatalog, holdQuery <-chan struct{}, listings *atomic.Int64) *httptest.Server {
	t.Helper()
	return observeMCPTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hold := func(gate <-chan struct{}) bool {
			if gate == nil {
				return true
			}
			select {
			case <-gate:
				return true
			case <-r.Context().Done():
				w.WriteHeader(http.StatusServiceUnavailable)
				return false
			}
		}
		switch r.URL.Path {
		case "/list_observability_providers":
			if listings != nil {
				listings.Add(1)
			}
			if !hold(holdCatalog) {
				return
			}
			writeJSON(w, 200, map[string]any{"providers": []observeCatalogProvider{{Name: "prod/prom", Namespace: "prod", Type: "prometheus"}}})
		case "/query_metrics":
			if !hold(holdQuery) {
				return
			}
			writeJSON(w, 200, map[string]any{"state": "OK", "data": json.RawMessage(`{"status":"success","data":{"resultType":"matrix","result":[]}}`)})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

// A slow shared catalog may occupy only a bounded number of catalog phases.
// Local queries stay admitted, unknown local ids stay 404, and the excess
// shared queries fail fast without listing the catalog.
func TestObserveSharedCatalogPhaseCannotStarveLocalQueries(t *testing.T) {
	release := make(chan struct{})
	var listings atomic.Int64
	gateway := observeHeldGateway(t, release, nil, &listings)
	defer gateway.Close()
	open := sync.OnceFunc(func() { close(release) })
	defer open()
	prom := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{"status": "success", "data": map[string]any{"resultType": "matrix", "result": []any{}}})
	}))
	defer prom.Close()
	s := observeTestService(t, gateway.URL, ProviderConfig{ID: "local", Name: "Local", Type: "prometheus", URL: prom.URL})
	// Waiters that cannot get a phase give up quickly, so the excess sheds at once.
	s.catalogWaitTimeout = 50 * time.Millisecond
	h := s.Handler()
	codes := make([]int, cap(s.queries))
	var wg sync.WaitGroup
	for i := range codes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes[i] = request(t, h, http.MethodPost, "/api/query", observeQueryBody(t, "prod/prom", "metrics"), observeHeaders("alice")).Code
		}()
	}
	deadline := time.Now().Add(10 * time.Second)
	for listings.Load() < int64(cap(s.catalogPhases)) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	require.Equal(t, int64(cap(s.catalogPhases)), listings.Load())
	// Release only after every waiter has timed out, so the excess cannot take
	// a phase that frees up at release.
	for len(s.catalogWaiting) > 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	localBody := savedQueryJSON(t, Query{ProviderID: "local", Kind: "metrics", Query: "up", Start: 1700000000, End: 1700000600, Step: 1})
	assert.Equal(t, http.StatusOK, request(t, h, http.MethodPost, "/api/query", localBody, nil).Code, "local query while catalog phases are pending")
	unknown := savedQueryJSON(t, Query{ProviderID: "deleted", Kind: "metrics", Query: "up", Start: 1700000000, End: 1700000600, Step: 1})
	assert.Equal(t, http.StatusNotFound, request(t, h, http.MethodPost, "/api/query", unknown, nil).Code, "unknown local id while catalog phases are pending")
	open()
	wg.Wait()
	var ok, busy int
	for _, code := range codes {
		switch code {
		case http.StatusOK:
			ok++
		case http.StatusTooManyRequests:
			busy++
		default:
			t.Errorf("unexpected shared query status %d", code)
		}
	}
	assert.Equal(t, cap(s.catalogPhases), ok)
	assert.Equal(t, cap(s.queries)-cap(s.catalogPhases), busy)
	assert.Equal(t, int64(cap(s.catalogPhases)), listings.Load(), "excess shared queries listed the catalog")
	assert.Zero(t, len(s.queries), "admission slot leaked")
	assert.Zero(t, len(s.catalogPhases), "catalog phase leaked")
}

func TestObserveUnknownLocalIDIsNotFoundWhenSaturated(t *testing.T) {
	gateway := observeHeldGateway(t, nil, nil, nil)
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)
	s.queryWaitTimeout = time.Millisecond
	for range cap(s.queries) {
		s.queries <- struct{}{}
	}
	defer func() {
		for range cap(s.queries) {
			<-s.queries
		}
	}()
	unknown := savedQueryJSON(t, Query{ProviderID: "deleted", Kind: "metrics", Query: "up", Start: 1700000000, End: 1700000600, Step: 1})
	assert.Equal(t, http.StatusNotFound, request(t, s.Handler(), http.MethodPost, "/api/query", unknown, nil).Code)
	w := request(t, s.Handler(), http.MethodPost, "/api/query", observeQueryBody(t, "prod/prom", "metrics"), observeHeaders("alice"))
	assert.Equal(t, http.StatusTooManyRequests, w.Code, "shared query while saturated")
	assert.Equal(t, "1", w.Header().Get("Retry-After"))
}

// A catalog phase is capped on its own, so a listing that never answers
// releases its admission slot promptly with Insights' own 504.
func TestObserveCatalogPhaseIsCappedAndReleasesSlots(t *testing.T) {
	release := make(chan struct{})
	gateway := observeHeldGateway(t, release, nil, nil)
	defer gateway.Close()
	defer close(release)
	s := observeTestService(t, gateway.URL)
	s.observe.timeouts.catalog = 100 * time.Millisecond
	started := time.Now()
	w := request(t, s.Handler(), http.MethodPost, "/api/query", observeQueryBody(t, "prod/prom", "metrics"), observeHeaders("alice"))
	assert.Equal(t, http.StatusGatewayTimeout, w.Code, w.Body.String())
	assert.Less(t, time.Since(started), 5*time.Second)
	assert.Zero(t, len(s.queries), "admission slot leaked after a slow catalog")
	assert.Zero(t, len(s.catalogPhases), "catalog phase leaked after a slow catalog")
}

// One HTTP request has a single gateway budget. Setup, discovery and every
// call draw on it, so /providers and /query answer within it.
func TestObserveRequestBudgetBoundsSharedWork(t *testing.T) {
	release := make(chan struct{})
	gateway := observeHeldGateway(t, release, nil, nil)
	defer gateway.Close()
	defer close(release)
	s := observeTestService(t, gateway.URL)
	s.observe.timeouts.providers = 300 * time.Millisecond
	s.observe.timeouts.catalog = 300 * time.Millisecond
	s.observe.timeouts.operation = 5 * time.Second
	// A silent gateway keeps local providers listed; the shared failure is reported.
	started := time.Now()
	w := request(t, s.Handler(), http.MethodGet, "/api/providers", nil, observeHeaders("alice"))
	assert.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Less(t, time.Since(started), 3*time.Second, "/providers outlived its budget")
	var listing struct {
		SharedCatalog *sharedCatalogFailure `json:"sharedCatalog"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &listing))
	require.NotNil(t, listing.SharedCatalog, w.Body.String())
	assert.Equal(t, http.StatusGatewayTimeout, listing.SharedCatalog.Code)
	assert.Equal(t, "unavailable", listing.SharedCatalog.Status)
	started = time.Now()
	w = request(t, s.Handler(), http.MethodPost, "/api/query", observeQueryBody(t, "prod/prom", "metrics"), observeHeaders("alice"))
	assert.Equal(t, http.StatusGatewayTimeout, w.Code, w.Body.String())
	assert.Less(t, time.Since(started), 3*time.Second, "/query outlived its catalog phase")
	assert.Zero(t, len(s.queries))
}

// A handler's own deadline bounds shared work and is inherited, not replaced.
func TestObserveOperationsInheritHandlerDeadline(t *testing.T) {
	release := make(chan struct{})
	gateway := observeHeldGateway(t, nil, release, nil)
	defer gateway.Close()
	defer close(release)
	s := observeTestService(t, gateway.URL)
	s.observe.timeouts.operation = 5 * time.Second
	s.observe.timeouts.catalog = 5 * time.Second
	handler := s.scopeObserveSessions(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 300*time.Millisecond)
		defer cancel()
		started := time.Now()
		_, err := s.observe.providers(ctx, "alice")
		require.NoError(t, err) // The catalog answers; only the data call is held.
		p, err := s.resolveProvider(r.WithContext(ctx), observeProviderID("prod/prom"))
		require.NoError(t, err)
		_, err = p.query(ctx, &Query{ProviderID: observeProviderID("prod/prom"), Kind: "metrics", Query: "up", Start: 1, End: 2, Step: 1})
		assert.Error(t, err)
		assert.Less(t, time.Since(started), 3*time.Second, "the handler deadline was not inherited")
		w.WriteHeader(http.StatusNoContent)
	}))
	require.Equal(t, http.StatusNoContent, request(t, handler, http.MethodGet, "/", nil, observeHeaders("alice")).Code)
}

// Each operation is capped at the operation limit even when the request
// budget has plenty of time left.
func TestObserveOperationCapIsMinimumOfOperationAndRemainingBudget(t *testing.T) {
	release := make(chan struct{})
	gateway := observeHeldGateway(t, release, nil, nil)
	defer gateway.Close()
	defer close(release)
	s := observeTestService(t, gateway.URL)
	s.observe.timeouts.operation = 100 * time.Millisecond
	started := time.Now()
	w := request(t, s.Handler(), http.MethodGet, "/api/providers", nil, observeHeaders("alice"))
	assert.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Less(t, time.Since(started), 3*time.Second, "one operation ignored its own cap")
	assert.Contains(t, w.Body.String(), `"sharedCatalog"`)
}

// A narrow context that opened the session must not poison later operations
// in the same request: the session belongs to the request budget.
func TestObserveSessionSurvivesNarrowFirstOperation(t *testing.T) {
	gateway := observeCatalogAndQueryGateway(t, http.StatusOK)
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)
	counts := countObserveWire(s)
	reference := observeProviderID("prod/prom")
	var firstErr, laterErr error
	h := s.scopeObserveSessions(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		narrow, cancel := context.WithCancel(r.Context())
		_, firstErr = s.observe.providers(narrow, "alice")
		cancel() // The narrow operation finished; the request continues.
		p, err := s.resolveProvider(r, reference)
		if err != nil {
			t.Errorf("resolve: %v", err)
			return
		}
		_, laterErr = p.query(r.Context(), &Query{ProviderID: reference, Kind: "metrics", Query: "up", Start: 1, End: 2, Step: 1})
		w.WriteHeader(http.StatusNoContent)
	}))
	w := request(t, h, http.MethodGet, "/", nil, observeHeaders("alice"))
	require.Equal(t, http.StatusNoContent, w.Code)
	require.NoError(t, firstErr)
	require.NoError(t, laterErr, "a narrow first operation poisoned the request's session")
	assert.Equal(t, 1, counts.count("session"))
}

// The scope never hands one delegated token's session to another caller,
// even inside the same HTTP request. Each caller's catalog is its own.
func TestObserveScopeNeverSharesSessionsAcrossTokens(t *testing.T) {
	var seen sync.Map
	gateway := observeMCPTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.Store(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), true)
		writeJSON(w, 200, map[string]any{"providers": []observeCatalogProvider{{Name: "prod/prom", Namespace: "prod", Type: "prometheus"}}})
	}))
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)
	counts := countObserveWire(s)
	h := s.scopeObserveSessions(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, token := range []string{"alice", "bob", "alice"} {
			_, err := s.observe.providers(r.Context(), token)
			assert.NoError(t, err, token)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	require.Equal(t, http.StatusNoContent, request(t, h, http.MethodGet, "/", nil, observeHeaders("alice")).Code)
	assert.Equal(t, 2, counts.count("session"), "alice's scope session plus bob's private session")
	assert.Equal(t, 2, counts.count("tool:list_observability_providers"), "alice's second lookup is memoized")
	_, bob := seen.Load("bob")
	assert.True(t, bob)
}

// A request canceled while its catalog listing is in flight releases its slot.
func TestObserveCanceledDuringCatalogReleasesSlot(t *testing.T) {
	started := make(chan struct{}, 1)
	gateway := observeMCPTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/list_observability_providers" {
			started <- struct{}{}
			<-r.Context().Done()
			w.WriteHeader(http.StatusServiceUnavailable)
		}
	}))
	defer gateway.Close()
	s := observeTestService(t, gateway.URL)
	ctx, cancel := context.WithCancel(t.Context())
	r := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/query", bytes.NewReader(observeQueryBody(t, "prod/prom", "metrics")))
	r.Header.Set("Authorization", "Bearer "+testToken)
	r.Header.Set(observeTokenHeader, "alice")
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		s.Handler().ServeHTTP(w, r)
		close(done)
	}()
	<-started
	assert.Equal(t, 1, len(s.queries), "slot held during the catalog listing")
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not return after cancellation")
	}
	assert.Zero(t, len(s.queries), "slot leaked after cancellation")
	assert.Zero(t, len(s.catalogPhases), "catalog phase leaked after cancellation")
}

// A shared query that finds every catalog phase busy waits for one, and succeeds
// when a phase frees within catalogWaitTimeout.
func TestObserveCatalogPhaseWaitsForAFreeSlot(t *testing.T) {
	release := make(chan struct{})
	var listings atomic.Int64
	gateway := observeHeldGateway(t, release, nil, &listings)
	defer gateway.Close()
	open := sync.OnceFunc(func() { close(release) })
	defer open()
	s := observeTestService(t, gateway.URL)
	s.catalogWaitTimeout = 5 * time.Second
	var wg sync.WaitGroup
	for range cap(s.catalogPhases) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			request(t, s.Handler(), http.MethodPost, "/api/query", observeQueryBody(t, "prod/prom", "metrics"), observeHeaders("alice"))
		}()
	}
	deadline := time.Now().Add(10 * time.Second)
	for listings.Load() < int64(cap(s.catalogPhases)) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	fifth := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		fifth <- request(t, s.Handler(), http.MethodPost, "/api/query", observeQueryBody(t, "prod/prom", "metrics"), observeHeaders("alice"))
	}()
	time.Sleep(100 * time.Millisecond)
	assert.Equal(t, 1, len(s.catalogWaiting), "the fifth shared query should be waiting, not failed")
	open()
	wg.Wait()
	w := <-fifth
	assert.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.Equal(t, int64(cap(s.catalogPhases))+1, listings.Load(), "the waiter listed the catalog once it got a phase")
	assert.Zero(t, len(s.catalogWaiting))
}

// Waiters are bounded: once the queue is full, the next shared query fails at
// once with a retry hint instead of queueing.
func TestObserveCatalogWaitersAreBounded(t *testing.T) {
	release := make(chan struct{})
	var listings atomic.Int64
	gateway := observeHeldGateway(t, release, nil, &listings)
	defer gateway.Close()
	open := sync.OnceFunc(func() { close(release) })
	defer open()
	s := observeTestService(t, gateway.URL)
	s.catalogWaitTimeout = 5 * time.Second
	s.catalogWaiting = make(chan struct{}, 2)
	var wg sync.WaitGroup
	for range cap(s.catalogPhases) + 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			request(t, s.Handler(), http.MethodPost, "/api/query", observeQueryBody(t, "prod/prom", "metrics"), observeHeaders("alice"))
		}()
	}
	deadline := time.Now().Add(10 * time.Second)
	for (listings.Load() < int64(cap(s.catalogPhases)) || len(s.catalogWaiting) < 2) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	require.Equal(t, 2, len(s.catalogWaiting))
	started := time.Now()
	w := request(t, s.Handler(), http.MethodPost, "/api/query", observeQueryBody(t, "prod/prom", "metrics"), observeHeaders("alice"))
	assert.Equal(t, http.StatusTooManyRequests, w.Code, w.Body.String())
	assert.Equal(t, "1", w.Header().Get("Retry-After"))
	assert.Less(t, time.Since(started), time.Second, "a full waiter queue must fail fast")
	open()
	wg.Wait()
}

// A waiter that never gets a phase gives up after catalogWaitTimeout with a
// retry hint, and holds no admission slot while it waits.
func TestObserveCatalogWaitTimesOutWithRetryHint(t *testing.T) {
	release := make(chan struct{})
	var listings atomic.Int64
	gateway := observeHeldGateway(t, release, nil, &listings)
	defer gateway.Close()
	open := sync.OnceFunc(func() { close(release) })
	defer open()
	s := observeTestService(t, gateway.URL)
	s.catalogWaitTimeout = 100 * time.Millisecond
	var wg sync.WaitGroup
	for range cap(s.catalogPhases) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			request(t, s.Handler(), http.MethodPost, "/api/query", observeQueryBody(t, "prod/prom", "metrics"), observeHeaders("alice"))
		}()
	}
	deadline := time.Now().Add(10 * time.Second)
	for listings.Load() < int64(cap(s.catalogPhases)) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	started := time.Now()
	w := request(t, s.Handler(), http.MethodPost, "/api/query", observeQueryBody(t, "prod/prom", "metrics"), observeHeaders("alice"))
	elapsed := time.Since(started)
	assert.Equal(t, http.StatusTooManyRequests, w.Code, w.Body.String())
	assert.Equal(t, "1", w.Header().Get("Retry-After"))
	assert.GreaterOrEqual(t, elapsed, 90*time.Millisecond, "the waiter gave up before its bound")
	assert.Less(t, elapsed, 2*time.Second)
	assert.Equal(t, int64(cap(s.catalogPhases)), listings.Load(), "a timed-out waiter must not list the catalog")
	open()
	wg.Wait()
	assert.Zero(t, len(s.queries), "admission slots leaked")
}

// A shared-catalog failure never hides the local providers. The listing still
// answers 200, and sharedCatalog says which kind of failure it was.
func TestObserveProvidersKeepLocalWhenSharedCatalogFails(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		want   string
		code   int
	}{
		{"busy", http.StatusTooManyRequests, "busy", http.StatusTooManyRequests},
		{"forbidden", http.StatusForbidden, "forbidden", http.StatusForbidden},
		{"unavailable", http.StatusInternalServerError, "unavailable", http.StatusBadGateway},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gateway := observeMCPTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				writeJSON(w, tc.status, map[string]any{"error": "private gateway detail"})
			}))
			defer gateway.Close()
			s := observeTestService(t, gateway.URL, ProviderConfig{ID: "local", Name: "Local", Type: "prometheus", URL: "http://local.invalid"})
			w := request(t, s.Handler(), http.MethodGet, "/api/providers", nil, observeHeaders("alice"))
			require.Equal(t, http.StatusOK, w.Code, w.Body.String())
			var listing struct {
				Providers     []Provider            `json:"providers"`
				SharedCatalog *sharedCatalogFailure `json:"sharedCatalog"`
			}
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &listing))
			require.Len(t, listing.Providers, 1)
			assert.Equal(t, "local", listing.Providers[0].ID)
			require.NotNil(t, listing.SharedCatalog)
			assert.Equal(t, tc.want, listing.SharedCatalog.Status)
			assert.Equal(t, tc.code, listing.SharedCatalog.Code)
			assert.NotContains(t, w.Body.String(), "private gateway detail")
			// Local queries keep working while the shared part is reported.
			local := request(t, s.Handler(), http.MethodPost, "/api/query", savedQueryJSON(t, Query{ProviderID: "local", Kind: "metrics", Query: "up", Start: 1700000000, End: 1700000600, Step: 1}), nil)
			assert.NotEqual(t, http.StatusNotFound, local.Code)
		})
	}
}

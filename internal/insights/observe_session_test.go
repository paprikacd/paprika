package insights

import (
	"bytes"
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
	assert.Equal(t, 1, counts.count("tool:list_observability_providers"), "catalog failures are request-scoped, successes are memoized")
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

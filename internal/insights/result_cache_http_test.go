package insights

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"
)

// promMatrixBody is a provider answer with one series that ends before the present.
const promMatrixBody = `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"service":"api"},"values":[[1700000000.5,"4.25"]]}]}}`

// cachedTestService is testService with the result cache enabled at the given budget.
func cachedTestService(t *testing.T, gateway string, providers ...ProviderConfig) *Server {
	t.Helper()
	store, err := OpenStore(t.TempDir())
	require.NoError(t, err)
	s, err := NewServer(Config{Token: testToken, ObservabilityURL: gateway, Providers: providers, ResultCacheMiB: 16}, store)
	require.NoError(t, err)
	require.NotNil(t, s.results)
	return s
}

// countingProvider serves promMatrixBody and counts the provider requests it receives.
func countingProvider(t *testing.T) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = io.WriteString(w, promMatrixBody)
	}))
	t.Cleanup(upstream.Close)
	return upstream, &calls
}

// receiptOf decodes the receipt a query response carries.
func receiptOf(t *testing.T, body []byte) *QueryDiagnostics {
	t.Helper()
	var response struct {
		Diagnostics *QueryDiagnostics `json:"diagnostics"`
	}
	require.NoError(t, json.Unmarshal(body, &response), "body %s", body)
	require.NotNil(t, response.Diagnostics, "body %s", body)
	return response.Diagnostics
}

func phaseNames(d *QueryDiagnostics) []string {
	names := make([]string, 0, len(d.Phases))
	for _, phase := range d.Phases {
		names = append(names, phase.Name)
	}
	return names
}

func TestResultCacheServesARepeatedLocalQueryWithoutAProviderRequest(t *testing.T) {
	upstream, calls := countingProvider(t)
	s := cachedTestService(t, "", ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
	h := s.Handler()

	first := request(t, h, http.MethodPost, "/api/query", []byte(receiptMetricsRequest), receiptHeaders())
	require.Equal(t, http.StatusOK, first.Code, first.Body.String())
	firstReceipt := receiptOf(t, first.Body.Bytes())
	require.NotNil(t, firstReceipt.Cache)
	require.Equal(t, "miss", firstReceipt.Cache.Status)
	require.True(t, firstReceipt.Effective.Dispatched)
	require.EqualValues(t, 1, calls.Load())

	second := request(t, h, http.MethodPost, "/api/query", []byte(receiptMetricsRequest), receiptHeaders())
	require.Equal(t, http.StatusOK, second.Code, second.Body.String())
	secondReceipt := receiptOf(t, second.Body.Bytes())
	require.EqualValues(t, 1, calls.Load(), "the second query is answered from the cache")
	require.NotNil(t, secondReceipt.Cache)
	require.Equal(t, "hit", secondReceipt.Cache.Status)
	require.Equal(t, firstReceipt.ExecutionID, secondReceipt.Cache.SourceExecutionID)
	require.NotNil(t, secondReceipt.Cache.AgeMs)
	require.False(t, secondReceipt.Effective.Dispatched, "a hit made no provider request")
	require.Contains(t, phaseNames(secondReceipt), "cache")
	require.NotContains(t, phaseNames(secondReceipt), "upstream", "a hit has no upstream phase")
	require.Equal(t, firstReceipt.Counts, secondReceipt.Counts)
}

func TestResultCacheRefreshHeaderBypassesAndStoresTheNewResult(t *testing.T) {
	upstream, calls := countingProvider(t)
	s := cachedTestService(t, "", ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
	h := s.Handler()
	require.Equal(t, http.StatusOK, request(t, h, http.MethodPost, "/api/query", []byte(receiptMetricsRequest), nil).Code)
	require.EqualValues(t, 1, calls.Load())

	refresh := request(t, h, http.MethodPost, "/api/query", []byte(receiptMetricsRequest), receiptHeaders(map[string]string{resultCacheHeader: resultCacheRefresh}))
	require.Equal(t, http.StatusOK, refresh.Code, refresh.Body.String())
	require.EqualValues(t, 2, calls.Load(), "a refresh never answers from the cache")
	refreshReceipt := receiptOf(t, refresh.Body.Bytes())
	require.NotNil(t, refreshReceipt.Cache)
	require.Equal(t, "bypass", refreshReceipt.Cache.Status)
	require.Equal(t, "refresh", refreshReceipt.Cache.Reason)

	// The refreshed execution is what the next caller is served.
	next := request(t, h, http.MethodPost, "/api/query", []byte(receiptMetricsRequest), receiptHeaders())
	require.Equal(t, http.StatusOK, next.Code)
	require.EqualValues(t, 2, calls.Load())
	require.Equal(t, refreshReceipt.ExecutionID, receiptOf(t, next.Body.Bytes()).Cache.SourceExecutionID)
}

// sharedGateway serves one shared provider to every caller. Each caller's catalog carries the
// scope the test assigns it: alice and bob have distinct digests, carol has none.
func sharedGateway(t *testing.T, queries *atomic.Int32) *httptest.Server {
	t.Helper()
	scopes := map[string]string{"alice": strings.Repeat("a", 64), "bob": strings.Repeat("b", 64), "carol": ""}
	return observeRESTTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		scope, known := scopes[token]
		if !known {
			http.Error(w, "unexpected caller", http.StatusForbidden)
			return
		}
		switch r.URL.Path {
		case "/list_observability_providers":
			writeJSON(w, 200, map[string]any{"providers": []observeCatalogProvider{{Name: "team-a/metrics", Namespace: "team-a", Type: "prometheus"}}, "authorizationScope": scope})
		case "/query_metrics":
			queries.Add(1)
			writeJSON(w, 200, map[string]any{"state": "OK", "data": json.RawMessage(promMatrixBody)})
		default:
			http.Error(w, "unexpected gateway path", http.StatusNotFound)
		}
	}))
}

func TestResultCacheSharesOnlyBetweenCallersWithTheSameScope(t *testing.T) {
	var queries atomic.Int32
	gateway := sharedGateway(t, &queries)
	t.Cleanup(gateway.Close)
	s := cachedTestService(t, gateway.URL)
	h := s.Handler()
	body := observeQueryBody(t, "team-a/metrics", "metrics")
	query := func(caller string) *QueryDiagnostics {
		t.Helper()
		response := request(t, h, http.MethodPost, "/api/query", body, mergeHeaders(receiptHeaders(), observeHeaders(caller)))
		require.Equal(t, http.StatusOK, response.Code, "%s: %s", caller, response.Body.String())
		return receiptOf(t, response.Body.Bytes())
	}

	require.Equal(t, "miss", query("alice").Cache.Status)
	require.Equal(t, "hit", query("alice").Cache.Status, "the same caller shares its own entry")
	require.EqualValues(t, 1, queries.Load())

	require.Equal(t, "miss", query("bob").Cache.Status, "a different scope never receives alice's result")
	require.EqualValues(t, 2, queries.Load())
}

func TestResultCacheNeverSharesAProviderWithNoScope(t *testing.T) {
	var queries atomic.Int32
	gateway := sharedGateway(t, &queries)
	t.Cleanup(gateway.Close)
	s := cachedTestService(t, gateway.URL)
	h := s.Handler()
	body := observeQueryBody(t, "team-a/metrics", "metrics")
	for range 2 {
		response := request(t, h, http.MethodPost, "/api/query", body, mergeHeaders(receiptHeaders(), observeHeaders("carol")))
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		cache := receiptOf(t, response.Body.Bytes()).Cache
		require.NotNil(t, cache)
		require.Equal(t, "bypass", cache.Status)
		require.Equal(t, "unscoped", cache.Reason)
	}
	require.EqualValues(t, 2, queries.Load(), "a gateway that reports no scope disables sharing")
}

func TestResultCacheServesALocalHitWhenTheExecutionPoolIsSaturated(t *testing.T) {
	upstream, calls := countingProvider(t)
	s := cachedTestService(t, "", ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
	h := s.Handler()
	require.Equal(t, http.StatusOK, request(t, h, http.MethodPost, "/api/query", []byte(receiptMetricsRequest), nil).Code)

	// Fill every execution slot and every waiting place, so any query that must execute is refused.
	for range cap(s.queries) {
		s.queries <- struct{}{}
	}
	for range cap(s.queryWaiting) {
		s.queryWaiting <- struct{}{}
	}
	hit := request(t, h, http.MethodPost, "/api/query", []byte(receiptMetricsRequest), receiptHeaders())
	require.Equal(t, http.StatusOK, hit.Code, "a hit takes no execution slot: %s", hit.Body.String())
	require.Equal(t, "hit", receiptOf(t, hit.Body.Bytes()).Cache.Status)

	other := strings.Replace(receiptMetricsRequest, `"step":30`, `"step":60`, 1)
	refused := request(t, h, http.MethodPost, "/api/query", []byte(other), nil)
	require.Equal(t, http.StatusTooManyRequests, refused.Code, "a miss needs a slot and is refused")
	require.EqualValues(t, 1, calls.Load())
}

func TestResultCacheIsNotUsedWhenItsBudgetIsZero(t *testing.T) {
	upstream, calls := countingProvider(t)
	store, err := OpenStore(t.TempDir())
	require.NoError(t, err)
	s, err := NewServer(Config{Token: testToken, Providers: []ProviderConfig{{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: upstream.URL}}}, store)
	require.NoError(t, err)
	require.Nil(t, s.results)
	h := s.Handler()
	for range 2 {
		response := request(t, h, http.MethodPost, "/api/query", []byte(receiptMetricsRequest), receiptHeaders())
		require.Equal(t, http.StatusOK, response.Code)
		require.Nil(t, receiptOf(t, response.Body.Bytes()).Cache, "a disabled cache adds no receipt field")
	}
	require.EqualValues(t, 2, calls.Load())
}

func TestResultCacheInvalidatesWhenAProviderChanges(t *testing.T) {
	upstream, calls := countingProvider(t)
	s := cachedTestService(t, "")
	h := s.Handler()
	created := request(t, h, http.MethodPut, "/api/provider-configs/prometheus", providerBody("prometheus", "Metrics", upstream.URL), map[string]string{"If-None-Match": "*"})
	require.Equal(t, http.StatusOK, created.Code, created.Body.String())
	tag := created.Header().Get("ETag")

	require.Equal(t, http.StatusOK, request(t, h, http.MethodPost, "/api/query", []byte(receiptMetricsRequest), nil).Code)
	require.Equal(t, http.StatusOK, request(t, h, http.MethodPost, "/api/query", []byte(receiptMetricsRequest), nil).Code)
	require.EqualValues(t, 1, calls.Load(), "the second query is cached")

	updated := request(t, h, http.MethodPut, "/api/provider-configs/prometheus", providerBody("prometheus", "Renamed", upstream.URL), map[string]string{"If-Match": tag})
	require.Equal(t, http.StatusOK, updated.Code, updated.Body.String())
	require.Equal(t, http.StatusOK, request(t, h, http.MethodPost, "/api/query", []byte(receiptMetricsRequest), nil).Code)
	require.EqualValues(t, 2, calls.Load(), "a configuration change drops the provider's cached results")
}

// A saved dashboard read that repeats a window is answered from the cache: the first read executes the
// signal, and the second counts it as cached, not executed, and still reports its latency.
func TestDashboardReadCountsRepeatedSignalsAsCached(t *testing.T) {
	upstream, calls := countingProvider(t)
	s := cachedTestService(t, "", ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
	putReadDashboard(t, s, queryReadWidget("requests", "up"))
	body := []byte(`{"id":"overview",` + dashboardQueryWindow + `}`)

	first := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", body, nil))
	require.Equal(t, 1, first.QueryCount.Executed)
	require.Zero(t, first.QueryCount.Cached)
	require.False(t, first.Signals[0].Cached)

	second := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", body, nil))
	require.Zero(t, second.QueryCount.Executed, "a cached signal is not executed")
	require.Equal(t, 1, second.QueryCount.Cached)
	require.True(t, second.Signals[0].Cached)
	require.NotNil(t, second.Signals[0].LatencyMs, "a cached signal keeps its receipt's latency")
	require.EqualValues(t, 1, calls.Load())
}

func mergeHeaders(maps ...map[string]string) map[string]string {
	merged := map[string]string{}
	for _, m := range maps {
		for key, value := range m {
			merged[key] = value
		}
	}
	return merged
}

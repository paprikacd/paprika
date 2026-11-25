package insights

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// pastQuery is a local metrics query whose window ended long ago, so its result may be stored.
func pastQuery() *Query {
	return &Query{ProviderID: "prometheus", Kind: "metrics", Query: "up", Start: 1_700_000_000, End: 1_700_000_600, Step: 30}
}

func flightFor(c *resultCache, key string) *resultFlight {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.flights[key]
}

// waitForFlight polls until key has an in-flight execution.
func waitForFlight(t *testing.T, c *resultCache, key string) *resultFlight {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if flight := flightFor(c, key); flight != nil {
			return flight
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("no flight began")
	return nil
}

// An execution that began before a provider was forgotten came from the old configuration: neither its
// flight nor a direct put may store it after the invalidation.
func TestResultCacheDoesNotStoreAResultThatBeganBeforeAnInvalidation(t *testing.T) {
	t.Parallel()
	c, _, _ := newTestResultCache(t, 16<<20)
	lead := leadOrFail(t, c, "k")
	epoch := c.currentEpoch()
	c.forgetProvider("prometheus")
	c.complete("k", "prometheus", lead, seriesResult(1), "old-config", nil, true)
	require.Nil(t, first(c.claim("k")), "a flight that began before the invalidation is not stored")

	c.put("j", "prometheus", seriesResult(1), "old-config", epoch)
	require.Nil(t, first(c.claim("j")), "a put that began before the invalidation is not stored")
	c.put("j", "prometheus", seriesResult(2), "new-config", c.currentEpoch())
	require.NotNil(t, first(c.claim("j")))
}

// A leader whose execution panics still completes its flight. Its joiner gets an error at once instead of
// waiting out its deadline, and the next caller leads a new execution instead of joining a dead flight.
func TestResultCacheLeaderPanicCompletesItsFlight(t *testing.T) {
	upstream, _ := countingProvider(t)
	s := cachedTestService(t, "", ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
	p, ok := s.providers.get("prometheus")
	require.True(t, ok)
	q := pastQuery()
	key := resultKey(resultScope(p), q)

	release := make(chan struct{})
	panicked := make(chan any, 1)
	go func() {
		defer func() { panicked <- recover() }()
		_, _ = s.throughResultCache(context.Background(), p, q, false, &admission{s: s}, func(context.Context) (QueryResult, error) {
			<-release
			panic("connector bug")
		})
	}()
	waitForFlight(t, s.results, key)

	joined := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, err := s.throughResultCache(ctx, p, q, false, &admission{s: s}, func(context.Context) (QueryResult, error) {
			return QueryResult{}, errors.New("the joiner must not execute")
		})
		joined <- err
	}()
	// The joiner is waiting when the flight has a second interested caller; give it a moment to join.
	time.Sleep(20 * time.Millisecond)
	close(release)
	require.Equal(t, "connector bug", <-panicked, "the panic still reaches the caller")
	select {
	case err := <-joined:
		require.ErrorIs(t, err, errResultLeaderPanicked)
	case <-time.After(5 * time.Second):
		t.Fatal("the joiner waited on a flight its panicking leader never completed")
	}
	require.Nil(t, flightFor(s.results, key), "no flight is left behind")
	_, join, lead := s.results.claim(key)
	require.Nil(t, join)
	require.NotNil(t, lead, "the next caller leads")
	s.results.complete(key, q.ProviderID, lead, nil, "", context.Canceled, false)
}

// Another caller's cancellation says nothing about this request. A joiner whose leaders keep being
// canceled stops waiting after a bounded number of flights and runs the query itself.
func TestResultCacheJoinerSurvivesRepeatedlyCanceledLeaders(t *testing.T) {
	upstream, calls := countingProvider(t)
	s := cachedTestService(t, "", ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
	p, ok := s.providers.get("prometheus")
	require.True(t, ok)
	q := pastQuery()
	key := resultKey(resultScope(p), q)
	_, _, lead := s.results.claim(key)
	require.NotNil(t, lead)

	type outcome struct {
		result QueryResult
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		ctx := withQueryReceipt(context.Background(), newQueryReceipt(q, true))
		result, err := s.throughResultCache(ctx, p, q, false, &admission{s: s}, func(ctx context.Context) (QueryResult, error) {
			return s.executeProviderQuery(ctx, p, q)
		})
		done <- outcome{result, err}
	}()
	// Each swap cancels the current leader and starts another in one step, so the joiner always finds a flight.
	swap := func() {
		s.results.mu.Lock()
		defer s.results.mu.Unlock()
		old := s.results.flights[key]
		s.results.flights[key] = &resultFlight{done: make(chan struct{}), epoch: s.results.epoch}
		old.err = fmt.Errorf("query execution context: %w", context.Canceled)
		close(old.done)
	}
	var got outcome
	for waiting := true; waiting; {
		select {
		case got = <-done:
			waiting = false
		case <-time.After(10 * time.Millisecond):
			swap()
		}
	}
	require.NoError(t, got.err, "a canceled leader never fails a live joiner")
	require.NotEmpty(t, got.result.Series)
	require.EqualValues(t, 1, calls.Load(), "the joiner ran the query itself")
	require.NotNil(t, got.result.Diagnostics)
	require.Equal(t, "miss", got.result.Diagnostics.Cache.Status)
	// The test's last flight is still open; complete it so nothing is left waiting.
	s.results.complete(key, q.ProviderID, flightFor(s.results, key), nil, "", context.Canceled, false)
}

// A gateway 429 on a miss is answered with the limit it named, and is never stored: the next request
// asks the gateway again.
func TestResultCacheNeverStoresAGatewayRefusalAndKeepsItsLimitScope(t *testing.T) {
	var queries atomic.Int32
	gateway := observeRESTTestGateway(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/list_observability_providers":
			writeJSON(w, 200, map[string]any{"providers": []observeCatalogProvider{{Name: "team-a/metrics", Namespace: "team-a", Type: "prometheus"}}, "authorizationScope": strings.Repeat("a", 64)})
		case "/query_metrics":
			if queries.Add(1) == 1 {
				w.Header().Set("Retry-After", "1")
				w.Header().Set(observeLimitScopeHeader, "provider")
				http.Error(w, `{"error":"rate_limited"}`, http.StatusTooManyRequests)
				return
			}
			writeJSON(w, 200, map[string]any{"state": "OK", "data": json.RawMessage(promMatrixBody)})
		default:
			http.Error(w, "unexpected gateway path", http.StatusNotFound)
		}
	}))
	t.Cleanup(gateway.Close)
	s := cachedTestService(t, gateway.URL)
	h := s.Handler()
	body := observeQueryBody(t, "team-a/metrics", "metrics")
	headers := mergeHeaders(receiptHeaders(), observeHeaders("alice"))

	refused := request(t, h, http.MethodPost, "/api/query", body, headers)
	require.Equal(t, http.StatusTooManyRequests, refused.Code, refused.Body.String())
	receipt := receiptOf(t, refused.Body.Bytes())
	require.Equal(t, "provider", receipt.LimitScope, "the gateway's limit scope survives the cache")
	require.Equal(t, "miss", receipt.Cache.Status)

	answered := request(t, h, http.MethodPost, "/api/query", body, headers)
	require.Equal(t, http.StatusOK, answered.Code, answered.Body.String())
	require.Equal(t, "miss", receiptOf(t, answered.Body.Bytes()).Cache.Status, "the refusal was not stored")
	require.EqualValues(t, 2, queries.Load())
}

// The key is the query after variable interpolation: a dashboard read with another variable value is
// another query, and only a repeat of the same value is answered from the cache.
func TestDashboardReadCachesEachVariableValueSeparately(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.URL.Query().Get("query"))
		mu.Unlock()
		_, _ = io.WriteString(w, promMatrixBody)
	}))
	t.Cleanup(upstream.Close)
	s := cachedTestService(t, "", ProviderConfig{ID: "prometheus", Name: "Metrics", Type: "prometheus", URL: upstream.URL})
	putReadDashboard(t, s, queryReadWidget("requests", `up{service={{service}}}`))
	read := func(service string) DashboardQueryResult {
		t.Helper()
		body := []byte(`{"id":"overview",` + dashboardQueryWindow + `,"variables":{"service":"` + service + `"}}`)
		return readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", body, nil))
	}

	require.Equal(t, 1, read("checkout").QueryCount.Executed)
	require.Equal(t, 1, read("api").QueryCount.Executed, "another value is another query")
	again := read("checkout")
	require.Zero(t, again.QueryCount.Executed)
	require.Equal(t, 1, again.QueryCount.Cached)
	mu.Lock()
	defer mu.Unlock()
	require.Equal(t, []string{`up{service="checkout"}`, `up{service="api"}`}, seen)
}

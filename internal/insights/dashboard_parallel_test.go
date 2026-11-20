package insights

import (
	"fmt"
	"hash/fnv"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// matrixWithTwoSamples answers a range query with one series whose samples sit at the query's start and end. The
// earlier-window query of a comparison then finds its sample at the window start, and the current query at its end.
func matrixWithTwoSamples(r *http.Request, value float64) string {
	start, _ := strconv.ParseFloat(r.URL.Query().Get("start"), 64)
	end, _ := strconv.ParseFloat(r.URL.Query().Get("end"), 64)
	return fmt.Sprintf(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"service":"api"},"values":[[%v,"%v"],[%v,"%v"]]}]}}`, start, value, end, value+1)
}

// queryValue is a stable value for a query, so every run of one dashboard sees the same numbers.
func queryValue(query string) float64 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(query))
	return float64(h.Sum32()%50) + 1
}

// The parallel read returns exactly what the serial read returns, for the same dashboard and the same provider
// answers, however the provider's latency orders the queries. The only difference allowed is latencyMs and the
// observation time.
func TestDashboardQueryParallelReadMatchesSerialOutput(t *testing.T) {
	widgets := func() []map[string]any {
		latency := queryReadWidget("latency", "lat{}")
		latency["type"] = "timeseries"
		latency["options"] = map[string]any{"decimals": 2}
		errors := comparingStat("errors", `rate{service="b"}`, "7d", "down")
		errors["providerId"] = "other"
		return []map[string]any{
			comparingStat("requests", `up{service="a"}`, "1d", "up"),
			errors,
			queryReadWidget("duplicate", `up{service="a"}`),
			latency,
			queryReadWidget("failing", "bad"),
			queryReadWidget("plain", "plain{}"),
		}
	}
	for seed := range int64(4) {
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			query := r.URL.Query().Get("query")
			// The delay depends on the seed and the query, so the completion order changes from seed to seed.
			time.Sleep(time.Duration((int64(queryValue(query))+seed*7)%12) * time.Millisecond)
			if query == "bad" {
				http.Error(w, "upstream failure", http.StatusBadGateway)
				return
			}
			_, _ = fmt.Fprint(w, matrixWithTwoSamples(r, queryValue(query)))
		}))
		t.Cleanup(provider.Close)
		providers := []ProviderConfig{
			{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL},
			{ID: "other", Name: "Other", Type: "prometheus", URL: provider.URL},
		}
		read := func(parallelism int) DashboardQueryResult {
			s, _ := testServiceWithDashboardParallelism(t, parallelism, providers...)
			putReadDashboard(t, s, widgets()...)
			result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
			for i := range result.Signals {
				result.Signals[i].LatencyMs = nil
			}
			result.ObservedAt = ""
			return result
		}
		serial := read(1)
		parallel := read(2)
		require.Equal(t, serial, parallel, "seed %d: the parallel read must match the serial read", seed)
		require.Equal(t, "partial", parallel.State)
		failing := parallel.Widgets[4]
		require.Equal(t, "failing", failing.ID)
		for _, signal := range parallel.Signals {
			if signal.ID == failing.SignalID {
				require.NotNil(t, signal.Error)
				require.Equal(t, "provider_error", signal.Error.Code)
			}
		}
		require.NotNil(t, parallel.Widgets[0].Comparison, "the comparison phase ran")
		require.Equal(t, "ok", parallel.Widgets[0].Comparison.State)
	}
}

// Ten queries against one provider that each take 100 ms: the read overlaps two at a time, and at parallelism 1 it
// runs them one after another.
func TestDashboardQueryOverlapsItsQueriesWithinTheReadLimit(t *testing.T) {
	var inFlight, peak atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		current := inFlight.Add(1)
		defer inFlight.Add(-1)
		for {
			seen := peak.Load()
			if current <= seen || peak.CompareAndSwap(seen, current) {
				break
			}
		}
		select {
		case <-time.After(100 * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		_, _ = fmt.Fprint(w, matrixWithTwoSamples(r, 1))
	}))
	defer provider.Close()
	widgets := make([]map[string]any, 0, 10)
	for i := range 10 {
		widgets = append(widgets, queryReadWidget(fmt.Sprintf("w%02d", i), fmt.Sprintf("q%02d", i)))
	}
	for _, tc := range []struct {
		parallelism int
		peak        int32
	}{{parallelism: 2, peak: 2}, {parallelism: 1, peak: 1}} {
		t.Run(fmt.Sprintf("parallelism %d", tc.parallelism), func(t *testing.T) {
			s, _ := testServiceWithDashboardParallelism(t, tc.parallelism, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
			putReadDashboard(t, s, widgets...)
			peak.Store(0)
			started := time.Now()
			result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
			elapsed := time.Since(started)
			require.Equal(t, tc.peak, peak.Load(), "peak provider queries in flight")
			require.Equal(t, 10, result.QueryCount.Executed)
			require.Equal(t, "ok", result.State)
			if tc.parallelism == 1 {
				require.GreaterOrEqual(t, elapsed, time.Second, "ten queries of 100 ms take at least a second one after another")
			} else {
				require.Less(t, elapsed, time.Second, "two overlapping queries finish well before the serial sum of about a second")
			}
		})
	}
}

// Two reads that run at once share one extra slot: together they never have more than three queries in flight, one
// own slot per read plus the single extra slot.
func TestDashboardQueryReadsShareTheExtraSlots(t *testing.T) {
	var inFlight, peak atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		current := inFlight.Add(1)
		defer inFlight.Add(-1)
		for {
			seen := peak.Load()
			if current <= seen || peak.CompareAndSwap(seen, current) {
				break
			}
		}
		select {
		case <-time.After(100 * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		_, _ = fmt.Fprint(w, matrixWithTwoSamples(r, 1))
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	widgets := make([]map[string]any, 0, 6)
	for i := range 6 {
		widgets = append(widgets, queryReadWidget(fmt.Sprintf("w%d", i), fmt.Sprintf("q%d", i)))
	}
	putReadDashboard(t, s, widgets...)
	responses := make(chan *httptest.ResponseRecorder, 2)
	for range 2 {
		go func() {
			responses <- request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil)
		}()
	}
	for range 2 {
		result := readDashboardResult(t, <-responses)
		require.Equal(t, 6, result.QueryCount.Executed)
		require.Equal(t, "ok", result.State)
	}
	require.LessOrEqual(t, peak.Load(), int32(3), "two reads share one extra slot: one own slot each plus one")
	require.Positive(t, peak.Load())
}

// Two stats share one main query and compare against two earlier windows. The main phase has one query, so any
// overlap comes from the comparison phase, which runs both earlier windows within the read's limit.
func TestDashboardComparisonsOverlapWithinTheReadLimit(t *testing.T) {
	var inFlight, peak atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		current := inFlight.Add(1)
		defer inFlight.Add(-1)
		for {
			seen := peak.Load()
			if current <= seen || peak.CompareAndSwap(seen, current) {
				break
			}
		}
		select {
		case <-time.After(100 * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		_, _ = fmt.Fprint(w, matrixWithTwoSamples(r, 1))
	}))
	defer provider.Close()
	for _, tc := range []struct {
		parallelism int
		peak        int32
	}{{parallelism: 2, peak: 2}, {parallelism: 1, peak: 1}} {
		t.Run(fmt.Sprintf("parallelism %d", tc.parallelism), func(t *testing.T) {
			s, _ := testServiceWithDashboardParallelism(t, tc.parallelism, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
			putReadDashboard(t, s, comparingStat("day", "rate", "1d", "up"), comparingStat("week", "rate", "7d", "up"))
			peak.Store(0)
			result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
			require.Equal(t, tc.peak, peak.Load(), "peak provider queries in flight during the comparison phase")
			require.Equal(t, 1, result.QueryCount.Planned)
			require.NotNil(t, result.QueryCount.Comparison)
			require.Equal(t, 2, result.QueryCount.Comparison.Executed)
			for _, widget := range result.Widgets {
				require.Equal(t, "ok", widget.Comparison.State, "%s: every earlier window answers", widget.ID)
			}
		})
	}
}

// The dry run shares the read's main phase, so its queries honour the same limit. A dry run plans no earlier-window
// queries at all (dryRunSummaryOptions skips them), so the provider sees exactly the two main queries.
func TestDryRunMainQueriesRespectTheReadLimit(t *testing.T) {
	comparing := func(id, query string, y int) string {
		return dataWidgetJSON(id, "stat", query, "req/s", y, `"options":{"decimals":2,"compare":{"window":"1d"}}`)
	}
	document := documentOf("demo", comparing("day", "rate", 0), comparing("week", "errors", 4))
	for _, tc := range []struct {
		name        string
		parallelism int
		peak        int32
	}{{"default", 0, 2}, {"serial", 1, 1}} {
		t.Run(tc.name, func(t *testing.T) {
			// At the parallel limit the first answer waits for the second request, so the overlap is shown by
			// arrival rather than by timing. The timeout only stops a regression to serial from hanging the test.
			var arrivals atomic.Int32
			second := make(chan struct{})
			provider, p := newDataProvider(t, func(_ string, end float64) (int, string) {
				if tc.peak > 1 {
					switch arrivals.Add(1) {
					case 1:
						select {
						case <-second:
						case <-time.After(5 * time.Second):
						}
					case 2:
						close(second)
					}
				}
				return http.StatusOK, promMatrix(promSeries("up", pair(end-60, "1")))
			})
			s, _ := testServiceWithDashboardParallelism(t, tc.parallelism, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
			report, _ := executeDryRunRequest(t, s, document, nil)
			require.Equal(t, int32(2), p.calls.Load(), "a dry run plans no comparison queries")
			require.Equal(t, tc.peak, p.peak.Load(), "the dry run's main queries overlap up to the read's parallelism")
			require.Empty(t, dataFindingsOf(report))
		})
	}
}

// A read at parallelism 2 whose queries mix a rate-limited answer with a slow healthy one keeps each outcome in its own
// signal: the 429 is rate_limited, and neither the slow query nor the fast one is failed or slowed by it.
func TestDashboardQueryRateLimitBesideSlowSiblingKeepsItsOwnOutcome(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("query") {
		case "limited":
			w.Header().Set("Retry-After", "30")
			http.Error(w, "slow down", http.StatusTooManyRequests)
		case "slow":
			time.Sleep(200 * time.Millisecond)
			_, _ = fmt.Fprint(w, matrixWithTwoSamples(r, 1))
		default:
			_, _ = fmt.Fprint(w, matrixWithTwoSamples(r, 1))
		}
	}))
	defer provider.Close()
	s, _ := testServiceWithDashboardParallelism(t, 2, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	putReadDashboard(t, s, queryReadWidget("limited", "limited"), queryReadWidget("slow", "slow"), queryReadWidget("fast", "fast"))
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
	require.Equal(t, "partial", result.State)
	require.Equal(t, 3, result.QueryCount.Executed)
	require.NotNil(t, result.Signals[0].Error)
	require.Equal(t, "rate_limited", result.Signals[0].Error.Code)
	require.Equal(t, "ok", result.Signals[1].State, "the slow sibling still answers")
	require.NotNil(t, result.Signals[1].LatencyMs)
	require.GreaterOrEqual(t, *result.Signals[1].LatencyMs, int64(200), "the slow sibling reports its own time")
	require.Equal(t, "ok", result.Signals[2].State, "the fast sibling still answers")
	require.Nil(t, result.Signals[2].Error)
}

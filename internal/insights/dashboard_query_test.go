package insights

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const dashboardQueryWindow = `"start":"2026-10-26T00:00:00Z","end":"2026-10-26T01:00:00Z"`

func queryReadWidget(id, expression string) map[string]any {
	return map[string]any{"id": id, "title": id, "type": "stat", "providerId": "prometheus", "query": expression, "unit": "req/s", "layout": map[string]int{"x": 0, "y": 0, "w": 6, "h": 4}, "options": map[string]int{"decimals": 2}}
}

func putReadDashboard(t *testing.T, s *Server, widgets ...map[string]any) (json.RawMessage, string) {
	t.Helper()
	document, err := json.Marshal(map[string]any{"schemaVersion": 1, "id": "overview", "title": "Service overview", "timeRange": "1h", "refreshInterval": 30, "widgets": widgets, "variables": []any{map[string]any{"name": "service", "label": "Service", "defaultValue": "checkout", "options": []string{"checkout", "api"}}}})
	if err != nil {
		t.Fatal(err)
	}
	etag, err := s.store.Put("overview", document, "", "*")
	if err != nil {
		t.Fatal(err)
	}
	return document, etag
}

func putReadSavedQuery(t *testing.T, s *Server, id, expression string) string {
	t.Helper()
	document, err := json.Marshal(SavedQuery{SchemaVersion: 1, ID: id, Name: id, ProviderID: "prometheus", Kind: "metrics", Query: expression, Parameters: []SavedQueryParameter{{Name: "service", Type: "string", DefaultValue: json.RawMessage(`"saved-default"`)}}})
	if err != nil {
		t.Fatal(err)
	}
	etag, err := s.savedQueries.put(id, document, "", "*")
	if err != nil {
		t.Fatal(err)
	}
	return etag
}

func readDashboardResult(t *testing.T, w *httptest.ResponseRecorder) DashboardQueryResult {
	t.Helper()
	if w.Code != 200 {
		t.Fatalf("query dashboard: %d %s", w.Code, w.Body)
	}
	var result DashboardQueryResult
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestDashboardQuerySavedBindingsDeduplicateAndDoNotWrite(t *testing.T) { //nolint:gocyclo // Verifies the complete saved-query execution contract and immutability together.
	var calls atomic.Int32
	var expression string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		expression = r.URL.Query().Get("query")
		if r.URL.Path != "/api/v1/query_range" || r.URL.Query().Get("step") != "12" {
			t.Errorf("provider request: %s", r.URL)
		}
		_, _ = fmt.Fprint(w, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"service":"api"},"values":[[1792972800,"1.2345"],[1792972812,"2.3456"],[1792972824,"NaN"]]}]}}`)
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	savedETag := putReadSavedQuery(t, s, "requests", `rate(requests_total{service={{service}}}[5m])`)
	first, second := queryReadWidget("rate", "dormant_query"), queryReadWidget("sparkline", "different_dormant_query")
	for _, widget := range []map[string]any{first, second} {
		widget["queryRef"] = map[string]any{"id": "requests", "bindings": []any{map[string]any{"parameter": "service", "source": "variable", "variable": "service"}}}
	}
	second["type"] = "timeseries"
	before, dashboardETag := putReadDashboard(t, s, first, second)
	value := "api\"} or vector(1) # {{service}}"
	body := fmt.Sprintf(`{"id":"overview","variables":{"service":%s},%s}`, dashboardStringLiteral(value), dashboardQueryWindow)
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(body), nil))
	if expression != `rate(requests_total{service=`+dashboardStringLiteral(value)+`}[5m])` {
		t.Fatalf("unsafe or recursive interpolation: %s", expression)
	}
	if calls.Load() != 1 || result.QueryCount != (DashboardQueryCount{Planned: 1, Executed: 1, Deduplicated: 1}) || len(result.Signals) != 1 {
		t.Fatalf("deduplication: calls=%d result=%+v", calls.Load(), result.QueryCount)
	}
	if result.State != "ok" || result.Widgets[0].SignalID != "q1" || result.Widgets[1].SignalID != "q1" || *result.Widgets[0].Decimals != 2 || result.Signals[0].Series[0].Last == nil || *result.Signals[0].Series[0].Last.Value != 2.3456 || !result.Signals[0].Series[0].TailMissing {
		t.Fatalf("signal did not preserve widget semantics: %+v", result)
	}
	if result.Dashboard.ETag != dashboardETag || len(result.SavedQueries) != 1 || result.SavedQueries[0].ETag != savedETag || result.Variables["service"] != value {
		t.Fatalf("snapshot provenance: %+v", result)
	}
	after, afterETag, err := s.store.Get("overview")
	if err != nil || !bytes.Equal(before, after) || dashboardETag != afterETag {
		t.Fatal("reading dashboard mutated its document")
	}
	_, afterSavedETag, err := s.savedQueries.get("requests")
	if err != nil || afterSavedETag != savedETag {
		t.Fatal("reading dashboard mutated saved query")
	}
}

func TestDashboardQueryDefaultsSelectionAndNoFallback(t *testing.T) {
	var queries []string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries = append(queries, r.URL.Query().Get("query"))
		_, _ = fmt.Fprint(w, `{"status":"success","data":{"resultType":"matrix","result":[]}}`)
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	putReadSavedQuery(t, s, "requests", `up{service={{service}}}`)
	first := queryReadWidget("saved", "dormant")
	first["queryRef"] = map[string]any{"id": "requests"}
	missing := queryReadWidget("missing", "never_run_dormant")
	missing["queryRef"] = map[string]any{"id": "missing-query"}
	inline := queryReadWidget("inline", `up{service={{service}}}`)
	putReadDashboard(t, s, first, missing, inline)
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
	if result.State != "partial" || len(queries) != 2 || queries[0] != `up{service="saved-default"}` || queries[1] != `up{service="checkout"}` || result.Widgets[1].Error.Code != "missing_saved_query" {
		t.Fatalf("default/fallback semantics queries=%v result=%+v", queries, result)
	}
	queries = nil
	result = readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview","widget_ids":["inline","saved"],`+dashboardQueryWindow+`}`), nil))
	if result.State != "empty" || result.Widgets[0].ID != "saved" || result.Widgets[1].ID != "inline" || len(result.Widgets) != 2 || len(queries) != 2 {
		t.Fatalf("selection must keep saved dashboard order: %+v", result)
	}
}

func TestDashboardQueryRejectsInvalidRequestsBeforeProviderIO(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls.Add(1) }))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	putReadDashboard(t, s, queryReadWidget("requests", "up"))
	for _, body := range []string{
		`{}`, `{"id":"overview","extra":true}`, `{"id":"overview","variables":null}`, `{"id":"overview","variables":{"service":null}}`,
		`{"id":"overview","variables":{"unknown":"api"}}`, `{"id":"overview","variables":{"service":1}}`, `{"id":"overview","widget_ids":[]}`,
		`{"id":"overview","widget_ids":["missing"]}`, `{"id":"overview","widget_ids":["requests","requests"]}`,
		`{"id":"overview","history_points":1}`, `{"id":"overview","history_points":33}`, `{"id":"overview","history_points":null}`, `{"id":"overview","history_points":1.5}`,
		`{"id":"overview","max_series":0}`, `{"id":"overview","max_series":9}`, `{"id":"overview","max_traces":11}`,
		`{"id":"overview","start":"2026-10-26T00:00:00Z"}`, `{"id":"overview","end":"2026-10-26T00:00:00Z"}`,
		`{"id":"overview","start":"","end":""}`, `{"id":"overview","start":"2026-10-26T00:00:00","end":"2026-10-26T01:00:00"}`,
		`{"id":"overview","start":"1970-01-01T00:00:00Z","end":"1970-01-01T01:00:00Z"}`,
		`{"id":"overview","start":"2026-10-26T01:00:00Z","end":"2026-10-26T00:00:00Z"}`,
		`{"id":"overview","start":"2026-09-01T00:00:00Z","end":"2026-10-26T01:00:00Z"}`,
		`{"id":"overview"} {"id":"overview"}`, `{"id":"overview","variables":{"service":"` + strings.Repeat("a", 1025) + `"}}`,
		`{"id":"overview","variables":{"service":"` + strings.Repeat("a", 33<<10) + `"}}`,
	} {
		t.Run(body[:min(70, len(body))], func(t *testing.T) {
			w := request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(body), nil)
			if w.Code != 400 {
				t.Fatalf("invalid request accepted: %d %s", w.Code, w.Body)
			}
		})
	}
	if calls.Load() != 0 {
		t.Fatal("invalid dashboard requests contacted the provider")
	}
	if w := request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"not-found"}`), nil); w.Code != 404 {
		t.Fatalf("missing dashboard: %d", w.Code)
	}
}

func TestDashboardQuerySnapshotReleasesMutationLockBeforeIO(t *testing.T) {
	started, resume := make(chan struct{}), make(chan struct{})
	var once sync.Once
	var queries []string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		once.Do(func() { close(started); <-resume })
		queries = append(queries, r.URL.Query().Get("query"))
		_, _ = fmt.Fprint(w, `{"status":"success","data":{"resultType":"matrix","result":[]}}`)
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	oldSavedETag := putReadSavedQuery(t, s, "requests", `up{service={{service}}}`)
	first, second := queryReadWidget("first", "up"), queryReadWidget("second", "unused")
	second["queryRef"] = map[string]any{"id": "requests"}
	_, oldDashboardETag := putReadDashboard(t, s, first, second)
	response := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		response <- request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil)
	}()
	<-started
	updated := make(chan struct{})
	go func() {
		defer close(updated)
		s.mutations.Lock()
		defer s.mutations.Unlock()
		original, _, _ := s.savedQueries.get("requests")
		replacement := bytes.Replace(original, []byte("up{service="), []byte("new_metric{service="), 1)
		if _, err := s.savedQueries.put("requests", replacement, oldSavedETag, ""); err != nil {
			t.Error(err)
		}
		original, _, _ = s.store.Get("overview")
		replacement = bytes.Replace(original, []byte("Service overview"), []byte("Updated title"), 1)
		if _, err := s.store.Put("overview", replacement, oldDashboardETag, ""); err != nil {
			t.Error(err)
		}
	}()
	select {
	case <-updated:
	case <-time.After(time.Second):
		close(resume)
		t.Fatal("provider I/O retained the mutations lock")
	}
	close(resume)
	result := readDashboardResult(t, <-response)
	if len(queries) != 2 || queries[1] != `up{service="saved-default"}` || result.Dashboard.Title != "Service overview" || result.Dashboard.ETag != oldDashboardETag || result.SavedQueries[0].ETag != oldSavedETag {
		t.Fatalf("read mixed document revisions: queries=%v result=%+v", queries, result)
	}
}

func TestDashboardQueryPartialProviderFailureAndCancellation(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Query().Get("query") == "bad" {
			http.Error(w, "secret endpoint and bearer token must not escape", http.StatusBadGateway)
			return
		}
		if r.URL.Query().Get("query") == "wait" {
			<-r.Context().Done()
			return
		}
		_, _ = fmt.Fprint(w, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{},"values":[[1792972800,"1"]]}]}}`)
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	putReadDashboard(t, s, queryReadWidget("good", "up"), queryReadWidget("bad", "bad"), queryReadWidget("wait", "wait"), queryReadWidget("later", "later"))
	w := request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview","widget_ids":["good","bad"],`+dashboardQueryWindow+`}`), nil)
	result := readDashboardResult(t, w)
	if result.State != "partial" || result.Signals[0].State != "ok" || result.Signals[1].Error.Code != "provider_error" || strings.Contains(w.Body.String(), "secret") {
		t.Fatalf("provider partial failure: %s", w.Body)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
	defer cancel()
	r := httptest.NewRequestWithContext(ctx, "POST", "/api/query-dashboard", strings.NewReader(`{"id":"overview","widget_ids":["good","wait","later"],`+dashboardQueryWindow+`}`))
	r.Header.Set("Authorization", "Bearer "+testToken)
	w = httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	result = readDashboardResult(t, w)
	if result.State != "partial" || result.QueryCount.Executed != 2 || result.Signals[0].State != "ok" || result.Signals[1].Error.Code != "timeout" || result.Signals[2].Error.Code != "timeout" || calls.Load() != 4 {
		t.Fatalf("deadline should preserve completed signals and stop I/O: %+v calls=%d", result, calls.Load())
	}
}

func TestDashboardQueryAdmissionIsSharedAndCancellationIsHonest(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls.Add(1) }))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	putReadDashboard(t, s, queryReadWidget("requests", "up"))
	for range cap(s.queries) {
		s.queries <- struct{}{}
	}
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview"}`), nil))
	if result.Signals[0].Error.Code != "rate_limited" || result.QueryCount.Executed != 0 || calls.Load() != 0 {
		t.Fatalf("dashboard bypassed provider admission: %+v", result)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	r := httptest.NewRequestWithContext(ctx, "POST", "/api/query-dashboard", strings.NewReader(`{"id":"overview"}`))
	r.Header.Set("Authorization", "Bearer "+testToken)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	result = readDashboardResult(t, w)
	if result.Signals[0].Error.Code != "canceled" || result.QueryCount.Executed != 0 || calls.Load() != 0 {
		t.Fatalf("cancellation was not honored: %+v", result)
	}
}

func TestDashboardQueryRangeUsesSavedCustomWindowAndSharedStep(t *testing.T) {
	now := time.Date(2026, 10, 26, 5, 0, 0, 123, time.UTC)
	document := dashboardReadDocument{TimeRange: "6h"}
	window, start, end, err := dashboardQueryTimeRange(&dashboardQueryRequest{}, &document, now)
	if err != nil || end-start != 6*3600 || window.StepSeconds != 72 || window.End != "2026-10-26T05:00:00Z" {
		t.Fatalf("relative window: %+v %v", window, err)
	}
	document.CustomTimeRange = &dashboardReadTimeRange{From: "2026-10-26T05:00:00.123+10:00", To: "2026-10-26T05:01:00.123+10:00"}
	window, start, end, err = dashboardQueryTimeRange(&dashboardQueryRequest{}, &document, now)
	if err != nil || end-start != 60 || window.StepSeconds != 1 || window.Start != "2026-10-25T19:00:00.123Z" {
		t.Fatalf("custom window: %+v %v", window, err)
	}
	window, _, _, err = dashboardQueryTimeRange(&dashboardQueryRequest{Start: "2026-10-26T00:00:00Z", End: "2026-10-26T01:00:00Z"}, &document, now)
	if err != nil || window.Start != "2026-10-26T00:00:00Z" || window.StepSeconds != 12 {
		t.Fatalf("explicit window did not override saved window: %+v %v", window, err)
	}
}

func TestDashboardQueryTempoSavedQueryAndOptInHistory(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/search" {
			if r.URL.Query().Get("q") != `{ resource.service.name = "checkout" }` {
				t.Errorf("trace service filter missing: %s", r.URL)
			}
			_, _ = fmt.Fprint(w, `{"traces":[{"traceID":"abc","rootServiceName":"checkout","rootTraceName":"GET /","startTimeUnixNano":"1792972800000000000","durationMs":12},{"traceID":"def","rootServiceName":"checkout","rootTraceName":"POST /","startTimeUnixNano":"1792972801000000000","durationMs":34}]}`)
			return
		}
		_, _ = fmt.Fprint(w, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{},"values":[[1792972800,"1"],[1792972812,"2"],[1792972824,"3"]]}]}}`)
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL}, ProviderConfig{ID: "tempo", Name: "Tempo", Type: "tempo", URL: provider.URL})
	traceQuery := []byte(`{"schemaVersion":1,"id":"traces","name":"Service traces","providerId":"tempo","kind":"traces","query":"{ resource.service.name = {{service}} }","parameters":[{"name":"service","type":"string"}]}`)
	if _, err := s.savedQueries.put("traces", traceQuery, "", "*"); err != nil {
		t.Fatal(err)
	}
	traceWidget := queryReadWidget("traces", "dormant")
	traceWidget["type"] = "traces"
	traceWidget["providerId"] = "tempo"
	traceWidget["queryRef"] = map[string]any{"id": "traces", "bindings": []any{map[string]any{"parameter": "service", "source": "variable", "variable": "service"}}}
	putReadDashboard(t, s, queryReadWidget("rate", "up"), traceWidget)
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview","max_traces":1,`+dashboardQueryWindow+`}`), nil))
	trace := result.Signals[1].Traces
	if result.State != "ok" || trace.Returned != 2 || trace.StatusCounts["unknown"] != 2 || len(trace.Examples) != 1 || !trace.ExamplesTruncated || trace.Examples[0].TraceID != "abc" || *trace.Examples[0].DurationMs != 12 {
		t.Fatalf("Tempo summary: %+v", trace)
	}
	w := request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview","widget_ids":["rate"],"history_points":2,`+dashboardQueryWindow+`}`), nil)
	var historyResult struct {
		Signals []struct {
			Series []struct {
				History [][2]float64 `json:"history"`
			} `json:"series"`
		} `json:"signals"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &historyResult); err != nil || w.Code != 200 {
		t.Fatalf("history response: %s %v", w.Body, err)
	}
	history := historyResult.Signals[0].Series[0].History
	if len(history) != 2 || history[0] != [2]float64{1792972800000, 1} || history[1] != [2]float64{1792972824000, 3} {
		t.Fatalf("history tuple endpoints: %v", history)
	}
}

func TestDashboardQueryResponseBudget(t *testing.T) {
	w := httptest.NewRecorder()
	result := DashboardQueryResult{Dashboard: DashboardQueryDocument{Title: strings.Repeat("x", 128<<10)}}
	writeDashboardQueryResult(w, &result)
	if w.Code != 413 || w.Body.Len() > 1024 {
		t.Fatalf("oversized response was not bounded: status=%d bytes=%d", w.Code, w.Body.Len())
	}
}

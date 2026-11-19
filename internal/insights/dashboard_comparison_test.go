package insights

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// The dashboard window in dashboard_query_test.go starts at this Unix second; the earlier hour ends where it starts.
const (
	comparisonRangeStart = 1792972800
)

// comparisonProvider answers the displayed range with current and the earlier window, which it recognises by its start.
// A non-empty failure is returned for the earlier window instead of data.
func comparisonProvider(t *testing.T, current, earlier string, failEarlier bool) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/query_range" {
			t.Errorf("unexpected provider request: %s", r.URL)
		}
		start, _ := strconv.ParseFloat(r.URL.Query().Get("start"), 64)
		if start < comparisonRangeStart {
			if failEarlier {
				http.Error(w, "earlier window unavailable", http.StatusInternalServerError)
				return
			}
			_, _ = fmt.Fprint(w, earlier)
			return
		}
		_, _ = fmt.Fprint(w, current)
	}))
}

func comparingStat(id, expression, window, good string) map[string]any {
	widget := queryReadWidget(id, expression)
	compare := map[string]any{"window": window}
	if good != "" {
		compare["good"] = good
	}
	widget["options"] = map[string]any{"decimals": 2, "compare": compare}
	return widget
}

func TestDashboardQueryComparesAStatWithItsEarlierWindow(t *testing.T) {
	provider := comparisonProvider(t, matrixBody(map[string][][2]string{"a": {{"1800", "112"}}}), matrixBody(map[string][][2]string{"a": {{"-1800", "100"}}}), false)
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	putReadDashboard(t, s, comparingStat("rate", "rate", "previous", "up"))
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))

	got := result.Widgets[0].Comparison
	if got == nil || got.State != "ok" || got.Window != "previous" || got.OffsetSeconds != 3600 {
		t.Fatalf("comparison: %+v", got)
	}
	assertComparedSamples(t, got)
	if got.Delta == nil || *got.Delta != 12 || got.Percent == nil || *got.Percent != 12 || got.Direction != "up" || got.Assessment != "better" || got.ChangeUnit != "req/s" {
		t.Fatalf("change: %+v", got)
	}
	if result.QueryCount.Comparison == nil || result.QueryCount.Comparison.Planned != 1 || result.QueryCount.Comparison.Executed != 1 {
		t.Fatalf("comparison query count: %+v", result.QueryCount.Comparison)
	}
	if len(result.Signals) != 1 || result.State != "ok" {
		t.Fatalf("the comparison must not add a signal or change the state: signals=%d state=%s", len(result.Signals), result.State)
	}
}

// assertComparedSamples checks the displayed sample and the earlier sample the change is taken between.
func assertComparedSamples(t *testing.T, got *DashboardComparison) {
	t.Helper()
	if got.Current == nil || got.Current.Timestamp != float64(comparisonRangeStart+1800)*1000 || got.Current.Value != 112 {
		t.Fatalf("displayed sample: %+v", got.Current)
	}
	if got.Baseline == nil || got.Baseline.Timestamp != float64(comparisonRangeStart-1800)*1000 || got.Baseline.Value != 100 {
		t.Fatalf("earlier sample: %+v", got.Baseline)
	}
}

func TestDashboardQueryComparisonAssessmentNeedsADeclaredDirection(t *testing.T) {
	// A day earlier, the sample sits 84600 s before the range end, inside the window [start - 1 d, end - 1 d).
	cases := map[string]struct{ good, want string }{"no direction": {"", ""}, "higher is worse": {"down", "worse"}}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			provider := comparisonProvider(t, matrixBody(map[string][][2]string{"a": {{"1800", "112"}}}), matrixBody(map[string][][2]string{"a": {{"-84600", "100"}}}), false)
			defer provider.Close()
			s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
			putReadDashboard(t, s, comparingStat("rate", "rate", "1d", tc.good))
			result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
			if got := result.Widgets[0].Comparison; got == nil || got.State != "ok" || got.Assessment != tc.want {
				t.Fatalf("assessment: %+v", got)
			}
		})
	}
}

func TestDashboardQueryComparisonFailureNeverChangesTheResult(t *testing.T) {
	provider := comparisonProvider(t, matrixBody(map[string][][2]string{"a": {{"1800", "112"}}}), "", true)
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	putReadDashboard(t, s, comparingStat("rate", "rate", "previous", "up"))
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
	got := result.Widgets[0].Comparison
	if got == nil || got.State != "error" || got.Error == nil {
		t.Fatalf("failed earlier window must be an error on the comparison: %+v", got)
	}
	if result.State != "ok" || result.Widgets[0].Attention != "" || result.Widgets[0].Error != nil {
		t.Fatalf("comparison failure reached the displayed result: state=%s widget=%+v", result.State, result.Widgets[0])
	}
}

func TestDashboardQueryComparisonWithNoEarlierSampleIsUnavailable(t *testing.T) {
	provider := comparisonProvider(t, matrixBody(map[string][][2]string{"a": {{"1800", "112"}}}), matrixBody(nil), false)
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	putReadDashboard(t, s, comparingStat("rate", "rate", "previous", ""))
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
	if got := result.Widgets[0].Comparison; got == nil || got.State != "unavailable" || got.Reason != "no_prior_sample" || got.Delta != nil || got.Percent != nil {
		t.Fatalf("no earlier sample must not invent a change: %+v", got)
	}
}

func TestDashboardQueryComparisonWithoutRoomBeforeTheRangeIsNeverQueried(t *testing.T) {
	provider := comparisonProvider(t, matrixBody(map[string][][2]string{"a": {{"1800", "112"}}}), matrixBody(map[string][][2]string{"a": {{"-1800", "100"}}}), false)
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	putReadDashboard(t, s, comparingStat("rate", "rate", "1d", ""))
	// The range starts one hour after the Unix epoch's first day, so a day earlier is before the epoch.
	window := `"start":"1970-01-02T00:00:00Z","end":"1970-01-02T01:00:00Z"`
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+window+`}`), nil))
	if got := result.Widgets[0].Comparison; got == nil || got.State != "unavailable" || got.Reason != "no_previous_range" {
		t.Fatalf("comparison without room: %+v", got)
	}
	if result.QueryCount.Comparison != nil {
		t.Fatalf("an unavailable window must not be counted as planned: %+v", result.QueryCount.Comparison)
	}
}

func TestDashboardQueryPlansEachEarlierWindowOnce(t *testing.T) {
	var earlierRequests int
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start, _ := strconv.ParseFloat(r.URL.Query().Get("start"), 64)
		if start < comparisonRangeStart {
			earlierRequests++
			_, _ = fmt.Fprint(w, matrixBody(map[string][][2]string{"a": {{"-1800", "100"}}}))
			return
		}
		_, _ = fmt.Fprint(w, matrixBody(map[string][][2]string{"a": {{"1800", "112"}}}))
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	putReadDashboard(t, s, comparingStat("first", "rate", "previous", ""), comparingStat("second", "rate", "previous", "down"))
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
	if result.QueryCount.Comparison == nil || result.QueryCount.Comparison.Planned != 1 || result.QueryCount.Comparison.Executed != 1 || earlierRequests != 1 {
		t.Fatalf("identical earlier windows must run once: count=%+v requests=%d", result.QueryCount.Comparison, earlierRequests)
	}
	for _, widget := range result.Widgets {
		if widget.Comparison == nil || widget.Comparison.State != "ok" {
			t.Fatalf("every comparing stat gets its own outcome: %+v", widget.Comparison)
		}
	}
	if result.Widgets[1].Comparison.Assessment != "worse" {
		t.Fatalf("each stat keeps its own direction: %+v", result.Widgets[1].Comparison)
	}
}

func TestDashboardQueryComparisonWithNoBudgetIsNotRun(t *testing.T) {
	result := &DashboardQueryResult{Widgets: []DashboardQueryWidget{{ID: "rate", SignalID: "q1", Comparison: &DashboardComparison{State: "not_run", Window: "previous"}}}}
	result.comparisonQueries = []Query{{Start: 1, End: 2}}
	result.comparisons = []dashboardComparisonPlan{{widget: 0, unique: 0, from: 1000, to: 2000, captured: true, current: &DashboardComparisonSample{Timestamp: 2000, Value: 1}}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/", nil)
	(&Server{}).executeDashboardComparisons(req, DashboardSummaryOptions{}, result, &dashboardQueryProviders{})
	if got := result.Widgets[0].Comparison; got.State != "not_run" || got.Reason != "time_budget" {
		t.Fatalf("an exhausted budget must read as not run: %+v", got)
	}
	if result.State != "" {
		t.Fatalf("a missed comparison must not change the result state: %q", result.State)
	}
}

func TestDashboardDryRunPlansNoComparison(t *testing.T) {
	result := &DashboardQueryResult{Widgets: []DashboardQueryWidget{{ID: "rate", Comparison: &DashboardComparison{State: "not_run"}}}}
	result.comparisons = []dashboardComparisonPlan{{widget: 0}}
	result.comparisonQueries = []Query{{Start: 1, End: 2}}
	result.QueryCount.Comparison = &DashboardComparisonCount{Planned: 1}
	dropDashboardComparisons(result)
	if result.Widgets[0].Comparison != nil || result.QueryCount.Comparison != nil || len(result.comparisonQueries) != 0 {
		t.Fatalf("a dry run must not keep an earlier-window plan: %+v", result)
	}
	if !dryRunSummaryOptions.SkipComparisons {
		t.Fatal("the validate dry run must skip earlier-window queries")
	}
}

func TestDashboardComparisonOutputKeepsOnlyTheWireFields(t *testing.T) {
	encoded, err := json.Marshal(DashboardComparison{State: "ok", Window: "1d", ChangeUnit: "pp"})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"state":"ok","window":"1d","offsetSeconds":0,"changeUnit":"pp"}` {
		t.Fatalf("wire form: %s", encoded)
	}
}

// A comparing stat with no displayed sample must not query its earlier window: there is nothing to compare with.
func TestDashboardQueryComparisonWithNoCurrentSampleIsNeverQueried(t *testing.T) {
	earlierQueries := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if start, _ := strconv.ParseFloat(r.URL.Query().Get("start"), 64); start < comparisonRangeStart {
			earlierQueries++
		}
		_, _ = fmt.Fprint(w, matrixBody(nil))
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	putReadDashboard(t, s, comparingStat("rate", "rate", "previous", ""))
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
	if earlierQueries != 0 {
		t.Fatalf("earlier-window queries without a displayed sample: %d", earlierQueries)
	}
	if got := result.Widgets[0].Comparison; got == nil || got.State != "unavailable" || got.Reason != "no_current_sample" {
		t.Fatalf("comparison without a displayed sample: %+v", got)
	}
}

// seriesBody is a Prometheus matrix with the given raw series entries, so a test can repeat a series name or add a warning.
func seriesBody(warnings string, entries ...string) string {
	return `{"status":"success",` + warnings + `"data":{"resultType":"matrix","result":[` + strings.Join(entries, ",") + `]}}`
}

func oneSeries(name string, samples ...string) string {
	return fmt.Sprintf(`{"metric":{"series":%q},"values":[%s]}`, name, strings.Join(samples, ","))
}

// sample is a Prometheus [timestamp, value] pair, with the timestamp given as an offset from the range start.
func sample(offset int, value string) string {
	return fmt.Sprintf(`[%d,%q]`, comparisonRangeStart+offset, value)
}

// comparisonResult runs the dashboard query for one comparing stat against a provider with the given bodies.
func comparisonResult(t *testing.T, current, earlier string, compare map[string]any) DashboardQueryResult {
	t.Helper()
	provider := comparisonProvider(t, current, earlier, false)
	t.Cleanup(provider.Close)
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	widget := queryReadWidget("rate", "rate")
	widget["options"] = map[string]any{"decimals": 2, "compare": compare}
	putReadDashboard(t, s, widget)
	return readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
}

// A truncated earlier response that still matched is partial, and the change is still shown.
func TestDashboardQueryComparisonFromAPartialEarlierResponseIsPartial(t *testing.T) {
	current := matrixBody(map[string][][2]string{"a": {{"1800", "112"}}})
	earlier := seriesBody(`"warnings":["partial response"],`, oneSeries("a", sample(-1800, "100")))
	result := comparisonResult(t, current, earlier, map[string]any{"window": "previous"})
	if got := result.Widgets[0].Comparison; got == nil || got.State != "partial" || got.Delta == nil || *got.Delta != 12 {
		t.Fatalf("partial earlier response: %+v", got)
	}
}

// A series key that is not unique on either side is never paired, so it has no change to report.
func TestDashboardQueryComparisonAmbiguousSeriesIsUnavailable(t *testing.T) {
	twice := seriesBody("", oneSeries("a", sample(1800, "112")), oneSeries("a", sample(1800, "113")))
	once := seriesBody("", oneSeries("a", sample(-1800, "100")))
	cases := map[string]struct{ current, earlier string }{
		"earlier side": {matrixBody(map[string][][2]string{"a": {{"1800", "112"}}}), seriesBody("", oneSeries("a", sample(-1800, "100")), oneSeries("a", sample(-1800, "101")))},
		"current side": {twice, once},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			result := comparisonResult(t, tc.current, tc.earlier, map[string]any{"window": "previous"})
			if got := result.Widgets[0].Comparison; got == nil || got.State != "unavailable" || got.Reason != "ambiguous_series" || got.Delta != nil {
				t.Fatalf("ambiguous series: %+v", got)
			}
		})
	}
}

// The earlier window excludes its end: a sample at the shifted range end belongs to the displayed range, not the window.
func TestDashboardQueryComparisonExcludesTheEarlierWindowEnd(t *testing.T) {
	current := matrixBody(map[string][][2]string{"a": {{"1800", "112"}}})
	// One day earlier the window is [start - 1 d, start - 1 d + 1 h), so a sample at start - 82800 s is outside it.
	atEnd := matrixBody(map[string][][2]string{"a": {{"-82800", "100"}}})
	if got := comparisonResult(t, current, atEnd, map[string]any{"window": "1d"}).Widgets[0].Comparison; got == nil || got.State != "unavailable" || got.Reason != "no_prior_sample" {
		t.Fatalf("a sample at the window end must not be paired: %+v", got)
	}
	justInside := matrixBody(map[string][][2]string{"a": {{"-82801", "100"}}})
	if got := comparisonResult(t, current, justInside, map[string]any{"window": "1d"}).Widgets[0].Comparison; got == nil || got.State != "ok" {
		t.Fatalf("a sample inside the window must be paired: %+v", got)
	}
}

// A negative earlier value divides by its absolute value, so a rise from -100 to 112 is a positive 212 percent.
func TestDashboardQueryComparisonPercentDividesByTheAbsoluteBaseline(t *testing.T) {
	current := matrixBody(map[string][][2]string{"a": {{"1800", "112"}}})
	earlier := matrixBody(map[string][][2]string{"a": {{"-1800", "-100"}}})
	got := comparisonResult(t, current, earlier, map[string]any{"window": "previous"}).Widgets[0].Comparison
	if got == nil || got.Percent == nil || *got.Percent != 212 || got.Direction != "up" {
		t.Fatalf("negative baseline: %+v", got)
	}
}

// A zero earlier value has no percent, and the absolute change still stands.
func TestDashboardQueryComparisonWithAZeroBaselineOmitsThePercent(t *testing.T) {
	current := matrixBody(map[string][][2]string{"a": {{"1800", "112"}}})
	earlier := matrixBody(map[string][][2]string{"a": {{"-1800", "0"}}})
	got := comparisonResult(t, current, earlier, map[string]any{"window": "previous"}).Widgets[0].Comparison
	if got == nil || got.State != "ok" || got.Percent != nil || got.Delta == nil || *got.Delta != 112 {
		t.Fatalf("zero baseline: %+v", got)
	}
}

// A validate dry run with execute answers from its main queries only. The dry run's range is relative to now, so the test
// counts every provider request: one main query, and no earlier-window request.
func TestDashboardDryRunWithExecuteSendsNoEarlierWindowRequest(t *testing.T) {
	var requests int
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = fmt.Fprint(w, matrixBody(map[string][][2]string{"a": {{"1800", "112"}}}))
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	document := map[string]any{"schemaVersion": 1, "id": "overview", "title": "Overview", "timeRange": "1h", "refreshInterval": 0, "widgets": []any{comparingStat("rate", "rate", "previous", "up")}}
	body, err := json.Marshal(map[string]any{"document": document, "execute": true})
	if err != nil {
		t.Fatal(err)
	}
	if w := request(t, s.Handler(), "POST", "/api/dashboards/validate", body, nil); w.Code != http.StatusOK {
		t.Fatalf("dry run: %d %s", w.Code, w.Body)
	}
	if requests != 1 {
		t.Fatalf("a dry run must send only its main query, sent %d provider requests", requests)
	}
}

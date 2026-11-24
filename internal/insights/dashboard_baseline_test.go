package insights

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
)

// currentBaselineBody is ten one-minute samples that step from 10 to 50 at the fifth, a run of five outside a flat band.
func currentBaselineBody() string {
	samples := make([][2]string, 0, 10)
	for k, value := range []string{"10", "10", "10", "10", "10", "50", "50", "50", "50", "50"} {
		samples = append(samples, [2]string{strconv.Itoa(k * 60), value})
	}
	return matrixBody(map[string][][2]string{"a": samples})
}

// earlierFlatBody is a flat 10 across the hour before the range, sampled every minute.
func earlierFlatBody() string {
	samples := make([][2]string, 0, 80)
	for k := 0; k < 80; k++ {
		samples = append(samples, [2]string{strconv.Itoa(-3600 + k*60), "10"})
	}
	return matrixBody(map[string][][2]string{"a": samples})
}

func baselineWidget(id string, baseline map[string]any) map[string]any {
	widget := queryReadWidget(id, "rate")
	widget["type"] = "timeseries"
	widget["options"] = map[string]any{"decimals": 2, "baseline": baseline}
	return widget
}

func TestDashboardQueryBaselineJudgesTheBandAgainstTheEarlierWindow(t *testing.T) {
	provider := comparisonProvider(t, currentBaselineBody(), earlierFlatBody(), false)
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	putReadDashboard(t, s, baselineWidget("rate", map[string]any{"window": "previous"}))
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))

	got := result.Widgets[0].Baseline
	if got == nil || got.State != "ok" || got.Window != "previous" || got.Band != "range" {
		t.Fatalf("baseline: %+v", got)
	}
	if got.OffsetSeconds == nil || *got.OffsetSeconds != 3600 {
		t.Fatalf("offset: %+v", got.OffsetSeconds)
	}
	if got.Evaluated != 10 || got.Outside != 5 || got.Fraction == nil || *got.Fraction != 0.5 {
		t.Fatalf("totals: %+v", got)
	}
	if len(got.Series) != 1 || len(got.Series[0].Runs) != 1 || got.Series[0].Runs[0].Samples != 5 {
		t.Fatalf("series and runs: %+v", got.Series)
	}
	if result.QueryCount.Baseline == nil || result.QueryCount.Baseline.Planned != 1 || result.QueryCount.Baseline.Executed != 1 {
		t.Fatalf("baseline query count: %+v", result.QueryCount.Baseline)
	}
	if len(result.Signals) != 1 {
		t.Fatalf("the baseline must not add a signal: %d", len(result.Signals))
	}
}

func TestDashboardQueryRollingBaselineRunsNoEarlierQuery(t *testing.T) {
	var earlierQueries atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if start, _ := strconv.ParseFloat(r.URL.Query().Get("start"), 64); start < comparisonRangeStart {
			earlierQueries.Add(1)
		}
		_, _ = fmt.Fprint(w, currentBaselineBody())
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	putReadDashboard(t, s, baselineWidget("rate", map[string]any{"window": "rolling"}))
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))

	if earlierQueries.Load() != 0 || result.QueryCount.Baseline != nil {
		t.Fatalf("a rolling baseline must not query an earlier window: queries=%d count=%+v", earlierQueries.Load(), result.QueryCount.Baseline)
	}
	got := result.Widgets[0].Baseline
	if got == nil || got.State != "ok" || got.OffsetSeconds != nil {
		t.Fatalf("rolling baseline: %+v", got)
	}
}

func TestDashboardBaselineSeriesIsTheFirstOmissionStep(t *testing.T) {
	if dashboardOmissionSteps[0].name != "baselineSeries" {
		t.Fatalf("first omission step: %s", dashboardOmissionSteps[0].name)
	}
	result := &DashboardQueryResult{Widgets: []DashboardQueryWidget{{Baseline: &DashboardBaseline{State: "ok", Evaluated: 10, Outside: 5, Series: []DashboardBaselineSeries{{Series: 0, Evaluated: 10, Outside: 5}, {Series: 1}}}}}}
	if !dropDashboardBaselineSeries(result) {
		t.Fatal("the step reported nothing dropped")
	}
	got := result.Widgets[0].Baseline
	if got.Series != nil || got.SeriesOmitted != 2 || got.Evaluated != 10 || got.Outside != 5 {
		t.Fatalf("after the step: %+v", got)
	}
	if dropDashboardBaselineSeries(result) {
		t.Fatal("a second pass has nothing to drop")
	}
}

func TestDashboardBaselineDryRunDropsItsPlans(t *testing.T) {
	result := &DashboardQueryResult{Widgets: []DashboardQueryWidget{{Baseline: &DashboardBaseline{State: "not_run"}}}}
	result.baselines = []dashboardBaselinePlan{{widget: 0, unique: 0}}
	result.baselineQueries = []Query{{Start: 1, End: 2}}
	result.QueryCount.Baseline = &DashboardComparisonCount{Planned: 1}
	dropDashboardComparisons(result)
	if result.Widgets[0].Baseline != nil || len(result.baselineQueries) != 0 || result.QueryCount.Baseline != nil || len(result.baselines) != 0 {
		t.Fatalf("a dry run must not keep a baseline plan: %+v", result)
	}
}

func TestDashboardBaselineMarkedNotRunWhenBudgetMissed(t *testing.T) {
	result := &DashboardQueryResult{Widgets: []DashboardQueryWidget{{Baseline: &DashboardBaseline{State: "not_run", Window: "1d"}}}}
	result.baselines = []dashboardBaselinePlan{{widget: 0, unique: 0, current: []Series{{Name: "a"}}}}
	markBaselines(result, 0, "not_run", "time_budget")
	if got := result.Widgets[0].Baseline; got.State != "not_run" || got.Reason != "time_budget" || got.Evaluated != 0 {
		t.Fatalf("missed budget: %+v", got)
	}
}

// Two time series that declare the same earlier window share one earlier query, and each gets its own band.
func TestDashboardQueryBaselinesShareIdenticalEarlierQueries(t *testing.T) {
	var earlierQueries atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if start, _ := strconv.ParseFloat(r.URL.Query().Get("start"), 64); start < comparisonRangeStart {
			earlierQueries.Add(1)
			_, _ = fmt.Fprint(w, earlierFlatBody())
			return
		}
		_, _ = fmt.Fprint(w, currentBaselineBody())
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	putReadDashboard(t, s, baselineWidget("first", map[string]any{"window": "previous"}), baselineWidget("second", map[string]any{"window": "previous"}))
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))

	if earlierQueries.Load() != 1 || result.QueryCount.Baseline == nil || result.QueryCount.Baseline.Planned != 1 || result.QueryCount.Baseline.Executed != 1 {
		t.Fatalf("identical windows must share one query: queries=%d count=%+v", earlierQueries.Load(), result.QueryCount.Baseline)
	}
	for index := range result.Widgets {
		if got := result.Widgets[index].Baseline; got == nil || got.State != "ok" || got.Outside != 5 {
			t.Fatalf("widget %d baseline: %+v", index, got)
		}
	}
}

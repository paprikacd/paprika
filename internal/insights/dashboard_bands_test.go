package insights

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// matrixBody builds a Prometheus matrix response. Each series is a label value and its
// samples as [offset seconds from 2026-10-26T00:00:00Z, value text].
func matrixBody(series map[string][][2]string) string {
	var entries []string
	for _, name := range []string{"a", "b", "c"} {
		samples, ok := series[name]
		if !ok {
			continue
		}
		var values []string
		for _, sample := range samples {
			values = append(values, fmt.Sprintf(`[%d,%q]`, 1792972800+atoiOffset(sample[0]), sample[1]))
		}
		entries = append(entries, fmt.Sprintf(`{"metric":{"series":%q},"values":[%s]}`, name, strings.Join(values, ",")))
	}
	return fmt.Sprintf(`{"status":"success","data":{"resultType":"matrix","result":[%s]}}`, strings.Join(entries, ","))
}

func atoiOffset(offset string) int {
	var seconds int
	_, _ = fmt.Sscanf(offset, "%d", &seconds)
	return seconds
}

func bandOptions(thresholds ...map[string]any) map[string]any {
	values := make([]any, 0, len(thresholds))
	for _, threshold := range thresholds {
		values = append(values, threshold)
	}
	return map[string]any{"thresholds": values}
}

func severityBands() map[string]any {
	return bandOptions(
		map[string]any{"value": 0, "status": "ok"},
		map[string]any{"value": 2, "status": "warning", "label": "Slow"},
		map[string]any{"value": 4, "status": "critical", "label": "Down"},
	)
}

func TestDashboardQueryDeclaresTheBandOfEachSeriesWidget(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("query") {
		case "gauge":
			_, _ = fmt.Fprint(w, matrixBody(map[string][][2]string{"a": {{"0", "1"}, {"60", "5"}}, "b": {{"0", "1"}, {"60", "1"}}}))
		case "grid":
			// The latest recorded sample of series a is missing, so it is unknown and sets no band.
			_, _ = fmt.Fprint(w, matrixBody(map[string][][2]string{"a": {{"0", "9"}, {"60", "NaN"}}, "b": {{"0", "1"}, {"60", "2.5"}}}))
		case "heat":
			_, _ = fmt.Fprint(w, matrixBody(map[string][][2]string{"a": {{"60", "3"}}}))
		case "colour":
			_, _ = fmt.Fprint(w, matrixBody(map[string][][2]string{"a": {{"60", "9"}}}))
		default:
			_, _ = fmt.Fprint(w, matrixBody(nil))
		}
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	gauge := queryReadWidget("gauge", "gauge")
	gauge["type"], gauge["pluginId"], gauge["dataKind"], gauge["options"] = "plugin", "threshold-gauge", "metrics", severityBands()
	grid := queryReadWidget("grid", "grid")
	grid["type"], grid["pluginId"], grid["dataKind"], grid["options"] = "plugin", "status-grid", "metrics", severityBands()
	heat := queryReadWidget("heat", "heat")
	heat["type"], heat["options"] = "heatmap", severityBands()
	colour := queryReadWidget("colour", "colour")
	colour["type"], colour["pluginId"], colour["dataKind"] = "plugin", "threshold-gauge", "metrics"
	colour["options"] = bandOptions(map[string]any{"value": 0, "color": "#123456"})
	putReadDashboard(t, s, gauge, grid, heat, colour)
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))

	assertSeriesBand(t, "gauge", &result.Widgets[0], "critical", "Down", 0, 4)
	assertSeriesBand(t, "status grid", &result.Widgets[1], "warning", "Slow", 1, 2)
	assertSeriesBand(t, "heatmap", &result.Widgets[2], "warning", "Slow", 0, 2)
	if result.Widgets[3].Threshold != nil {
		t.Fatalf("colour-only thresholds name no status, so they declare no band: %+v", result.Widgets[3].Threshold)
	}
	if result.Attention.Critical != 1 || result.Attention.Warning != 2 || result.Attention.Checked != 4 {
		t.Fatalf("attention counts from declared bands: %+v", result.Attention)
	}
}

// assertSeriesBand checks a multi-series band: its status, label, the series that set it and its boundary.
func assertSeriesBand(t *testing.T, name string, widget *DashboardQueryWidget, status, label string, series int, boundary float64) {
	t.Helper()
	got := widget.Threshold
	if got == nil || got.State != "matched" || got.Status != status || got.Label != label || got.Boundary == nil || *got.Boundary != boundary {
		t.Fatalf("%s: want %s %q at %v: %+v", name, status, label, boundary, got)
	}
	if widget.BandSeries == nil || widget.BandSeries.Series == nil || *widget.BandSeries.Series != series {
		t.Fatalf("%s: band must name series %d in its bandSeries sibling: %+v", name, series, widget.BandSeries)
	}
}

func TestDashboardQueryUnknownSeriesBandWhenNoLatestSampleIsValid(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, matrixBody(map[string][][2]string{"a": {{"0", "9"}, {"60", "NaN"}}}))
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	grid := queryReadWidget("grid", "grid")
	grid["type"], grid["pluginId"], grid["dataKind"], grid["options"] = "plugin", "status-grid", "metrics", severityBands()
	putReadDashboard(t, s, grid)
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
	if got := result.Widgets[0].Threshold; got == nil || got.State != "unknown" || got.Status != "" || result.Widgets[0].BandSeries.Series != nil {
		t.Fatalf("a missing latest recorded sample is unknown: %+v", got)
	}
	if result.Attention.Critical != 0 || result.Attention.Warning != 0 || result.Attention.Checked != 1 {
		t.Fatalf("unknown is not attention and the data was checked: %+v", result.Attention)
	}
}

func TestDashboardQueryBreachesAndFreshnessForTimeSeries(t *testing.T) { //nolint:gocyclo // One request exercises breaches, failure and freshness together.
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("query") {
		case "trend":
			// Samples every 60 s: ok, warning, warning, critical, ok.
			_, _ = fmt.Fprint(w, matrixBody(map[string][][2]string{"a": {{"0", "0"}, {"60", "3"}, {"120", "3"}, {"180", "5"}, {"240", "1"}}}))
		case "boom":
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = fmt.Fprint(w, `{"status":"error","error":"boom"}`)
		default:
			_, _ = fmt.Fprint(w, matrixBody(map[string][][2]string{"a": {{"240", "1"}}}))
		}
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	trend := queryReadWidget("trend", "trend")
	trend["type"], trend["options"] = "timeseries", severityBands()
	failing := queryReadWidget("failing", "boom")
	failing["type"], failing["options"] = "timeseries", severityBands()
	plain := queryReadWidget("plain", "other")
	plain["options"] = map[string]any{"staleAfterSeconds": 3600}
	putReadDashboard(t, s, trend, failing, plain)
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))

	breaches := result.Widgets[0].Breaches
	if breaches == nil || breaches.SeriesEvaluated != 1 || len(breaches.Intervals) != 2 {
		t.Fatalf("breaches: %+v", breaches)
	}
	warning, critical := breaches.Intervals[0], breaches.Intervals[1]
	if warning.Level != "warning" || warning.Series != 0 || warning.Start != 1792972860000 || warning.End != 1792972980000 || warning.DurationMs != 120000 {
		t.Fatalf("warning interval: %+v", warning)
	}
	if critical.Level != "critical" || critical.Start != 1792972980000 || critical.End != 1792973040000 || critical.DurationMs != 60000 {
		t.Fatalf("critical interval: %+v", critical)
	}
	if len(breaches.Summary) != 2 || breaches.Summary[0].Level != "critical" || breaches.Summary[1].DurationMs != 120000 {
		t.Fatalf("summary: %+v", breaches.Summary)
	}
	if result.Widgets[0].Attention != "critical" {
		t.Fatalf("a critical breach in the window needs attention: %+v", result.Widgets[0])
	}
	if result.Widgets[1].Breaches != nil || result.Widgets[1].Attention != "failed" {
		t.Fatalf("a failed read reports no breaches and counts as failed: %+v", result.Widgets[1])
	}
	if got := result.Widgets[2].Freshness; got == nil || got.State != "fresh" || got.ThresholdSeconds == nil || *got.ThresholdSeconds != 3600 {
		t.Fatalf("staleAfterSeconds still judges freshness: %+v", got)
	}
	// The trend series has no staleAfterSeconds, so the UI's cadence fallback applies: its samples
	// are 60 s apart, the limit is 120 s, and the newest sample is 3360 s old, so the tail is stale.
	if got := result.Widgets[0].Sample; got == nil || got.State != "stale" || got.Basis != sampleBasisCadence || got.StaleAfterSeconds == nil || *got.StaleAfterSeconds != 120 || got.AgeSeconds == nil || *got.AgeSeconds != 3360 {
		t.Fatalf("a time series without an option is judged by the UI's cadence fallback: %+v", got)
	}
	if result.Widgets[0].Freshness != nil {
		t.Fatalf("the first-contract freshness is reported only for an explicit staleAfterSeconds: %+v", result.Widgets[0].Freshness)
	}
	if result.Attention != (DashboardAttention{Basis: dashboardAttentionBasis, Widgets: 3, Checked: 2, Critical: 1, Failed: 1}) {
		t.Fatalf("attention rollup: %+v", result.Attention)
	}
}

// Only stat and timeseries judge staleAfterSeconds, the types the UI marks stale. A bar keeps
// its age but makes no stale judgement, and a time series is judged on its newest sample.
func TestDashboardQueryJudgesStalenessOnlyWhereTheUIDoes(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("query") {
		case "bar":
			_, _ = fmt.Fprint(w, matrixBody(map[string][][2]string{"a": {{"240", "1"}}}))
		default:
			// Series a last reports at 60 s, series b at 240 s; the newest sample is 240 s.
			_, _ = fmt.Fprint(w, matrixBody(map[string][][2]string{"a": {{"0", "1"}, {"60", "2"}}, "b": {{"0", "1"}, {"240", "3"}}}))
		}
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	bar := queryReadWidget("bar", "bar")
	bar["type"], bar["options"] = "bar", map[string]any{"staleAfterSeconds": 60}
	series := queryReadWidget("series", "series")
	series["type"], series["options"] = "timeseries", map[string]any{"staleAfterSeconds": 3400}
	putReadDashboard(t, s, bar, series)
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))

	if got := result.Widgets[0].Sample; got == nil || got.State != "no_threshold" || got.Basis != "" || got.StaleAfterSeconds != nil || got.AgeSeconds == nil || *got.AgeSeconds != 3360 {
		t.Fatalf("a bar reports its age without a stale judgement: %+v", got)
	}
	if result.Widgets[0].Freshness != nil {
		t.Fatalf("a bar has no first-contract freshness: %+v", result.Widgets[0].Freshness)
	}
	if got := result.Widgets[1].Freshness; got == nil || got.State != "fresh" || got.AgeSeconds == nil || *got.AgeSeconds != 3360 || got.ThresholdSeconds == nil || *got.ThresholdSeconds != 3400 {
		t.Fatalf("a time series is judged on its newest sample across series: %+v", got)
	}
	if result.Attention.Stale != 0 {
		t.Fatalf("no widget is stale here: %+v", result.Attention)
	}
}

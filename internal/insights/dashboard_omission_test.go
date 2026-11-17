package insights

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// statusBandedMatrix is a three-series matrix whose values cycle through ok, warning and
// critical bands, with three labels of realistic length per series. Every series breaches, so a 48-widget dashboard built
// from it carries breach intervals, breach summaries and series identities.
func statusBandedMatrix(t *testing.T) string {
	t.Helper()
	result := make([]map[string]any, 0, 3)
	for index := range 3 {
		metric := map[string]string{"series": fmt.Sprintf("checkout-production-region-%d", index)}
		for key := range 3 {
			metric[fmt.Sprintf("label_%d", key)] = fmt.Sprintf("value-%d-%d-abcdefghijklmnopqrstuvwxyz0123456789abcdef", index, key)
		}
		values := make([][]any, 0, 60)
		for sample := range 60 {
			value := []string{"1", "3", "5"}[(sample/5)%3]
			values = append(values, []any{1792972800 + sample*60, value})
		}
		result = append(result, map[string]any{"metric": metric, "values": values})
	}
	body, err := json.Marshal(map[string]any{"status": "success", "data": map[string]any{"resultType": "matrix", "result": result}})
	require.NoError(t, err)
	return string(body)
}

// The status-banded 48-widget dashboard is within the 130 KiB cap. It must return 200 within the cap,
// and report the detail it dropped in the fixed order.
func TestDashboardQueryStatusBanded48WidgetsReturnWithinTheCap(t *testing.T) {
	body := statusBandedMatrix(t)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, body)
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	widgets := make([]map[string]any, 0, 48)
	for index := range 48 {
		widget := queryReadWidget(fmt.Sprintf("widget-with-a-long-identifier-%02d", index), fmt.Sprintf("sum(rate(http_requests_total{job=\"x%d\"}[5m]))", index))
		widget["type"], widget["options"] = "timeseries", severityBands()
		widgets = append(widgets, widget)
	}
	putReadDashboard(t, s, widgets...)
	w := request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil)
	require.Equal(t, http.StatusOK, w.Code, "a 48-widget status-banded dashboard must not exceed the cap: %s", w.Body.String()[:min(w.Body.Len(), 200)])
	require.LessOrEqual(t, w.Body.Len(), DashboardQueryResponseBytes)
	result := readDashboardResult(t, w)
	require.Equal(t, []string{"breachIntervals"}, result.Omitted, "dropping the listed intervals alone brings this dashboard within the cap")
	requireOmittedMatchesWidgets(t, result.Omitted, result.Widgets)
	require.Equal(t, 48, result.Attention.Widgets)
	require.Equal(t, 48, result.Attention.Critical, "attention is decided before any detail is omitted")
}

// A small dashboard keeps every fact, and its result has no omitted field at all.
func TestDashboardQuerySmallDashboardKeepsEveryFactWithoutOmitted(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, labelledMatrix(labelled{"a", [][2]string{{"0", "1"}, {"60", "5"}, {"120", "5"}}}))
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	widget := queryReadWidget("requests", "up")
	widget["type"], widget["options"] = "timeseries", severityBands()
	putReadDashboard(t, s, widget)
	w := request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil)
	require.Equal(t, http.StatusOK, w.Code)
	var raw map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &raw))
	require.NotContains(t, raw, "omitted")
	result := readDashboardResult(t, w)
	require.Empty(t, result.Omitted)
	require.Len(t, result.Widgets, 1)
	breaches := result.Widgets[0].Breaches
	require.NotNil(t, breaches)
	require.Len(t, breaches.Intervals, 1, "the listed interval is kept")
	require.Equal(t, "critical", breaches.LatestLevel)
	require.NotNil(t, result.Widgets[0].Sample)
}

// breachDetailDashboard builds 48 widgets that each declare every fact the omission ladder can
// drop. Names are long enough that every step saves real bytes.
func breachDetailDashboard() *DashboardQueryResult {
	long := strings.Repeat("n", 96)
	result := &DashboardQueryResult{SchemaVersion: 1, Dashboard: DashboardQueryDocument{ID: "overview", Title: "Overview"}}
	for index := range 48 {
		breaches := &DashboardBreaches{SeriesEvaluated: 3, LatestLevel: "critical", Intervals: []DashboardBreachInterval{}, Summary: []DashboardBreachLevel{{Level: "critical", Intervals: 2, Samples: 1, DurationMs: 120_000}}}
		for interval := range 2 {
			breaches.Intervals = append(breaches.Intervals, DashboardBreachInterval{Series: interval, Name: long, Level: "critical", Start: float64(interval), End: float64(interval) + 60_000, DurationMs: 60_000})
		}
		seriesIndex, seconds, age, last := 1, 60.0, 12.5, 1792972800000.0
		state := "stale"
		if index%2 == 1 {
			state = "fresh" // Odd widgets are fresh, so the sample step removes them entirely.
		}
		threshold := 60
		result.Widgets = append(result.Widgets, DashboardQueryWidget{
			ID: fmt.Sprintf("widget-%02d", index), Title: "Widget", Type: "timeseries", Unit: "req/s", Attention: "critical",
			Breaches:   breaches,
			BandSeries: &DashboardBandSeries{Evaluated: 3, Series: &seriesIndex, Name: long},
			Sample:     &DashboardSample{State: state, Basis: sampleBasisStaleAfter, StaleAfterSeconds: &seconds, LastTimestamp: &last, AgeSeconds: &age},
			Freshness:  &DashboardObservationFreshness{ThresholdSeconds: &threshold, State: state, LastTimestamp: &last, AgeSeconds: &age},
		})
	}
	return result
}

// sizeAfterStepsOf measures a fresh dashboard from build after the first n ladder steps, with the
// omitted list those steps report. The title is set to one byte: an empty title is omitted from the
// JSON altogether, so a one-byte placeholder is the size the filler replaces.
func sizeAfterStepsOf(t *testing.T, build func() *DashboardQueryResult, n int) int {
	t.Helper()
	result := build()
	result.Dashboard.Title = "t"
	for _, step := range dashboardOmissionSteps[:n] {
		require.True(t, step.drop(result), "step %s must remove detail from this dashboard", step.name)
		result.Omitted = append(result.Omitted, step.name)
	}
	encoded, err := json.Marshal(result)
	require.NoError(t, err)
	return len(encoded)
}

// fillerForStepsOf sizes a title filler so the result is exactly DashboardQueryResponseBytes after n
// steps. The placeholder byte measured by sizeAfterStepsOf is replaced, so the filler is one byte
// longer than the cap's room. Before the n-th step the result is over the cap, so exactly n steps
// are needed. The filler is ASCII, so its JSON length equals its byte length.
func fillerForStepsOf(t *testing.T, build func() *DashboardQueryResult, n int) string {
	t.Helper()
	return strings.Repeat("t", DashboardQueryResponseBytes-sizeAfterStepsOf(t, build, n)+1)
}

// fillerForSteps is fillerForStepsOf for breachDetailDashboard.
func fillerForSteps(t *testing.T, n int) string {
	t.Helper()
	return fillerForStepsOf(t, breachDetailDashboard, n)
}

// The ladder applies steps in order and stops as soon as the result fits. Each case needs one more
// step than the previous one, and the omitted list names exactly those steps.
func TestDashboardOmissionDropsDetailInTheFixedOrder(t *testing.T) {
	for n := range len(dashboardOmissionSteps) + 1 {
		t.Run(fmt.Sprintf("%d steps", n), func(t *testing.T) {
			result := breachDetailDashboard()
			result.Dashboard.Title = fillerForSteps(t, n)
			encoded, err := encodeDashboardQueryResult(result)
			require.NoError(t, err)
			require.Equal(t, DashboardQueryResponseBytes, len(encoded), "the filler lands exactly on the cap, so the cap itself is a fit")
			want := make([]string, 0, n)
			for _, step := range dashboardOmissionSteps[:n] {
				want = append(want, step.name)
			}
			if n == 0 {
				require.Nil(t, result.Omitted, "a result that fits keeps every fact and reports no omission")
			} else {
				require.Equal(t, want, result.Omitted)
			}
		})
	}
}

// Omitted lists exactly what was dropped: each named detail is gone everywhere, and each detail
// not named is still present on every widget that declared it.
func TestDashboardOmittedListsExactlyWhatWasDropped(t *testing.T) {
	for n := 1; n <= len(dashboardOmissionSteps); n++ {
		result := breachDetailDashboard()
		result.Dashboard.Title = fillerForSteps(t, n)
		_, err := encodeDashboardQueryResult(result)
		require.NoError(t, err)
		dropped := make(map[string]bool, len(result.Omitted))
		for _, name := range result.Omitted {
			dropped[name] = true
		}
		for index := range result.Widgets {
			widget := &result.Widgets[index]
			stale := index%2 == 0
			require.Equal(t, dropped["breaches"], widget.Breaches == nil, "breaches on %s", widget.ID)
			if widget.Breaches != nil {
				require.Equal(t, dropped["breachIntervals"], len(widget.Breaches.Intervals) == 0, "listed intervals on %s", widget.ID)
				if dropped["breachIntervals"] {
					require.Equal(t, 2, widget.Breaches.IntervalsOmitted, "every listed interval moves into intervalsOmitted on %s", widget.ID)
				}
				require.NotEmpty(t, widget.Breaches.Summary, "summaries are kept until the breach object itself is dropped")
			}
			require.Equal(t, dropped["bandSeries"], widget.BandSeries == nil, "the bandSeries object on %s", widget.ID)
			require.Equal(t, dropped["sample"], widget.Freshness == nil, "time-series freshness on %s", widget.ID)
			switch {
			case !dropped["sample"]:
				require.NotNil(t, widget.Sample, "sample kept on %s", widget.ID)
				require.NotEmpty(t, widget.Sample.Basis, "sample limit kept on %s", widget.ID)
			case stale:
				require.NotNil(t, widget.Sample, "a stale sample keeps its state on %s", widget.ID)
				require.Equal(t, "stale", widget.Sample.State)
				require.Empty(t, widget.Sample.Basis, "a stale sample loses its limit on %s", widget.ID)
				require.Nil(t, widget.Sample.StaleAfterSeconds, "a stale sample loses its limit on %s", widget.ID)
				require.Nil(t, widget.Sample.LastTimestamp, "a stale sample loses its timestamp on %s", widget.ID)
				require.Nil(t, widget.Sample.AgeSeconds, "a stale sample loses its age on %s", widget.ID)
			default:
				require.Nil(t, widget.Sample, "a sample that is not stale is removed entirely on %s", widget.ID)
			}
			require.Equal(t, "critical", widget.Attention, "attention is decided before any detail is dropped")
		}
	}
}

// The only refusal left is a floor that exceeds the cap with every omittable fact removed.
func TestDashboardOmissionRefusesOnlyWhenTheFloorExceedsTheCap(t *testing.T) {
	result := breachDetailDashboard()
	result.Dashboard.Title = strings.Repeat("t", DashboardQueryResponseBytes)
	w := httptest.NewRecorder()
	writeDashboardQueryResult(w, result)
	require.Equal(t, http.StatusRequestEntityTooLarge, w.Code)
	require.Less(t, w.Body.Len(), 1024)
}

// A time-series dashboard with staleAfterSeconds and raw kube-state labels, and no status bands, is
// near the cap before any omission. The time-series freshness and the sample detail are what the
// ladder drops, so the 48-widget result must still return 200 within the cap.
func TestDashboardQueryTimeSeriesWithStalenessReturnsWithinTheCap(t *testing.T) {
	body := kubeStateMatrix(t, "0")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, body)
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	widgets := make([]map[string]any, 0, 48)
	for index := range 48 {
		widget := queryReadWidget(fmt.Sprintf("pod-restarts-widget-%02d", index), fmt.Sprintf("sum by (pod) (kube_pod_container_status_restarts_total{job=\"kube-state-%d\"})", index))
		widget["type"], widget["options"] = "timeseries", map[string]any{"staleAfterSeconds": 3600}
		widgets = append(widgets, widget)
	}
	putReadDashboard(t, s, widgets...)
	w := request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil)
	require.Equal(t, http.StatusOK, w.Code, "a 48-widget time-series dashboard must not exceed the cap: %s", w.Body.String()[:min(w.Body.Len(), 200)])
	require.LessOrEqual(t, w.Body.Len(), DashboardQueryResponseBytes)
	result := readDashboardResult(t, w)
	require.Equal(t, []string{"sample"}, result.Omitted, "no breach detail exists, so only the sample detail is dropped")
	require.Len(t, result.Widgets, 48)
	for index := range result.Widgets {
		require.Nil(t, result.Widgets[index].Freshness, "the time-series freshness mirror is dropped with the sample detail")
	}
}

// Forty-eight critical widgets with raw kube-state labels need the second ladder step: dropping the listed
// intervals alone leaves the result over the 130 KiB cap, so the per-widget breach objects go too, and
// the omitted list names both, in order.
func TestDashboardQueryStatusBandedDropsBreachObjectsWithinTheCap(t *testing.T) {
	body := kubeStateMatrix(t, "5")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, body)
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	widgets := make([]map[string]any, 0, 48)
	for index := range 48 {
		widget := queryReadWidget(fmt.Sprintf("pod-restarts-widget-%02d", index), fmt.Sprintf("sum by (pod) (kube_pod_container_status_restarts_total{job=\"kube-state-%d\"})", index))
		widget["type"], widget["options"] = "timeseries", severityBands()
		widgets = append(widgets, widget)
	}
	putReadDashboard(t, s, widgets...)
	w := request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil)
	require.Equal(t, http.StatusOK, w.Code, "a 48-widget status-banded dashboard must not exceed the cap: %s", w.Body.String()[:min(w.Body.Len(), 200)])
	require.LessOrEqual(t, w.Body.Len(), DashboardQueryResponseBytes)
	result := readDashboardResult(t, w)
	require.Equal(t, []string{"breachIntervals", "breaches"}, result.Omitted)
	for index := range result.Widgets {
		require.Nil(t, result.Widgets[index].Breaches, "breaches is reported, so none is present on %s", result.Widgets[index].ID)
		require.Equal(t, "critical", result.Widgets[index].Attention, "attention is decided before any detail is omitted")
	}
	require.Equal(t, 48, result.Attention.Critical)
}

// kubeStateMatrix is a three-series matrix with raw kube-state labels, the shape of a pod-level query.
// Every sample carries value, so a status-banded widget breaches on every series.
func kubeStateMatrix(t *testing.T, value string) string {
	t.Helper()
	result := make([]map[string]any, 0, 3)
	for index := range 3 {
		metric := map[string]string{
			"__name__":  "kube_pod_container_status_restarts_total",
			"namespace": "paprika-e2e-observability-namespace",
			"pod":       fmt.Sprintf("insights-query-gateway-deployment-7f9c8d6b5-%05d", index),
			"container": "observability-gateway-sidecar-container",
			"node":      fmt.Sprintf("gke-paprika-e2e-pool-%02d-", index) + strings.Repeat("n", 40),
			"uid":       fmt.Sprintf("6f1e2d3c-4b5a-4978-8a6b-9c0d1e2f3a4%d", index),
		}
		values := make([][]any, 0, 60)
		for sample := range 60 {
			values = append(values, []any{1792972800 + sample*60, value})
		}
		result = append(result, map[string]any{"metric": metric, "values": values})
	}
	body, err := json.Marshal(map[string]any{"status": "success", "data": map[string]any{"resultType": "matrix", "result": result}})
	require.NoError(t, err)
	return string(body)
}

// requireOmittedMatchesWidgets checks the dropped intervals named in the list against the widgets.
func requireOmittedMatchesWidgets(t *testing.T, omitted []string, widgets []DashboardQueryWidget) {
	t.Helper()
	dropped := make(map[string]bool, len(omitted))
	for _, name := range omitted {
		dropped[name] = true
	}
	for index := range widgets {
		widget := &widgets[index]
		if widget.Breaches != nil && dropped["breachIntervals"] {
			require.Empty(t, widget.Breaches.Intervals, "breachIntervals is reported, so no interval is listed on %s", widget.ID)
		}
		if dropped["breaches"] {
			require.Nil(t, widget.Breaches, "breaches is reported, so none is present on %s", widget.ID)
		}
	}
}

// withStatWidgets is breachDetailDashboard plus stat widgets with staleAfterSeconds. The first contract
// gave every stat a freshness object, so a capped result must keep each one, stale or fresh.
func withStatWidgets() *DashboardQueryResult {
	result := breachDetailDashboard()
	seconds, age, last := 60.0, 12.5, 1792972800000.0
	threshold := 60
	for index := range 4 {
		state := "stale"
		if index%2 == 1 {
			state = "fresh"
		}
		result.Widgets = append(result.Widgets, DashboardQueryWidget{
			ID: fmt.Sprintf("stat-%02d", index), Title: "Stat", Type: "stat", Unit: "req/s", Attention: "stale",
			Sample:    &DashboardSample{State: state, Basis: sampleBasisStaleAfter, StaleAfterSeconds: &seconds, LastTimestamp: &last, AgeSeconds: &age},
			Freshness: &DashboardObservationFreshness{ThresholdSeconds: &threshold, State: state, LastTimestamp: &last, AgeSeconds: &age},
		})
	}
	return result
}

// A capped result keeps every stat's first-contract freshness, so a client of the first contract still
// reads each stat's stale judgement. Only time-series freshness, which was added after the first
// contract, is dropped.
func TestDashboardOmissionKeepsEveryStatFreshnessWhenCapped(t *testing.T) {
	const steps = 4 // The sample step runs, so the time-series freshness and sample detail are dropped.
	result := withStatWidgets()
	result.Dashboard.Title = fillerForStepsOf(t, withStatWidgets, steps)
	encoded, err := encodeDashboardQueryResult(result)
	require.NoError(t, err)
	require.Equal(t, DashboardQueryResponseBytes, len(encoded))
	require.Equal(t, dashboardOmissionStepNamesThrough(steps), result.Omitted)
	stats := 0
	for index := range result.Widgets {
		widget := &result.Widgets[index]
		if widget.Type == "stat" {
			stats++
			require.NotNil(t, widget.Freshness, "stat %s keeps its first-contract freshness", widget.ID)
			require.Equal(t, 60, *widget.Freshness.ThresholdSeconds)
			require.Contains(t, []string{"fresh", "stale"}, widget.Freshness.State)
			require.NotNil(t, widget.Freshness.AgeSeconds, "stat %s keeps its age", widget.ID)
			continue
		}
		require.Nil(t, widget.Freshness, "time-series freshness is dropped on %s", widget.ID)
	}
	require.Equal(t, 4, stats)
	var raw map[string]any
	require.NoError(t, json.Unmarshal(encoded, &raw))
	require.Contains(t, raw, "omitted")
}

// dashboardOmissionStepNamesThrough names the first n steps in ladder order.
func dashboardOmissionStepNamesThrough(n int) []string {
	names := make([]string, 0, n)
	for _, step := range dashboardOmissionSteps[:n] {
		names = append(names, step.name)
	}
	return names
}

// Step 4 drops a stale sample stub entirely when the widget's attention already reads stale, because
// attention says the same. A stale sample on a widget with a more severe reason keeps its state.
func TestDashboardOmissionDropsStaleSampleStubWhenAttentionReadsStale(t *testing.T) {
	seconds, age, last := 120.0, 600.0, 1792975800000.0
	threshold := 120
	stale := func() *DashboardSample {
		return &DashboardSample{State: "stale", Basis: sampleBasisCadence, StaleAfterSeconds: &seconds, LastTimestamp: &last, AgeSeconds: &age}
	}
	result := &DashboardQueryResult{Widgets: []DashboardQueryWidget{
		{ID: "stale-only", Type: "timeseries", Attention: "stale", Sample: stale(), Freshness: &DashboardObservationFreshness{ThresholdSeconds: &threshold, State: "stale"}},
		{ID: "critical", Type: "timeseries", Attention: "critical", Sample: stale()},
		{ID: "stat-stale", Type: "stat", Attention: "stale", Sample: stale(), Freshness: &DashboardObservationFreshness{ThresholdSeconds: &threshold, State: "stale", LastTimestamp: &last, AgeSeconds: &age}},
	}}
	require.True(t, dashboardOmissionSteps[3].drop(result))
	require.Nil(t, result.Widgets[0].Sample, "a stale stub on a widget whose attention reads stale is dropped")
	require.Nil(t, result.Widgets[0].Freshness)
	require.NotNil(t, result.Widgets[1].Sample, "a stale stub under a more severe attention is kept")
	require.Equal(t, "stale", result.Widgets[1].Sample.State)
	require.Empty(t, result.Widgets[1].Sample.Basis)
	require.Nil(t, result.Widgets[1].Sample.AgeSeconds)
	require.Nil(t, result.Widgets[2].Sample, "a stat's stale stub under stale attention is dropped too")
	require.NotNil(t, result.Widgets[2].Freshness, "a stat keeps its first-contract freshness")
	require.Equal(t, "stale", result.Widgets[2].Freshness.State)
}

// kubeStateNineLabelMatrix is a three-series matrix of raw kube-state series with nine labels each. Its
// samples stop at lastIndex, so a widget judged by cadence is stale when the window ends after it.
func kubeStateNineLabelMatrix(t *testing.T, value string, samples, padding int) string {
	t.Helper()
	result := make([]map[string]any, 0, 3)
	for index := range 3 {
		metric := map[string]string{
			"__name__":  "kube_pod_container_status_restarts_total",
			"container": "api-server",
			"endpoint":  "http",
			"instance":  fmt.Sprintf("10.244.%d.%d:8080", index, index+1),
			"job":       "kube-state-metrics",
			"namespace": "paprika-e2e-observability-namespace" + strings.Repeat("x", padding),
			"pod":       fmt.Sprintf("insights-query-gateway-deployment-7f9c8d6b5-%05d", index),
			"service":   "kube-prometheus-stack-kube-state-metrics",
			"uid":       fmt.Sprintf("6f1e2d3c-4b5a-4978-8a6b-9c0d1e2f3a4%d", index),
		}
		values := make([][]any, 0, samples)
		for sample := range samples {
			values = append(values, []any{1792972800 + sample*60, value})
		}
		result = append(result, map[string]any{"metric": metric, "values": values})
	}
	body, err := json.Marshal(map[string]any{"status": "success", "data": map[string]any{"resultType": "matrix", "result": result}})
	require.NoError(t, err)
	return string(body)
}

// A 48-widget colour-only time series, each judged stale by the cadence fallback because its samples end
// ten minutes before the range end, must return 200 within the cap. The namespace label carries 30 extra
// characters, so the fixture encodes to 136,167 bytes before any step. Only step 4 (sample) runs, and it
// fits at 130,620 bytes, which drops the stale stubs whose attention already reads stale. The padding
// sizes this fixture; it is not a claim about real namespaces. It is a different shape from review
// probe (b), which is pinned to 200 within the cap in dashboard_omission_probe_test.go.
func TestDashboardQueryColourOnlyCadenceStale48WidgetsReturnWithinTheCap(t *testing.T) {
	body := kubeStateNineLabelMatrix(t, "0", 51, 30)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, body)
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	widgets := make([]map[string]any, 0, 48)
	for index := range 48 {
		title := fmt.Sprintf("Pod restarts by container, namespace and node for shard %02d over the last hour", index)
		widget := queryReadWidget(fmt.Sprintf("pod-restarts-widget-%02d", index), fmt.Sprintf("sum by (pod) (kube_pod_container_status_restarts_total{job=\"kube-state-%d\"})", index))
		widget["title"], widget["type"] = title, "timeseries"
		widget["options"] = map[string]any{"thresholds": []map[string]any{{"value": 0, "color": "#2a9d8f"}, {"value": 60, "color": "#e9c46a"}, {"value": 85, "color": "#e76f51"}}}
		widgets = append(widgets, widget)
	}
	putReadDashboard(t, s, widgets...)
	w := request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil)
	require.Equal(t, http.StatusOK, w.Code, "a 48-widget cadence-stale time-series dashboard must not exceed the cap: %s", w.Body.String()[:min(w.Body.Len(), 200)])
	require.LessOrEqual(t, w.Body.Len(), DashboardQueryResponseBytes)
	result := readDashboardResult(t, w)
	require.Equal(t, []string{"sample"}, result.Omitted, "the stale stubs are dropped, and nothing else is needed")
	require.Len(t, result.Widgets, 48)
	require.Equal(t, 48, result.Attention.Stale, "attention keeps every stale widget counted")
	for index := range result.Widgets {
		widget := &result.Widgets[index]
		require.Equal(t, "stale", widget.Attention, "attention is kept on %s", widget.ID)
		require.Nil(t, widget.Sample, "the stale stub on %s is dropped because its attention reads stale", widget.ID)
		require.Nil(t, widget.Freshness)
	}
}

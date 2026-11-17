package insights

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// The two review probes below are the reviewer's dashboards, reproduced in the test suite. Each has
// 48 widgets, three series per widget and nine raw kube-state labels per series. The cap is 130 KiB, the
// decision recorded in docs/design/insights/dashboard-query.md under Compatibility. After the omission
// ladder, probe (a) encodes to 131,910 bytes and probe (b) to 131,868 bytes, both within the cap, so both
// must return 200. The pathological test below keeps the 413 path pinned.

// reviewProbeProvider answers query_range the way the review probe does: a sine around 50 sampled at
// each step from the range start, stopping endGap steps before the range end, so the newest sample
// is judged stale by cadence.
func reviewProbeProvider(t *testing.T, endGap, seriesCount int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		start, _ := strconv.ParseFloat(r.Form.Get("start"), 64)
		end, _ := strconv.ParseFloat(r.Form.Get("end"), 64)
		step, _ := strconv.ParseFloat(r.Form.Get("step"), 64)
		series := make([]string, 0, seriesCount)
		for index := range seriesCount {
			values := make([]string, 0, 64)
			sample := 0
			for ts := start; ts <= end-float64(endGap)*step; ts += step {
				value := 50 + 45*math.Sin(float64(sample)*2*math.Pi/7+float64(index))
				values = append(values, fmt.Sprintf(`[%v,"%v"]`, ts, value))
				sample++
			}
			labels, _ := json.Marshal(reviewProbeLabels(index))
			series = append(series, fmt.Sprintf(`{"metric":%s,"values":[%s]}`, labels, strings.Join(values, ",")))
		}
		_, _ = fmt.Fprintf(w, `{"status":"success","data":{"resultType":"matrix","result":[%s]}}`, strings.Join(series, ","))
	}))
}

// reviewProbeLabels are the nine raw kube-state labels of one series.
func reviewProbeLabels(index int) map[string]string {
	return map[string]string{
		"__name__":  "kube_pod_container_status_restarts_total",
		"container": "api-server",
		"endpoint":  "http",
		"instance":  fmt.Sprintf("10.244.%d.%d:8080", index, index+1),
		"job":       "kube-state-metrics",
		"namespace": "paprika-e2e",
		"pod":       fmt.Sprintf("paprika-api-server-7d9c8b6f5d-%05d", index),
		"service":   "kube-prometheus-stack-kube-state-metrics",
		"uid":       fmt.Sprintf("2f1c3b9e-8a7d-4c6b-9e2f-1a3b5c7d%04d", index),
	}
}

// reviewProbeWidgets builds the 48 widgets. Each kind cycles through kinds. Colour-only thresholds
// carry no status, and statuses adds ok, warning and critical statuses to them.
func reviewProbeWidgets(kinds []string, statuses bool, titlePad int) []map[string]any {
	widgets := make([]map[string]any, 0, 48)
	for index := range 48 {
		kind, height := kinds[index%len(kinds)], 4
		thresholds := []map[string]any{{"value": 0, "color": "#2a9d8f"}, {"value": 60, "color": "#e9c46a"}, {"value": 85, "color": "#e76f51"}}
		if statuses {
			thresholds[0]["status"], thresholds[1]["status"], thresholds[2]["status"] = "ok", "warning", "critical"
		}
		options := map[string]any{"thresholds": thresholds}
		if kind == "stat" || kind == "timeseries" {
			options["decimals"] = 1
		}
		widget := map[string]any{
			"id": fmt.Sprintf("widget-%02d", index), "title": fmt.Sprintf("Restarts by pod %02d", index) + strings.Repeat("x", titlePad), "type": kind,
			"providerId": "prometheus", "query": fmt.Sprintf(`sum by (pod) (kube_pod_container_status_restarts_total{namespace="paprika-e2e",n="%d"})`, index),
			"unit": "ms", "layout": map[string]int{"x": (index % 2) * 6, "y": (index / 2) * 4, "w": 6, "h": height},
			"options": options,
		}
		switch kind {
		case "status-grid", "threshold-gauge", "status-history":
			widget["type"], widget["pluginId"], widget["dataKind"] = "plugin", kind, "metrics"
		}
		widgets = append(widgets, widget)
	}
	return widgets
}

// postReviewProbe posts the dashboard body against the review probe provider, which returns seriesCount
// series per query, and returns the response.
func postReviewProbe(t *testing.T, endGap, seriesCount int, widgets []map[string]any, body string) *httptest.ResponseRecorder {
	t.Helper()
	provider := reviewProbeProvider(t, endGap, seriesCount)
	t.Cleanup(provider.Close)
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	putReadDashboard(t, s, widgets...)
	return request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(body), nil)
}

// reviewProbeBody is the request for the whole review window, with the default three series.
const reviewProbeBody = `{"id":"overview",` + dashboardQueryWindow + `}`

// requireReviewProbeWithinCap requires 200 within the cap, with the omitted steps the probe needs. It
// also requires each widget that needs attention to keep its per-widget attention, so an omission that
// cleared attention fails here: the flagged widgets must equal the top-level Critical, Warning, Failed
// and Stale counts, which count each widget once.
func requireReviewProbeWithinCap(t *testing.T, endGap int, widgets []map[string]any, wantOmitted []string) {
	t.Helper()
	w := postReviewProbe(t, endGap, 3, widgets, reviewProbeBody)
	require.Equal(t, http.StatusOK, w.Code, "the review probe must fit the cap: %.200s", w.Body.String())
	require.LessOrEqual(t, w.Body.Len(), DashboardQueryResponseBytes)
	result := readDashboardResult(t, w)
	require.Equal(t, wantOmitted, result.Omitted)
	require.Len(t, result.Widgets, 48)
	require.Equal(t, 48, result.Attention.Widgets)
	flagged := 0
	for index := range result.Widgets {
		if result.Widgets[index].Attention != "" {
			flagged++
		}
	}
	attention := result.Attention
	require.Positive(t, flagged, "the review probe has widgets that need attention")
	require.Equal(t, attention.Critical+attention.Warning+attention.Failed+attention.Stale, flagged, "every flagged widget keeps its per-widget attention")
	requireOmittedMatchesWidgets(t, result.Omitted, result.Widgets)
}

// Review probe (a): status bands on time series, stat, heatmap, status-grid, threshold-gauge and
// status-history widgets, with raw kube-state series. After all four steps it encodes to 131,910 bytes,
// 1,210 bytes under the cap.
func TestDashboardQueryReviewProbeStatusBandedReturnsWithinTheCap(t *testing.T) {
	kinds := []string{"timeseries", "stat", "heatmap", "status-grid", "threshold-gauge", "status-history"}
	requireReviewProbeWithinCap(t, 0, reviewProbeWidgets(kinds, true, 0), dashboardOmissionStepNamesThrough(len(dashboardOmissionSteps)))
}

// Review probe (b) is the measured 7fe8ccca check: a colour-only time series with cadence staleness. It
// has no breach or band objects, so only the sample step removes anything. It encodes to 131,868 bytes,
// 1,252 bytes under the cap, and its per-widget attention and top-level attention are kept.
func TestDashboardQueryReviewProbeColourOnlyCadenceStaleReturnsWithinTheCap(t *testing.T) {
	requireReviewProbeWithinCap(t, 5, reviewProbeWidgets([]string{"timeseries"}, false, 61), []string{"sample"})
}

// A pathological selection still gets a clear 413. It is the 48-widget, nine-label shape with max_series 8.
// Its never-dropped signals and labels still exceed the cap after every ladder step (322,187 bytes after
// the ladder), so the refusal is the one path that stays pinned. The message names the cap in KiB, derived
// from the constant, so it cannot drift from the cap it reports.
func TestDashboardQueryPathologicalResultIsRefusedWithAClear413(t *testing.T) {
	body := `{"id":"overview",` + dashboardQueryWindow + `,"max_series":8}`
	w := postReviewProbe(t, 0, 8, reviewProbeWidgets([]string{"timeseries"}, false, 61), body)
	require.Equal(t, http.StatusRequestEntityTooLarge, w.Code, "eight series per query must exceed the cap: %.200s", w.Body.String())
	require.Contains(t, w.Body.String(), "even without optional detail")
	require.Contains(t, w.Body.String(), fmt.Sprintf("%d KiB", DashboardQueryResponseBytes>>10))
	require.Less(t, w.Body.Len(), 1024)
}

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

// The two review probes below are the reviewer's dashboards, reproduced in the test suite. Each
// has 48 widgets, three series per widget and nine raw kube-state labels per series. Their facts
// that the omission ladder never drops (signals, declared bands, attention) still exceed the cap
// after every step, so each is refused with 413. They are pinned as refusals so that the decision
// is visible in the suite: when the cap, or the per-widget attention it carries, changes, these
// flip to 200 and must be updated with it. See Compatibility in docs/design/insights/dashboard-query.md.

// reviewProbeProvider answers query_range the way the review probe does: a sine around 50 sampled at
// each step from the range start, stopping endGap steps before the range end, so the newest sample
// is judged stale by cadence.
func reviewProbeProvider(t *testing.T, endGap int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		start, _ := strconv.ParseFloat(r.Form.Get("start"), 64)
		end, _ := strconv.ParseFloat(r.Form.Get("end"), 64)
		step, _ := strconv.ParseFloat(r.Form.Get("step"), 64)
		series := make([]string, 0, 3)
		for index := range 3 {
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

// requireReviewProbeRefused posts the dashboard and requires the 413 that follows every ladder step.
func requireReviewProbeRefused(t *testing.T, endGap int, widgets []map[string]any) {
	t.Helper()
	provider := reviewProbeProvider(t, endGap)
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	putReadDashboard(t, s, widgets...)
	w := request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil)
	require.Equal(t, http.StatusRequestEntityTooLarge, w.Code, "the never-dropped facts still exceed the cap: %.200s", w.Body.String())
	require.Contains(t, w.Body.String(), "even without optional detail")
}

// Review probe (a): status bands on heatmap, status-grid, threshold-gauge and status-history widgets,
// with raw kube-state series. Its signals, bands and attention alone exceed the cap.
func TestDashboardQueryReviewProbeStatusBandedIsRefusedAfterEveryStep(t *testing.T) {
	kinds := []string{"timeseries", "stat", "heatmap", "status-grid", "threshold-gauge", "status-history"}
	requireReviewProbeRefused(t, 0, reviewProbeWidgets(kinds, true, 0))
}

// Review probe (b): a colour-only time series with cadence staleness. Its per-widget attention, top-level
// attention and omitted list are never dropped, and together they exceed the 7fe8ccca headroom.
func TestDashboardQueryReviewProbeColourOnlyCadenceStaleIsRefusedAfterEveryStep(t *testing.T) {
	requireReviewProbeRefused(t, 5, reviewProbeWidgets([]string{"timeseries"}, false, 61))
}

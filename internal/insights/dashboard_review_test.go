package insights

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// labelled is one series of a test matrix: its label and its samples, each
// [offset seconds from 2026-10-26T00:00:00Z, value text].
type labelled struct {
	name    string
	samples [][2]string
}

// labelledMatrix builds a Prometheus matrix with one series per label.
func labelledMatrix(series ...labelled) string {
	entries := make([]string, 0, len(series))
	for _, entry := range series {
		values := make([]string, 0, len(entry.samples))
		for _, sample := range entry.samples {
			offset, _ := strconv.Atoi(sample[0])
			values = append(values, fmt.Sprintf(`[%d,%q]`, 1792972800+offset, sample[1]))
		}
		entries = append(entries, fmt.Sprintf(`{"metric":{"series":%q},"values":[%s]}`, entry.name, strings.Join(values, ",")))
	}
	return fmt.Sprintf(`{"status":"success","data":{"resultType":"matrix","result":[%s]}}`, strings.Join(entries, ","))
}

// The first-mode gauge draws only its first series, so a critical second series it does not draw
// must not set its band.
func TestFirstModeGaugeDoesNotEvaluateSeriesItDoesNotDraw(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, labelledMatrix(
			labelled{"a", [][2]string{{"60", "1"}}},
			labelled{"b", [][2]string{{"60", "5"}}},
		))
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	gauge := queryReadWidget("gauge", "gauge")
	gauge["type"], gauge["pluginId"], gauge["dataKind"] = "plugin", "threshold-gauge", "metrics"
	gauge["options"], gauge["config"] = severityBands(), map[string]any{"seriesMode": "first"}
	putReadDashboard(t, s, gauge)
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
	widget := result.Widgets[0]
	require.Equal(t, "ok", widget.Threshold.Status, "the tile shows series a, so its ok band is the band")
	require.Equal(t, DashboardBandSeries{Evaluated: 1, Omitted: 1, Series: intPtr(0), Name: `{series="a"}`}, *widget.BandSeries)
	require.Empty(t, widget.Attention, "an undrawn critical series is not attention")
}

// The status history draws twelve series by default, so the thirteenth must not set the band,
// and an explicit maxSeries widens what is drawn.
func TestStatusHistoryDrawsItsDefaultSeriesOnly(t *testing.T) {
	series := make([]labelled, 0, 13)
	for index := range 13 {
		value := "1"
		if index == 12 {
			value = "5"
		}
		series = append(series, labelled{fmt.Sprintf("s%02d", index), [][2]string{{"60", value}}})
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, labelledMatrix(series...))
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	history := queryReadWidget("history", "history")
	history["type"], history["pluginId"], history["dataKind"], history["options"] = "plugin", "status-history", "metrics", severityBands()
	wider := queryReadWidget("wider", "history")
	wider["type"], wider["pluginId"], wider["dataKind"], wider["options"] = "plugin", "status-history", "metrics", severityBands()
	wider["config"] = map[string]any{"maxSeries": 13}
	putReadDashboard(t, s, history, wider)
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
	require.Equal(t, "ok", result.Widgets[0].Threshold.Status)
	require.Equal(t, 12, result.Widgets[0].BandSeries.Evaluated)
	require.Equal(t, 1, result.Widgets[0].BandSeries.Omitted)
	require.Equal(t, "critical", result.Widgets[1].Threshold.Status)
	require.Equal(t, 12, *result.Widgets[1].BandSeries.Series)
	require.Equal(t, `{series="s12"}`, result.Widgets[1].BandSeries.Name, "a series beyond the signal's summary is still named")
}

// A time series without an explicit option is judged by the UI's cadence fallback: twice the
// cadence of the series that reported last. This series is 60 s apart and ended 3420 s before the
// range end, so its tail is stale against a 120 s limit.
func TestTimeSeriesWithoutOptionIsJudgedByTheUICadenceFallback(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, labelledMatrix(labelled{"a", [][2]string{{"0", "1"}, {"60", "2"}, {"120", "3"}, {"180", "4"}}}))
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	trend := queryReadWidget("trend", "trend")
	trend["type"], trend["options"] = "timeseries", map[string]any{}
	putReadDashboard(t, s, trend)
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
	sample := result.Widgets[0].Sample
	require.NotNil(t, sample)
	require.Equal(t, "stale", sample.State)
	require.Equal(t, sampleBasisCadence, sample.Basis)
	require.Equal(t, 120.0, *sample.StaleAfterSeconds)
	require.Equal(t, 3420.0, *sample.AgeSeconds)
	require.Nil(t, result.Widgets[0].Freshness, "the first-contract freshness needs an explicit option")
	require.Equal(t, "stale", result.Widgets[0].Attention)
}

// The UI draws no stale tail for a truncated result, whatever the option says.
func TestTruncatedTimeSeriesIsNotJudgedStale(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, `{"status":"success","warnings":["partial response"],"data":{"resultType":"matrix","result":[{"metric":{"series":"a"},"values":[[1792972800,"1"],[1792972860,"2"],[1792972920,"3"],[1792972980,"4"]]}]}}`)
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	plain, explicit := queryReadWidget("plain", "up"), queryReadWidget("explicit", "up")
	plain["type"] = "timeseries"
	explicit["type"], explicit["options"] = "timeseries", map[string]any{"staleAfterSeconds": 60}
	putReadDashboard(t, s, plain, explicit)
	result := readDashboardResult(t, request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil))
	for index := range result.Widgets {
		require.Equal(t, "no_threshold", result.Widgets[index].Sample.State, "widget %d", index)
		require.Empty(t, result.Widgets[index].Sample.Basis, "widget %d has no limit", index)
		require.Nil(t, result.Widgets[index].Freshness, "widget %d", index)
	}
}

// A critical interval must survive a later run of warning flaps: the caps are per level.
func TestBreachIntervalsAreCappedPerLevel(t *testing.T) {
	thresholds := []dashboardReadThreshold{{Value: 0, Status: "ok"}, {Value: 2, Status: "warning"}, {Value: 4, Status: "critical"}}
	points := []Point{{Timestamp: 0, Value: fptr(5)}}
	for index := 1; index <= 26; index++ {
		value := 0.0
		if index%2 == 1 {
			value = 3
		}
		points = append(points, Point{Timestamp: float64(index) * 60_000, Value: fptr(value)})
	}
	breaches := dashboardBreaches([]Series{{Points: points}}, thresholds)
	critical, warnings := 0, 0
	for _, interval := range breaches.Intervals {
		if interval.Level == "critical" {
			critical++
		} else {
			warnings++
		}
	}
	require.Equal(t, 1, critical, "the critical interval is kept")
	require.Equal(t, 12, warnings, "warnings keep their most recent twelve")
	require.Equal(t, 1, breaches.IntervalsOmitted, "the oldest warning is counted, not listed")
	require.Equal(t, "critical", breaches.Intervals[0].Level, "chronological order: the critical interval comes first")
	require.Empty(t, breaches.LatestLevel, "the newest sample (index 26) is back in the ok band")
}

func TestLatestLevelIsTheNewestSample(t *testing.T) {
	thresholds := []dashboardReadThreshold{{Value: 0, Status: "ok"}, {Value: 2, Status: "critical"}}
	breaches := dashboardBreaches([]Series{{Points: []Point{{Timestamp: 0, Value: fptr(3)}, {Timestamp: 60_000, Value: fptr(0)}}}}, thresholds)
	require.Empty(t, breaches.LatestLevel, "a breach that has ended is not the current level")
	breaches = dashboardBreaches([]Series{{Points: []Point{{Timestamp: 0, Value: fptr(0)}, {Timestamp: 60_000, Value: fptr(3)}}}}, thresholds)
	require.Equal(t, "critical", breaches.LatestLevel)
}

// Many flapping time series together must stay under the response cap, with the listed
// intervals bounded dashboard-wide rather than per widget.
func TestBreachBudgetKeepsTheWorstCaseWellUnderTheResponseCap(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		series := make([]labelled, 0, 3)
		for index := range 3 {
			values := make([][2]string, 0, 300)
			for sample := range 300 {
				value := "1"
				if (sample/5)%2 == 1 {
					value = "5"
				}
				values = append(values, [2]string{strconv.Itoa(sample * 12), value})
			}
			series = append(series, labelled{fmt.Sprintf("svc-%d", index), values})
		}
		_, _ = fmt.Fprint(w, labelledMatrix(series...))
	}))
	defer provider.Close()
	s, _ := testService(t, ProviderConfig{ID: "prometheus", Name: "Prometheus", Type: "prometheus", URL: provider.URL})
	widgets := make([]map[string]any, 0, 48)
	for index := range 48 {
		widget := queryReadWidget(fmt.Sprintf("widget-%02d", index), fmt.Sprintf("q%d", index))
		widget["type"], widget["options"] = "timeseries", severityBands()
		widgets = append(widgets, widget)
	}
	putReadDashboard(t, s, widgets...)
	w := request(t, s.Handler(), "POST", "/api/query-dashboard", []byte(`{"id":"overview",`+dashboardQueryWindow+`}`), nil)
	require.Equal(t, http.StatusOK, w.Code, "the worst case must not exceed the response cap: %s", w.Body.String()[:min(w.Body.Len(), 200)])
	require.Less(t, w.Body.Len(), 96<<10, "the structured result stays well under its 128 KiB cap")
	result := readDashboardResult(t, w)
	listed := 0
	for _, widget := range result.Widgets {
		if widget.Breaches != nil {
			listed += len(widget.Breaches.Intervals)
		}
	}
	require.LessOrEqual(t, listed, dashboardBreachBudget, "listed breach intervals are budgeted across the dashboard")
}

// The UI's series caps are constants in its source. The Go caps must match them, or a band would
// come from series the visualization never shows.
func TestPluginSeriesCapsMatchTheUI(t *testing.T) {
	read := func(path string) string {
		raw, err := os.ReadFile("../../ui/src/features/insights/" + path) //nolint:gosec // Fixed repository paths named in this test.
		require.NoError(t, err)
		return string(raw)
	}
	capOf := func(source, pattern string) int {
		match := regexp.MustCompile(pattern).FindStringSubmatch(source)
		require.NotNil(t, match, "UI source no longer contains %q", pattern)
		value, err := strconv.Atoi(match[1])
		require.NoError(t, err)
		return value
	}
	gauge := read("plugins/threshold-gauge.tsx")
	require.Contains(t, gauge, `config.seriesMode !== "all"`, "a first-mode gauge draws one series")
	require.Equal(t, uiGaugeDefaultMaxSeries, capOf(gauge, `config\.maxSeries \?\? (\d+)`))
	require.Equal(t, uiStatusHistoryDefaultMaxSeries, capOf(read("plugins/metric-distributions.tsx"), `config\.maxSeries \?\? (\d+)`))
	require.Equal(t, uiStatusGridDefaultMaxSeries, capOf(read("plugins/status-grid.tsx"), `config\.maxSeries \?\? (\d+)`))
	require.Equal(t, uiHeatmapMaxRows, capOf(read("chart-renderers.tsx"), `const MAX_ROWS = (\d+);`))
}

func intPtr(value int) *int { return &value }

func fptr(value float64) *float64 { return &value }

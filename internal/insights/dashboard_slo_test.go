package insights

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

const sloTestConfig = `{"objective":99.9,"period":"30d","total":"http_requests_total","bad":"http_requests_total{code=\"500\"}"}`

// sloTestSeries returns one group's compiled-query series: each window's total and bad readings, labelled
// as the compiled query labels them.
func sloTestSeries(labels map[string]string, readings map[string][2]float64) []Series {
	series := []Series{}
	for window, pair := range readings {
		for part, value := range map[string]float64{"total": pair[0], "bad": pair[1]} {
			v := value
			all := map[string]string{"slo_window": window, "slo_part": part}
			for name, value := range labels {
				all[name] = value
			}
			series = append(series, Series{Labels: all, Points: []Point{{Timestamp: 1, Value: &v}}})
		}
	}
	return series
}

// sloTestWindows is a result where every window of the 30d multiwindow preset reads the same total and bad.
func sloTestWindows(total, bad float64) map[string][2]float64 {
	readings := map[string][2]float64{}
	for _, window := range []string{"5m", "30m", "1h", "2h", "6h", "1d", "3d", "30d"} {
		readings[window] = [2]float64{total, bad}
	}
	return readings
}

// sloTestWidget plans an slo-summary widget as the planner does, and binds it to signal q1.
func sloTestWidget(t *testing.T, config string) DashboardQueryWidget {
	t.Helper()
	widget := &dashboardReadWidget{ID: "slo", Title: "SLO", Type: "plugin", PluginID: sloSummaryPluginID, DataKind: "metrics", Config: json.RawMessage(config)}
	output := dashboardQueryWidgetOutput(widget)
	output.SignalID = "q1"
	return output
}

// The objective is evaluated on the executed result and reported as slo. Its state maps to attention, and
// the signal state and threshold are not changed by it.
func TestSLOSummaryWidgetReportsItsObjectiveAndAttention(t *testing.T) {
	cases := []struct {
		name      string
		readings  map[string][2]float64
		state     string
		reasons   []string
		attention string
	}{
		{name: "meeting", readings: sloTestWindows(1000, 0), state: "meeting", reasons: []string{}, attention: ""},
		{name: "budget spent is breaching and critical", readings: map[string][2]float64{"30d": {1000000, 2000}}, state: "breaching", reasons: []string{"budget_exhausted"}, attention: "critical"},
		{name: "slow burn is at risk and warning", readings: sloAtRiskReadings(), state: "at_risk", reasons: []string{"slow_burn"}, attention: "warning"},
		{name: "no traffic is unknown and not an attention", readings: map[string][2]float64{"30d": {0, 0}}, state: "unknown", reasons: []string{"no_traffic"}, attention: ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			output := sloTestWidget(t, sloTestConfig)
			result := &DashboardQueryResult{Widgets: []DashboardQueryWidget{output}, Signals: []DashboardSignal{{ID: "q1", State: "ok"}}}
			raw := &QueryResult{Series: sloTestSeries(nil, c.readings)}
			applyDashboardSignal(&result.Widgets[0], &result.Signals[0], raw, 1_800_000_000, 0)
			attention := applyDashboardAttention(result)

			slo := result.Widgets[0].SLO
			require.NotNil(t, slo)
			require.Equal(t, c.state, slo.State)
			require.Equal(t, c.reasons, slo.Reasons)
			require.Equal(t, 99.9, slo.Objective)
			require.Equal(t, "30d", slo.Period)
			require.Equal(t, dashboardSLOBasis, slo.Basis)
			require.Equal(t, time.Unix(1_800_000_000, 0).UTC().Format(time.RFC3339Nano), slo.EvaluatedAt)
			require.Equal(t, c.attention, result.Widgets[0].Attention)
			require.Equal(t, "ok", result.Signals[0].State, "the objective never changes the signal state")
			require.Nil(t, result.Widgets[0].Threshold, "the objective never sets a threshold")
			require.Equal(t, DashboardAttention{Basis: dashboardAttentionBasis, Widgets: 1, Checked: 1,
				Critical: boolCount(c.attention == "critical"), Warning: boolCount(c.attention == "warning")}, attention)
		})
	}
}

// sloAtRiskReadings fires only the 1d/2h warning pair: burn 5 on both windows, against factor 3.
func sloAtRiskReadings() map[string][2]float64 {
	readings := sloTestWindows(1000, 0)
	readings["30d"] = [2]float64{1000000, 500}
	readings["2h"] = [2]float64{10000, 50}
	readings["1d"] = [2]float64{100000, 500}
	return readings
}

func boolCount(value bool) int {
	if value {
		return 1
	}
	return 0
}

// A failed signal has no raw result, so the objective reads unknown with no data, not the stale reading.
func TestSLOSummaryFailedSignalEvaluatesToNoData(t *testing.T) {
	output := sloTestWidget(t, sloTestConfig)
	result := &DashboardQueryResult{Widgets: []DashboardQueryWidget{output}, Signals: []DashboardSignal{{ID: "q1", State: "error", Error: &DashboardQueryError{Code: "provider_error", Message: "down"}}}}
	raw := &QueryResult{Series: sloTestSeries(nil, sloTestWindows(1000, 0))}
	applyDashboardSignal(&result.Widgets[0], &result.Signals[0], raw, 1_800_000_000, 0)
	require.Equal(t, "unknown", result.Widgets[0].SLO.State)
	require.Equal(t, []string{"no_data"}, result.Widgets[0].SLO.Reasons)
	applyDashboardAttention(result)
	require.Equal(t, "failed", result.Widgets[0].Attention, "a failed signal needs attention, never a reading from its raw result")
}

// Groups sort worst first. The listed groups are capped at max_series, and the rest are counted as omitted.
func TestSLOSummaryListsAtMostMaxSeriesGroups(t *testing.T) {
	config := `{"objective":99.9,"period":"30d","total":"http_requests_total","bad":"http_requests_total{code=\"500\"}","groupBy":"service"}`
	output := sloTestWidget(t, config)
	series := make([]Series, 0, 5*16)
	for index := range 5 {
		labels := map[string]string{"service": string(rune('a' + index))}
		series = append(series, sloTestSeries(labels, sloTestWindows(1000, 0))...)
	}
	result := &DashboardQueryResult{Widgets: []DashboardQueryWidget{output}, Signals: []DashboardSignal{{ID: "q1", State: "ok"}}}
	applyDashboardSignal(&result.Widgets[0], &result.Signals[0], &QueryResult{Series: series}, 1_800_000_000, 3)

	slo := result.Widgets[0].SLO
	require.Equal(t, 5, slo.Counts.Meeting)
	require.Len(t, slo.Groups, 3)
	require.Equal(t, 2, slo.GroupsOmitted)
	require.Equal(t, map[string]string{"service": "a"}, slo.Groups[0].Labels)
}

// The sloBurn step drops the burn windows of each listed group and keeps the state, reasons and budget.
func TestSLOSummaryBurnIsTheOmissionStepThatDropsBurnOnly(t *testing.T) {
	result := &DashboardQueryResult{Widgets: []DashboardQueryWidget{{SLO: sloDetailObjective()}}}
	require.Equal(t, "sloBurn", dashboardOmissionSteps[len(dashboardOmissionSteps)-1].name)
	require.True(t, dropDashboardSLOBurn(result))
	require.False(t, dropDashboardSLOBurn(result), "a second pass has nothing left to drop")

	encoded, err := json.Marshal(result.Widgets[0].SLO)
	require.NoError(t, err)
	var decoded map[string]any
	require.NoError(t, json.Unmarshal(encoded, &decoded))
	groups, ok := decoded["groups"].([]any)
	require.True(t, ok)
	require.Len(t, groups, 1)
	group, ok := groups[0].(map[string]any)
	require.True(t, ok)
	require.NotContains(t, group, "burn")
	require.Equal(t, "meeting", group["state"])
	require.Equal(t, "meeting", decoded["state"])
}

// The attention basis names objectives, so a reader knows an SLO state counts toward attention.
func TestDashboardAttentionBasisNamesObjectives(t *testing.T) {
	require.Contains(t, dashboardAttentionBasis, "objectives")
	require.Contains(t, dashboardSLOBasis, "author-declared objective")
}

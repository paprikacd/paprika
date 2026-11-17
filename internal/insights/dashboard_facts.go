package insights

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// DashboardBandSeries describes the series a multi-series band was evaluated over. Evaluated
// counts the series the visualization draws; Omitted counts returned series it does not.
// Series and Name identify the series that set the band, when a band was matched.
type DashboardBandSeries struct {
	Evaluated int    `json:"evaluated"`
	Omitted   int    `json:"omitted"`
	Series    *int   `json:"series,omitempty"`
	Name      string `json:"name,omitempty"`
}

// These caps are how many leading series the UI draws for each band widget. They are
// pinned against the UI source by TestPluginSeriesCapsMatchTheUI, so a change there
// fails here. Evaluating more series than the UI draws would report a band it never shows.
const (
	uiGaugeDefaultMaxSeries         = 6   // threshold-gauge: seriesMode "all" draws config.maxSeries ?? 6; "first" draws one.
	uiStatusHistoryDefaultMaxSeries = 12  // status-history: config.maxSeries ?? 12.
	uiStatusGridDefaultMaxSeries    = 512 // status-grid: config.maxSeries ?? 512.
	uiHeatmapMaxRows                = 100 // heatmap: MAX_ROWS.
)

// dashboardBreachBudget bounds the breach intervals listed across one dashboard result.
// Each widget keeps at most breachIntervalsPerLevel intervals per level; a large selection
// keeps fewer, so the structured result is more likely to fit its 130 KiB cap unaided.
const dashboardBreachBudget = 96

// dashboardPluginConfig is the part of a plugin's config that decides which series are drawn.
type dashboardPluginConfig struct {
	SeriesMode string `json:"seriesMode"`
	MaxSeries  *int   `json:"maxSeries"`
}

// drawnSeriesCap is how many leading series a band widget draws, from its declared config.
// A config the UI would reject falls back to the defaults.
func drawnSeriesCap(widget *dashboardReadWidget) int {
	var config dashboardPluginConfig
	if json.Unmarshal(widget.Config, &config) != nil {
		config = dashboardPluginConfig{}
	}
	optional := func(value *int, fallback int) int {
		if value != nil {
			return *value
		}
		return fallback
	}
	switch {
	case widget.Type == "heatmap":
		return uiHeatmapMaxRows
	case widget.PluginID == "threshold-gauge":
		if config.SeriesMode == "all" {
			return optional(config.MaxSeries, uiGaugeDefaultMaxSeries)
		}
		return 1
	case widget.PluginID == "status-history":
		return optional(config.MaxSeries, uiStatusHistoryDefaultMaxSeries)
	default:
		return optional(config.MaxSeries, uiStatusGridDefaultMaxSeries)
	}
}

// dashboardWidgetBandOutput prepares a widget's band and breach evaluation. A stat keeps any
// band; the multi-series types need a status; a time series needs a warning or critical one.
func dashboardWidgetBandOutput(output *DashboardQueryWidget, widget *dashboardReadWidget) {
	switch {
	case widget.Type == "stat" && len(widget.Options.Thresholds) > 0:
		output.Threshold = &DashboardStatThreshold{State: "unknown"}
		output.thresholds = widget.Options.Thresholds
	case dashboardMultiSeriesBandWidget(widget) && dashboardHasStatusThreshold(widget.Options.Thresholds):
		output.Threshold = &DashboardStatThreshold{State: "unknown"}
		output.BandSeries = &DashboardBandSeries{}
		output.thresholds = widget.Options.Thresholds
		output.seriesCap = drawnSeriesCap(widget)
	case widget.Type == "timeseries" && dashboardHasBreachThreshold(widget.Options.Thresholds):
		output.thresholds = widget.Options.Thresholds
	}
}

// applyDashboardSignal applies one executed signal to a widget bound to it. Stat bands read
// the displayed summary; the other evaluations need the drawn series, so they read the raw
// result, which is nil when the provider did not answer.
func applyDashboardSignal(widget *DashboardQueryWidget, signal *DashboardSignal, raw *QueryResult, end float64) {
	if widget.SignalID != signal.ID {
		return
	}
	if widget.Type == "stat" {
		applyDashboardThreshold(widget, signal)
	} else {
		applyDashboardSeriesBand(widget, signal, raw)
	}
	applyDashboardFreshness(widget, signal, raw, end)
	applyDashboardBreaches(widget, signal, raw)
}

// applyDashboardThreshold evaluates a stat on the last valid value it displays.
func applyDashboardThreshold(widget *DashboardQueryWidget, signal *DashboardSignal) {
	if widget.Type != "stat" || widget.Threshold == nil {
		return
	}
	last := dashboardPrimaryObservation(signal, true)
	if last == nil {
		return
	}
	match := matchDashboardBand(*last.Value, widget.thresholds)
	widget.Threshold = &DashboardStatThreshold{State: "matched", Boundary: &match.Value, Status: match.Status, Color: match.Color, Label: match.Label}
}

// matchDashboardBand is the band a value falls in: the highest threshold it reaches.
// The first threshold also applies below its boundary. Thresholds are sorted.
func matchDashboardBand(value float64, thresholds []dashboardReadThreshold) dashboardReadThreshold {
	match := thresholds[0]
	for _, threshold := range thresholds {
		if threshold.Value > value {
			break
		}
		match = threshold
	}
	return match
}

// applyDashboardSeriesBand evaluates a gauge, status view or heatmap over the series the UI
// draws. Each drawn series' latest recorded sample sets its band, as the UI draws it: a
// missing latest sample is unknown and sets no band. The widget reports the most severe
// declared band among them, with the lowest series position winning a tie.
func applyDashboardSeriesBand(widget *DashboardQueryWidget, signal *DashboardSignal, raw *QueryResult) {
	if widget.SignalID != signal.ID || widget.Threshold == nil || widget.BandSeries == nil || signal.Error != nil || raw == nil {
		return
	}
	drawn := min(len(raw.Series), widget.seriesCap)
	widget.BandSeries.Evaluated, widget.BandSeries.Omitted = drawn, len(raw.Series)-drawn
	worst, index := worstSeriesBand(raw.Series[:drawn], widget.thresholds)
	if worst == nil {
		return
	}
	widget.Threshold = worst
	widget.BandSeries.Series = &index
	widget.BandSeries.Name = seriesDisplayName(raw.Series[index])
}

// worstSeriesBand is the most severe matched band across the series' latest recorded samples,
// with its series position, or nil when no series has a valid latest sample.
func worstSeriesBand(series []Series, thresholds []dashboardReadThreshold) (worst *DashboardStatThreshold, worstIndex int) {
	worstIndex = -1
	worstRank := 0
	for index := range series {
		latest := latestRecordedPoint(series[index].Points)
		if latest == nil || !dashboardFiniteValue(latest.Value) {
			continue
		}
		match := matchDashboardBand(*latest.Value, thresholds)
		boundary := match.Value
		band := &DashboardStatThreshold{State: "matched", Boundary: &boundary, Status: match.Status, Color: match.Color, Label: match.Label}
		if rank := dashboardStatusRank(match.Status); worst == nil || rank > worstRank {
			worst, worstIndex, worstRank = band, index, rank
		}
	}
	return worst, worstIndex
}

// latestRecordedPoint is the point with the latest valid timestamp. A tie keeps the
// later point, as the UI's status grid does. The value may be missing.
func latestRecordedPoint(points []Point) *Point {
	var latest *Point
	for index := range points {
		point := &points[index]
		if dashboardTimestamp(point.Timestamp) && (latest == nil || point.Timestamp >= latest.Timestamp) {
			latest = point
		}
	}
	return latest
}

// dashboardStatusRank orders declared statuses by severity for a multi-series band.
// A colour-only band has no status and ranks lowest.
func dashboardStatusRank(status string) int {
	switch status {
	case "critical":
		return 4
	case "warning":
		return 3
	case "unknown":
		return 2
	case "info":
		return 1
	case "ok":
		return 0
	default:
		return -1
	}
}

// applyDashboardBreaches evaluates a time series against its declared warning and critical
// bands. A failed or missing signal reports no breaches rather than an empty result.
func applyDashboardBreaches(widget *DashboardQueryWidget, signal *DashboardSignal, raw *QueryResult) {
	if widget.SignalID != signal.ID || widget.Type != "timeseries" || !dashboardHasBreachThreshold(widget.thresholds) || signal.Error != nil || raw == nil {
		return
	}
	widget.Breaches = dashboardBreaches(raw.Series, widget.thresholds)
}

// budgetDashboardBreaches keeps the listed breach intervals within dashboardBreachBudget
// across the result: each widget keeps its most recent intervals per level, and the cut
// intervals are counted as omitted. Summaries are unaffected.
func budgetDashboardBreaches(result *DashboardQueryResult) {
	breaching := 0
	for index := range result.Widgets {
		if result.Widgets[index].Breaches != nil {
			breaching++
		}
	}
	if breaching == 0 {
		return
	}
	perLevel := min(breachIntervalsPerLevel, max(1, dashboardBreachBudget/(2*breaching)))
	for index := range result.Widgets {
		if breaches := result.Widgets[index].Breaches; breaches != nil {
			breaches.trimToPerLevel(perLevel)
		}
	}
}

// dashboardMultiSeriesBandWidget names the visualizations whose band is evaluated per series
// on its latest recorded sample. Their bands are authored in options.thresholds.
func dashboardMultiSeriesBandWidget(widget *dashboardReadWidget) bool {
	return widget.Type == "heatmap" || (widget.Type == "plugin" && (widget.PluginID == "threshold-gauge" || widget.PluginID == "status-grid" || widget.PluginID == "status-history"))
}

// dashboardHasStatusThreshold reports whether any authored threshold names a status.
// A colour-only threshold has no status to report.
func dashboardHasStatusThreshold(thresholds []dashboardReadThreshold) bool {
	for _, threshold := range thresholds {
		if threshold.Status != "" {
			return true
		}
	}
	return false
}

// dashboardHasBreachThreshold reports whether any authored threshold is a warning or
// critical status, the only statuses that breach.
func dashboardHasBreachThreshold(thresholds []dashboardReadThreshold) bool {
	for _, threshold := range thresholds {
		if threshold.Status == "warning" || threshold.Status == "critical" {
			return true
		}
	}
	return false
}

// seriesDisplayName is a bounded label that identifies a series in the output. Signals
// summarise only a few series, so a raw position alone cannot always be resolved.
func seriesDisplayName(series Series) string {
	if series.Name != "" {
		name, _ := dashboardText(series.Name, 96)
		return name
	}
	keys := make([]string, 0, len(series.Labels))
	for key := range series.Labels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, fmt.Sprintf("%s=%s", key, series.Labels[key]))
	}
	name, _ := dashboardText(strings.Join(parts, ", "), 96)
	return name
}

// latestBreachLevel is the level of the newest latest-valid sample among the evaluated
// series, or empty when that sample is not in a warning or critical band.
func latestBreachLevel(series []Series, thresholds []dashboardReadThreshold) string {
	var newest *Point
	level := ""
	for index := range series {
		latest := latestValidPoint(series[index].Points)
		if latest != nil && (newest == nil || latest.Timestamp >= newest.Timestamp) {
			newest = latest
			level = breachStatus(thresholds[breachBandIndex(*latest.Value, thresholds)].Status)
		}
	}
	return level
}

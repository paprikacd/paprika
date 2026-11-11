package insights

import "math"

// DashboardSample is the age of a metric widget's latest observation and the limit that judges
// it. State is unknown without an observation, no_threshold when no limit applies, and fresh or
// stale against the limit otherwise. Basis names what set the limit.
type DashboardSample struct {
	State             string   `json:"state"`
	Basis             string   `json:"basis,omitempty"`
	StaleAfterSeconds *float64 `json:"staleAfterSeconds,omitempty"`
	LastTimestamp     *float64 `json:"lastTimestamp,omitempty"`
	AgeSeconds        *float64 `json:"ageSeconds,omitempty"`
}

// The sample basis names what judges a widget's latest sample. An explicit option wins;
// a time series without one falls back to the UI's cadence rule.
const (
	sampleBasisStaleAfter = "staleAfterSeconds"
	sampleBasisCadence    = "cadence"
)

// judgesStaleAfter reports whether a widget's options.staleAfterSeconds is judged as
// staleness. Only these two types judge it, and only these two get a stale mark or
// hatch in the UI, which is the source of truth:
//   - stat: the Single value warns when its displayed sample is older than the
//     threshold (ui/src/features/insights/chart-renderers.tsx, the stale flag).
//   - timeseries: the stale tail after the newest latest-valid sample is hatched
//     (ui/src/features/insights/time-series-chart.tsx, staleTail).
//
// The widget editor offers the option for exactly these types
// (ui/src/features/insights/widget-editor.tsx). Rich metrics read staleAfterSeconds
// only as a track-end grace (ui/src/features/insights/plugins/rich-metrics-data.ts),
// which is not a stale judgement, so they are not in the set. Every other metric
// widget reports its age without a stale judgement.
//
// The query_dashboard sample, the dry run's data.stale rule, the schema note and the
// composition guidance all use this set. TestStaleJudgementSetMatchesTheUI pins it.
// Change the UI and this function together.
func judgesStaleAfter(widgetType string) bool {
	return widgetType == "stat" || widgetType == "timeseries"
}

// latestValidPoint is the latest finite observation with a valid timestamp, as the UI's
// latestPoint picks it. A tie keeps the later point.
func latestValidPoint(points []Point) *Point {
	var latest *Point
	for index := range points {
		point := &points[index]
		if !dashboardTimestamp(point.Timestamp) || !dashboardFiniteValue(point.Value) {
			continue
		}
		if latest == nil || point.Timestamp >= latest.Timestamp {
			latest = point
		}
	}
	return latest
}

// newestValidPoint is the newest latest-valid observation across every returned series.
// The timeseries stale tail is judged on this, as the UI judges it.
func newestValidPoint(series []Series) *Point {
	var newest *Point
	for index := range series {
		latest := latestValidPoint(series[index].Points)
		if latest != nil && (newest == nil || latest.Timestamp >= newest.Timestamp) {
			newest = latest
		}
	}
	return newest
}

// timeseriesCadenceLimit ports the UI's stale-tail fallback without an explicit option:
// twice the longest cadence among the series whose latest valid sample is the newest
// one (time-series-chart.tsx, staleTail). It reports false when no such series has a
// cadence, in which case the UI draws no stale tail.
func timeseriesCadenceLimit(series []Series, at float64) (seconds float64, ok bool) {
	var cadence float64
	for index := range series {
		points := series[index].Points
		if last := latestValidPoint(points); last == nil || last.Timestamp != at {
			continue
		}
		if step := sampleCadence(points); step > cadence {
			cadence = step
		}
	}
	if cadence <= 0 {
		return 0, false
	}
	return 2 * cadence / 1000, true
}

// applyDashboardFreshness reports the age of the widget's latest observation at the range
// end and judges it against the limit in effect. A stat reads its displayed (primary)
// series, a time series the newest sample of any series. A truncated time-series result is
// not judged at all, as the UI draws no stale tail for one.
func applyDashboardFreshness(widget *DashboardQueryWidget, signal *DashboardSignal, raw *QueryResult, end float64) {
	if widget.SignalID != signal.ID || widget.Sample == nil {
		return
	}
	truncated := raw != nil && raw.Truncated
	if widget.Type == "timeseries" && truncated {
		clearSampleLimit(widget)
	}
	last := freshnessObservation(widget, signal, raw)
	if last == nil {
		setUnknownSample(widget)
		return
	}
	timestamp := last.Timestamp
	age := math.Max(0, end-timestamp/1000)
	sample := widget.Sample
	sample.LastTimestamp, sample.AgeSeconds = &timestamp, &age
	if widget.Type == "timeseries" && !truncated && raw != nil {
		applyCadenceLimit(sample, raw.Series, timestamp)
	}
	sample.State = sampleState(sample, end, timestamp)
	mirrorFreshness(widget, timestamp, age)
}

// setUnknownSample records that the widget has no usable observation.
func setUnknownSample(widget *DashboardQueryWidget) {
	widget.Sample.State = "unknown"
	if widget.Freshness != nil {
		widget.Freshness.State = "unknown"
	}
}

// mirrorFreshness copies the judged sample into the first-contract freshness, where one exists.
func mirrorFreshness(widget *DashboardQueryWidget, timestamp, age float64) {
	if widget.Freshness == nil {
		return
	}
	widget.Freshness.LastTimestamp, widget.Freshness.AgeSeconds = &timestamp, &age
	widget.Freshness.State = widget.Sample.State
}

// clearSampleLimit removes every limit from a widget's sample, and the first-contract freshness.
func clearSampleLimit(widget *DashboardQueryWidget) {
	widget.Sample.Basis, widget.Sample.StaleAfterSeconds = "", nil
	widget.Freshness = nil
}

// freshnessObservation is the observation a widget's age is measured from, or nil when there
// is no usable one.
func freshnessObservation(widget *DashboardQueryWidget, signal *DashboardSignal, raw *QueryResult) *Point {
	if widget.Type != "timeseries" {
		return dashboardPrimaryObservation(signal, false)
	}
	if raw == nil || signal.Error != nil {
		return nil
	}
	return newestValidPoint(raw.Series)
}

// applyCadenceLimit sets the UI's cadence fallback as the sample's limit, when an explicit option
// is absent and a cadence exists.
func applyCadenceLimit(sample *DashboardSample, series []Series, at float64) {
	if sample.StaleAfterSeconds != nil {
		return
	}
	if seconds, ok := timeseriesCadenceLimit(series, at); ok {
		sample.Basis, sample.StaleAfterSeconds = sampleBasisCadence, &seconds
	}
}

// sampleState judges the observation against the limit in effect. The comparison is in
// milliseconds, as the UI makes it, and a sample exactly at the limit is fresh.
func sampleState(sample *DashboardSample, end, timestamp float64) string {
	if sample.StaleAfterSeconds == nil {
		return "no_threshold"
	}
	if end*1000-timestamp > *sample.StaleAfterSeconds*1000 {
		return "stale"
	}
	return "fresh"
}

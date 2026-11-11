package insights

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
// The query_dashboard freshness state, the dry run's data.stale rule, the schema
// note and the composition guidance all use this set. TestStaleJudgementSetMatchesTheUI
// pins it. Change the UI and this function together.
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

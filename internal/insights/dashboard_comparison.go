package insights

import (
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// Comparison windows, as offsets from the selected range. "previous" is the equal window immediately before the range.
const (
	comparisonDayMs  = 86_400_000
	comparisonWeekMs = 7 * comparisonDayMs
	comparisonMaxMs  = 31 * comparisonDayMs
)

// DashboardComparison is a stat's point-to-point change against an earlier window: the displayed sample now and the latest
// valid sample of the same series in that window. It is information, not status. A state other than ok or partial names
// why there is no change, and not_run means the earlier window was not queried within the budget. Never read not_run as
// no change. Direction and Assessment here use the exact sign; the query_dashboard gateway settles them to flat and
// unchanged when the change rounds to nothing at the widget's display, as the UI does.
type DashboardComparison struct {
	State         string                     `json:"state"`
	Window        string                     `json:"window"`
	OffsetSeconds float64                    `json:"offsetSeconds"`
	Current       *DashboardComparisonSample `json:"current,omitempty"`
	Baseline      *DashboardComparisonSample `json:"baseline,omitempty"`
	Delta         *float64                   `json:"delta,omitempty"`
	Percent       *float64                   `json:"percent,omitempty"`
	// ChangeUnit is the unit of delta: percentage points for a percentage widget, otherwise the widget unit.
	ChangeUnit string `json:"changeUnit"`
	Direction  string `json:"direction,omitempty"`
	// Assessment is set only when the stat declares which direction is better.
	Assessment string               `json:"assessment,omitempty"`
	Reason     string               `json:"reason,omitempty"`
	Error      *DashboardQueryError `json:"error,omitempty"`
}

// DashboardComparisonSample is one observation in Unix milliseconds and its value.
type DashboardComparisonSample struct {
	Timestamp float64 `json:"timestamp"`
	Value     float64 `json:"value"`
}

// DashboardComparisonCount counts the earlier-window queries: distinct queries planned, and those executed.
type DashboardComparisonCount struct {
	Planned  int `json:"planned"`
	Executed int `json:"executed"`
}

// dashboardComparisonPlan links one comparing widget to its earlier-window query. The displayed sample is captured from the
// widget's own signal before that signal's raw result is dropped, so the comparison never keeps a second raw result.
type dashboardComparisonPlan struct {
	widget int
	unique int
	good   string
	// from and to bound the earlier window in Unix milliseconds. The window is closed at from and open at to.
	from, to float64
	captured bool
	current  *DashboardComparisonSample
	// seriesKey is the displayed series' key, and currentSeries counts the displayed result's series that share it.
	seriesKey     string
	currentSeries int
}

// planDashboardComparison plans a stat's earlier-window query for the widget about to be appended at index. The query is
// the main query moved back by the window's offset, so it asks the same question of the earlier window. Identical earlier
// queries share one execution. A window with no room before the range is unavailable and never queried.
func planDashboardComparison(result *DashboardQueryResult, index int, widget *dashboardReadWidget, output *DashboardQueryWidget, query *Query, seen map[Query]int) {
	compare := widget.Options.Compare
	if compare == nil || widget.Type != "stat" {
		return
	}
	startMs, endMs := math.Round(query.Start*1000), math.Round(query.End*1000)
	span := endMs - startMs
	offset := comparisonOffsetMs(compare.Window, span)
	output.Comparison = &DashboardComparison{State: "not_run", Window: compare.Window, OffsetSeconds: offset / 1000, ChangeUnit: comparisonChangeUnit(widget.Unit)}
	if span < 1000 || span > comparisonMaxMs || startMs-offset <= 0 {
		output.Comparison.State, output.Comparison.Reason = "unavailable", "no_previous_range"
		return
	}
	earlier := *query
	// The same bounds the time-series lens asks for: the start is inclusive and the end sits one millisecond before the
	// shifted range end, so a sample exactly at the boundary belongs to the displayed range, not the earlier window.
	earlier.Start, earlier.End = (startMs-offset)/1000, (endMs-offset-1)/1000
	unique, found := seen[earlier]
	if !found {
		unique = len(result.comparisonQueries)
		result.comparisonQueries = append(result.comparisonQueries, earlier)
		seen[earlier] = unique
		if result.QueryCount.Comparison == nil {
			result.QueryCount.Comparison = &DashboardComparisonCount{}
		}
		result.QueryCount.Comparison.Planned++
	}
	result.comparisons = append(result.comparisons, dashboardComparisonPlan{widget: index, unique: unique, good: compare.Good, from: startMs - offset, to: endMs - offset})
}

func comparisonOffsetMs(window string, span float64) float64 {
	switch window {
	case "1d":
		return comparisonDayMs
	case "7d":
		return comparisonWeekMs
	}
	return span
}

func comparisonChangeUnit(unit string) string {
	if unit == "%" {
		return "pp"
	}
	return unit
}

// captureDashboardComparisons records the displayed sample of each comparing widget that this signal answers. It runs
// before the signal's raw result is dropped.
func captureDashboardComparisons(result *DashboardQueryResult, signalID string, raw *QueryResult) {
	for i := range result.comparisons {
		plan := &result.comparisons[i]
		if plan.captured || result.Widgets[plan.widget].SignalID != signalID {
			continue
		}
		plan.captured = true
		if raw == nil {
			continue
		}
		primary := primaryDashboardSeries(raw.Series)
		if primary < 0 {
			continue
		}
		series := &raw.Series[primary]
		plan.seriesKey = comparisonSeriesKey(series)
		plan.currentSeries = countComparisonSeries(raw.Series, plan.seriesKey)
		if point := comparisonLatestPoint(series.Points, math.Inf(-1), math.Inf(1)); point != nil {
			plan.current = &DashboardComparisonSample{Timestamp: point.Timestamp, Value: *point.Value}
		}
	}
}

// executeDashboardComparisons queries each distinct earlier window once, in order, while the budget lasts, then gives each
// comparing widget its outcome. A failure or a missed budget never changes the result's state or attention.
func (s *Server) executeDashboardComparisons(r *http.Request, options DashboardSummaryOptions, result *DashboardQueryResult, cache *dashboardQueryProviders) {
	for unique := range result.comparisonQueries {
		query := &result.comparisonQueries[unique]
		if !comparisonHasCurrentSample(result, unique) {
			// No displayed sample means there is nothing to compare, so the earlier window is not queried.
			markComparisons(result, unique, "unavailable", "no_current_sample")
			continue
		}
		if r.Context().Err() != nil {
			markComparisons(result, unique, "not_run", "time_budget")
			continue
		}
		signal, executed, _, raw := s.executeDashboardQuery(r, query, options, cache)
		if executed {
			result.QueryCount.Comparison.Executed++
		}
		for i := range result.comparisons {
			plan := &result.comparisons[i]
			if plan.unique == unique {
				finishDashboardComparison(result, plan, &signal, raw)
			}
		}
	}
}

// markComparisons sets the state of every comparing stat that shares one earlier-window query.
func markComparisons(result *DashboardQueryResult, unique int, state, reason string) {
	for i := range result.comparisons {
		if result.comparisons[i].unique == unique {
			setComparisonState(result, &result.comparisons[i], state, reason, nil)
		}
	}
}

// comparisonHasCurrentSample reports whether a comparing stat that uses this earlier query has a displayed sample.
func comparisonHasCurrentSample(result *DashboardQueryResult, unique int) bool {
	for i := range result.comparisons {
		if result.comparisons[i].unique == unique && result.comparisons[i].current != nil {
			return true
		}
	}
	return false
}

func finishDashboardComparison(result *DashboardQueryResult, plan *dashboardComparisonPlan, signal *DashboardSignal, raw *QueryResult) {
	if signal.Error != nil {
		setComparisonState(result, plan, "error", "", signal.Error)
		return
	}
	if plan.current == nil || raw == nil {
		setComparisonState(result, plan, "unavailable", "no_current_sample", nil)
		return
	}
	if plan.currentSeries > 1 {
		setComparisonState(result, plan, "unavailable", "ambiguous_series", nil)
		return
	}
	matches := comparisonMatches(raw.Series, plan.seriesKey)
	if len(matches) > 1 {
		setComparisonState(result, plan, "unavailable", "ambiguous_series", nil)
		return
	}
	var earlier *Point
	if len(matches) == 1 {
		earlier = comparisonLatestPoint(matches[0].Points, plan.from, plan.to)
	}
	if earlier == nil {
		setComparisonState(result, plan, "unavailable", "no_prior_sample", nil)
		return
	}
	applyComparisonChange(result.Widgets[plan.widget].Comparison, plan, earlier, raw.Truncated && (raw.Truncation == nil || raw.Truncation.Reason != "row_limit"))
}

// applyComparisonChange sets the change between the displayed sample and the earlier one. A percentage is absent when the
// earlier value is zero. The state is partial when the earlier response was truncated and still matched.
func applyComparisonChange(component *DashboardComparison, plan *dashboardComparisonPlan, earlier *Point, partial bool) {
	delta := plan.current.Value - *earlier.Value
	component.Current = plan.current
	component.Baseline = &DashboardComparisonSample{Timestamp: earlier.Timestamp, Value: *earlier.Value}
	component.Delta = &delta
	if *earlier.Value != 0 {
		if percent := delta / math.Abs(*earlier.Value) * 100; !math.IsInf(percent, 0) && !math.IsNaN(percent) {
			component.Percent = &percent
		}
	}
	component.Direction = comparisonDirection(delta)
	component.Assessment = comparisonAssessment(plan.good, component.Direction)
	component.State = "ok"
	if partial {
		component.State = "partial"
	}
}

// comparisonMatches returns the series of an earlier result that share the displayed series' key.
func comparisonMatches(series []Series, key string) []*Series {
	var matches []*Series
	for index := range series {
		if comparisonSeriesKey(&series[index]) == key {
			matches = append(matches, &series[index])
		}
	}
	return matches
}

func setComparisonState(result *DashboardQueryResult, plan *dashboardComparisonPlan, state, reason string, failure *DashboardQueryError) {
	component := result.Widgets[plan.widget].Comparison
	if component == nil {
		return
	}
	component.State, component.Reason, component.Error = state, reason, failure
}

func comparisonDirection(delta float64) string {
	switch {
	case delta > 0:
		return "up"
	case delta < 0:
		return "down"
	}
	return "flat"
}

func comparisonAssessment(good, direction string) string {
	switch {
	case good == "":
		return ""
	case direction == "flat":
		return "unchanged"
	case direction == good:
		return "better"
	}
	return "worse"
}

// comparisonSeriesKey matches a series across two results by its name and labels, in a fixed order. Each part is quoted,
// so no two different series share a key.
func comparisonSeriesKey(series *Series) string {
	keys := make([]string, 0, len(series.Labels))
	for key := range series.Labels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var key strings.Builder
	key.WriteString(strconv.Quote(series.Name))
	for _, name := range keys {
		key.WriteString("|" + strconv.Quote(name) + "=" + strconv.Quote(series.Labels[name]))
	}
	return key.String()
}

func countComparisonSeries(series []Series, key string) int {
	count := 0
	for index := range series {
		if comparisonSeriesKey(&series[index]) == key {
			count++
		}
	}
	return count
}

// comparisonLatestPoint is the valid sample with the latest timestamp inside [from, to), taking the later of equal timestamps.
func comparisonLatestPoint(points []Point, from, to float64) *Point {
	var latest *Point
	for index := range points {
		point := &points[index]
		if !dashboardTimestamp(point.Timestamp) || !dashboardFiniteValue(point.Value) || point.Timestamp < from || point.Timestamp >= to {
			continue
		}
		if latest == nil || point.Timestamp >= latest.Timestamp {
			latest = point
		}
	}
	return latest
}

// dropDashboardComparisons removes every earlier-window plan and its output, for a dry run that must not query them.
func dropDashboardComparisons(result *DashboardQueryResult) {
	for index := range result.comparisons {
		result.Widgets[result.comparisons[index].widget].Comparison = nil
	}
	result.comparisons, result.comparisonQueries, result.QueryCount.Comparison = nil, nil, nil
}

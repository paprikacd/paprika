package insights

import (
	"math"
	"net/http"
	"sync"
)

// A time series' baseline in query_dashboard: its band over the current samples, judged against an earlier window
// (previous, 1d or 7d; one extra query, shared by identical windows) or against its own recent samples (rolling; no
// query). The series behind it are judged in the same pass, and the algorithm is baseline.go's, which the UI runs too.

// baselineSeriesCap bounds the series judged per widget, as the UI's MAX_SERIES does for the drawn lines.
const baselineSeriesCap = 12

// baselineRunsCap bounds the runs listed per series: the latest, as the UI's run text names them.
const baselineRunsCap = 3

// DashboardBaseline is a time series' band reading. State is ok or partial when the band was judged; unavailable, error
// or not_run say why it was not. Evaluated counts the samples that had a band, Outside those beyond it. These describe
// the chart's own history, never an alert or a health verdict. Series lists each judged series until the omission ladder
// drops it, and SeriesOmitted counts the series not listed, including those beyond the cap.
type DashboardBaseline struct {
	State         string                    `json:"state"`
	Window        string                    `json:"window"`
	Band          string                    `json:"band"`
	OffsetSeconds *float64                  `json:"offsetSeconds,omitempty"`
	Evaluated     int                       `json:"evaluated"`
	Outside       int                       `json:"outside"`
	Fraction      *float64                  `json:"fraction,omitempty"`
	Series        []DashboardBaselineSeries `json:"series,omitempty"`
	SeriesOmitted int                       `json:"seriesOmitted,omitempty"`
	Reason        string                    `json:"reason,omitempty"`
	Error         *DashboardQueryError      `json:"error,omitempty"`
}

// DashboardBaselineSeries is one judged series. Runs are the latest runs of two or more samples outside the band.
type DashboardBaselineSeries struct {
	Series    int                    `json:"series"`
	Name      string                 `json:"name,omitempty"`
	Evaluated int                    `json:"evaluated"`
	Outside   int                    `json:"outside"`
	Fraction  *float64               `json:"fraction,omitempty"`
	Runs      []DashboardBaselineRun `json:"runs,omitempty"`
	Reason    string                 `json:"reason,omitempty"`
}

// DashboardBaselineRun is one run of consecutive samples outside the band, in Unix milliseconds.
type DashboardBaselineRun struct {
	Start   float64 `json:"start"`
	End     float64 `json:"end"`
	Samples int     `json:"samples"`
}

// dashboardBaselinePlan links one baselined widget to its earlier-window query (unique), or marks it rolling. The current
// series are kept from the widget's own signal before its raw result is dropped, so no second raw result is held.
type dashboardBaselinePlan struct {
	widget   int
	unique   int
	rolling  bool
	options  baselineOptions
	captured bool
	current  []Series
	omitted  int
}

// planDashboardBaseline plans a time series' baseline for the widget about to be appended at index. A previous-period window
// is the main query moved back by its offset, as a stat's comparison is; identical earlier queries share one execution.
// A rolling baseline plans no query.
func planDashboardBaseline(result *DashboardQueryResult, index int, widget *dashboardReadWidget, output *DashboardQueryWidget, query *Query, seen map[Query]int) {
	spec := widget.Options.Baseline
	if spec == nil || widget.Type != "timeseries" {
		return
	}
	band := spec.Band
	if band == "" {
		band = "range"
	}
	output.Baseline = &DashboardBaseline{State: "not_run", Window: spec.Window, Band: band}
	plan := dashboardBaselinePlan{widget: index, unique: -1, options: baselineOptions{Window: spec.Window, Band: band, StepMs: query.Step * 1000}}
	if spec.Window == "rolling" {
		plan.rolling = true
		result.baselines = append(result.baselines, plan)
		return
	}
	startMs, endMs := math.Round(query.Start*1000), math.Round(query.End*1000)
	span := endMs - startMs
	offset := comparisonOffsetMs(spec.Window, span)
	seconds := offset / 1000
	output.Baseline.OffsetSeconds = &seconds
	plan.options.OffsetMs = offset
	if span < 1000 || span > comparisonMaxMs || startMs-offset <= 0 {
		output.Baseline.State, output.Baseline.Reason = "unavailable", "no_previous_range"
		return
	}
	earlier := *query
	earlier.Start, earlier.End = (startMs-offset)/1000, (endMs-offset-1)/1000
	unique, found := seen[earlier]
	if !found {
		unique = len(result.baselineQueries)
		result.baselineQueries = append(result.baselineQueries, earlier)
		seen[earlier] = unique
		if result.QueryCount.Baseline == nil {
			result.QueryCount.Baseline = &DashboardComparisonCount{}
		}
		result.QueryCount.Baseline.Planned++
	}
	plan.unique = unique
	result.baselines = append(result.baselines, plan)
}

// captureDashboardBaselines keeps the first series of each baselined widget that this signal answers, before the signal's
// raw result is dropped. A rolling baseline needs nothing else, so it is judged here.
func captureDashboardBaselines(result *DashboardQueryResult, signalID string, raw *QueryResult) {
	for i := range result.baselines {
		plan := &result.baselines[i]
		if plan.captured || result.Widgets[plan.widget].SignalID != signalID {
			continue
		}
		plan.captured = true
		if raw == nil {
			continue
		}
		series := raw.Series
		if len(series) > baselineSeriesCap {
			plan.omitted = len(series) - baselineSeriesCap
			series = series[:baselineSeriesCap]
		}
		plan.current = series
		if plan.rolling {
			judged := seriesBaselines(plan.current, nil, false, plan.options)
			setBaselineOutcome(result, plan, judged, baselinePartial(raw))
		}
	}
}

// executeDashboardBaselines queries each distinct earlier window once, within the read's limits, then gives each baselined
// widget its band. A window that no displayed series needs is marked without a query. A failure, a panic or a missed budget
// never changes the result's state or attention.
func (s *Server) executeDashboardBaselines(r *http.Request, options DashboardSummaryOptions, result *DashboardQueryResult, cache *dashboardQueryProviders, limits dashboardLimits) {
	var pending []int
	for unique := range result.baselineQueries {
		if !baselineHasCurrent(result, unique) {
			markBaselines(result, unique, "unavailable", "no_current_sample")
			continue
		}
		pending = append(pending, unique)
	}
	if len(pending) == 0 {
		return
	}
	var merge sync.Mutex
	run := func(k int) {
		unique := pending[k]
		if s.dashboardFault != nil {
			s.dashboardFault("baseline", &result.baselineQueries[unique])
		}
		signal, executed, _, raw := s.executeDashboardQuery(r, &result.baselineQueries[unique], options, cache)
		merge.Lock()
		defer merge.Unlock()
		if executed {
			result.QueryCount.Baseline.Executed++
		}
		finishDashboardBaselines(result, unique, &signal, raw)
	}
	providerOf := func(k int) string { return result.baselineQueries[pending[k]].ProviderID }
	tasks := runDashboardBounded(r.Context(), len(pending), providerOf, limits, run)
	for k := range tasks {
		switch {
		case tasks[k].Panicked != nil:
			finishDashboardBaselines(result, pending[k], &DashboardSignal{State: "error", Error: classifyQueryFailure(tasks[k].Panicked)}, nil)
		case !tasks[k].Started:
			markBaselines(result, pending[k], "not_run", "time_budget")
		}
	}
}

// finishDashboardBaselines gives every baselined widget that shares one earlier-window query its band.
func finishDashboardBaselines(result *DashboardQueryResult, unique int, signal *DashboardSignal, raw *QueryResult) {
	for i := range result.baselines {
		plan := &result.baselines[i]
		if plan.unique == unique {
			finishDashboardBaseline(result, plan, signal, raw)
		}
	}
}

func finishDashboardBaseline(result *DashboardQueryResult, plan *dashboardBaselinePlan, signal *DashboardSignal, raw *QueryResult) {
	component := result.Widgets[plan.widget].Baseline
	if component == nil {
		return
	}
	if signal.Error != nil {
		component.State, component.Error = "error", signal.Error
		return
	}
	if plan.current == nil {
		component.State, component.Reason = "unavailable", "no_current_sample"
		return
	}
	if raw == nil {
		component.State, component.Reason = "unavailable", "no_prior_sample"
		return
	}
	judged := seriesBaselines(plan.current, raw.Series, true, plan.options)
	setBaselineOutcome(result, plan, judged, baselinePartial(raw))
}

// setBaselineOutcome writes a widget's band from its judged series: totals over every series, the first cap listed, and
// the first reason a series gave when no sample had a band.
func setBaselineOutcome(result *DashboardQueryResult, plan *dashboardBaselinePlan, judged []seriesBaseline, partial bool) {
	component := result.Widgets[plan.widget].Baseline
	if component == nil {
		return
	}
	component.Evaluated, component.Outside = 0, 0
	component.Series = make([]DashboardBaselineSeries, 0, len(judged))
	reason := ""
	for _, entry := range judged {
		component.Evaluated += entry.Evaluated
		component.Outside += entry.Outside
		listed := DashboardBaselineSeries{Series: entry.Index, Name: plan.current[entry.Index].Name, Evaluated: entry.Evaluated, Outside: entry.Outside, Fraction: fractionOf(entry.Outside, entry.Evaluated), Reason: entry.Reason}
		runs := entry.Runs
		if len(runs) > baselineRunsCap {
			runs = runs[len(runs)-baselineRunsCap:]
		}
		if len(runs) > 0 {
			listed.Runs = make([]DashboardBaselineRun, 0, len(runs))
			for _, run := range runs {
				listed.Runs = append(listed.Runs, DashboardBaselineRun(run))
			}
		}
		if reason == "" && entry.Reason != "" {
			reason = entry.Reason
		}
		component.Series = append(component.Series, listed)
	}
	component.Fraction = fractionOf(component.Outside, component.Evaluated)
	component.SeriesOmitted = plan.omitted
	component.State = "ok"
	if partial {
		component.State = "partial"
	}
	if component.Evaluated == 0 {
		component.Reason = reason
	}
	component.Error = nil
}

func fractionOf(outside, evaluated int) *float64 {
	if evaluated == 0 {
		return nil
	}
	fraction := float64(outside) / float64(evaluated)
	return &fraction
}

// baselinePartial reports a truncated result that still judged its series. A row limit is not truncation for this purpose.
func baselinePartial(raw *QueryResult) bool {
	return raw.Truncated && (raw.Truncation == nil || raw.Truncation.Reason != "row_limit")
}

func baselineHasCurrent(result *DashboardQueryResult, unique int) bool {
	for i := range result.baselines {
		if result.baselines[i].unique == unique && len(result.baselines[i].current) > 0 {
			return true
		}
	}
	return false
}

// markBaselines sets the state of every baselined widget that shares one earlier-window query.
func markBaselines(result *DashboardQueryResult, unique int, state, reason string) {
	for i := range result.baselines {
		if result.baselines[i].unique != unique {
			continue
		}
		if component := result.Widgets[result.baselines[i].widget].Baseline; component != nil {
			component.State, component.Reason = state, reason
		}
	}
}

// dropDashboardBaselineSeries removes each widget's listed series, keeping its totals and the count of series not listed.
// It is the first step of the omission ladder, because the band totals say most of what the series do.
func dropDashboardBaselineSeries(result *DashboardQueryResult) bool {
	dropped := false
	for index := range result.Widgets {
		baseline := result.Widgets[index].Baseline
		if baseline == nil || len(baseline.Series) == 0 {
			continue
		}
		baseline.SeriesOmitted += len(baseline.Series)
		baseline.Series = nil
		dropped = true
	}
	return dropped
}

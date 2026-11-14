package insights

import (
	"encoding/json"
	"fmt"
)

// dashboardOmissionStep removes one kind of optional detail from a dashboard result. Its name is
// reported in DashboardQueryResult.Omitted. drop reports whether it removed anything, so a step
// with nothing to remove is not reported.
type dashboardOmissionStep struct {
	name string
	drop func(*DashboardQueryResult) bool
}

// dashboardOmissionSteps is the fixed order in which optional detail is dropped when the encoded
// result exceeds DashboardQueryResponseBytes. The ladder stops as soon as the result fits. Attention
// counts, band thresholds and signals are never dropped. Breach summaries and latest levels go only
// with a widget's breach object, in step 2. The series behind a band go with its whole bandSeries
// object, in step 3. A result whose never-dropped facts alone exceed the cap is refused.
var dashboardOmissionSteps = []dashboardOmissionStep{
	{name: "breachIntervals", drop: dropDashboardBreachIntervals},
	{name: "breaches", drop: dropDashboardWidgetBreaches},
	{name: "bandSeries", drop: dropDashboardBandSeriesDetail},
	{name: "sample", drop: dropDashboardSampleDetail},
}

// DashboardOmissionStepNames is the name of each omission step, in the order the ladder applies them.
// The MCP output schema and the gateway's text phrases use the same names, and a test ties them here.
func DashboardOmissionStepNames() []string {
	names := make([]string, 0, len(dashboardOmissionSteps))
	for _, step := range dashboardOmissionSteps {
		names = append(names, step.name)
	}
	return names
}

// dropDashboardBreachIntervals removes the listed breach intervals and their series names from every
// widget. Their count moves into intervalsOmitted, so the number of intervals not listed stays exact.
func dropDashboardBreachIntervals(result *DashboardQueryResult) bool {
	dropped := false
	for index := range result.Widgets {
		breaches := result.Widgets[index].Breaches
		if breaches == nil || len(breaches.Intervals) == 0 {
			continue
		}
		breaches.IntervalsOmitted += len(breaches.Intervals)
		breaches.Intervals = []DashboardBreachInterval{}
		dropped = true
	}
	return dropped
}

// dropDashboardWidgetBreaches removes each widget's breach object: its window summary, its latest
// level and any listed intervals. Attention already counted the breaches it reported.
func dropDashboardWidgetBreaches(result *DashboardQueryResult) bool {
	dropped := false
	for index := range result.Widgets {
		if result.Widgets[index].Breaches != nil {
			result.Widgets[index].Breaches = nil
			dropped = true
		}
	}
	return dropped
}

// dropDashboardBandSeriesDetail removes each multi-series band's bandSeries object: the drawn and
// omitted counts, and the series that set the band. The band's threshold stays, so the widget still
// shows its status.
func dropDashboardBandSeriesDetail(result *DashboardQueryResult) bool {
	dropped := false
	for index := range result.Widgets {
		if result.Widgets[index].BandSeries != nil {
			result.Widgets[index].BandSeries = nil
			dropped = true
		}
	}
	return dropped
}

// dropDashboardSampleDetail removes the optional sample facts. A stale sample keeps its state, so the
// widget stays identified as stale, and loses its basis, limit, lastTimestamp and age. A stale sample
// whose widget attention already reads stale is removed entirely, as attention says the same. A sample
// in any other state is removed entirely, so a widget without a sample has a fresh, no_threshold or
// unknown state that the cap removed. Time-series freshness, added after the first contract, repeats
// the sample and goes too. A stat's first-contract freshness predates that addition, so it stays on
// every stat.
func dropDashboardSampleDetail(result *DashboardQueryResult) bool {
	dropped := false
	for index := range result.Widgets {
		widget := &result.Widgets[index]
		if dropTimeSeriesFreshness(widget) {
			dropped = true
		}
		if trimDashboardSample(widget) {
			dropped = true
		}
	}
	return dropped
}

// dropTimeSeriesFreshness removes a time series' freshness object. It was added to time series after
// the first contract, and it repeats the sample.
func dropTimeSeriesFreshness(widget *DashboardQueryWidget) bool {
	if widget.Type != "timeseries" || widget.Freshness == nil {
		return false
	}
	widget.Freshness = nil
	return true
}

// trimDashboardSample applies step 4 to one widget's sample: it removes a sample that is not stale or
// whose widget attention already reads stale. Any other stale sample keeps its state and loses its
// basis, staleAfterSeconds, lastTimestamp and ageSeconds.
func trimDashboardSample(widget *DashboardQueryWidget) bool {
	sample := widget.Sample
	switch {
	case sample == nil:
		return false
	case sample.State != "stale" || widget.Attention == "stale":
		widget.Sample = nil
		return true
	case sample.Basis != "" || sample.StaleAfterSeconds != nil || sample.LastTimestamp != nil || sample.AgeSeconds != nil:
		sample.Basis, sample.StaleAfterSeconds, sample.LastTimestamp, sample.AgeSeconds = "", nil, nil, nil
		return true
	}
	return false
}

// encodeDashboardQueryResult encodes the result within DashboardQueryResponseBytes when possible. It
// applies the omission ladder one step at a time, re-encoding after each step that removed something,
// and records every applied step in result.Omitted. The result may still exceed the cap when every
// step has run; the caller then refuses it.
func encodeDashboardQueryResult(result *DashboardQueryResult) ([]byte, error) {
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, fmt.Errorf("encode dashboard result: %w", err)
	}
	for _, step := range dashboardOmissionSteps {
		if len(encoded) <= DashboardQueryResponseBytes {
			break
		}
		if !step.drop(result) {
			continue
		}
		result.Omitted = append(result.Omitted, step.name)
		if encoded, err = json.Marshal(result); err != nil {
			return nil, fmt.Errorf("encode dashboard result: %w", err)
		}
	}
	return encoded, nil
}

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
// counts, band states, signals and their series are never dropped. Breach summaries and latest
// levels go only with a widget's breach object, in step 2.
var dashboardOmissionSteps = []dashboardOmissionStep{
	{name: "breachIntervals", drop: dropDashboardBreachIntervals},
	{name: "breaches", drop: dropDashboardWidgetBreaches},
	{name: "bandSeries", drop: dropDashboardBandSeriesDetail},
	{name: "sample", drop: dropDashboardSampleDetail},
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

// dropDashboardBandSeriesDetail removes the series that set a multi-series band and its name. The
// counts of drawn and omitted series stay, as they are required by the band's shape.
func dropDashboardBandSeriesDetail(result *DashboardQueryResult) bool {
	dropped := false
	for index := range result.Widgets {
		bands := result.Widgets[index].BandSeries
		if bands == nil || (bands.Series == nil && bands.Name == "") {
			continue
		}
		bands.Series, bands.Name = nil, ""
		dropped = true
	}
	return dropped
}

// dropDashboardSampleDetail removes the optional sample facts. A stale sample keeps its state, so the
// widget stays identified as stale, and loses its limit and age. A sample in any other state is removed
// entirely, so a widget without a sample has a fresh, no_threshold or unknown state that the cap removed.
// The first-contract freshness object repeats the sample, so it goes too, on every widget that has one.
func dropDashboardSampleDetail(result *DashboardQueryResult) bool {
	dropped := false
	for index := range result.Widgets {
		widget := &result.Widgets[index]
		if widget.Freshness != nil {
			widget.Freshness = nil
			dropped = true
		}
		sample := widget.Sample
		switch {
		case sample == nil:
		case sample.State != "stale":
			widget.Sample = nil
			dropped = true
		case sample.Basis != "" || sample.StaleAfterSeconds != nil || sample.LastTimestamp != nil || sample.AgeSeconds != nil:
			sample.Basis, sample.StaleAfterSeconds, sample.LastTimestamp, sample.AgeSeconds = "", nil, nil, nil
			dropped = true
		}
	}
	return dropped
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

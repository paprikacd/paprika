package insights

import (
	"math"
	"sort"
)

// This file ports ui/src/features/insights/breaches.ts. Both implementations run the
// shared cases in docs/design/insights/conformance/breaches.json, so they cannot
// silently diverge. Times are Unix milliseconds. A step of zero or less means unknown.

const (
	// maxBreachSeries matches the UI's MAX_SERIES: series beyond it are not evaluated.
	maxBreachSeries = 12
	// maxBreachIntervals bounds the intervals listed per widget. The most recent are kept,
	// as the UI keeps its most recent bands, and the rest are counted.
	maxBreachIntervals = 12
)

// breachInterval is one contiguous stretch of breaching samples. Start is the first
// breaching sample. End is the last breaching sample, extended toward the next sample
// only when that sample is observed and contiguous. Duration is End minus Start.
type breachInterval struct {
	Start    float64
	End      float64
	Level    string
	Duration float64
}

type seriesBreachInterval struct {
	breachInterval
	Series int
}

// breachSeries is the input for one series: its points and its sampling cadence.
type breachSeries struct {
	Points []Point
	Step   float64
}

type breachLevelSummary struct {
	Level     string
	Intervals int
	Samples   int
	Duration  float64
}

type breachSpan struct{ start, end float64 }

// DashboardBreaches reports the time-series stretches inside warning or critical
// bands that the author declared. It is a window fact, not a health verdict.
type DashboardBreaches struct {
	SeriesEvaluated  int                       `json:"seriesEvaluated"`
	SeriesOmitted    int                       `json:"seriesOmitted,omitempty"`
	Intervals        []DashboardBreachInterval `json:"intervals"`
	IntervalsOmitted int                       `json:"intervalsOmitted,omitempty"`
	Summary          []DashboardBreachLevel    `json:"summary"`
}

// DashboardBreachInterval times are Unix milliseconds. DurationMs is End minus Start;
// zero marks one breaching sample with no observed time after it.
type DashboardBreachInterval struct {
	Series     int     `json:"series"`
	Level      string  `json:"level"`
	Start      float64 `json:"start"`
	End        float64 `json:"end"`
	DurationMs float64 `json:"durationMs"`
}

// DashboardBreachLevel merges intervals across series: Intervals counts merged spans with
// positive duration, Samples counts single breaching samples outside them, and DurationMs
// is the merged time.
type DashboardBreachLevel struct {
	Level      string  `json:"level"`
	Intervals  int     `json:"intervals"`
	Samples    int     `json:"samples"`
	DurationMs float64 `json:"durationMs"`
}

// breachStatus is the level a status breaches at. Only author-set warning and critical
// statuses breach; a colour-only threshold has no status and never does.
func breachStatus(status string) string {
	if status == "warning" || status == "critical" {
		return status
	}
	return ""
}

// thresholdsAreOrdered mirrors thresholdsAreOrdered in breaches.ts: values must be finite
// and strictly increasing. Unordered or repeated values produce no breaches.
func thresholdsAreOrdered(thresholds []dashboardReadThreshold) bool {
	for index, threshold := range thresholds {
		if !finite(threshold.Value) || (index > 0 && threshold.Value <= thresholds[index-1].Value) {
			return false
		}
	}
	return true
}

// breachBandIndex is the highest threshold at or below the value, or the first threshold
// when the value is below them all.
func breachBandIndex(value float64, thresholds []dashboardReadThreshold) int {
	index := 0
	for position := 1; position < len(thresholds); position++ {
		if thresholds[position].Value > value {
			break
		}
		index = position
	}
	return index
}

type breachSample struct {
	timestamp float64
	observed  bool
	level     string
}

type breachRun struct {
	start, last float64
	level       string
}

// breachSamples are the samples with valid timestamps, in time order. Each records whether
// it is observed and the level its band breaches at, if any.
func breachSamples(points []Point, thresholds []dashboardReadThreshold) []breachSample {
	samples := make([]breachSample, 0, len(points))
	for _, point := range points {
		if !dashboardTimestamp(point.Timestamp) {
			continue
		}
		sample := breachSample{timestamp: point.Timestamp}
		if dashboardFiniteValue(point.Value) {
			sample.observed = true
			sample.level = breachStatus(thresholds[breachBandIndex(*point.Value, thresholds)].Status)
		}
		samples = append(samples, sample)
	}
	sort.SliceStable(samples, func(i, j int) bool { return samples[i].timestamp < samples[j].timestamp })
	return samples
}

// closeBreachRun ends a run at the sample that stopped it. The run extends to that sample,
// or one step past its last breaching sample if that is earlier, only when the sample is
// observed and contiguous. Otherwise it ends at its last breaching sample.
func closeBreachRun(run *breachRun, sample breachSample, stepMs float64) breachInterval {
	end := run.last
	if sample.observed && !breachGap(run.last, sample.timestamp, stepMs) {
		end = math.Min(run.last+stepMs, sample.timestamp)
	}
	return breachInterval{Start: run.start, End: end, Level: run.level, Duration: end - run.start}
}

// breachGap reports a timing gap of more than 1.5 steps. Without a known step, timing never
// ends a run.
func breachGap(last, timestamp, stepMs float64) bool {
	return stepMs > 0 && timestamp-last > stepMs*1.5
}

// seriesBreaches ports seriesBreaches in breaches.ts. A run ends at the first sample that
// does not continue it, or at a timing gap of more than 1.5 steps, which only a known step
// can establish.
func seriesBreaches(points []Point, thresholds []dashboardReadThreshold, step float64) []breachInterval {
	if len(thresholds) == 0 || !thresholdsAreOrdered(thresholds) {
		return nil
	}
	stepMs := 0.0
	if step > 0 {
		stepMs = step
	}
	return breachRunsOf(breachSamples(points, thresholds), stepMs)
}

// breachRunsOf walks ordered samples and returns the breach run each one closes or opens.
func breachRunsOf(samples []breachSample, stepMs float64) []breachInterval {
	var intervals []breachInterval
	var run *breachRun
	for _, sample := range samples {
		if run != nil && (sample.level != run.level || breachGap(run.last, sample.timestamp, stepMs)) {
			intervals = append(intervals, closeBreachRun(run, sample, stepMs))
			run = nil
		}
		if sample.level == "" {
			continue
		}
		if run != nil {
			run.last = sample.timestamp
		} else {
			run = &breachRun{start: sample.timestamp, last: sample.timestamp, level: sample.level}
		}
	}
	if run != nil {
		intervals = append(intervals, breachInterval{Start: run.start, End: run.last, Level: run.level, Duration: run.last - run.start})
	}
	return intervals
}

// timeSeriesBreaches ports timeSeriesBreaches: every series' intervals, ordered by start and
// then by series position.
func timeSeriesBreaches(series []breachSeries, thresholds []dashboardReadThreshold) []seriesBreachInterval {
	var all []seriesBreachInterval
	for index := range series {
		for _, interval := range seriesBreaches(series[index].Points, thresholds, series[index].Step) {
			all = append(all, seriesBreachInterval{breachInterval: interval, Series: index})
		}
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].Start != all[j].Start {
			return all[i].Start < all[j].Start
		}
		return all[i].Series < all[j].Series
	})
	return all
}

// unionSpans merges spans that overlap or lie within gap of each other, ordered by start.
func unionSpans(spans []breachSpan, gap float64) []breachSpan {
	sorted := append([]breachSpan(nil), spans...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].start != sorted[j].start {
			return sorted[i].start < sorted[j].start
		}
		return sorted[i].end < sorted[j].end
	})
	var merged []breachSpan
	for _, span := range sorted {
		if last := len(merged) - 1; last >= 0 && span.start <= merged[last].end+gap {
			merged[last].end = math.Max(merged[last].end, span.end)
			continue
		}
		merged = append(merged, span)
	}
	return merged
}

// breachSummary ports breachSummary: worst level first, with intervals merged across
// series, so one incident seen by two series counts once.
func breachSummary(intervals []breachInterval) []breachLevelSummary {
	var summary []breachLevelSummary
	for _, level := range []string{"critical", "warning"} {
		if entry, ok := breachLevelSummaryOf(intervals, level); ok {
			summary = append(summary, entry)
		}
	}
	return summary
}

// breachLevelSummaryOf summarises one level. A single breaching sample outside every merged
// span is a sample, not a zero-length interval.
func breachLevelSummaryOf(intervals []breachInterval, level string) (breachLevelSummary, bool) {
	var positive []breachSpan
	var own []breachInterval
	for _, interval := range intervals {
		if interval.Level != level {
			continue
		}
		own = append(own, interval)
		if interval.Duration > 0 {
			positive = append(positive, breachSpan{start: interval.Start, end: interval.End})
		}
	}
	spans := unionSpans(positive, 0)
	instants := make(map[float64]struct{})
	for _, interval := range own {
		if interval.Duration != 0 || insideBreachSpan(interval.Start, spans) {
			continue
		}
		instants[interval.Start] = struct{}{}
	}
	if len(spans) == 0 && len(instants) == 0 {
		return breachLevelSummary{}, false
	}
	duration := 0.0
	for _, span := range spans {
		duration += span.end - span.start
	}
	return breachLevelSummary{Level: level, Intervals: len(spans), Samples: len(instants), Duration: duration}, true
}

func insideBreachSpan(at float64, spans []breachSpan) bool {
	for _, span := range spans {
		if at >= span.start && at <= span.end {
			return true
		}
	}
	return false
}

// sampleCadence ports sampleCadence in chart-data.ts: the lower median of the positive
// steps between observed samples, in milliseconds. It needs three observed samples. It
// returns zero when the cadence is unknown.
func sampleCadence(points []Point) float64 {
	var ordered []Point
	for _, point := range points {
		if dashboardTimestamp(point.Timestamp) {
			ordered = append(ordered, point)
		}
	}
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Timestamp < ordered[j].Timestamp })
	var times []float64
	for _, point := range ordered {
		if dashboardFiniteValue(point.Value) {
			times = append(times, point.Timestamp)
		}
	}
	if len(times) < 3 {
		return 0
	}
	var steps []float64
	for index := 1; index < len(times); index++ {
		if step := times[index] - times[index-1]; step > 0 {
			steps = append(steps, step)
		}
	}
	if len(steps) == 0 {
		return 0
	}
	sort.Float64s(steps)
	return steps[(len(steps)-1)/2]
}

// dashboardBreaches builds the bounded output for one time-series signal. Every returned
// series up to maxBreachSeries is evaluated with its own cadence, as the UI does.
func dashboardBreaches(series []Series, thresholds []dashboardReadThreshold) *DashboardBreaches {
	evaluated := min(len(series), maxBreachSeries)
	inputs := make([]breachSeries, 0, evaluated)
	for index := range series[:evaluated] {
		inputs = append(inputs, breachSeries{Points: series[index].Points, Step: sampleCadence(series[index].Points)})
	}
	all := timeSeriesBreaches(inputs, thresholds)
	intervals := make([]breachInterval, 0, len(all))
	for _, interval := range all {
		intervals = append(intervals, interval.breachInterval)
	}
	breaches := &DashboardBreaches{SeriesEvaluated: evaluated, SeriesOmitted: len(series) - evaluated, Intervals: []DashboardBreachInterval{}, Summary: []DashboardBreachLevel{}}
	shown := all[max(0, len(all)-maxBreachIntervals):]
	breaches.IntervalsOmitted = len(all) - len(shown)
	for _, interval := range shown {
		breaches.Intervals = append(breaches.Intervals, DashboardBreachInterval{Series: interval.Series, Level: interval.Level, Start: interval.Start, End: interval.End, DurationMs: interval.Duration})
	}
	for _, level := range breachSummary(intervals) {
		breaches.Summary = append(breaches.Summary, DashboardBreachLevel{Level: level.Level, Intervals: level.Intervals, Samples: level.Samples, DurationMs: level.Duration})
	}
	return breaches
}

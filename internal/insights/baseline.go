package insights

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
)

// This file ports ui/src/features/insights/baseline.ts. Both implementations run the shared cases in
// docs/design/insights/conformance/baseline.json, so they cannot silently diverge. Times are Unix milliseconds.

const (
	baselineRollingSamples = 12
	baselineRollingMin     = 6
	baselinePriorNeighbors = 5
	baselineP10P90Min      = 5
	baselineSigmaBand      = 3
	baselineMADScale       = 1.4826
	baselineRelativeFloor  = 0.01
	baselineTiny           = 1e-12
	baselineMaxTimestamp   = 8.64e15
)

// baselineOptions mirrors BaselineOptions. Window is previous, 1d, 7d or rolling; Band is range or p10p90.
type baselineOptions struct {
	Window   string
	Band     string
	OffsetMs float64
	StepMs   float64
}

type baselinePoint struct {
	Timestamp float64
	Lower     float64
	Upper     float64
	Outside   bool
}

type baselineRun struct {
	Start   float64
	End     float64
	Samples int
}

type seriesBaseline struct {
	Index     int
	Points    []baselinePoint
	Evaluated int
	Outside   int
	Runs      []baselineRun
	Reason    string
}

type baselineSample struct {
	timestamp float64
	value     float64
}

func baselineFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func baselineValidTimestamp(value float64) bool {
	return baselineFinite(value) && math.Abs(value) <= baselineMaxTimestamp
}

// baselineSamplesOf keeps the finite samples with valid timestamps, sorted by time. The sort is stable, as the UI's is.
func baselineSamplesOf(series Series) []baselineSample {
	var samples []baselineSample
	for _, point := range series.Points {
		if point.Value == nil || !baselineValidTimestamp(point.Timestamp) || !baselineFinite(*point.Value) {
			continue
		}
		samples = append(samples, baselineSample{timestamp: point.Timestamp, value: *point.Value})
	}
	sort.SliceStable(samples, func(i, j int) bool { return samples[i].timestamp < samples[j].timestamp })
	return samples
}

// baselineQuantile interpolates between closest ranks over a sorted slice.
func baselineQuantile(sorted []float64, p float64) float64 {
	position := p * float64(len(sorted)-1)
	low, high := math.Floor(position), math.Ceil(position)
	return sorted[int(low)] + (sorted[int(high)]-sorted[int(low)])*(position-low)
}

func baselineMedian(values []float64) float64 {
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	return baselineQuantile(sorted, 0.5)
}

// baselineRollingNeighbours returns the 12 finite samples before the timestamp, or none when fewer than 6 exist.
func baselineRollingNeighbours(current []baselineSample, timestamp float64) []float64 {
	var earlier []float64
	for _, sample := range current {
		if sample.timestamp < timestamp {
			earlier = append(earlier, sample.value)
		}
	}
	if len(earlier) > baselineRollingSamples {
		earlier = earlier[len(earlier)-baselineRollingSamples:]
	}
	if len(earlier) < baselineRollingMin {
		return nil
	}
	return earlier
}

type baselineCandidate struct {
	distance float64
	shifted  float64
	value    float64
}

// baselinePriorNeighbours returns the nearest prior samples within two steps, shifted by the offset: nearest first,
// ties by shifted time, at most five.
func baselinePriorNeighbours(prior []baselineSample, offsetMs, stepMs, timestamp float64) []float64 {
	tolerance := 2 * stepMs
	var candidates []baselineCandidate
	for _, sample := range prior {
		shifted := sample.timestamp + offsetMs
		distance := math.Abs(shifted - timestamp)
		if distance <= tolerance {
			candidates = append(candidates, baselineCandidate{distance: distance, shifted: shifted, value: sample.value})
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].distance != candidates[j].distance {
			return candidates[i].distance < candidates[j].distance
		}
		return candidates[i].shifted < candidates[j].shifted
	})
	if len(candidates) > baselinePriorNeighbors {
		candidates = candidates[:baselinePriorNeighbors]
	}
	values := make([]float64, 0, len(candidates))
	for _, candidate := range candidates {
		values = append(values, candidate.value)
	}
	return values
}

// baselineBandOf returns the band over the neighbours, or false when the band needs more neighbours than exist.
func baselineBandOf(values []float64, band string) (lower, upper float64, ok bool) {
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	if band == "p10p90" {
		if len(sorted) < baselineP10P90Min {
			return 0, 0, false
		}
		return baselineQuantile(sorted, 0.1), baselineQuantile(sorted, 0.9), true
	}
	if len(sorted) == 0 {
		return 0, 0, false
	}
	return sorted[0], sorted[len(sorted)-1], true
}

// baselineIsOutside reports a value more than three robust sigmas beyond the band. The sigma never falls below 1% of the median.
func baselineIsOutside(value float64, values []float64, lower, upper float64) bool {
	m := baselineMedian(values)
	deviations := make([]float64, 0, len(values))
	for _, neighbour := range values {
		deviations = append(deviations, math.Abs(neighbour-m))
	}
	mad := baselineMedian(deviations)
	sigma := math.Max(baselineMADScale*mad, math.Max(baselineRelativeFloor*math.Abs(m), baselineTiny))
	return value > upper+baselineSigmaBand*sigma || value < lower-baselineSigmaBand*sigma
}

// baselineRunTracker collects runs of two or more consecutive outside samples. A sample without a band breaks a run.
type baselineRunTracker struct {
	open *baselineRun
	runs []baselineRun
}

func (tracker *baselineRunTracker) close() {
	if tracker.open != nil && tracker.open.Samples >= 2 {
		tracker.runs = append(tracker.runs, *tracker.open)
	}
	tracker.open = nil
}

func (tracker *baselineRunTracker) add(timestamp float64, outside bool) {
	if !outside {
		tracker.close()
		return
	}
	if tracker.open != nil {
		tracker.open.End = timestamp
		tracker.open.Samples++
		return
	}
	tracker.open = &baselineRun{Start: timestamp, End: timestamp, Samples: 1}
}

// baselineNeighbours returns the samples a current sample is judged against: its rolling history, or the prior
// window's neighbourhood.
func baselineNeighbours(current, prior []baselineSample, sample baselineSample, options baselineOptions) []float64 {
	if options.Window == "rolling" {
		return baselineRollingNeighbours(current, sample.timestamp)
	}
	return baselinePriorNeighbours(prior, options.OffsetMs, options.StepMs, sample.timestamp)
}

func baselineEvaluate(index int, current, prior []baselineSample, hasPrior bool, options baselineOptions) seriesBaseline {
	result := seriesBaseline{Index: index}
	var tracker baselineRunTracker
	for _, sample := range current {
		neighbours := baselineNeighbours(current, prior, sample, options)
		lower, upper, ok := baselineBandOf(neighbours, options.Band)
		if !ok {
			tracker.close()
			continue
		}
		outside := baselineIsOutside(sample.value, neighbours, lower, upper)
		result.Points = append(result.Points, baselinePoint{Timestamp: sample.timestamp, Lower: lower, Upper: upper, Outside: outside})
		tracker.add(sample.timestamp, outside)
	}
	tracker.close()
	result.Runs = tracker.runs
	result.Evaluated = len(result.Points)
	for _, point := range result.Points {
		if point.Outside {
			result.Outside++
		}
	}
	if options.Window != "rolling" && len(result.Points) == 0 && hasPrior && len(prior) > 0 {
		result.Reason = "no_prior_sample"
	}
	return result
}

func baselineUnevaluated(index int, reason string) seriesBaseline {
	return seriesBaseline{Index: index, Reason: reason}
}

// baselineSeriesKey matches seriesKey in time-window.ts: JSON of the name and the labels sorted by key.
func baselineSeriesKey(series Series) string {
	keys := make([]string, 0, len(series.Labels))
	for key := range series.Labels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	pairs := make([][2]string, 0, len(keys))
	for _, key := range keys {
		pairs = append(pairs, [2]string{key, series.Labels[key]})
	}
	encoded, err := json.Marshal([]any{series.Name, pairs})
	if err != nil {
		panic(fmt.Sprintf("baseline series key: %v", err))
	}
	return string(encoded)
}

// seriesBaselines is the Go port of seriesBaselines. A nil prior result means the prior window was not queried.
func seriesBaselines(current, prior []Series, hasPrior bool, options baselineOptions) []seriesBaseline {
	keys := make([]string, len(current))
	counts := map[string]int{}
	for i, series := range current {
		keys[i] = baselineSeriesKey(series)
		counts[keys[i]]++
	}
	results := make([]seriesBaseline, 0, len(current))
	for index, series := range current {
		results = append(results, baselineOne(index, series, keys[index], counts[keys[index]] > 1, prior, hasPrior, options))
	}
	return results
}

// baselineOne evaluates one current series against the prior result paired by its key.
func baselineOne(index int, series Series, key string, repeated bool, prior []Series, hasPrior bool, options baselineOptions) seriesBaseline {
	if repeated {
		return baselineUnevaluated(index, "ambiguous_series")
	}
	if options.Window == "rolling" {
		return baselineEvaluate(index, baselineSamplesOf(series), nil, false, options)
	}
	if !hasPrior {
		return baselineUnevaluated(index, "no_prior_sample")
	}
	var matches []Series
	for _, other := range prior {
		if baselineSeriesKey(other) == key {
			matches = append(matches, other)
		}
	}
	switch len(matches) {
	case 0:
		return baselineUnevaluated(index, "no_prior_sample")
	case 1:
		return baselineEvaluate(index, baselineSamplesOf(series), baselineSamplesOf(matches[0]), true, options)
	default:
		return baselineUnevaluated(index, "ambiguous_series")
	}
}

// baselineRunsText lists the latest three runs in time order, then how many earlier runs are not listed.
func baselineRunsText(runs []baselineRun, clock func(float64) string) string {
	if len(runs) == 0 {
		return ""
	}
	shown := runs
	if len(shown) > 3 {
		shown = shown[len(shown)-3:]
	}
	parts := make([]string, 0, len(shown))
	for _, run := range shown {
		parts = append(parts, clock(run.Start)+"–"+clock(run.End))
	}
	list := strings.Join(parts, ", ")
	if earlier := len(runs) - len(shown); earlier > 0 {
		return fmt.Sprintf("%s and %d earlier", list, earlier)
	}
	return list
}

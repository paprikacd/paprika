package insights

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"unicode/utf8"
)

// DashboardSummaryOptions controls output volume, never provider query semantics.
type DashboardSummaryOptions struct {
	MaxSeries     int
	MaxTraces     int
	HistoryPoints int
}

type DashboardQueryError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// DashboardSignal describes observations, not an inferred service health verdict.
// PrimarySeries is the original provider index used by a Single value widget.
type DashboardSignal struct {
	ID                string                   `json:"id"`
	State             string                   `json:"state"`
	Error             *DashboardQueryError     `json:"error,omitempty"`
	Series            []DashboardSeriesSummary `json:"series,omitempty"`
	Traces            *DashboardTraceSummary   `json:"traces,omitempty"`
	PrimarySeries     *int                     `json:"primarySeries,omitempty"`
	Truncated         bool                     `json:"truncated,omitempty"`
	ProviderTruncated bool                     `json:"providerTruncated,omitempty"`
	SeriesTruncated   bool                     `json:"seriesTruncated,omitempty"`
}

// All timestamps are Unix milliseconds, matching the UI's normalized results.
// First and Last contain finite values only; FirstAt/LastAt also include gaps.
type DashboardSeriesSummary struct {
	Index             int                     `json:"index"`
	Name              string                  `json:"name,omitempty"`
	Labels            map[string]string       `json:"labels,omitempty"`
	Samples           int                     `json:"samples"`
	Valid             int                     `json:"valid"`
	Missing           int                     `json:"missing"`
	InvalidTimestamps int                     `json:"invalidTimestamps,omitempty"`
	First             *Point                  `json:"first,omitempty"`
	Last              *Point                  `json:"last,omitempty"`
	Min               *float64                `json:"min,omitempty"`
	Max               *float64                `json:"max,omitempty"`
	FirstAt           *float64                `json:"firstAt,omitempty"`
	LastAt            *float64                `json:"lastAt,omitempty"`
	TailMissing       bool                    `json:"tailMissing,omitempty"`
	MetadataTruncated bool                    `json:"metadataTruncated,omitempty"`
	LabelsOmitted     int                     `json:"labelsOmitted,omitempty"`
	History           []DashboardHistoryPoint `json:"history,omitempty"`
	HistoryTruncated  bool                    `json:"historyTruncated,omitempty"`
}

// DashboardHistoryPoint is [Unix milliseconds, value|null]. The compact tuple
// avoids repeating two field names for every opt-in history observation.
type DashboardHistoryPoint Point

func (p DashboardHistoryPoint) MarshalJSON() ([]byte, error) {
	encoded, err := json.Marshal([2]any{p.Timestamp, p.Value})
	if err != nil {
		return nil, fmt.Errorf("encode dashboard history point: %w", err)
	}
	return encoded, nil
}

// Returned is the number of rows in this provider response, not total traffic
// or an exhaustive trace count. StatusCounts refer to that same bounded sample.
type DashboardTraceSummary struct {
	Returned          int                     `json:"returned"`
	StatusCounts      map[string]int          `json:"statusCounts"`
	Examples          []DashboardTraceExample `json:"examples,omitempty"`
	ExamplesTruncated bool                    `json:"examplesTruncated,omitempty"`
	MetadataTruncated bool                    `json:"metadataTruncated,omitempty"`
}

type DashboardTraceExample struct {
	TraceID       string   `json:"traceId"`
	Service       string   `json:"service,omitempty"`
	Operation     string   `json:"operation,omitempty"`
	DurationMs    *float64 `json:"durationMs,omitempty"`
	StartTime     *float64 `json:"startTime,omitempty"`
	Status        string   `json:"status"`
	InvalidFields bool     `json:"invalidFields,omitempty"`
}

func summarizeDashboardResult(result QueryResult, options DashboardSummaryOptions) DashboardSignal {
	options = boundedDashboardSummaryOptions(options)
	signal := DashboardSignal{State: "empty", ProviderTruncated: result.Truncated, Truncated: result.Truncated}
	primary := primaryDashboardSeries(result.Series)
	if primary >= 0 {
		signal.PrimarySeries, signal.State = &primary, "ok"
	}
	indexes := dashboardSeriesIndexes(len(result.Series), primary, options.MaxSeries)
	signal.SeriesTruncated = len(indexes) < len(result.Series)
	signal.Truncated = signal.Truncated || signal.SeriesTruncated
	for _, index := range indexes {
		summary := summarizeDashboardSeries(result.Series[index], index, options.HistoryPoints)
		signal.Truncated = signal.Truncated || summary.MetadataTruncated || summary.HistoryTruncated
		signal.Series = append(signal.Series, summary)
	}
	if result.Traces != nil {
		traces := summarizeDashboardTraces(result.Traces, options.MaxTraces)
		signal.Traces = &traces
		signal.Truncated = signal.Truncated || traces.ExamplesTruncated || traces.MetadataTruncated
		if traces.Returned > 0 {
			signal.State = "ok"
		}
	}
	return signal
}

func boundedDashboardSummaryOptions(options DashboardSummaryOptions) DashboardSummaryOptions {
	if options.MaxSeries <= 0 {
		options.MaxSeries = 3
	}
	if options.MaxTraces <= 0 {
		options.MaxTraces = 3
	}
	options.MaxSeries = min(options.MaxSeries, 8)
	options.MaxTraces = min(options.MaxTraces, 10)
	if options.HistoryPoints < 2 {
		options.HistoryPoints = 0
	}
	options.HistoryPoints = min(options.HistoryPoints, 32)
	return options
}

func primaryDashboardSeries(series []Series) int {
	for index, entry := range series {
		for _, point := range entry.Points {
			if dashboardTimestamp(point.Timestamp) && dashboardFiniteValue(point.Value) {
				return index
			}
		}
	}
	return -1
}

func dashboardSeriesIndexes(count, primary, limit int) []int {
	indexes := make([]int, min(count, limit))
	for index := range indexes {
		indexes[index] = index
	}
	// Missing early series must not hide the value the UI actually selects.
	if primary >= len(indexes) && len(indexes) > 0 {
		indexes[len(indexes)-1] = primary
	}
	return indexes
}

func summarizeDashboardSeries(series Series, index, historyPoints int) DashboardSeriesSummary {
	summary := DashboardSeriesSummary{Index: index}
	summary.Name, summary.MetadataTruncated = dashboardText(series.Name, 160)
	summary.Labels, summary.LabelsOmitted, summary.MetadataTruncated = dashboardLabels(series.Labels, summary.MetadataTruncated)
	for _, point := range series.Points {
		addDashboardObservation(&summary, point)
	}
	if historyPoints > 0 {
		points := dashboardNormalizedPoints(series.Points)
		summary.History = dashboardHistory(points, historyPoints)
		summary.HistoryTruncated = len(summary.History) < len(points)
	}
	return summary
}

func addDashboardObservation(summary *DashboardSeriesSummary, point Point) {
	if !dashboardTimestamp(point.Timestamp) {
		summary.InvalidTimestamps++
		return
	}
	summary.Samples++
	if summary.FirstAt == nil || point.Timestamp < *summary.FirstAt {
		summary.FirstAt = dashboardNumber(point.Timestamp)
	}
	valid := dashboardFiniteValue(point.Value)
	if summary.LastAt == nil || point.Timestamp >= *summary.LastAt {
		summary.LastAt, summary.TailMissing = dashboardNumber(point.Timestamp), !valid
	}
	if !valid {
		summary.Missing++
		return
	}
	addDashboardFiniteObservation(summary, point)
}

func addDashboardFiniteObservation(summary *DashboardSeriesSummary, point Point) {
	summary.Valid++
	if summary.First == nil || point.Timestamp < summary.First.Timestamp {
		summary.First = dashboardPoint(point)
	}
	// This >= tie rule matches latestPoint in chart-data.ts.
	if summary.Last == nil || point.Timestamp >= summary.Last.Timestamp {
		summary.Last = dashboardPoint(point)
	}
	if summary.Min == nil || *point.Value < *summary.Min {
		summary.Min = dashboardNumber(*point.Value)
	}
	if summary.Max == nil || *point.Value > *summary.Max {
		summary.Max = dashboardNumber(*point.Value)
	}
}

func dashboardPoint(point Point) *Point {
	return &Point{Timestamp: point.Timestamp, Value: dashboardNumber(*point.Value)}
}

func dashboardNumber(value float64) *float64 { return &value }

func dashboardFiniteValue(value *float64) bool { return value != nil && finite(*value) }

func dashboardTimestamp(value float64) bool { return finite(value) && math.Abs(value) <= 8.64e15 }

func dashboardText(value string, limit int) (string, bool) {
	if len(value) <= limit {
		return value, false
	}
	end := limit - len("…")
	for end > 0 && !utf8.RuneStart(value[end]) {
		end--
	}
	return value[:end] + "…", true
}

func dashboardLabels(labels map[string]string, truncated bool) (bounded map[string]string, omittedCount int, wasTruncated bool) {
	keys := make([]string, 0, len(labels))
	for key := range labels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make(map[string]string, min(len(keys), 8))
	omitted := 0
	for _, key := range keys {
		// Do not shorten keys: two original names could collapse to one identity.
		if len(result) >= 8 || len(key) > 128 {
			omitted++
			continue
		}
		value, cut := dashboardText(labels[key], 128)
		result[key], truncated = value, truncated || cut
	}
	return result, omitted, truncated || omitted > 0
}

func summarizeDashboardTraces(traces []Trace, limit int) DashboardTraceSummary {
	summary := DashboardTraceSummary{Returned: len(traces), StatusCounts: map[string]int{}, ExamplesTruncated: len(traces) > limit}
	for index := range traces {
		summary.StatusCounts[dashboardTraceStatus(traces[index].Status)]++
		if index >= limit {
			continue
		}
		example, truncated := summarizeDashboardTrace(&traces[index])
		summary.Examples = append(summary.Examples, example)
		summary.MetadataTruncated = summary.MetadataTruncated || truncated
	}
	return summary
}

func dashboardTraceStatus(status string) string {
	switch status {
	case "", "unknown":
		return "unknown"
	case "ok", "error":
		return status
	default:
		return "other"
	}
}

func summarizeDashboardTrace(trace *Trace) (DashboardTraceExample, bool) {
	var cutID, cutService, cutOperation, cutStatus bool
	example := DashboardTraceExample{}
	example.TraceID, cutID = dashboardText(trace.TraceID, 64)
	example.Service, cutService = dashboardText(trace.Service, 128)
	example.Operation, cutOperation = dashboardText(trace.Operation, 160)
	example.Status, cutStatus = dashboardText(trace.Status, 32)
	if example.Status == "" {
		example.Status = "unknown"
	}
	if finite(trace.DurationMs) && trace.DurationMs >= 0 {
		example.DurationMs = dashboardNumber(trace.DurationMs)
	} else {
		example.InvalidFields = true
	}
	if dashboardTimestamp(trace.StartTime) {
		example.StartTime = dashboardNumber(trace.StartTime)
	} else {
		example.InvalidFields = true
	}
	return example, cutID || cutService || cutOperation || cutStatus
}

func dashboardNormalizedPoints(input []Point) []Point {
	points := make([]Point, 0, len(input))
	for _, point := range input {
		if !dashboardTimestamp(point.Timestamp) {
			continue
		}
		normalized := Point{Timestamp: point.Timestamp}
		if dashboardFiniteValue(point.Value) {
			normalized.Value = dashboardNumber(*point.Value)
		}
		points = append(points, normalized)
	}
	sort.SliceStable(points, func(i, j int) bool { return points[i].Timestamp < points[j].Timestamp })
	return points
}

// The same min/max buckets and gap separators as the UI retain incidents instead
// of stride-sampling them away. Small budgets necessarily omit observations;
// HistoryTruncated identifies that loss and the exact extrema remain in Min/Max.
func dashboardHistory(points []Point, maximum int) []DashboardHistoryPoint {
	if len(points) == 0 {
		return nil
	}
	latest := len(points) - 1
	for latest >= 0 && points[latest].Value == nil {
		latest--
	}
	var bounded []Point
	if latest >= 0 && latest < len(points)-1 {
		if maximum == 2 {
			bounded = []Point{points[latest], points[len(points)-1]}
		} else {
			bounded = dashboardDownsample(points[:latest+1], maximum-1)
			bounded = append(bounded, points[len(points)-1])
		}
	} else {
		bounded = dashboardDownsample(points, maximum)
	}
	result := make([]DashboardHistoryPoint, len(bounded))
	for index := range bounded {
		result[index] = DashboardHistoryPoint(bounded[index])
	}
	return result
}

func dashboardDownsample(points []Point, maximum int) []Point {
	if len(points) <= maximum {
		return points
	}
	budget := maximum
	for _, point := range points {
		if point.Value == nil {
			budget = max(2, (maximum+1)/2)
			break
		}
	}
	selected := dashboardHistoryIndexes(points, budget)
	return dashboardHistoryGaps(points, selected, maximum)
}

func dashboardHistoryIndexes(points []Point, budget int) []int {
	selected := map[int]bool{0: true, len(points) - 1: true}
	if budget == 3 {
		selected[dashboardAbsoluteExtreme(points)] = true
	} else {
		buckets := (budget - 2) / 2
		for bucket := 0; bucket < buckets; bucket++ {
			start := 1 + bucket*(len(points)-2)/buckets
			end := 1 + (bucket+1)*(len(points)-2)/buckets
			low, high := dashboardBucketExtrema(points, start, end)
			if low >= 0 {
				selected[low], selected[high] = true, true
			}
		}
	}
	indexes := make([]int, 0, len(selected))
	for index := range selected {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	return indexes
}

func dashboardAbsoluteExtreme(points []Point) int {
	chosen := 1
	for index := 2; index < len(points)-1; index++ {
		if points[index].Value == nil {
			continue
		}
		if points[chosen].Value == nil || math.Abs(*points[index].Value) > math.Abs(*points[chosen].Value) {
			chosen = index
		}
	}
	return chosen
}

func dashboardBucketExtrema(points []Point, start, end int) (low, high int) {
	low, high = -1, -1
	for index := start; index < end; index++ {
		value := points[index].Value
		if value == nil {
			continue
		}
		if low < 0 || *value < *points[low].Value {
			low = index
		}
		if high < 0 || *value > *points[high].Value {
			high = index
		}
	}
	return low, high
}

func dashboardHistoryGaps(points []Point, indexes []int, maximum int) []Point {
	result := make([]Point, 0, maximum)
	result = append(result, points[indexes[0]])
	for position := 1; position < len(indexes); position++ {
		previous, current := indexes[position-1], indexes[position]
		gap := dashboardInterveningGap(points, previous, current)
		if gap >= 0 {
			if len(result)+2 > maximum {
				// A two-point budget cannot retain both endpoints and a gap.
				// Keep a visible gap before the final sample rather than join it.
				result[len(result)-1] = points[gap]
			} else {
				result = append(result, points[gap])
			}
		}
		if len(result) < maximum {
			result = append(result, points[current])
		}
	}
	return result
}

func dashboardInterveningGap(points []Point, previous, current int) int {
	if points[previous].Value == nil || points[current].Value == nil {
		return -1
	}
	for index := previous + 1; index < current; index++ {
		if points[index].Value == nil {
			return index
		}
	}
	return -1
}

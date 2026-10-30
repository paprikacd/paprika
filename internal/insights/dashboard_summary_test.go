package insights

import (
	"encoding/json"
	"math"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/benebsworth/paprika/internal/dataframe"
)

func TestDashboardSummaryDoesNotCallIncompleteEmptySourceEmpty(t *testing.T) {
	for name, result := range map[string]QueryResult{
		"metrics": {Series: []Series{}, Truncated: true},
		"traces":  {Traces: []Trace{}, Truncated: true},
		"records": {Records: &dataframe.Frame{Columns: []dataframe.Column{{Key: "value", Type: "number"}}, Rows: [][]any{}, Truncated: true}},
	} {
		t.Run(name, func(t *testing.T) {
			signal := summarizeDashboardResult(result, DashboardSummaryOptions{})
			if signal.State != "partial" || !signal.ProviderTruncated || !signal.Truncated {
				t.Fatalf("source-limited empty response must be partial, not definitively empty: %+v", signal)
			}
			if signal.PrimarySeries != nil {
				t.Fatalf("source-limited empty response must not invent a primary observation: %+v", signal)
			}
		})
	}
	// A compact preview limit is not a source failure; populated source-limited
	// signals remain ok and are independently marked providerTruncated.
	signal := summarizeDashboardResult(QueryResult{Series: []Series{{Points: []Point{dashboardTestPoint(1, 0)}}}, Truncated: true}, DashboardSummaryOptions{})
	if signal.State != "ok" || !signal.ProviderTruncated || signal.PrimarySeries == nil || *signal.Series[0].Last.Value != 0 {
		t.Fatalf("an observed zero is valid even in a bounded source response: %+v", signal)
	}
}

func dashboardTestPoint(timestamp, value float64) Point {
	return Point{Timestamp: timestamp, Value: &value}
}

func TestDashboardSummaryMatchesFiniteUIReadings(t *testing.T) {
	result := QueryResult{Series: []Series{{Name: "requests", Points: []Point{
		dashboardTestPoint(3_000, 2), dashboardTestPoint(1_000, 0),
		dashboardTestPoint(3_000, 3.123456789), {Timestamp: 4_000},
		dashboardTestPoint(2_000, math.NaN()), dashboardTestPoint(2_500, math.Inf(1)),
		dashboardTestPoint(math.Inf(1), 99), dashboardTestPoint(8.64e15+1, 99),
	}}}}
	signal := summarizeDashboardResult(result, DashboardSummaryOptions{})
	if signal.State != "ok" || signal.PrimarySeries == nil || *signal.PrimarySeries != 0 {
		t.Fatalf("unexpected primary state: %+v", signal)
	}
	summary := signal.Series[0]
	if summary.Samples != 6 || summary.Valid != 3 || summary.Missing != 3 || summary.InvalidTimestamps != 2 {
		t.Fatalf("wrong quality counts: %+v", summary)
	}
	assertDashboardSummaryExtrema(t, summary)
	if *summary.Last.Value != 3.123456789 || summary.Last.Timestamp != 3_000 || !summary.TailMissing || *summary.LastAt != 4_000 || *summary.FirstAt != 1_000 {
		t.Fatalf("latest/tied timestamp or missing tail differs from UI: %+v", summary)
	}
	if summary.History != nil || summary.HistoryTruncated {
		t.Fatal("default output must not include raw history")
	}
	if _, err := json.Marshal(signal); err != nil {
		t.Fatalf("nonfinite provider observations reached JSON: %v", err)
	}
	*result.Series[0].Points[2].Value = 100
	if *summary.Last.Value != 3.123456789 {
		t.Fatal("summary retained a mutable provider-value pointer")
	}
}

func assertDashboardSummaryExtrema(t *testing.T, summary DashboardSeriesSummary) {
	t.Helper()
	if *summary.First.Value != 0 || summary.First.Timestamp != 1_000 || *summary.Min != 0 || *summary.Max != 3.123456789 {
		t.Fatalf("zero or full precision was lost: %+v", summary)
	}
}

func TestDashboardSummaryDoesNotInventZero(t *testing.T) {
	for name, points := range map[string][]Point{
		"no samples":        {},
		"missing samples":   {{Timestamp: 1}, {Timestamp: 2}},
		"nonfinite samples": {dashboardTestPoint(1, math.NaN())},
		"invalid timestamp": {dashboardTestPoint(math.NaN(), 0)},
	} {
		t.Run(name, func(t *testing.T) {
			signal := summarizeDashboardResult(QueryResult{Series: []Series{{Points: points}}}, DashboardSummaryOptions{})
			if signal.State != "empty" || signal.PrimarySeries != nil {
				t.Fatalf("missing data acquired a reading: %+v", signal)
			}
			summary := signal.Series[0]
			if summary.Last != nil || summary.First != nil || summary.Min != nil || summary.Max != nil || summary.Mean != nil || summary.Valid != 0 {
				t.Fatalf("missing samples were converted into finite values: %+v", summary)
			}
			if _, err := json.Marshal(signal); err != nil {
				t.Fatal(err)
			}
		})
	}
	zero := summarizeDashboardResult(QueryResult{Series: []Series{{Points: []Point{dashboardTestPoint(1, 0)}}}}, DashboardSummaryOptions{})
	if zero.State != "ok" || zero.Series[0].Last == nil || *zero.Series[0].Last.Value != 0 || zero.Series[0].Mean == nil || *zero.Series[0].Mean != 0 {
		t.Fatalf("an observed zero is valid data: %+v", zero)
	}
}

func TestDashboardSummaryDisclosesRepeatedValidTimestamps(t *testing.T) {
	points := []Point{dashboardTestPoint(3, 9), dashboardTestPoint(1, 0), {Timestamp: 3}, dashboardTestPoint(3, 3), dashboardTestPoint(math.Inf(1), 4), dashboardTestPoint(math.Inf(1), 5)}
	summary := summarizeDashboardSeries(Series{Points: points}, 0, 2)
	if summary.DuplicateObservations != 2 || summary.InvalidTimestamps != 2 || summary.Samples != 4 || summary.Valid != 3 {
		t.Fatalf("duplicate observations must count additional samples with valid timestamps, including gaps: %+v", summary)
	}
	if summary.Mean == nil || *summary.Mean != 4 {
		t.Fatalf("duplicate disclosure must not change the raw-observation mean: %+v", summary)
	}
	encoded, err := json.Marshal(summary)
	if err != nil || !strings.Contains(string(encoded), `"duplicateObservations":2`) {
		t.Fatalf("duplicate disclosure missing from JSON: %s: %v", encoded, err)
	}
}

func TestDashboardSummaryDuplicateDetectionAfterUnorderedSamples(t *testing.T) {
	// The first ordering reversal is not itself a duplicate, but a later point
	// can duplicate one of the observations before that reversal.
	points := []Point{dashboardTestPoint(1, 1), dashboardTestPoint(math.NaN(), 2), dashboardTestPoint(3, 3), dashboardTestPoint(2, 4), dashboardTestPoint(1, 5), {Timestamp: 2}}
	summary := summarizeDashboardSeries(Series{Points: points}, 0, 0)
	if summary.DuplicateObservations != 2 || summary.Samples != 5 || summary.InvalidTimestamps != 1 {
		t.Fatalf("unordered duplicates or invalid timestamps miscounted: %+v", summary)
	}
}

func TestDashboardSummaryMeanUsesAllFiniteReturnedObservationsWithoutOverflow(t *testing.T) {
	for _, test := range []struct {
		name   string
		points []Point
		want   float64
	}{
		{"gaps and duplicate timestamps", []Point{dashboardTestPoint(3, 9), dashboardTestPoint(1, 0), {Timestamp: 2}, dashboardTestPoint(3, 3), dashboardTestPoint(math.Inf(1), 100)}, 4},
		{"large same sign", []Point{dashboardTestPoint(1, math.MaxFloat64), dashboardTestPoint(2, math.MaxFloat64), dashboardTestPoint(3, math.MaxFloat64)}, math.MaxFloat64},
		{"large opposite signs", []Point{dashboardTestPoint(1, 1e308), dashboardTestPoint(2, -1e308)}, 0},
		{"cancellation retains small observation", []Point{dashboardTestPoint(1, 1e16), dashboardTestPoint(2, 1), dashboardTestPoint(3, -1e16)}, 1.0 / 3},
		{"extreme cancellation retains subnormal mean", []Point{dashboardTestPoint(1, 1e308), dashboardTestPoint(2, 1e-308), dashboardTestPoint(3, -1e308)}, 1e-308 / 3},
	} {
		t.Run(test.name, func(t *testing.T) {
			summary := summarizeDashboardSeries(Series{Points: test.points}, 0, 2)
			if summary.Mean == nil || !finite(*summary.Mean) || *summary.Mean != test.want {
				t.Fatalf("wrong finite sample mean: %+v", summary)
			}
			if _, err := json.Marshal(summary); err != nil {
				t.Fatalf("mean cannot be encoded: %v", err)
			}
		})
	}
}

func BenchmarkDashboardSeriesSummary(b *testing.B) {
	points := make([]Point, 1000)
	for i := range points {
		points[i] = dashboardTestPoint(float64(i), float64(i%97)-48)
	}
	series := Series{Points: points}
	b.ReportAllocs()
	for b.Loop() {
		_ = summarizeDashboardSeries(series, 0, 0)
	}
}

func TestDashboardSummaryIncludesPrimarySeriesBeyondLimit(t *testing.T) {
	series := make([]Series, 10)
	for index := range series {
		series[index] = Series{Points: []Point{{Timestamp: 1}}}
	}
	series[7].Points[0] = dashboardTestPoint(1, 42)
	series[8].Points[0] = dashboardTestPoint(1, 99)
	signal := summarizeDashboardResult(QueryResult{Series: series}, DashboardSummaryOptions{MaxSeries: 3})
	if signal.PrimarySeries == nil || *signal.PrimarySeries != 7 || len(signal.Series) != 3 {
		t.Fatalf("wrong primary selection: %+v", signal)
	}
	if signal.Series[2].Index != 7 || *signal.Series[2].Last.Value != 42 || !signal.SeriesTruncated || !signal.Truncated || signal.ProviderTruncated {
		t.Fatalf("primary or local truncation was lost: %+v", signal)
	}
	if signal.SeriesReturned == nil || *signal.SeriesReturned != 10 || signal.SeriesOmitted == nil || *signal.SeriesOmitted != 7 {
		t.Fatalf("counts must describe the fetched series and summaries omitted: %+v", signal)
	}
	bounded := summarizeDashboardResult(QueryResult{Series: series, Truncated: true}, DashboardSummaryOptions{MaxSeries: 10_000})
	if len(bounded.Series) != 8 || !bounded.ProviderTruncated || bounded.SeriesReturned == nil || *bounded.SeriesReturned != 10 || bounded.SeriesOmitted == nil || *bounded.SeriesOmitted != 2 {
		t.Fatalf("defensive limits or provider truncation missing: %+v", bounded)
	}
}

func TestDashboardSeriesCountsDistinguishEmptyFromOtherKinds(t *testing.T) {
	for _, test := range []struct {
		name   string
		result QueryResult
		want   string
	}{
		{"empty metrics", QueryResult{Series: []Series{}}, `"seriesReturned":0,"seriesOmitted":0`},
		{"traces", QueryResult{Traces: []Trace{}}, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			encoded, err := json.Marshal(summarizeDashboardResult(test.result, DashboardSummaryOptions{}))
			if err != nil {
				t.Fatal(err)
			}
			if test.want != "" && !strings.Contains(string(encoded), test.want) {
				t.Fatalf("missing zero counts: %s", encoded)
			}
			if test.want == "" && strings.Contains(string(encoded), "seriesReturned") {
				t.Fatalf("invented metric counts: %s", encoded)
			}
		})
	}
}

func TestDashboardSummaryBoundsIdentityWithoutCollidingKeys(t *testing.T) {
	labels := map[string]string{
		"a": strings.Repeat("é", 100), "b": "", "c": "3", "d": "4", "e": "5",
		"f": "6", "g": "7", "h": "8", "i": "9", strings.Repeat("z", 129): "long key",
	}
	signal := summarizeDashboardResult(QueryResult{Series: []Series{{Name: strings.Repeat("🍒", 80), Labels: labels, Points: []Point{dashboardTestPoint(1, 1)}}}}, DashboardSummaryOptions{})
	summary := signal.Series[0]
	if len(summary.Name) > 160 || !utf8.ValidString(summary.Name) || len(summary.Labels["a"]) > 128 || !utf8.ValidString(summary.Labels["a"]) {
		t.Fatalf("text budgets broke UTF-8: %+v", summary)
	}
	if len(summary.Labels) != 8 || summary.LabelsOmitted != 2 || !summary.MetadataTruncated || !signal.Truncated {
		t.Fatalf("identity omissions were not disclosed: %+v", summary)
	}
	if value, exists := summary.Labels["b"]; !exists || value != "" {
		t.Fatal("empty label values are part of identity and must survive")
	}
}

func TestDashboardTraceSummaryIsABoundedSample(t *testing.T) {
	traces := []Trace{
		{TraceID: "a", Service: "uptime-api", Status: "unknown", DurationMs: 1.23456789, StartTime: 1_000},
		{TraceID: "b", Status: "", DurationMs: 0, StartTime: 2_000},
		{TraceID: "c", Status: "error", DurationMs: 3, StartTime: 3_000},
		{TraceID: "d", Status: "vendor-status", DurationMs: 4, StartTime: 4_000},
	}
	signal := summarizeDashboardResult(QueryResult{Traces: traces, Truncated: true}, DashboardSummaryOptions{MaxTraces: 2})
	if signal.State != "ok" || signal.PrimarySeries != nil || !signal.ProviderTruncated || signal.Series != nil {
		t.Fatalf("wrong trace availability: %+v", signal)
	}
	summary := signal.Traces
	if summary.Returned != 4 || len(summary.Examples) != 2 || !summary.ExamplesTruncated {
		t.Fatalf("wrong bounded sample: %+v", summary)
	}
	if !reflect.DeepEqual(summary.StatusCounts, map[string]int{"unknown": 2, "error": 1, "other": 1}) {
		t.Fatalf("unknown statuses must not imply success: %+v", summary.StatusCounts)
	}
	if *summary.Examples[0].DurationMs != 1.23456789 || *summary.Examples[1].DurationMs != 0 {
		t.Fatal("trace precision or zero duration was lost")
	}
	empty := summarizeDashboardResult(QueryResult{Traces: []Trace{}}, DashboardSummaryOptions{})
	if empty.State != "empty" || empty.Traces == nil || empty.Traces.Returned != 0 {
		t.Fatalf("empty trace data is explicit: %+v", empty)
	}
}

func TestDashboardTraceSummaryBoundsTextAndInvalidNumbers(t *testing.T) {
	trace := Trace{TraceID: strings.Repeat("a", 128), Service: strings.Repeat("b", 256), Operation: strings.Repeat("c", 1_000), Status: strings.Repeat("d", 100), DurationMs: math.NaN(), StartTime: math.Inf(1)}
	signal := summarizeDashboardResult(QueryResult{Traces: []Trace{trace}}, DashboardSummaryOptions{})
	example := signal.Traces.Examples[0]
	if !signal.Traces.MetadataTruncated || !example.InvalidFields || example.DurationMs != nil || example.StartTime != nil {
		t.Fatalf("invalid or truncated trace fields were hidden: %+v", example)
	}
	if len(example.TraceID) > 64 || len(example.Service) > 128 || len(example.Operation) > 160 || len(example.Status) > 32 {
		t.Fatalf("unbounded trace metadata: %+v", example)
	}
	if _, err := json.Marshal(signal); err != nil {
		t.Fatal(err)
	}
}

func TestDashboardHistoryRetainsExtremaGapsAndLatestValidTail(t *testing.T) {
	points := make([]Point, 301)
	for index := range points {
		points[index] = dashboardTestPoint(float64(index)*1_000, 5)
	}
	points[37].Value = dashboardNumber(-100)
	points[181].Value = dashboardNumber(900)
	points[90].Value, points[220].Value = nil, nil
	points[298].Value = dashboardNumber(17.123456789)
	points[299].Value, points[300].Value = nil, nil
	signal := summarizeDashboardResult(QueryResult{Series: []Series{{Points: points}}}, DashboardSummaryOptions{HistoryPoints: 32})
	summary := signal.Series[0]
	if !summary.HistoryTruncated || len(summary.History) > 32 || *summary.Last.Value != 17.123456789 || !summary.TailMissing {
		t.Fatalf("history budget or exact latest reading failed: %+v", summary)
	}
	seen := map[float64]bool{}
	for _, point := range summary.History {
		seen[point.Timestamp] = true
	}
	for _, timestamp := range []float64{0, 37_000, 181_000, 298_000, 300_000} {
		if !seen[timestamp] {
			t.Fatalf("history lost required endpoint/extreme/latest sample %v: %+v", timestamp, summary.History)
		}
	}
	assertDashboardHistoryDoesNotBridgeGaps(t, points, summary.History)
	encoded, err := json.Marshal(summary.History)
	if err != nil || !strings.HasPrefix(string(encoded), "[[") || !strings.Contains(string(encoded), "null]") {
		t.Fatalf("history must use compact tuples and explicit gaps: %s, %v", encoded, err)
	}
}

func TestDashboardHistorySmallBudgetsStayBoundedAndHonest(t *testing.T) {
	points := []Point{dashboardTestPoint(0, 1), {Timestamp: 1}, dashboardTestPoint(2, 3), {Timestamp: 3}, dashboardTestPoint(4, 5), {Timestamp: 5}}
	for maximum := 2; maximum <= 32; maximum++ {
		t.Run(strconv.Itoa(maximum), func(t *testing.T) {
			signal := summarizeDashboardResult(QueryResult{Series: []Series{{Points: points}}}, DashboardSummaryOptions{HistoryPoints: maximum})
			history := signal.Series[0].History
			if len(history) > maximum || history[len(history)-1].Timestamp != 5 || history[len(history)-1].Value != nil {
				t.Fatalf("budget %d or missing tail failed: %+v", maximum, history)
			}
			seenLatest := false
			for _, point := range history {
				seenLatest = seenLatest || point.Timestamp == 4 && point.Value != nil && *point.Value == 5
			}
			if !seenLatest {
				t.Fatalf("budget %d dropped latest finite reading: %+v", maximum, history)
			}
			assertDashboardHistoryDoesNotBridgeGaps(t, points, history)
		})
	}
}

func assertDashboardHistoryDoesNotBridgeGaps(t *testing.T, source []Point, history []DashboardHistoryPoint) {
	t.Helper()
	for index := 1; index < len(history); index++ {
		previous, current := history[index-1], history[index]
		if previous.Value == nil || current.Value == nil {
			continue
		}
		for _, point := range source {
			if point.Timestamp > previous.Timestamp && point.Timestamp < current.Timestamp && !dashboardFiniteValue(point.Value) {
				t.Fatalf("history joined finite observations across missing sample %v", point.Timestamp)
			}
		}
	}
}

func TestDashboardSummaryReducesPayloadWithoutChangingReadings(t *testing.T) {
	points := make([]Point, 301)
	for index := range points {
		points[index] = dashboardTestPoint(1_790_000_000_000+float64(index)*12_000, float64(index)/7)
	}
	raw := QueryResult{Series: []Series{{Name: "request rate", Labels: map[string]string{"service": "uptime-api"}, Points: points}}}
	summary := summarizeDashboardResult(raw, DashboardSummaryOptions{})
	full, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	compact, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	if len(compact)*10 >= len(full) {
		t.Fatalf("expected at least 90%% fewer bytes, raw=%d compact=%d", len(full), len(compact))
	}
	if *summary.Series[0].Last.Value != *points[300].Value {
		t.Fatal("compact result must retain exact core reading")
	}
	t.Logf("raw=%d bytes, summary=%d bytes (%.1f%% smaller)", len(full), len(compact), 100*(1-float64(len(compact))/float64(len(full))))
}

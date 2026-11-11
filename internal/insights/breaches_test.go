package insights

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

// breachConformance mirrors docs/design/insights/conformance/breaches.json. The UI test
// reads the same file, so both ports must produce exactly these results.
type breachConformance struct {
	Cases []struct {
		Name       string                   `json:"name"`
		Thresholds []dashboardReadThreshold `json:"thresholds"`
		Series     []struct {
			Step   *float64 `json:"step"`
			Points []struct {
				Timestamp float64  `json:"timestamp"`
				Value     *float64 `json:"value"`
			} `json:"points"`
		} `json:"series"`
		Expected struct {
			Intervals []struct {
				Series   int     `json:"series"`
				Start    float64 `json:"start"`
				End      float64 `json:"end"`
				Level    string  `json:"level"`
				Duration float64 `json:"duration"`
			} `json:"intervals"`
			Summary []struct {
				Level     string  `json:"level"`
				Intervals int     `json:"intervals"`
				Samples   int     `json:"samples"`
				Duration  float64 `json:"duration"`
			} `json:"summary"`
		} `json:"expected"`
	} `json:"cases"`
}

func loadBreachConformance(t *testing.T) breachConformance {
	t.Helper()
	raw, err := os.ReadFile("../../docs/design/insights/conformance/breaches.json")
	require.NoError(t, err)
	var fixture breachConformance
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Cases)
	return fixture
}

func TestBreachConformanceMatchesSharedFixtures(t *testing.T) {
	for _, testCase := range loadBreachConformance(t).Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			series := make([]breachSeries, 0, len(testCase.Series))
			for _, entry := range testCase.Series {
				points := make([]Point, 0, len(entry.Points))
				for _, point := range entry.Points {
					points = append(points, Point{Timestamp: point.Timestamp, Value: point.Value})
				}
				step := 0.0
				if entry.Step != nil {
					step = *entry.Step
				}
				series = append(series, breachSeries{Points: points, Step: step})
			}
			intervals := timeSeriesBreaches(series, testCase.Thresholds)
			gotIntervals := make([]struct {
				Series   int     `json:"series"`
				Start    float64 `json:"start"`
				End      float64 `json:"end"`
				Level    string  `json:"level"`
				Duration float64 `json:"duration"`
			}, 0, len(intervals))
			plain := make([]breachInterval, 0, len(intervals))
			for _, interval := range intervals {
				gotIntervals = append(gotIntervals, struct {
					Series   int     `json:"series"`
					Start    float64 `json:"start"`
					End      float64 `json:"end"`
					Level    string  `json:"level"`
					Duration float64 `json:"duration"`
				}{interval.Series, interval.Start, interval.End, interval.Level, interval.Duration})
				plain = append(plain, interval.breachInterval)
			}
			require.Equal(t, testCase.Expected.Intervals, gotIntervals)
			summary := breachSummary(plain)
			require.Len(t, summary, len(testCase.Expected.Summary))
			for index, want := range testCase.Expected.Summary {
				require.Equal(t, want.Level, summary[index].Level)
				require.Equal(t, want.Intervals, summary[index].Intervals)
				require.Equal(t, want.Samples, summary[index].Samples)
				require.Equal(t, want.Duration, summary[index].Duration)
			}
		})
	}
}

func TestSampleCadenceNeedsThreeObservedSamplesAndUsesTheLowerMedian(t *testing.T) {
	at := func(ts float64, value *float64) Point { return Point{Timestamp: ts, Value: value} }
	v := func(x float64) *float64 { return &x }
	require.Zero(t, sampleCadence([]Point{at(0, v(1)), at(60_000, v(1))}), "two observations are not a cadence")
	require.Zero(t, sampleCadence([]Point{at(0, v(1)), at(60_000, nil), at(120_000, nil)}), "missing samples are not observations")
	// Steps 10, 20, 30, 40 sort to 10, 20, 30, 40; the lower median is 20.
	require.Equal(t, 20.0, sampleCadence([]Point{at(0, v(1)), at(10, v(1)), at(30, v(1)), at(60, v(1)), at(100, v(1))}))
	// Unsorted input is ordered by time first.
	require.Equal(t, 60_000.0, sampleCadence([]Point{at(120_000, v(1)), at(0, v(1)), at(60_000, v(1))}))
}

func TestDashboardBreachesBoundIntervalsAndSeries(t *testing.T) {
	thresholds := []dashboardReadThreshold{{Value: 0, Status: "ok"}, {Value: 2, Status: "critical"}}
	// Each flap is a single breaching sample surrounded by normal samples, so every one is an instant.
	points := make([]Point, 0, 20)
	for index := range 20 {
		value := 0.0
		if index%2 == 1 {
			value = 3
		}
		points = append(points, Point{Timestamp: float64(index) * 60_000, Value: &value})
	}
	series := make([]Series, 0, maxBreachSeries+2)
	for range maxBreachSeries + 2 {
		series = append(series, Series{Points: points})
	}
	breaches := dashboardBreaches(series, thresholds)
	require.Equal(t, maxBreachSeries, breaches.SeriesEvaluated)
	require.Equal(t, 2, breaches.SeriesOmitted)
	require.Len(t, breaches.Intervals, maxBreachIntervals)
	require.Equal(t, (maxBreachSeries*10)-maxBreachIntervals, breaches.IntervalsOmitted)
	// The most recent intervals are kept, in chronological order.
	last := breaches.Intervals[len(breaches.Intervals)-1]
	require.Equal(t, "critical", last.Level)
	require.Equal(t, 1_140_000.0, last.Start)
	// Each series flaps into nine 60-second intervals and one final instant. Merged across identical series, they stay nine spans and one sample.
	require.Equal(t, []DashboardBreachLevel{{Level: "critical", Intervals: 9, Samples: 1, DurationMs: 540_000}}, breaches.Summary)
}

func TestDashboardBreachesMergeOverlappingSeriesInTheSummary(t *testing.T) {
	thresholds := []dashboardReadThreshold{{Value: 0, Status: "ok"}, {Value: 2, Status: "warning"}}
	three := 3.0
	first := Series{Points: []Point{{Timestamp: 0, Value: &three}, {Timestamp: 60_000, Value: &three}}}
	second := Series{Points: []Point{{Timestamp: 30_000, Value: &three}, {Timestamp: 90_000, Value: &three}}}
	breaches := dashboardBreaches([]Series{first, second}, thresholds)
	require.Len(t, breaches.Intervals, 2)
	require.Equal(t, []DashboardBreachLevel{{Level: "warning", Intervals: 1, Samples: 0, DurationMs: 90_000}}, breaches.Summary)
}

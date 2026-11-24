package insights

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The shared baseline cases also run in ui/src/features/insights/baseline.test.ts.
const baselineFixturePath = "../../docs/design/insights/conformance/baseline.json"

type baselineFixtureRun struct {
	Start   float64 `json:"start"`
	End     float64 `json:"end"`
	Samples int     `json:"samples"`
}

type baselineFixtureExpect struct {
	Index     int                  `json:"index"`
	Evaluated int                  `json:"evaluated"`
	Outside   int                  `json:"outside"`
	Runs      []baselineFixtureRun `json:"runs"`
	Reason    string               `json:"reason,omitempty"`
}

type baselineFixtureCase struct {
	Name    string                  `json:"name"`
	Window  string                  `json:"window"`
	Band    string                  `json:"band"`
	Current []Series                `json:"current"`
	Prior   *[]Series               `json:"prior"`
	Expect  []baselineFixtureExpect `json:"expect"`
}

type baselineFixture struct {
	OffsetMs float64               `json:"offsetMs"`
	StepMs   float64               `json:"stepMs"`
	Cases    []baselineFixtureCase `json:"cases"`
}

func baselineSummary(results []seriesBaseline) []baselineFixtureExpect {
	summary := make([]baselineFixtureExpect, 0, len(results))
	for _, result := range results {
		runs := make([]baselineFixtureRun, 0, len(result.Runs))
		for _, run := range result.Runs {
			runs = append(runs, baselineFixtureRun{Start: run.Start, End: run.End, Samples: run.Samples})
		}
		summary = append(summary, baselineFixtureExpect{Index: result.Index, Evaluated: result.Evaluated, Outside: result.Outside, Runs: runs, Reason: result.Reason})
	}
	return summary
}

// TestBaselineConformance runs the shared fixture through the Go port, which must match the UI exactly.
func TestBaselineConformance(t *testing.T) {
	source, err := os.ReadFile(baselineFixturePath)
	require.NoError(t, err)
	var fixture baselineFixture
	require.NoError(t, json.Unmarshal(source, &fixture))
	require.NotEmpty(t, fixture.Cases)
	for _, testCase := range fixture.Cases {
		t.Run(testCase.Name, func(t *testing.T) {
			var prior []Series
			hasPrior := testCase.Prior != nil
			if hasPrior {
				prior = *testCase.Prior
			}
			results := seriesBaselines(testCase.Current, prior, hasPrior, baselineOptions{
				Window: testCase.Window, Band: testCase.Band, OffsetMs: fixture.OffsetMs, StepMs: fixture.StepMs,
			})
			require.Equal(t, testCase.Expect, baselineSummary(results))
		})
	}
}

func TestBaselineRunsTextMatchesUI(t *testing.T) {
	clock := func(ms float64) string {
		return time.UnixMilli(int64(ms)).UTC().Format("15:04")
	}
	run := func(start float64) baselineRun { return baselineRun{Start: start, End: start + 120_000, Samples: 3} }
	require.Equal(t, "", baselineRunsText(nil, clock))
	require.Equal(t, "00:00–00:02", baselineRunsText([]baselineRun{run(0)}, clock))
	require.Equal(t, "00:10–00:12, 00:20–00:22, 00:30–00:32 and 1 earlier",
		baselineRunsText([]baselineRun{run(0), run(600_000), run(1_200_000), run(1_800_000)}, clock))
}

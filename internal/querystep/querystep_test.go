package querystep

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// conformance mirrors docs/design/insights/conformance/query-step.json. The UI
// test reads the same file, so both ports must produce exactly these steps.
type conformance struct {
	Cases []struct {
		Name           string  `json:"name"`
		RangeSeconds   float64 `json:"rangeSeconds"`
		TargetPoints   int     `json:"targetPoints"`
		MinStepSeconds float64 `json:"minStepSeconds"`
		Step           float64 `json:"step"`
	} `json:"cases"`
}

func seconds(s float64) time.Duration {
	return time.Duration(s * float64(time.Second))
}

func TestConformance(t *testing.T) {
	t.Parallel()
	raw, err := os.ReadFile("../../docs/design/insights/conformance/query-step.json")
	require.NoError(t, err)
	var doc conformance
	require.NoError(t, json.Unmarshal(raw, &doc))
	require.GreaterOrEqual(t, len(doc.Cases), 30)

	for _, tt := range doc.Cases {
		t.Run(tt.Name, func(t *testing.T) {
			t.Parallel()
			got := For(seconds(tt.RangeSeconds), tt.TargetPoints, seconds(tt.MinStepSeconds))
			require.Equal(t, seconds(tt.Step), got)
		})
	}
}

func TestDefaultTargetPointsMatchesTheUI(t *testing.T) {
	t.Parallel()
	require.Equal(t, 300, DefaultTargetPoints)
}

func TestForUsesTheDefaultTargetForPresetRanges(t *testing.T) {
	t.Parallel()
	// The 7-day preset at the default density: 604800 / 300 = 2016 s, which
	// snaps to the 30-minute rung. Without the snap the step would be 2016 s.
	require.Equal(t, 30*time.Minute, For(7*24*time.Hour, DefaultTargetPoints, 0))
	// A 15-minute range with a 15 s scrape floor keeps every real sample.
	require.Equal(t, 15*time.Second, For(15*time.Minute, DefaultTargetPoints, 15*time.Second))
}

func TestForNeverExceedsOneAndAHalfTimesTheTarget(t *testing.T) {
	t.Parallel()
	for span := time.Second; span <= 31*24*time.Hour; span = span*3/2 + time.Second {
		step := For(span, DefaultTargetPoints, 0)
		require.LessOrEqual(t, span.Seconds()/step.Seconds(), 1.5*DefaultTargetPoints+1e-9,
			"span %s step %s", span, step)
	}
}

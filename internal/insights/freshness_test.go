package insights

import (
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/insights/guidance"
)

// TestStaleJudgementSetMatchesTheUI pins the widget types whose staleAfterSeconds is judged.
// The UI is the source of truth: it marks stale on stat (chart-renderers.tsx) and hatches a
// stale time-series tail (time-series-chart.tsx), and the widget editor offers the option for
// exactly those types (widget-editor.tsx). Every statement of the set in Go must name the same
// two types, so a change to one surface fails here.
func TestStaleJudgementSetMatchesTheUI(t *testing.T) {
	for _, widgetType := range []string{"timeseries", "bar", "stat", "table", "traces", "heatmap", "plugin"} {
		require.Equal(t, widgetType == "stat" || widgetType == "timeseries", judgesStaleAfter(widgetType), widgetType)
	}

	var lintSummary string
	for _, rule := range dataRules {
		if rule.ID == "data.stale" {
			lintSummary = rule.Summary
		}
	}
	require.Contains(t, lintSummary, "Applies to stat and timeseries widgets", "dry-run data.stale rule")

	var composition string
	for _, line := range guidance.DashboardComposition() {
		if strings.Contains(line, "staleAfterSeconds") {
			composition = line
		}
	}
	require.Contains(t, composition, "It applies to stat and time-series widgets only", "composition guidance")

	s, _ := testService(t)
	for _, kind := range []string{"widget", "dashboard"} {
		w := request(t, s.Handler(), http.MethodGet, "/api/schemas/"+kind, nil, nil)
		require.Equal(t, http.StatusOK, w.Code)
		require.Contains(t, w.Body.String(), "Only these two types judge staleAfterSeconds", "schema note for "+kind)
	}

	for path, marker := range map[string]string{
		"../../ui/src/features/insights/widget-attention.ts":   `const explicit = widget.options?.staleAfterSeconds`,
		"../../ui/src/features/insights/time-series-chart.tsx": `options.staleAfterSeconds`,
		"../../ui/src/features/insights/widget-editor.tsx":     `widget.type === "stat" || widget.type === "timeseries"`,
	} {
		source, err := os.ReadFile(path) //nolint:gosec // Fixed repository paths listed above.
		require.NoError(t, err)
		require.Contains(t, string(source), marker, "UI source of truth no longer marks stale on this surface: "+path)
	}
}

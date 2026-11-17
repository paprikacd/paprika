package observabilitygateway

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/insights"
)

// The omitted names in the advertised schema and the text phrases use the Insights step names. One test
// ties all three together, so a renamed or added step fails here rather than silently reaching clients.
func TestDashboardOmissionNamesMatchTheInsightsSteps(t *testing.T) {
	steps := insights.DashboardOmissionStepNames()
	require.NotEmpty(t, steps)

	var schema map[string]any
	require.NoError(t, json.Unmarshal([]byte(dashboardQueryOutputSchema), &schema))
	properties, ok := schema["properties"].(map[string]any)
	require.True(t, ok)
	omitted, ok := properties["omitted"].(map[string]any)
	require.True(t, ok)
	items, ok := omitted["items"].(map[string]any)
	require.True(t, ok)
	enum, ok := items["enum"].([]any)
	require.True(t, ok)
	names := make([]string, 0, len(enum))
	for _, value := range enum {
		name, ok := value.(string)
		require.True(t, ok)
		names = append(names, name)
	}
	require.ElementsMatch(t, steps, names, "the schema's omitted enum must list exactly the Insights steps")

	phrases := make([]string, 0, len(dashboardOmissionPhrases))
	for name := range dashboardOmissionPhrases {
		phrases = append(phrases, name)
	}
	require.ElementsMatch(t, steps, phrases, "every Insights step needs a text phrase, and no phrase may name a step Insights does not have")
}

// dashboardCappedGoldenPath is the capped wire output the Insights handler writes after n steps of the
// omission ladder. Insights pins each file in its own golden test, so the schema checked here is the one
// a real capped result is read against.
func dashboardCappedGoldenPath(n int) string {
	return fmt.Sprintf("../insights/testdata/dashboard_query_capped/steps-%d.json", n)
}

// A capped result from the real handler validates against the advertised MCP output schema after every
// prefix of the ladder, and its text names what was dropped. The goldens hold breach objects, band series,
// time-series and stat freshness, and stale samples, so every omission branch is covered.
func TestDashboardCappedOutputValidatesAgainstTheSchema(t *testing.T) {
	resolved := loadDashboardQuerySchema(t, []byte(dashboardQueryOutputSchema))
	steps := insights.DashboardOmissionStepNames()
	for n := 1; n <= len(steps); n++ {
		raw, err := os.ReadFile(dashboardCappedGoldenPath(n))
		require.NoError(t, err)
		var document map[string]any
		require.NoError(t, json.Unmarshal(raw, &document))
		require.Equal(t, toAnySlice(steps[:n]), document["omitted"], "the golden after %d steps names exactly those steps", n)
		require.NoError(t, resolved.Validate(document), "a result capped after %d steps must validate", n)

		text, err := dashboardQueryText(raw)
		require.NoError(t, err)
		require.Contains(t, text, "Omitted from structuredContent to fit the result cap, in this order:")
		for _, name := range steps[:n] {
			require.Contains(t, text, dashboardOmissionPhrases[name])
		}
	}
}

// A capped result the gateway reads still carries every attention count, which the ladder never changes.
func TestDashboardCappedOutputKeepsAttentionCounts(t *testing.T) {
	var uncapped map[string]any
	raw, err := os.ReadFile(dashboardCappedGoldenPath(1))
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(raw, &uncapped))
	before, err := json.Marshal(uncapped["attention"])
	require.NoError(t, err)
	for n := 2; n <= len(insights.DashboardOmissionStepNames()); n++ {
		raw, err := os.ReadFile(dashboardCappedGoldenPath(n))
		require.NoError(t, err)
		var capped map[string]any
		require.NoError(t, json.Unmarshal(raw, &capped))
		after, err := json.Marshal(capped["attention"])
		require.NoError(t, err)
		require.JSONEq(t, string(before), string(after), "attention after %d steps", n)
	}
}

func toAnySlice(names []string) []any {
	out := make([]any, 0, len(names))
	for _, name := range names {
		out = append(out, name)
	}
	return out
}

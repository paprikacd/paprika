package observabilitygateway

import (
	"encoding/json"
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

// applyDashboardOmissionSteps applies the first n omission steps to a structured result the way Insights
// does: intervals move into intervalsOmitted, breach and bandSeries objects go, the time-series freshness
// goes, and a sample keeps only a stale state unless attention already reads stale.
func applyDashboardOmissionSteps(t *testing.T, document map[string]any, n int) {
	t.Helper()
	steps := insights.DashboardOmissionStepNames()
	widgets := requireDashboardTextSlice(t, document["widgets"])
	for step := range n {
		for _, raw := range widgets {
			widget := requireDashboardTextMap(t, raw)
			switch steps[step] {
			case "breachIntervals":
				if breaches, ok := widget["breaches"].(map[string]any); ok {
					listed := requireDashboardTextSlice(t, breaches["intervals"])
					breaches["intervalsOmitted"] = float64(len(listed)) + numberOrZero(breaches["intervalsOmitted"])
					breaches["intervals"] = []any{}
				}
			case "breaches":
				delete(widget, "breaches")
			case "bandSeries":
				delete(widget, "bandSeries")
			case "sample":
				if widget["type"] == "timeseries" {
					delete(widget, "freshness")
				}
				sample, ok := widget["sample"].(map[string]any)
				if !ok {
					continue
				}
				if sample["state"] != "stale" || widget["attention"] == "stale" {
					delete(widget, "sample")
					continue
				}
				for _, key := range []string{"basis", "staleAfterSeconds", "lastTimestamp", "ageSeconds"} {
					delete(sample, key)
				}
			}
		}
		document["omitted"] = toAnySlice(steps[:step+1])
	}
}

func numberOrZero(value any) float64 {
	number, _ := value.(float64)
	return number
}

func toAnySlice(names []string) []any {
	out := make([]any, 0, len(names))
	for _, name := range names {
		out = append(out, name)
	}
	return out
}

// A capped result validates against the advertised MCP output schema after every prefix of the ladder,
// and its text names what was dropped. The fixture is a real runtime capture with breaches, a band series,
// stat and time-series freshness, and stale samples.
func TestDashboardCappedOutputValidatesAgainstTheSchema(t *testing.T) {
	resolved := loadDashboardQuerySchema(t, []byte(dashboardQueryOutputSchema))
	steps := insights.DashboardOmissionStepNames()
	for n := 1; n <= len(steps); n++ {
		var document map[string]any
		require.NoError(t, json.Unmarshal(mustReadDashboardTestdata(t, "dashboard_query_wire.json"), &document))
		applyDashboardOmissionSteps(t, document, n)
		require.NoError(t, resolved.Validate(document), "a result capped after %d steps must validate", n)

		raw, err := json.Marshal(document)
		require.NoError(t, err)
		text, err := dashboardQueryText(raw)
		require.NoError(t, err)
		require.Contains(t, text, "Omitted from structuredContent to fit the result cap, in this order:")
	}
}

// A capped result the gateway reads still carries every attention count, which the ladder never changes.
func TestDashboardCappedOutputKeepsAttentionCounts(t *testing.T) {
	var document map[string]any
	require.NoError(t, json.Unmarshal(mustReadDashboardTestdata(t, "dashboard_query_wire.json"), &document))
	before, err := json.Marshal(document["attention"])
	require.NoError(t, err)
	applyDashboardOmissionSteps(t, document, len(insights.DashboardOmissionStepNames()))
	after, err := json.Marshal(document["attention"])
	require.NoError(t, err)
	require.JSONEq(t, string(before), string(after))
}

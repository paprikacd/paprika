package observabilitygateway

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// sloDashboardFixture is a query_dashboard result with one breaching slo-summary widget and the sloBurn step applied.
const sloDashboardFixture = `{"schemaVersion":1,"widgets":[{"id":"slo","title":"SLO","type":"plugin","pluginId":"slo-summary","dataKind":"metrics","unit":"%","signalId":"q1","attention":"critical","slo":{"basis":"evaluation of the widget's author-declared objective; not a health verdict","objective":99.9,"period":"30d","evaluatedAt":"2026-10-26T10:00:00Z","state":"breaching","reasons":["budget_exhausted"],"counts":{"meeting":0,"at_risk":0,"breaching":1,"unknown":0},"groups":[{"labels":{"service":"api"},"state":"breaching","reasons":["budget_exhausted"],"availability":80,"errorRatio":0.2,"budgetRemaining":-100,"total":1000,"bad":200,"allowed":1}],"groupsOmitted":2}}],"signals":[{"id":"q1","state":"ok"}],"omitted":["sloBurn"],"queryCount":{"planned":1,"executed":1,"deduplicated":0},"savedQueries":[],"variables":{},"observedAt":"2026-10-26T10:00:00Z","range":{"start":"2026-10-26T09:00:00Z","end":"2026-10-26T10:00:00Z","stepSeconds":12},"dashboard":{"id":"reliability","title":"Reliability","etag":"v1"},"state":"ok","attention":{"basis":"author-declared warning and critical statuses and objectives, query failures and staleness only; not a health verdict","widgets":1,"checked":1,"critical":1,"warning":0,"failed":0,"stale":0}}`

// The output schema accepts an slo object, its state names and the sloBurn omission, and rejects an unknown state.
func TestDashboardQuerySchemaAcceptsSLOObjects(t *testing.T) {
	resolved := loadDashboardQuerySchema(t, []byte(dashboardQueryOutputSchema))
	validate := func(raw string) error {
		var document map[string]any
		require.NoError(t, json.Unmarshal([]byte(raw), &document))
		return resolved.Validate(document)
	}
	require.NoError(t, validate(sloDashboardFixture))

	unknownState := strings.Replace(sloDashboardFixture, `"state":"breaching","reasons"`, `"state":"healthy","reasons"`, 1)
	require.Error(t, validate(unknownState), "a state outside the four names is not valid")

	unknownOmission := strings.Replace(sloDashboardFixture, `"omitted":["sloBurn"]`, `"omitted":["sloDetail"]`, 1)
	require.Error(t, validate(unknownOmission), "an omission name outside the ladder is not valid")
}

// The text reader gets one objective line per slo-summary widget, with its state, counts and listed groups.
func TestDashboardQueryTextStatesTheSLOObjective(t *testing.T) {
	text, err := dashboardQueryText(json.RawMessage(sloDashboardFixture))
	require.NoError(t, err)
	require.Contains(t, text, `widget "slo" objective 99.9% over 30d: state breaching (budget_exhausted); meeting=0 at_risk=0 breaching=1 unknown=0; [service=api breaching availability 80% budget -100%] (2 more groups in structuredContent)`)
	require.Contains(t, text, "burn windows of slo-summary groups (state, reasons and budget kept)")
	require.Contains(t, text, "Attention: 1 critical;", "the breaching objective counts as critical attention")
	require.Contains(t, text, "not a health verdict")
}

// The synopsis rounds each percentage at the widget's decimals, but a value under 100 never reads as 100.
func TestSLOSynopsisUsesDecimalsWithoutRoundingUpToHundred(t *testing.T) {
	raw := `{"id":"slo","title":"SLO","type":"plugin","pluginId":"slo-summary","unit":"%","decimals":0,"slo":{"basis":"b","objective":99.9,"period":"30d","evaluatedAt":"2026-10-26T10:00:00Z","state":"meeting","reasons":[],"counts":{"meeting":1,"at_risk":0,"breaching":0,"unknown":0},"groups":[{"labels":{"service":"api"},"state":"meeting","reasons":[],"availability":99.99997,"budgetRemaining":99.96,"total":10,"bad":0,"allowed":10,"burn":[]}],"groupsOmitted":0}}`
	var widget dashboardTextWidget
	require.NoError(t, json.Unmarshal([]byte(raw), &widget))
	line := dashboardSLOLineText(&widget)
	require.Contains(t, line, "objective 99.9% over 30d", "the objective keeps its own value")
	require.Contains(t, line, "availability 99.99997%", "a value under 100 is not rounded up to 100 at zero decimals")
	require.Contains(t, line, "budget 99.96%")
	require.NotContains(t, line, "availability 100%")
	require.NotContains(t, line, "budget 100%")
}

func TestSLOSynopsisWordsUnknownGroupsByReason(t *testing.T) {
	cases := map[string]string{
		"no_traffic": "no traffic",
		"incomplete": "not proven (truncated)",
		"no_data":    "no data",
	}
	for reason, want := range cases {
		raw := `{"id":"slo","title":"SLO","type":"plugin","pluginId":"slo-summary","unit":"%","slo":{"basis":"b","objective":99.9,"period":"30d","evaluatedAt":"2026-10-26T10:00:00Z","state":"unknown","reasons":["` + reason + `"],"counts":{"meeting":0,"at_risk":0,"breaching":0,"unknown":1},"groups":[{"labels":{"service":"api"},"state":"unknown","reasons":["` + reason + `"]}],"groupsOmitted":0}}`
		var widget dashboardTextWidget
		require.NoError(t, json.Unmarshal([]byte(raw), &widget))
		line := dashboardSLOLineText(&widget)
		require.Contains(t, line, "availability "+want, reason)
	}
}

// A negative budget keeps its sign at zero decimals, so an overspend of 0.04% never reads as "0%" in the synopsis.
func TestSLOSynopsisKeepsTheSignOfASmallOverspend(t *testing.T) {
	for _, value := range []float64{-0.04, -0.4} {
		require.NotEqual(t, "0%", sloPercentText(value, sloTestZeroDecimals()), "a value below zero must not print as zero")
		require.True(t, strings.HasPrefix(sloPercentText(value, sloTestZeroDecimals()), "-"), "the sign survives at zero decimals")
	}
	require.Equal(t, "-0.04%", sloPercentText(-0.04, sloTestZeroDecimals()))
	require.Equal(t, "-1%", sloPercentText(-1, sloTestZeroDecimals()), "a whole negative value keeps its fixed decimals")
}

// The omitted-groups note agrees with its count, so one omitted group is not "1 more groups".
func TestSLOSynopsisPluralisesOmittedGroups(t *testing.T) {
	raw := `{"id":"slo","title":"SLO","type":"plugin","pluginId":"slo-summary","unit":"%","slo":{"basis":"b","objective":99.9,"period":"30d","evaluatedAt":"2026-10-26T10:00:00Z","state":"meeting","reasons":[],"counts":{"meeting":1,"at_risk":0,"breaching":0,"unknown":0},"groups":[],"groupsOmitted":1}}`
	var widget dashboardTextWidget
	require.NoError(t, json.Unmarshal([]byte(raw), &widget))
	require.Contains(t, dashboardSLOLineText(&widget), "(1 more group in structuredContent)")
}

func sloTestZeroDecimals() *int {
	zero := 0
	return &zero
}

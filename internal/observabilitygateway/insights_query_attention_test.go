package observabilitygateway

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/stretchr/testify/require"
)

const dashboardAttentionFixture = `{"schemaVersion":1,"dashboard":{"id":"reliability","title":"Reliability","etag":"v1"},"observedAt":"now","range":{"start":"s","end":"e","stepSeconds":12},"variables":{},"state":"partial",` +
	`"attention":{"basis":"author-declared warning and critical statuses, query failures and staleness only; not a health verdict","widgets":4,"checked":2,"critical":1,"warning":0,"failed":1,"stale":1},` +
	`"widgets":[` +
	`{"id":"burn","title":"Burn rate","type":"timeseries","unit":"x","signalId":"q1","attention":"critical","sample":{"state":"no_threshold","lastTimestamp":3000,"ageSeconds":30},` +
	`"breaches":{"seriesEvaluated":2,"seriesOmitted":0,"latestLevel":"warning","intervalsOmitted":4,"intervals":[{"series":0,"name":"a","level":"warning","start":1000,"end":2000,"durationMs":1000},{"series":1,"name":"b","level":"critical","start":3000,"end":3000,"durationMs":0}],"summary":[{"level":"critical","intervals":0,"samples":1,"durationMs":0},{"level":"warning","intervals":1,"samples":0,"durationMs":1000}]}},` +
	`{"id":"grid","title":"Services","type":"plugin","pluginId":"status-grid","unit":"","signalId":"q1","threshold":{"state":"matched","boundary":2,"status":"warning","label":"Degraded"},"bandSeries":{"evaluated":3,"omitted":2,"series":3,"name":"svc-3"}},` +
	`{"id":"boom","title":"Boom","type":"stat","unit":"","signalId":"q2","attention":"failed","error":{"code":"provider_error","message":"failed"}},` +
	`{"id":"cold","title":"Cold","type":"stat","unit":"","signalId":"q1","attention":"stale","freshness":{"state":"stale","thresholdSeconds":300,"lastTimestamp":1000,"ageSeconds":900},"sample":{"state":"stale","basis":"staleAfterSeconds","staleAfterSeconds":300,"lastTimestamp":1000,"ageSeconds":900}}` +
	`],"savedQueries":[],"signals":[` +
	`{"id":"q1","kind":"metrics","state":"ok","primarySeries":0,"series":[{"index":0,"samples":2,"valid":2,"missing":0,"last":{"timestamp":3000,"value":3}}]},` +
	`{"id":"q2","kind":"metrics","state":"error","error":{"code":"provider_error","message":"failed"}}],"queryCount":{"planned":2,"executed":2,"deduplicated":0},"state":"partial"}`

func TestDashboardAttentionLeadsTheTextAndCountsDeclaredStatusesOnly(t *testing.T) {
	text, err := dashboardQueryText(json.RawMessage(dashboardAttentionFixture))
	require.NoError(t, err)
	lines := strings.Split(text, "\n")
	require.Equal(t, "Attention: 1 critical, 1 failed, 1 stale; 2 of 4 widgets checked. Declared statuses, failures and staleness only; not a health verdict.", lines[0])
	require.Equal(t, `Attention widgets: "burn" critical in window; "boom" failed; "cold" stale`, lines[1], "a time series counts its breaches in the window, and the text says so when the newest sample is not critical")
	require.Contains(t, text, `Dashboard "reliability": partial.`)
	require.Contains(t, text, `widget "burn" breaches: "critical" in window: intervals=0, merged=0 ms, samples=1; "warning" in window: intervals=1, merged=1000 ms, samples=0; latest sample: "warning" now; [series 0 "a" "warning" 1000-2000 ms] [series 1 "b" "critical" 3000-3000 ms] (4 more intervals in structuredContent)`)
	require.Contains(t, text, `widget "grid": configured visual band="matched"; boundary=2; status="warning"; label="Degraded"; series=3 name="svc-3"; evaluated=3 omitted=2`)
	require.Contains(t, text, `widget "cold": returned sample freshness=stale (threshold 300s, age 900s)`)
	require.NotContains(t, text, `widget "burn": returned sample freshness`, "an unjudged age is not described in text")
	require.LessOrEqual(t, len(text), dashboardQueryTextBytes)
}

func TestDashboardAttentionTextStatesNothingDeclaredAndKeepsWidgetListBounded(t *testing.T) {
	healthy := `{"schemaVersion":1,"dashboard":{"id":"quiet"},"widgets":[{"id":"a","title":"A","type":"stat","signalId":"q1"}],"signals":[{"id":"q1","state":"ok"}],"state":"ok","attention":{"basis":"b","widgets":1,"checked":1,"critical":0,"warning":0,"failed":0,"stale":0}}`
	text, err := dashboardQueryText(json.RawMessage(healthy))
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(text, "Attention: none; 1 of 1 widgets checked. Declared statuses, failures and staleness only; not a health verdict.\n"), text)
	require.NotContains(t, text, "Attention widgets:")

	widgets := make([]string, 0, 60)
	for index := range 60 {
		widgets = append(widgets, `{"id":"widget-`+strings.Repeat("x", 20)+`-`+string(rune('a'+index%26))+`","title":"W","type":"stat","signalId":"q1","attention":"critical"}`)
	}
	crowded := `{"schemaVersion":1,"dashboard":{"id":"busy"},"widgets":[` + strings.Join(widgets, ",") + `],"signals":[{"id":"q1","state":"ok"}],"state":"ok","attention":{"basis":"b","widgets":60,"checked":60,"critical":60,"warning":0,"failed":0,"stale":0}}`
	text, err = dashboardQueryText(json.RawMessage(crowded))
	require.NoError(t, err)
	require.Contains(t, text, "Attention: 60 critical; 60 of 60 widgets checked.")
	require.Contains(t, text, "more in structuredContent)")
	require.LessOrEqual(t, len(text), dashboardQueryTextBytes)
}

func loadDashboardQuerySchema(t *testing.T, raw []byte) *jsonschema.Resolved {
	t.Helper()
	var schema jsonschema.Schema
	require.NoError(t, json.Unmarshal(raw, &schema))
	resolved, err := schema.Resolve(nil)
	require.NoError(t, err)
	return resolved
}

func TestDashboardAttentionOutputValidatesAgainstTheSchema(t *testing.T) {
	resolved := loadDashboardQuerySchema(t, []byte(dashboardQueryOutputSchema))
	var document any
	require.NoError(t, json.Unmarshal([]byte(dashboardAttentionFixture), &document))
	require.NoError(t, resolved.Validate(document))

	// The breaches are closed: an undeclared field is refused.
	widgets := requireDashboardTextSlice(t, requireDashboardTextMap(t, document)["widgets"])
	breaches := requireDashboardTextMap(t, requireDashboardTextMap(t, widgets[0])["breaches"])
	breaches["extra"] = true
	require.Error(t, resolved.Validate(document), "breaches must not accept undeclared fields")
	delete(breaches, "extra")
	requireDashboardTextMap(t, widgets[0])["sample"] = map[string]any{"state": "healthy"}
	require.Error(t, resolved.Validate(document), "sample states are the published ones")
	requireDashboardTextMap(t, widgets[0])["sample"] = map[string]any{"state": "no_threshold"}
	require.NoError(t, resolved.Validate(document))
	// Band series sit beside the threshold, so the threshold keeps its first-contract shape.
	requireDashboardTextMap(t, requireDashboardTextMap(t, widgets[1])["threshold"])["series"] = 3
	require.Error(t, resolved.Validate(document), "the threshold must not carry a series index")
}

// The structured output is consumed by MCP clients that may be one version behind. Insights and
// the gateway deploy separately, so the schema must accept both directions of the wire change.
func TestDashboardQuerySchemaIsSkewSafeWithTheFirstContract(t *testing.T) {
	firstContract := loadDashboardQuerySchema(t, mustReadDashboardTestdata(t, "dashboard_query_schema_dfad989c.json"))
	current := loadDashboardQuerySchema(t, []byte(dashboardQueryOutputSchema))

	var oldOutput, newOutput any
	require.NoError(t, json.Unmarshal(mustReadDashboardTestdata(t, "dashboard_query_base.json"), &oldOutput))
	require.NoError(t, json.Unmarshal(mustReadDashboardTestdata(t, "dashboard_query_wire.json"), &newOutput))

	require.NoError(t, firstContract.Validate(oldOutput), "first-contract output must validate against the first schema")
	require.NoError(t, current.Validate(oldOutput), "a first-contract gateway must not be broken by new Insights output's peer: old output validates against the new schema")
	require.NoError(t, firstContract.Validate(newOutput), "new Insights output must validate against a first-contract gateway's schema")
	require.NoError(t, current.Validate(newOutput), "new output must validate against the new schema")
}

func mustReadDashboardTestdata(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name) //nolint:gosec // Fixed fixture names in this package.
	require.NoError(t, err)
	return raw
}

// dashboard_query_wire.json is structured output captured from the insights runtime for a
// document with declared bands, a first-mode gauge, breaches, cadence and explicit staleness,
// and failures. It guards the real wire shape.
func TestDashboardQueryRuntimeOutputValidatesAndDescribesAttention(t *testing.T) {
	raw := mustReadDashboardTestdata(t, "dashboard_query_wire.json")
	resolved := loadDashboardQuerySchema(t, []byte(dashboardQueryOutputSchema))
	var document any
	require.NoError(t, json.Unmarshal(raw, &document))
	require.NoError(t, resolved.Validate(document))
	text, err := dashboardQueryText(raw)
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(text, "Attention: "), text)
	require.LessOrEqual(t, len(text), dashboardQueryTextBytes)
}

// A time series judged by the cadence fallback names its basis in text, so a reader does not take
// the limit for an option the author set.
func TestDashboardSampleTextNamesTheCadenceBasis(t *testing.T) {
	fixture := `{"schemaVersion":1,"dashboard":{"id":"trend"},"widgets":[{"id":"trend","title":"Trend","type":"timeseries","unit":"req/s","signalId":"q1","sample":{"state":"stale","basis":"cadence","staleAfterSeconds":120,"lastTimestamp":180000,"ageSeconds":3420}}],"signals":[{"id":"q1","state":"ok"}],"state":"ok","attention":{"basis":"b","widgets":1,"checked":1,"critical":0,"warning":0,"failed":0,"stale":1}}`
	text, err := dashboardQueryText(json.RawMessage(fixture))
	require.NoError(t, err)
	require.Contains(t, text, `widget "trend": returned sample freshness=stale (threshold 120s, twice the longest cadence, age 3420s); relative to range end, not scrape health`)
}

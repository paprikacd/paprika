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
	`{"id":"burn","title":"Burn rate","type":"timeseries","unit":"x","signalId":"q1","attention":"critical","freshness":{"state":"no_threshold","lastTimestamp":1000,"ageSeconds":30},` +
	`"breaches":{"seriesEvaluated":2,"seriesOmitted":0,"intervalsOmitted":4,"intervals":[{"series":0,"level":"warning","start":1000,"end":2000,"durationMs":1000},{"series":1,"level":"critical","start":3000,"end":3000,"durationMs":0}],"summary":[{"level":"critical","intervals":0,"samples":1,"durationMs":0},{"level":"warning","intervals":1,"samples":0,"durationMs":1000}]}},` +
	`{"id":"grid","title":"Services","type":"plugin","pluginId":"status-grid","unit":"","signalId":"q1","threshold":{"state":"matched","boundary":2,"status":"warning","label":"Degraded","series":3}},` +
	`{"id":"boom","title":"Boom","type":"stat","unit":"","signalId":"q2","attention":"failed","error":{"code":"provider_error","message":"failed"}},` +
	`{"id":"cold","title":"Cold","type":"stat","unit":"","signalId":"q1","attention":"stale","freshness":{"state":"stale","thresholdSeconds":300,"lastTimestamp":1000,"ageSeconds":900}}` +
	`],"savedQueries":[],"signals":[` +
	`{"id":"q1","kind":"metrics","state":"ok","primarySeries":0,"series":[{"index":0,"samples":2,"valid":2,"missing":0,"last":{"timestamp":3000,"value":3}}]},` +
	`{"id":"q2","kind":"metrics","state":"error","error":{"code":"provider_error","message":"failed"}}],"queryCount":{"planned":2,"executed":2,"deduplicated":0},"state":"partial"}`

func TestDashboardAttentionLeadsTheTextAndCountsDeclaredStatusesOnly(t *testing.T) {
	text, err := dashboardQueryText(json.RawMessage(dashboardAttentionFixture))
	require.NoError(t, err)
	lines := strings.Split(text, "\n")
	require.Equal(t, "Attention: 1 critical, 1 failed, 1 stale; 2 of 4 widgets checked. Declared statuses, failures and staleness only; not a health verdict.", lines[0])
	require.Equal(t, `Attention widgets: "burn" critical; "boom" failed; "cold" stale`, lines[1])
	require.Contains(t, text, `Dashboard "reliability": partial.`)
	require.Contains(t, text, `widget "burn" breaches in window: "critical": intervals=0, merged=0 ms, samples=1; "warning": intervals=1, merged=1000 ms, samples=0; [series 0 "warning" 1000-2000 ms] [series 1 "critical" 3000-3000 ms] (4 more intervals in structuredContent)`)
	require.Contains(t, text, `widget "grid": configured visual band="matched"; boundary=2; status="warning"; label="Degraded"; series=3`)
	require.Contains(t, text, `widget "cold": returned sample freshness=stale (threshold 300s, age 900s)`)
	require.NotContains(t, text, `widget "burn": returned sample freshness`, "an unjudged age is not described in text")
	require.LessOrEqual(t, len(text), dashboardQueryTextBytes)
}

func TestDashboardAttentionTextStatesNothingDeclaredAndKeepsWidgetListBounded(t *testing.T) {
	healthy := `{"schemaVersion":1,"dashboard":{"id":"quiet"},"widgets":[{"id":"a","title":"A","type":"stat","signalId":"q1"}],"signals":[{"id":"q1","state":"ok"}],"state":"ok","attention":{"basis":"b","widgets":1,"checked":1,"critical":0,"warning":0,"failed":0,"stale":0}}`
	text, err := dashboardQueryText(json.RawMessage(healthy))
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(text, "Attention: none declared; 1 of 1 widgets checked. Declared statuses, failures and staleness only; not a health verdict.\n"), text)
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

func TestDashboardAttentionOutputValidatesAgainstTheSchema(t *testing.T) {
	var schema jsonschema.Schema
	require.NoError(t, json.Unmarshal([]byte(dashboardQueryOutputSchema), &schema))
	resolved, err := schema.Resolve(nil)
	require.NoError(t, err)
	var document any
	require.NoError(t, json.Unmarshal([]byte(dashboardAttentionFixture), &document))
	require.NoError(t, resolved.Validate(document))

	// The attention summary is exact: its counts are required and nothing else is accepted.
	widgets := requireDashboardTextSlice(t, requireDashboardTextMap(t, document)["widgets"])
	breaches := requireDashboardTextMap(t, requireDashboardTextMap(t, widgets[0])["breaches"])
	breaches["extra"] = true
	require.Error(t, resolved.Validate(document), "breaches must not accept undeclared fields")
	delete(breaches, "extra")
	requireDashboardTextMap(t, widgets[0])["freshness"] = map[string]any{"state": "healthy"}
	require.Error(t, resolved.Validate(document), "freshness states are the published ones")
	requireDashboardTextMap(t, widgets[0])["freshness"] = map[string]any{"state": "no_threshold"}
	require.NoError(t, resolved.Validate(document))
	delete(requireDashboardTextMap(t, document), "attention")
	require.Error(t, resolved.Validate(document), "every query_dashboard result carries its attention summary")
}

// dashboard_query_wire.json is structured output captured from the insights runtime for a document with
// declared bands, breaches, unjudged and judged freshness, and failures. It guards the real wire shape.
func TestDashboardQueryRuntimeOutputValidatesAndDescribesAttention(t *testing.T) {
	raw, err := os.ReadFile("testdata/dashboard_query_wire.json")
	require.NoError(t, err)
	var schema jsonschema.Schema
	require.NoError(t, json.Unmarshal([]byte(dashboardQueryOutputSchema), &schema))
	resolved, err := schema.Resolve(nil)
	require.NoError(t, err)
	var document any
	require.NoError(t, json.Unmarshal(raw, &document))
	require.NoError(t, resolved.Validate(document))
	text, err := dashboardQueryText(raw)
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(text, "Attention: 2 critical, 1 failed, 1 stale; 3 of 4 widgets checked."), text)
	require.Contains(t, text, `widget "gauge": configured visual band="matched"; boundary=4; status="critical"; label="Down"; series=0`)
	require.LessOrEqual(t, len(text), dashboardQueryTextBytes)
}

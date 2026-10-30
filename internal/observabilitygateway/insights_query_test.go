package observabilitygateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"
	"github.com/google/jsonschema-go/jsonschema"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"

	apiserver "github.com/benebsworth/paprika/internal/api"
	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
)

const dashboardQueryFixture = `{"schemaVersion":1,"dashboard":{"id":"service-overview","title":"Service overview","etag":"v1"},"observedAt":"2026-10-26T10:00:00Z","range":{"start":"2026-10-26T09:00:00Z","end":"2026-10-26T10:00:00Z","stepSeconds":12},"variables":{"service":"api"},"widgets":[{"id":"rate","title":"Request rate","type":"stat","unit":"req/s","signalId":"s1"},{"id":"trace","title":"Matching traces","type":"traces","unit":"ms","signalId":"s2"}],"savedQueries":[{"id":"requests","etag":"q1"}],"signals":[{"id":"s1","state":"ok","primarySeries":0,"series":[{"index":0,"samples":300,"valid":299,"missing":1,"last":{"timestamp":1793008800000,"value":1.234567890123}}]},{"id":"s2","state":"partial","traces":{"returned":100,"statusCounts":{"unknown":100},"examples":[],"examplesTruncated":true}}],"queryCount":{"planned":2,"executed":2,"deduplicated":0},"state":"partial"}`

func TestDashboardQueryCompactTextIncludesSampleMeans(t *testing.T) {
	fixture := `{"schemaVersion":1,"dashboard":{"id":"test"},"widgets":[{"id":"rate","title":"Rate","type":"timeseries","unit":"req/s","signalId":"s1"}],"signals":[{"id":"s1","state":"ok","primarySeries":0,"series":[{"index":0,"name":"api","mean":0,"last":{"timestamp":1000,"value":2}},{"index":1,"name":"worker","mean":4.25,"last":{"timestamp":1000,"value":6}}]}]}`
	text, err := dashboardQueryText(json.RawMessage(fixture))
	require.NoError(t, err)
	require.Contains(t, text, `latest valid=2 "req/s" at 1000 ms; sample mean=0 "req/s"`)
	require.Contains(t, text, `name="worker"; last valid=6 "req/s" at 1000 ms; sample mean=4.25 "req/s"`)
	var schema map[string]any
	require.NoError(t, json.Unmarshal([]byte(dashboardQueryOutputSchema), &schema))
	defs := schema["$defs"].(map[string]any)
	series := defs["series"].(map[string]any)
	mean := series["properties"].(map[string]any)["mean"].(map[string]any)
	require.Contains(t, mean["description"], "not time weighted")
}

func TestDashboardTraceTextIncludesBoundedSampleDetails(t *testing.T) {
	fixture := `{"schemaVersion":1,"dashboard":{"id":"demo"},"widgets":[{"id":"trace","title":"Traces","type":"traces","signalId":"q1"}],"signals":[{"id":"q1","state":"ok","traces":{"returned":9,"statusCounts":{"error":2,"ok":7},"examplesTruncated":true,"examples":[{"traceId":"abc123","service":"checkout","operation":"POST /order","durationMs":42.5,"startTime":1793008800000,"status":"error"},{"traceId":"def456","service":"worker","status":"unknown","invalidFields":true}]}}]}`
	text, err := dashboardQueryText(json.RawMessage(fixture))
	require.NoError(t, err)
	require.Contains(t, text, `returned traces=9 (bounded sample); trace preview truncated`)
	require.Contains(t, text, `sample status counts: "error"=2 "ok"=7`)
	require.Contains(t, text, `trace="abc123" service="checkout" operation="POST /order" status="error" duration=42.5 ms start=1793008800000 ms`)
	require.Contains(t, text, `trace="def456" service="worker" status="unknown"; invalid fields`)
	require.NotContains(t, text, `duration=0`, "missing fields must not be invented")
	require.LessOrEqual(t, len(text), dashboardQueryTextBytes)
}

func TestDashboardTraceTextBoundsUntrustedDetails(t *testing.T) {
	examples := make([]map[string]any, 10)
	for index := range examples {
		examples[index] = map[string]any{"traceId": fmt.Sprintf("trace-%d", index), "service": strings.Repeat("\\\"", 160), "operation": strings.Repeat("<span>\n", 100), "status": "ok", "durationMs": 0}
	}
	fixture := map[string]any{"schemaVersion": 1, "dashboard": map[string]any{"id": "demo"}, "widgets": []any{map[string]any{"id": "trace", "title": "Traces", "signalId": "q1"}}, "signals": []any{map[string]any{"id": "q1", "state": "ok", "traces": map[string]any{"returned": 10, "statusCounts": map[string]int{"ok": 10}, "examples": examples}}}}
	raw, err := json.Marshal(fixture)
	require.NoError(t, err)
	text, err := dashboardQueryText(raw)
	require.NoError(t, err)
	require.Contains(t, text, "trace examples omitted; see structuredContent")
	require.LessOrEqual(t, len(text), dashboardQueryTextBytes)
	require.True(t, utf8.ValidString(text))
}

const dashboardRecordsQueryFixture = `{"schemaVersion":1,"dashboard":{"id":"service-records","title":"Service records","etag":"v1"},"observedAt":"2026-10-26T10:00:00Z","range":{"start":"2026-10-26T09:00:00Z","end":"2026-10-26T10:00:00Z","stepSeconds":12},"variables":{},"widgets":[{"id":"services","title":"Service records","type":"plugin","unit":"","signalId":"q1"}],"savedQueries":[],"signals":[{"id":"q1","state":"ok","truncated":true,"providerTruncated":true,"records":{"returned":7,"columns":[{"key":"service","type":"string"},{"key":"requests","label":"Requests","type":"number","unit":"req/s"},{"key":"active","type":"boolean"}],"rows":[["api",0,false],["worker",null,true]],"rowsTruncated":true,"columnsOmitted":1,"metadataTruncated":true}}],"queryCount":{"planned":1,"executed":1,"deduplicated":0},"state":"ok"}`

func TestDashboardQueryCompactTextIncludesSnapshotContext(t *testing.T) {
	text, err := dashboardQueryText(json.RawMessage(dashboardQueryFixture))
	require.NoError(t, err)
	require.Contains(t, text, `Range "2026-10-26T09:00:00Z" to "2026-10-26T10:00:00Z"; step=12s; observed at "2026-10-26T10:00:00Z"; dashboard ETag="v1"`)
	require.Contains(t, text, `Selected variables: "service"="api"`)
	text, err = dashboardQueryText(json.RawMessage(dashboardRecordsQueryFixture))
	require.NoError(t, err)
	require.Contains(t, text, "Selected variables: none")
}

func TestDashboardQueryProvenanceSchemaAndCompactText(t *testing.T) {
	var fixture map[string]any
	require.NoError(t, json.Unmarshal([]byte(dashboardQueryFixture), &fixture))
	widgets := fixture["widgets"].([]any)
	widgets[0].(map[string]any)["savedQueryId"] = "requests"
	widgets[0].(map[string]any)["annotationSavedQueryId"] = "events"
	signals := fixture["signals"].([]any)
	signals[0].(map[string]any)["kind"] = "metrics"
	signals[0].(map[string]any)["providerId"] = "prometheus"
	signals[1].(map[string]any)["kind"] = "traces"
	encoded, err := json.Marshal(fixture)
	require.NoError(t, err)
	text, err := dashboardQueryText(encoded)
	require.NoError(t, err)
	require.Contains(t, text, `kind="metrics"; provider="prometheus"`)
	require.Contains(t, text, `kind="traces"`)
	var schema jsonschema.Schema
	require.NoError(t, json.Unmarshal(insightsQueryDashboardTool(nil).OutputSchema, &schema))
	resolved, err := schema.Resolve(nil)
	require.NoError(t, err)
	require.NoError(t, resolved.Validate(fixture))
	signals[0].(map[string]any)["kind"] = "unknown"
	require.Error(t, resolved.Validate(fixture), "Provenance must use an explicit normalized query kind")
}

func TestDashboardQueryCompactTextAndSchemaDescribeStatVisualThreshold(t *testing.T) {
	var fixture map[string]any
	require.NoError(t, json.Unmarshal([]byte(dashboardQueryFixture), &fixture))
	widgets := fixture["widgets"].([]any)
	widgets[0].(map[string]any)["threshold"] = map[string]any{"state": "matched", "boundary": 0, "color": "#ff0000", "label": "High"}
	widgets[1].(map[string]any)["threshold"] = map[string]any{"state": "unknown"}
	encoded, err := json.Marshal(fixture)
	require.NoError(t, err)
	text, err := dashboardQueryText(encoded)
	require.NoError(t, err)
	require.Contains(t, text, `widget "rate": configured visual band="matched"; boundary=0; color="#ff0000"; label="High"`)
	require.Contains(t, text, `widget "trace": configured visual band="unknown"`)
	var schema jsonschema.Schema
	require.NoError(t, json.Unmarshal(insightsQueryDashboardTool(nil).OutputSchema, &schema))
	resolved, err := schema.Resolve(nil)
	require.NoError(t, err)
	require.NoError(t, resolved.Validate(fixture))
	widgets[0].(map[string]any)["threshold"] = map[string]any{"state": "matched", "color": "#ff0000"}
	require.Error(t, resolved.Validate(fixture), "a matched band requires its boundary")
	widgets[0].(map[string]any)["threshold"] = map[string]any{"state": "unknown", "boundary": 0}
	require.Error(t, resolved.Validate(fixture), "an unknown band cannot claim a boundary")
}

func TestDashboardThresholdTextIsBounded(t *testing.T) {
	widgets := make([]dashboardTextWidget, 48)
	for i := range widgets {
		widgets[i].ID = strings.Repeat("🫑", 40)
		var entry dashboardTextWidget
		require.NoError(t, json.Unmarshal([]byte(`{"threshold":{"state":"matched","boundary":0,"color":"#ff0000","label":"`+strings.Repeat("a", 80)+`"}}`), &entry))
		widgets[i].Threshold = entry.Threshold
	}
	var out strings.Builder
	appendDashboardThresholdsText(&out, widgets)
	require.Less(t, out.Len(), 1200)
	require.True(t, utf8.ValidString(out.String()))
	require.Contains(t, out.String(), "visual bands omitted; see structuredContent")
}

func TestDashboardQueryCompactVariableContextIsBoundedAndDeterministic(t *testing.T) {
	variables := make(map[string]string)
	for i := range 20 {
		variables[fmt.Sprintf("variable%02d", i)] = strings.Repeat("🫑\n", 200)
	}
	var first, second strings.Builder
	appendDashboardVariablesText(&first, variables)
	appendDashboardVariablesText(&second, variables)
	require.Equal(t, first.String(), second.String())
	require.Less(t, first.Len(), 1150)
	require.True(t, utf8.ValidString(first.String()))
	require.Contains(t, first.String(), `\n`, "variable values remain quoted and escaped")
	require.Contains(t, first.String(), "variables omitted; see structuredContent")
	require.Less(t, strings.Index(first.String(), `"variable00"`), strings.Index(first.String(), `"variable01"`))
}

func TestDashboardQueryRecordsContractAndCompactText(t *testing.T) {
	c, calls := newDashboardQueryClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, dashboardRecordsQueryFixture)
	}))
	tool := insightsQueryDashboardTool(c)
	require.Contains(t, string(tool.OutputSchema), "State can still be ok when a bounded query succeeded", "MCP discovery must explain provider truncation independently from query success")
	require.Contains(t, string(tool.OutputSchema), "distinct from providerTruncated", "MCP discovery must distinguish compact series limits from provider limits")
	require.Contains(t, string(tool.OutputSchema), "Latest recorded timestamp, including missing values, in Unix milliseconds", "MCP discovery must explain missing-tail timestamps")
	require.Contains(t, string(tool.OutputSchema), "last refers to an earlier valid observation", "MCP discovery must not imply the last valid point is the latest observation")
	principal := &auth.Principal{Subject: "human", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"}}
	result, err := tool.Invoke(auth.WithPrincipal(t.Context(), principal), nil, json.RawMessage(`{"id":"service-records"}`))
	require.NoError(t, err)
	wire, ok := result.(*sdkmcp.CallToolResult)
	require.True(t, ok)
	structured, ok := wire.StructuredContent.(json.RawMessage)
	require.True(t, ok)
	require.JSONEq(t, dashboardRecordsQueryFixture, string(structured), "null, zero and false must survive in the authoritative record tuples")
	require.Equal(t, int32(1), calls.Load())
	content, ok := wire.Content[0].(*sdkmcp.TextContent)
	require.True(t, ok)
	require.Contains(t, content.Text, "returned records=7 (bounded page)")
	require.Contains(t, content.Text, "record preview truncated; omitted columns=1; partial source response")
	require.Contains(t, content.Text, `first record (3/4 columns): "service"="api", "requests"=0, "active"=false`)
	require.NotContains(t, content.Text, "worker", "later record rows belong only in structuredContent")
	require.LessOrEqual(t, len(content.Text), dashboardQueryTextBytes)

	var schema jsonschema.Schema
	require.NoError(t, json.Unmarshal(tool.OutputSchema, &schema))
	resolved, err := schema.Resolve(nil)
	require.NoError(t, err)
	var document any
	require.NoError(t, json.Unmarshal(structured, &document))
	require.NoError(t, resolved.Validate(document))
	for _, invalid := range []string{
		strings.Replace(dashboardRecordsQueryFixture, `"returned":7`, `"returned":-1`, 1),
		strings.Replace(dashboardRecordsQueryFixture, `"type":"number"`, `"type":"json"`, 1),
		strings.Replace(dashboardRecordsQueryFixture, `["api",0,false]`, `["api",{"opaque":"object"},false]`, 1),
		strings.Replace(dashboardRecordsQueryFixture, `"rowsTruncated":true`, `"rowsTruncated":"yes"`, 1),
	} {
		require.NoError(t, json.Unmarshal([]byte(invalid), &document))
		require.Error(t, resolved.Validate(document), "records must be an explicit validated output contract")
	}
}

func TestDashboardQueryCompactTextReportsWidgetAndSignalErrors(t *testing.T) {
	fixture := `{"schemaVersion":1,"dashboard":{"id":"example"},"widgets":[{"id":"broken","title":"Missing query","error":{"code":"missing_saved_query","message":"The referenced saved query is unavailable."}},{"id":"events","title":"Events","signalId":"s1","annotationError":{"code":"invalid_bindings","message":"Saved query bindings are invalid."}}],"signals":[{"id":"s1","state":"error","error":{"code":"invalid_query","message":"The provider rejected the resolved query."}}],"state":"partial"}`
	text, err := dashboardQueryText(json.RawMessage(fixture))
	require.NoError(t, err)
	require.Contains(t, text, `widget "broken" "Missing query": error "missing_saved_query": "The referenced saved query is unavailable."`)
	require.Contains(t, text, `widget "events" "Events" events: error "invalid_bindings": "Saved query bindings are invalid."`)
	require.Contains(t, text, `s1 "Events": error; error "invalid_query": "The provider rejected the resolved query."`)
}

func TestDashboardQueryCompactTextDescribesEveryIncludedMetricSeries(t *testing.T) {
	fixture := `{"schemaVersion":1,"dashboard":{"id":"example"},"widgets":[{"id":"rates","title":"Rates","type":"timeseries","unit":"req/s","signalId":"q1"}],"signals":[{"id":"q1","state":"ok","primarySeries":0,"series":[{"index":0,"name":"checkout","labels":{"service":"checkout"},"last":{"timestamp":1700000000000,"value":0}},{"index":1,"name":"worker","labels":{"service":"worker"},"last":{"timestamp":1700000001000,"value":12.5},"tailMissing":true},{"index":2,"name":"catalog","labels":{"service":"catalog"}}]}],"state":"ok"}`
	text, err := dashboardQueryText(json.RawMessage(fixture))
	require.NoError(t, err)
	require.Contains(t, text, `[#0 name="checkout" "service"="checkout"; last valid=0 "req/s" at 1700000000000 ms]`)
	require.Contains(t, text, `[#1 name="worker" "service"="worker"; last valid=12.5 "req/s" at 1700000001000 ms; latest observation missing]`)
	require.Contains(t, text, `[#2 name="catalog" "service"="catalog"; no valid observation]`)
}

func TestDashboardQueryMetricSeriesTextIsBoundedAndDeterministic(t *testing.T) {
	last := &dashboardTextSample{Timestamp: 1700000000000, Value: 42}
	entries := make([]dashboardTextSeries, 8)
	for i := range entries {
		entries[i] = dashboardTextSeries{Index: i, Name: strings.Repeat("🫑\n", 100), Last: last, Labels: map[string]string{"z": strings.Repeat("z", 200), "a": strings.Repeat("a", 200), "b": "b", "c": "c"}}
	}
	signal := &dashboardTextSignal{ID: "q1", State: "ok", Series: entries}
	first := dashboardSignalText(signal, nil)
	require.Equal(t, first, dashboardSignalText(signal, nil), "map iteration must not reorder labels")
	require.Less(t, len(first), 1400)
	require.True(t, utf8.ValidString(first))
	require.Contains(t, first, `\n`, "untrusted labels must remain quoted")
	require.Contains(t, first, "+1 labels")
	require.Contains(t, first, "series details omitted; see structuredContent")
}

func TestDashboardQueryMetricSeriesTextAvoidsRepeatingCanonicalNames(t *testing.T) {
	series := []dashboardTextSeries{
		{Index: 0, Name: `requests{cluster="omega", service="checkout"}`, Labels: map[string]string{"__name__": "requests", "cluster": "omega", "service": "checkout"}},
		{Index: 1, Name: "Authored alias", Labels: map[string]string{"service": "worker"}},
	}
	var line strings.Builder
	appendDashboardSeriesText(&line, series, "")
	require.NotContains(t, line.String(), `name="requests`)
	require.Contains(t, line.String(), `"service"="checkout"`)
	require.Contains(t, line.String(), `name="Authored alias"`)
}

func TestDashboardQueryTextDistinguishesIncompleteEmptySource(t *testing.T) {
	fixture := `{"schemaVersion":1,"dashboard":{"id":"example"},"widgets":[{"id":"limited","title":"Limited","signalId":"q1"},{"id":"empty","title":"Empty","signalId":"q2"}],"signals":[{"id":"q1","state":"partial","providerTruncated":true,"truncated":true},{"id":"q2","state":"empty"}],"state":"partial"}`
	text, err := dashboardQueryText(json.RawMessage(fixture))
	require.NoError(t, err)
	require.Contains(t, text, `q1 "Limited": partial; partial source response`)
	require.Contains(t, text, `q2 "Empty": empty`)
	require.NotContains(t, text, `q1 "Limited": empty`)
	require.Contains(t, dashboardQueryOutputSchema, "source-limited response without usable observations is partial")
}

func TestDashboardQueryCompactTextReportsReturnedSampleFreshness(t *testing.T) {
	fixture := `{"schemaVersion":1,"dashboard":{"id":"example"},"widgets":[{"id":"old","title":"Old","freshness":{"thresholdSeconds":300,"state":"stale","ageSeconds":600,"lastTimestamp":1000}},{"id":"empty","title":"Empty","freshness":{"thresholdSeconds":60,"state":"unknown"}}],"signals":[],"state":"ok"}`
	text, err := dashboardQueryText(json.RawMessage(fixture))
	require.NoError(t, err)
	require.Contains(t, text, `widget "old": returned sample freshness=stale (threshold 300s, age 600s); relative to range end, not scrape health`)
	require.Contains(t, text, `widget "empty": returned sample freshness=unknown (threshold 60s); relative to range end, not scrape health`)
	var schema jsonschema.Schema
	require.NoError(t, json.Unmarshal(json.RawMessage(dashboardQueryOutputSchema), &schema))
	_, err = schema.Resolve(nil)
	require.NoError(t, err)
}

func TestDashboardQueryCompactTextBoundsAndQuotesWidgetErrors(t *testing.T) {
	var body map[string]any
	require.NoError(t, json.Unmarshal([]byte(dashboardQueryFixture), &body))
	widgets := make([]any, 0, 48)
	for i := range 48 {
		widgets = append(widgets, map[string]any{"id": fmt.Sprintf("w%d", i), "title": strings.Repeat("🫑\n", 100), "error": map[string]any{"code": "invalid_query", "message": strings.Repeat("bad\n", 200)}})
	}
	body["widgets"] = widgets
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	text, err := dashboardQueryText(raw)
	require.NoError(t, err)
	require.LessOrEqual(t, len(text), dashboardQueryTextBytes)
	require.Contains(t, text, `bad\n`)
	require.Contains(t, text, "More widget errors and signals are available in structuredContent.")
	require.True(t, utf8.ValidString(text))
}

func TestDashboardQueryAnnotationSignalContract(t *testing.T) {
	fixture := strings.Replace(dashboardRecordsQueryFixture, `"type":"plugin"`, `"type":"plugin","pluginId":"record-table","dataKind":"records"`, 1)
	fixture = strings.Replace(fixture, `"signalId":"q1"`, `"signalId":"q1","annotationSignalId":"q1","annotationColumns":{"timestamp":"date","end":"ended_at","label":"label","severity":"status"}`, 1)
	c, _ := newDashboardQueryClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, fixture) }))
	tool := insightsQueryDashboardTool(c)
	principal := &auth.Principal{Subject: "human", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"}}
	result, err := tool.Invoke(auth.WithPrincipal(t.Context(), principal), nil, json.RawMessage(`{"id":"service-records"}`))
	require.NoError(t, err)
	wire := result.(*sdkmcp.CallToolResult)
	structured := wire.StructuredContent.(json.RawMessage)
	var schema jsonschema.Schema
	require.NoError(t, json.Unmarshal(tool.OutputSchema, &schema))
	resolved, err := schema.Resolve(nil)
	require.NoError(t, err)
	var document any
	require.NoError(t, json.Unmarshal(structured, &document))
	require.NoError(t, resolved.Validate(document))
	require.Contains(t, string(structured), `"annotationSignalId":"q1"`)
	require.Contains(t, string(structured), `"annotationColumns"`)
	require.Contains(t, string(structured), `"pluginId":"record-table"`)
	require.Contains(t, string(structured), `"dataKind":"records"`)
	require.Contains(t, string(tool.OutputSchema), `"end":{"type":"string"`, "Interval annotations must be discoverable")
	var invalid any
	require.NoError(t, json.Unmarshal([]byte(strings.Replace(fixture, `"dataKind":"records"`, `"dataKind":"logs"`, 1)), &invalid))
	require.Error(t, resolved.Validate(invalid), "Discovery must constrain plugin input kinds")
}

func TestDashboardQueryCompactTextNamesFirstVisualizationAndSharedWidgets(t *testing.T) {
	fixture := `{"schemaVersion":1,"dashboard":{"id":"signals"},"state":"ok","widgets":[{"id":"gauge","title":"CPU","type":"plugin","pluginId":"threshold-gauge","signalId":"q1"},{"id":"history","title":"CPU history","type":"plugin","pluginId":"status-history","signalId":"q1"},{"id":"trace","title":"Traces","type":"traces","signalId":"q2"}],"signals":[{"id":"q1","state":"ok"},{"id":"q2","state":"empty"}]}`
	text, err := dashboardQueryText(json.RawMessage(fixture))
	require.NoError(t, err)
	require.Contains(t, text, `q1 "CPU": ok; first view="threshold-gauge"; shared widgets=2`)
	require.Contains(t, text, `q2 "Traces": empty; first view="traces"`)
	require.NotContains(t, text, `first view="status-history"`, "The title and view refer to the same first widget")
}

func TestDashboardQueryEmptyAndCompleteRecordText(t *testing.T) {
	for _, count := range []int{0, 2} {
		text := dashboardSignalText(&dashboardTextSignal{ID: "q1", State: "empty", Records: &dashboardTextRecords{Returned: count}}, nil)
		require.Contains(t, text, fmt.Sprintf("returned records=%d (bounded page)", count))
		require.NotContains(t, text, "truncated")
		require.NotContains(t, text, "partial source")
	}
}

func TestDashboardQueryCompactTextDistinguishesMissingTailAndTruncation(t *testing.T) {
	fixture := `{"schemaVersion":1,"dashboard":{"id":"signals"},"state":"ok","widgets":[{"id":"metric","title":"Metric","unit":"req/s","signalId":"s1"},{"id":"trace","title":"Trace","unit":"","signalId":"s2"}],"signals":[{"id":"s1","state":"ok","primarySeries":0,"truncated":true,"providerTruncated":true,"seriesTruncated":true,"series":[{"index":0,"last":{"timestamp":1793008740000,"value":0},"lastAt":1793008800000,"tailMissing":true}]},{"id":"s2","state":"ok","truncated":true,"providerTruncated":true,"traces":{"returned":100,"examplesTruncated":true}}]}`
	text, err := dashboardQueryText(json.RawMessage(fixture))
	require.NoError(t, err)
	require.Contains(t, text, `latest valid=0 "req/s" at 1793008740000 ms; latest observation missing`)
	require.Contains(t, text, `series preview truncated; partial source response`)
	require.Contains(t, text, `returned traces=100 (bounded sample); trace preview truncated; partial source response`)
	require.NotContains(t, text, "latest=0", "A missing tail must not be described as a current value")
}

func TestDashboardQueryCompactTextDisclosesDuplicateObservations(t *testing.T) {
	fixture := `{"schemaVersion":1,"dashboard":{"id":"signals"},"state":"ok","widgets":[{"id":"metric","title":"Metric","unit":"req/s","signalId":"s1"}],"signals":[{"id":"s1","state":"ok","primarySeries":0,"series":[{"index":0,"last":{"timestamp":1793008740000,"value":0},"duplicateObservations":2}]}]}`
	text, err := dashboardQueryText(json.RawMessage(fixture))
	require.NoError(t, err)
	require.Contains(t, text, "duplicate timestamp observations=2 in summarized series (additional samples; some charts require aggregation)")
	var schema map[string]any
	require.NoError(t, json.Unmarshal([]byte(dashboardQueryOutputSchema), &schema))
	defs := schema["$defs"].(map[string]any)
	series := defs["series"].(map[string]any)
	property := series["properties"].(map[string]any)["duplicateObservations"].(map[string]any)
	require.Contains(t, property["description"], "Some visualizations reject duplicate timestamps")
}

func TestDashboardQueryCompactTextDisclosesHistoryOnlyTruncation(t *testing.T) {
	fixture := `{"schemaVersion":1,"dashboard":{"id":"signals"},"state":"ok","widgets":[{"id":"metric","title":"Metric","unit":"","signalId":"s1"}],"signals":[{"id":"s1","state":"ok","primarySeries":0,"truncated":true,"series":[{"index":0,"last":{"timestamp":1000,"value":3},"historyTruncated":true}]}]}`
	text, err := dashboardQueryText(json.RawMessage(fixture))
	require.NoError(t, err)
	require.Contains(t, text, "bounded signal truncated")
	require.NotContains(t, text, "partial source response", "A compact-history limit is not a provider limit")
	// A mixed result can also have an intact records preview; it must not hide
	// truncation in its metric history.
	fixture = strings.Replace(fixture, `"state":"ok","primarySeries"`, `"state":"ok","records":{"returned":0,"columns":[],"rows":[]},"primarySeries"`, 1)
	text, err = dashboardQueryText(json.RawMessage(fixture))
	require.NoError(t, err)
	require.Contains(t, text, "bounded signal truncated")
}

func TestDashboardQueryRecordTextBoundsAndScalarHonesty(t *testing.T) {
	for _, tc := range []struct {
		raw, want string
	}{
		{`null`, "null"}, {`0`, "0"}, {`false`, "false"},
		{`1.23456789012345`, "1.23456789012345"}, {`"line\nnext"`, `"line\nnext"`},
		{`{"opaque":"not-a-cell"}`, "[unavailable]"},
	} {
		require.Equal(t, tc.want, dashboardRecordScalarText(json.RawMessage(tc.raw)))
	}
	longCell, err := json.Marshal(strings.Repeat("🫑\n", 200))
	require.NoError(t, err)
	formatted := dashboardRecordScalarText(longCell)
	require.True(t, utf8.ValidString(formatted))
	require.Less(t, len(formatted), 180)
	require.NotContains(t, formatted, "\n")
	require.Contains(t, formatted, `\n`)
	var records dashboardTextRecords
	require.NoError(t, json.Unmarshal([]byte(`{"returned":1,"columns":[{"key":"a"},{"key":"b"},{"key":"c"},{"key":"hidden"}],"rows":[[null,0,false,"omit-me"]]}`), &records))
	var preview strings.Builder
	appendDashboardRecordPreview(&preview, &records)
	require.Contains(t, preview.String(), `first record (3/4 columns): "a"=null, "b"=0, "c"=false`)
	require.NotContains(t, preview.String(), "omit-me")
}

func newDashboardQueryClient(t *testing.T, responder http.Handler) (*InsightsAuthoringClient, *atomic.Int32) {
	t.Helper()
	secret := []byte(rand.Text())
	serviceToken := rand.Text() + rand.Text()
	calls := &atomic.Int32{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		require.Equal(t, http.MethodPost, r.Method)
		require.Equal(t, "/api/query-dashboard", r.URL.Path)
		require.Equal(t, "Bearer "+serviceToken, r.Header.Get("Authorization"))
		require.Empty(t, r.Header.Get("Cookie"))
		responder.ServeHTTP(w, r)
	}))
	t.Cleanup(upstream.Close)
	cfg := auth.Config{Enabled: true, TokenSecret: secret, RBACRules: []auth.RBACRule{{Subjects: []string{"group:readers"}, Actions: []string{"read"}, Resources: []string{"insights"}, Namespaces: []string{"*"}}}}
	proxy, err := apiserver.NewInsightsProxy(t.Context(), cfg, upstream.URL, serviceToken)
	require.NoError(t, err)
	client, err := NewInsightsAuthoringClient(proxy, secret, "https://paprika.example.test", nil)
	require.NoError(t, err)
	return client, calls
}

func TestDashboardQueryUsesObserveReadAndHumanInsightsRead(t *testing.T) {
	c, calls := newDashboardQueryClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.JSONEq(t, `{"id":"service-overview","variables":{"service":"api"}}`, string(body))
		_, _ = io.WriteString(w, dashboardQueryFixture)
	}))
	registry := mcp.NewRegistry()
	require.NoError(t, RegisterInsightsTools(registry, c, nil))
	tool, found := registry.Lookup("query_dashboard")
	require.True(t, found)
	require.Equal(t, mcp.ScopeObserve, tool.Scope)
	require.False(t, tool.Destructive)
	var output map[string]any
	require.NoError(t, json.Unmarshal(tool.OutputSchema, &output))
	require.Contains(t, output["required"], "signals")
	invoker := mcp.NewInvoker(registry, nil, nil, nil)
	for _, tc := range []struct {
		name   string
		groups []string
		scopes []string
		code   connect.Code
		denied bool
	}{
		{name: "observe read with no authoring consent", groups: []string{"readers"}, scopes: []string{"paprika:observe"}},
		{name: "empty groups stay empty", groups: []string{}, scopes: []string{"paprika:observe"}, code: connect.CodePermissionDenied},
		{name: "wrong human group", groups: []string{"editors"}, scopes: []string{"paprika:observe", "paprika:insights:write"}, code: connect.CodePermissionDenied},
		{name: "write does not imply observe", groups: []string{"readers"}, scopes: []string{"paprika:insights:write"}, denied: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := calls.Load()
			p := &auth.Principal{Subject: "human", Groups: tc.groups, Scopes: tc.scopes}
			result, err := invoker.Call(auth.WithPrincipal(t.Context(), p), p, "query_dashboard", json.RawMessage(`{"id":"service-overview","variables":{"service":"api"}}`))
			if tc.denied {
				require.ErrorIs(t, err, mcp.ErrScopeDenied)
			} else if tc.code != 0 {
				require.Equal(t, tc.code, connect.CodeOf(err))
			} else {
				require.NoError(t, err)
				wire, ok := result.(*sdkmcp.CallToolResult)
				require.True(t, ok)
				require.False(t, wire.IsError, "partial telemetry is an honest result, not a tool transport error")
				structured, ok := wire.StructuredContent.(json.RawMessage)
				require.True(t, ok)
				require.JSONEq(t, dashboardQueryFixture, string(structured))
				content, ok := wire.Content[0].(*sdkmcp.TextContent)
				require.True(t, ok)
				text := content.Text
				require.Contains(t, text, "1.234567890123")
				require.Contains(t, text, "returned traces=100 (bounded sample)")
				require.NotContains(t, text, `"samples":300`)
				require.Less(t, len(text), len(dashboardQueryFixture))
				require.Equal(t, before+1, calls.Load())
				return
			}
			require.Equal(t, before, calls.Load(), "denied caller must never reach the Insights service")
		})
	}
}

func TestDashboardQueryRejectsMalformedArgumentsBeforeProxy(t *testing.T) {
	c, calls := newDashboardQueryClient(t, http.NotFoundHandler())
	tool := insightsQueryDashboardTool(c)
	p := &auth.Principal{Subject: "human", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"}}
	for _, input := range []string{"", "null", "[]", `{}`, `{"id":"../provider-configs"}`, `{"id":"demo","document":{}}`, `{"id":"demo"}{}`, `{"id":"demo","variables":{"service":4}}`, `{"id":"demo","history_points":1.5}`, strings.Repeat(" ", 32<<10) + `{}`} {
		_, err := tool.Invoke(auth.WithPrincipal(t.Context(), p), nil, json.RawMessage(input))
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), input)
	}
	require.Zero(t, calls.Load())
}

func TestDashboardQueryCapsResponseAndSanitizesFailures(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		code   connect.Code
	}{
		{"oversized summary", http.StatusOK, strings.Repeat(" ", dashboardQueryResponseBytes+1), connect.CodeResourceExhausted},
		{"upstream private failure", http.StatusBadGateway, `{"error":"secret credential detail"}`, connect.CodeUnavailable},
		{"invalid JSON", http.StatusOK, `not-json-secret`, connect.CodeInternal},
		{"wrong summary version", http.StatusOK, strings.Replace(dashboardQueryFixture, `"schemaVersion":1`, `"schemaVersion":2`, 1), connect.CodeInternal},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := newDashboardQueryClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			p := &auth.Principal{Subject: "human", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"}}
			_, err := insightsQueryDashboardTool(c).Invoke(auth.WithPrincipal(t.Context(), p), nil, json.RawMessage(`{"id":"demo"}`))
			require.Equal(t, tc.code, connect.CodeOf(err))
			require.NotContains(t, err.Error(), "secret")
		})
	}
}

func TestDashboardQueryCompactTextIncludesBoundedSeriesCounts(t *testing.T) {
	var body map[string]any
	require.NoError(t, json.Unmarshal([]byte(dashboardQueryFixture), &body))
	body["widgets"] = []any{map[string]any{"id": "metrics", "title": "Metrics", "type": "timeseries", "unit": "", "signalId": "q1"}}
	body["signals"] = []any{map[string]any{"id": "q1", "kind": "metrics", "state": "ok", "seriesReturned": 10, "seriesOmitted": 7, "providerTruncated": true}}
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	text, err := dashboardQueryText(raw)
	require.NoError(t, err)
	require.Contains(t, text, "returned series=10 (bounded response), omitted summaries=7")
	require.Contains(t, text, "partial source response")
	var schema map[string]any
	require.NoError(t, json.Unmarshal([]byte(dashboardQueryOutputSchema), &schema))
	signal := schema["properties"].(map[string]any)["signals"].(map[string]any)["items"].(map[string]any)["properties"].(map[string]any)
	require.Contains(t, signal, "seriesReturned")
	require.Contains(t, signal, "seriesOmitted")
}

func TestDashboardQueryCompactTextBoundsAndQuotesUntrustedTitles(t *testing.T) {
	var body map[string]any
	require.NoError(t, json.Unmarshal([]byte(dashboardQueryFixture), &body))
	widgets, signals := make([]any, 0, 48), make([]any, 0, 48)
	for i := range 48 {
		id := strings.Repeat("s", 78) + string(rune('a'+i))
		widgets = append(widgets, map[string]any{"id": id, "title": strings.Repeat("🫑\n", 100), "unit": "req/s", "signalId": id})
		signals = append(signals, map[string]any{"id": id, "state": "ok", "records": map[string]any{
			"returned": 1000, "rowsTruncated": true,
			"columns": []any{map[string]any{"key": "name"}, map[string]any{"key": "count"}, map[string]any{"key": "missing"}},
			"rows":    []any{[]any{strings.Repeat("🫑\n", 80), 0, nil}},
		}})
	}
	body["widgets"], body["signals"] = widgets, signals
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	text, err := dashboardQueryText(raw)
	require.NoError(t, err)
	require.LessOrEqual(t, len(text), dashboardQueryTextBytes)
	require.Contains(t, text, `\n`)
	require.Contains(t, text, "More signals are available")
	require.True(t, utf8.ValidString(text))
}

func TestDashboardQueryCancellationReachesProxy(t *testing.T) {
	entered := make(chan struct{})
	closed := make(chan struct{})
	stop := make(chan struct{})
	defer close(stop)
	c, _ := newDashboardQueryClient(t, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(entered)
		select {
		case <-r.Context().Done():
			close(closed)
		case <-stop:
		}
	}))
	p := &auth.Principal{Subject: "human", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"}}
	ctx, cancel := context.WithTimeout(auth.WithPrincipal(t.Context(), p), 3*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := insightsQueryDashboardTool(c).Invoke(ctx, nil, json.RawMessage(`{"id":"demo"}`))
		result <- err
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("dashboard query did not reach the upstream")
	}
	cancel()
	select {
	case err := <-result:
		require.Equal(t, connect.CodeCanceled, connect.CodeOf(err))
	case <-time.After(3 * time.Second):
		t.Fatal("dashboard query did not propagate cancellation")
	}
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream request did not receive cancellation")
	}
}

func TestDashboardQueryReadHelperDoesNotChangeAuthoringPermissions(t *testing.T) {
	c, calls := newDashboardQueryClient(t, http.NotFoundHandler())
	p := &auth.Principal{Subject: "human", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"}}
	_, _, err := c.request(auth.WithPrincipal(t.Context(), p), http.MethodPut, "dashboards/demo", bytes.Repeat([]byte("x"), 4), nil)
	require.Equal(t, connect.CodePermissionDenied, connect.CodeOf(err))
	require.Zero(t, calls.Load())
}

func TestDashboardQueryRequiresItsHTTPOrchestrationAdmission(t *testing.T) {
	c, calls := newDashboardQueryClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, dashboardQueryFixture)
	}))
	principal := &auth.Principal{Subject: "human", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"}}
	ctx := auth.WithPrincipal(t.Context(), principal)
	for _, tc := range []struct {
		name string
		ctx  context.Context
		deny bool
	}{
		{"direct in-process call", ctx, false},
		{"dashboard slot", WithDashboardQueryAdmission(ctx, true), false},
		{"ordinary work slot", WithDashboardQueryAdmission(ctx, false), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := calls.Load()
			_, err := insightsQueryDashboardTool(c).Invoke(tc.ctx, nil, json.RawMessage(`{"id":"demo"}`))
			if tc.deny {
				require.Equal(t, connect.CodeResourceExhausted, connect.CodeOf(err))
				require.Equal(t, before, calls.Load(), "misclassified request must never reach dashboard execution")
			} else {
				require.NoError(t, err)
				require.Equal(t, before+1, calls.Load())
			}
		})
	}
}

func TestDashboardQueryMCPWirePublishesSchemaAndAvoidsPayloadDuplication(t *testing.T) {
	c, _ := newDashboardQueryClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, dashboardQueryFixture)
	}))
	tool := insightsQueryDashboardTool(c)
	principal := &auth.Principal{Subject: "human", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"}}
	server := sdkmcp.NewServer(&sdkmcp.Implementation{Name: "observe", Version: "test"}, nil)
	server.AddTool(&sdkmcp.Tool{Name: tool.Name, InputSchema: tool.InputSchema, OutputSchema: tool.OutputSchema}, func(ctx context.Context, req *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
		result, err := tool.Invoke(auth.WithPrincipal(ctx, principal), nil, req.Params.Arguments)
		if err != nil {
			return nil, err
		}
		response, ok := result.(*sdkmcp.CallToolResult)
		if !ok {
			return nil, fmt.Errorf("unexpected dashboard result type %T", result)
		}
		return response, nil
	})
	serverTransport, clientTransport := sdkmcp.NewInMemoryTransports()
	serverSession, err := server.Connect(t.Context(), serverTransport, nil)
	require.NoError(t, err)
	defer func() { require.NoError(t, serverSession.Close()) }()
	client := sdkmcp.NewClient(&sdkmcp.Implementation{Name: "reader", Version: "test"}, nil)
	clientSession, err := client.Connect(t.Context(), clientTransport, nil)
	require.NoError(t, err)
	defer func() { require.NoError(t, clientSession.Close()) }()
	listing, err := clientSession.ListTools(t.Context(), nil)
	require.NoError(t, err)
	require.Len(t, listing.Tools, 1)
	require.NotNil(t, listing.Tools[0].OutputSchema)
	result, err := clientSession.CallTool(t.Context(), &sdkmcp.CallToolParams{Name: "query_dashboard", Arguments: map[string]any{"id": "service-overview"}})
	require.NoError(t, err)
	require.False(t, result.IsError)
	encoded, err := json.Marshal(result)
	require.NoError(t, err)
	require.Equal(t, 1, bytes.Count(encoded, []byte(`"samples":300`)), "sample summaries must occur only in structuredContent")
	require.NotContains(t, string(encoded), "\\\"samples\\\"")
	require.Contains(t, string(encoded), `"schemaVersion":1`)
}

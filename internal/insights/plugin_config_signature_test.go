package insights

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	insightsschema "github.com/benebsworth/paprika/docs/design/insights"
)

// The signatures of three plugins are pinned, one per shape: a records plugin with a repeated object, a bounded
// metrics plugin and an enum-only one. A change to a plugin's config shows up here and in the plugin kind's notes.
func TestPluginConfigSignaturesAreStable(t *testing.T) {
	bundle := pluginBundleDefs(t)
	want := map[string]string{
		"geo-heatmap":          "{aggregation?:count|sum|mean,gridColumns?:8..48,label?:string,latitude?:string,longitude?:string,maxRecords?:1..500,mode?:map|grid,radius?:8..36,value?:string}",
		"kubernetes-placement": "{maxNodes?:1..64,pressure?:0.5..1,resource?:cpu|memory,showPods?:boolean}",
		"record-table":         "{cellStyles?:{barColorMode?:gradient|value,column:string,display:bar|bar-segments|color-text|color-background|sparkline|status-badge,mappings?:{color?:string,status?:ok|info|warning|critical|unknown,value:string}[0..16],max?:number,min?:number,segments?:4..60,thresholdColumn?:string,thresholds?:{color?:string,label?:string,status?:ok|info|warning|critical|unknown,value:number}[1..12],unit?:string}[0..16],columns?:string[1..64],density?:compact|comfortable,pageSize?:5..100,rank?:{limit?:1..100,order?:descending|ascending,rail?:boolean,status:string,value?:string},showRowNumbers?:boolean,showSearch?:boolean,timeSelection?:{duration:string,durationUnit:milliseconds|seconds|minutes,paddingSeconds?:0..86400,start:string}}",
	}
	for id, signature := range want {
		require.Equal(t, signature, pluginConfigSignature(bundle[id]), id)
	}
}

// An array with only a maximum still reads as a range, with the JSON Schema default of 0 as its minimum.
func TestPluginConfigSignatureReadsArrayMaximaAsRanges(t *testing.T) {
	node := map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "maxItems": float64(4)}
	require.Equal(t, "string[0..4]", pluginConfigSignature(node))
	require.Equal(t, "string[]", pluginConfigSignature(map[string]any{"type": "array", "items": map[string]any{"type": "string"}}))
}

// The plugin kind serves a signature for every configured plugin, and each dashboard and widget response stays under the
// size cap with the pointer to it.
func TestAuthoringSchemaServesThePluginKind(t *testing.T) {
	s, _ := testService(t)
	w := request(t, s.Handler(), http.MethodGet, "/api/schemas/plugin", nil, nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.LessOrEqual(t, w.Body.Len(), maxSchemaResponseBytes)
	t.Logf("plugin kind: %d bytes", w.Body.Len())

	var response authoringSchemaResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &response))
	require.Equal(t, "plugin", response.Kind)
	expected, err := insightsschema.Document("plugin")
	require.NoError(t, err)
	require.JSONEq(t, string(expected), string(response.Schema))
	require.NotEmpty(t, response.Examples)

	notes := strings.Join(response.Notes, "\n")
	require.Contains(t, notes, "geo-heatmap (records) config {aggregation?:count|sum|mean,")
	require.Contains(t, notes, "kubernetes-placement (metrics) config {maxNodes?:1..64,")
	require.NotContains(t, notes, "slo-summary (", "slo-summary is checked by the dashboard schema, not a plugin signature")
	require.Equal(t, 24, countNotesWith(response.Notes, " config {"), "one signature per configured built-in plugin")

	for _, kind := range []string{"dashboard", "widget"} {
		document := request(t, s.Handler(), http.MethodGet, "/api/schemas/"+kind, nil, nil)
		require.Equal(t, http.StatusOK, document.Code, kind)
		require.LessOrEqual(t, document.Body.Len(), maxSchemaResponseBytes, kind)
		t.Logf("%s kind: %d bytes", kind, document.Body.Len())
		var body authoringSchemaResponse
		require.NoError(t, json.Unmarshal(document.Body.Bytes(), &body))
		require.Contains(t, body.Notes, schemaPluginPointerNote, kind)
	}
}

func pluginBundleDefs(t *testing.T) map[string]map[string]any {
	t.Helper()
	var bundle struct {
		Defs map[string]map[string]any `json:"$defs"`
	}
	require.NoError(t, json.Unmarshal(insightsschema.PluginConfigSchemas(), &bundle))
	return bundle.Defs
}

func countNotesWith(notes []string, fragment string) int {
	count := 0
	for _, note := range notes {
		if strings.Contains(note, fragment) {
			count++
		}
	}
	return count
}

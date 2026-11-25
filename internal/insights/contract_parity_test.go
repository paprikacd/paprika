package insights

import (
	"encoding/json"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	insightsschema "github.com/benebsworth/paprika/docs/design/insights"
)

// The hand-written Go copies of the published contract. Each list in contract_shapes.go must equal the schema's
// properties and required keys at its node, so a field added to the Zod model fails here until the validator follows.

func publishedDashboardSchema(t *testing.T) map[string]any {
	t.Helper()
	raw, err := insightsschema.Document("dashboard")
	require.NoError(t, err)
	var root map[string]any
	require.NoError(t, json.Unmarshal(raw, &root))
	return root
}

// schemaNode follows a path of object keys from root and fails the test when a step is missing.
func schemaNode(t *testing.T, root map[string]any, path ...string) map[string]any {
	t.Helper()
	node := root
	for _, key := range path {
		next, ok := node[key].(map[string]any)
		require.True(t, ok, "schema has no %q at %s", key, strings.Join(path, "/"))
		node = next
	}
	return node
}

func sortedStrings(values []string) []string {
	out := append([]string{}, values...)
	sort.Strings(out)
	return out
}

// schemaMembers returns the required and all member names of an object schema, sorted.
func schemaMembers(node map[string]any) (required, all []string) {
	list, _ := node["required"].([]any)
	required = make([]string, 0, len(list))
	for _, item := range list {
		if name, ok := item.(string); ok {
			required = append(required, name)
		}
	}
	properties, _ := node["properties"].(map[string]any)
	all = make([]string, 0, len(properties))
	for name := range properties {
		all = append(all, name)
	}
	return sortedStrings(required), sortedStrings(all)
}

// assertShape requires the list's required members to be the schema's required members, and the list's members in full
// to be the schema's properties.
func assertShape(t *testing.T, name string, node map[string]any, required, optional []string) {
	t.Helper()
	gotRequired, gotAll := schemaMembers(node)
	require.Equal(t, sortedStrings(required), gotRequired, "%s: required members differ from the schema", name)
	members := append(append([]string{}, required...), optional...)
	require.Equal(t, sortedStrings(members), gotAll, "%s: members differ from the schema", name)
}

func TestContractShapesMatchThePublishedDashboardSchema(t *testing.T) {
	root := publishedDashboardSchema(t)
	widget := schemaNode(t, root, "properties", "widgets", "items")
	options := schemaNode(t, widget, "properties", "options")
	assertShape(t, "widget", widget, widgetRequiredFields, widgetOptionalFields)
	assertShape(t, "layout", schemaNode(t, widget, "properties", "layout"), layoutFields, nil)
	assertShape(t, "options", options, nil, optionFields)
	assertShape(t, "tooltipView", schemaNode(t, options, "properties", "tooltipView"), tooltipViewRequiredFields, tooltipViewOptionalFields)
	assertShape(t, "referenceLine", schemaNode(t, options, "properties", "referenceLines", "items"), referenceLineRequiredFields, referenceLineOptionalFields)
	assertShape(t, "seriesRule", schemaNode(t, options, "properties", "seriesColors", "items"), seriesRuleRequiredFields, seriesRuleOptionalFields)
	assertShape(t, "threshold", schemaNode(t, options, "properties", "thresholds", "items"), thresholdRequiredFields, thresholdOptionalFields)
	assertShape(t, "annotationSource", schemaNode(t, widget, "properties", "annotationSource"), annotationSourceRequiredFields, annotationSourceOptionalFields)
}

func TestDashboardFieldListsMatchThePublishedSchema(t *testing.T) {
	assertShape(t, "dashboard", publishedDashboardSchema(t), dashboardRequiredFields, dashboardOptionalFields)
}

// validID and the published id pattern accept the same ids: one leading character and up to 79 more, which the schema
// states as a pattern and a maximum length of 80.
func TestValidIDMatchesThePublishedIDPattern(t *testing.T) {
	id := schemaNode(t, publishedDashboardSchema(t), "properties", "id")
	require.Equal(t, "^[a-zA-Z0-9][a-zA-Z0-9_-]*$", id["pattern"])
	require.Equal(t, float64(80), id["maxLength"])
	require.Equal(t, "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$", validID.String())
}

// The bundle holds one schema for every built-in plugin except slo-summary, which the dashboard schema checks.
func TestPluginConfigBundleCoversEveryBuiltInPluginButSLO(t *testing.T) {
	ids, err := insightsschema.BuiltInWidgetPlugins()
	require.NoError(t, err)
	want := make([]string, 0, len(ids))
	for _, id := range ids {
		if id != "slo-summary" {
			want = append(want, id)
		}
	}
	bundle := pluginBundleDefs(t)
	got := make([]string, 0, len(bundle))
	for id := range bundle {
		got = append(got, id)
	}
	require.Equal(t, sortedStrings(want), sortedStrings(got))
}

// undocumentedPluginKeys pins the plugin configuration keys that no authoring note names. The prose notes are
// hand-written, so this list is what they do not yet say. Adding a key to a plugin without a note fails the test, and so
// does documenting a pinned key, until the pin is removed.
var undocumentedPluginKeys = []string{
	"connection-map.display",
	"connection-map.showCoordinates",
	"connection-map.showGrid",
	"directional-traffic.seriesColors",
	"directional-traffic.symmetricAxis",
	"distribution-heatmap.traces",
	"stacked-timeseries.annotations",
	"stacked-timeseries.seriesColors",
}

// A plugin's key counts as documented when a dashboard or widget note names the plugin and the key as a whole word.
func TestPluginNotesNameEveryConfigKeyOrPinIt(t *testing.T) {
	s, _ := testService(t)
	notes := make([]string, 0, 128)
	for _, kind := range []string{"dashboard", "widget"} {
		w := request(t, s.Handler(), http.MethodGet, "/api/schemas/"+kind, nil, nil)
		require.Equal(t, http.StatusOK, w.Code, kind)
		var response authoringSchemaResponse
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &response))
		notes = append(notes, response.Notes...)
	}
	bundle := pluginBundleDefs(t)
	var undocumented []string
	for _, id := range sortedMapKeys(bundle) {
		properties, _ := bundle[id]["properties"].(map[string]any)
		for _, key := range sortedMapKeys(properties) {
			if !documentedInNotes(notes, id, key) {
				undocumented = append(undocumented, id+"."+key)
			}
		}
	}
	require.Equal(t, sortedStrings(undocumentedPluginKeys), undocumented, "pinned undocumented plugin keys differ from the notes")
}

func documentedInNotes(notes []string, pluginID, key string) bool {
	word := regexp.MustCompile(`\b` + regexp.QuoteMeta(key) + `\b`)
	for _, note := range notes {
		if strings.Contains(note, pluginID) && word.MatchString(note) {
			return true
		}
	}
	return false
}

func sortedMapKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

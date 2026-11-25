package insights

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"testing"

	"github.com/stretchr/testify/require"

	insightsschema "github.com/benebsworth/paprika/docs/design/insights"
	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
)

type pluginConfigCase struct {
	Name          string          `json:"name"`
	PluginID      string          `json:"pluginId"`
	Config        json.RawMessage `json:"config"`
	Valid         bool            `json:"valid"`
	Pointer       *string         `json:"pointer"`
	JSONSchemaGap string          `json:"jsonSchemaGap"`
}

// The Go half of docs/design/insights/conformance/plugin-configs.json. The UI half runs the same cases through Zod and
// checks that each pointer is a prefix of Zod's first issue path.
func TestPluginConfigFixturesMatchTheGoValidator(t *testing.T) {
	raw, err := os.ReadFile("../../docs/design/insights/conformance/plugin-configs.json")
	require.NoError(t, err)
	var fixtures struct {
		Cases []pluginConfigCase `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixtures))
	require.NotEmpty(t, fixtures.Cases)
	for _, tc := range fixtures.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			pointer, _, refused := pluginConfigProblem(tc.PluginID, tc.Config)
			if tc.JSONSchemaGap != "" {
				// The published schema cannot carry this refinement, so it accepts the configuration. The UI refuses it.
				require.False(t, refused, "a gap case is accepted by the published schema")
				return
			}
			require.Equal(t, !tc.Valid, refused)
			if refused {
				require.NotNil(t, tc.Pointer, "a refused case names the pointer Go reports")
				require.Equal(t, *tc.Pointer, pointer)
			}
		})
	}
}

// Every built-in plugin with its own configuration schema has one in the bundle, and the bundle compiles.
func TestPluginConfigBundleCompilesForEveryConfiguredPlugin(t *testing.T) {
	schemas, err := pluginConfigSchemas()
	require.NoError(t, err)
	ids, err := insightsschema.BuiltInWidgetPlugins()
	require.NoError(t, err)
	want := 0
	for _, id := range ids {
		if id == "slo-summary" {
			continue
		}
		want++
		require.NotNil(t, schemas[id], "plugin %q has no published configuration schema", id)
	}
	require.Len(t, schemas, want)
}

// pluginWidgetJSON is a plugin widget with the given layout and configuration, typed the way the UI saves one.
func pluginWidgetJSON(id, layout, pluginID, config string) string {
	return fmt.Sprintf(`{"id":%q,"title":"Plugin %s","type":"plugin","pluginId":%q,"dataKind":"records","providerId":"postgres","query":"select 1","unit":"","layout":%s,"config":%s}`, id, id, pluginID, layout, config)
}

func findingsForRule(findings []*insightsv1.CheckFinding, rule string) []*insightsv1.CheckFinding {
	var matched []*insightsv1.CheckFinding
	for _, finding := range findings {
		if finding.RuleId == rule {
			matched = append(matched, finding)
		}
	}
	return matched
}

func TestSaveRefusesAPluginConfigThatItsSchemaRefuses(t *testing.T) {
	document := documentWithWidgets("demo", pluginWidgetJSON("table", `{"x":0,"y":0,"w":6,"h":4}`, "record-table", `{"pageSize":2}`))
	refused := findingsForRule(saveFindings("demo", document), "plugin.config")
	require.Len(t, refused, 1)
	require.Equal(t, insightsv1.Severity_SEVERITY_ERROR, refused[0].Severity)
	require.Equal(t, "/widgets/0/config/pageSize", refused[0].Pointer)
}

// A configuration the stored dashboard already had is a warning, so an unrelated edit still saves. A changed
// configuration is an error again, even when it is still invalid.
func TestStoredInvalidPluginConfigIsAWarningOnlyWhenUnchanged(t *testing.T) {
	stored := documentWithWidgets("demo", pluginWidgetJSON("table", `{"x":0,"y":0,"w":6,"h":4}`, "record-table", `{"pageSize":2}`))

	unrelated := documentWithWidgets("demo", pluginWidgetJSON("table", `{"x":0,"y":0,"w":5,"h":4}`, "record-table", `{"pageSize":2}`))
	carried := findingsForRule(saveReport("demo", unrelated, stored, unboundedFindings, nil).findings(), "plugin.config")
	require.Len(t, carried, 1)
	require.Equal(t, insightsv1.Severity_SEVERITY_WARNING, carried[0].Severity)

	changed := documentWithWidgets("demo", pluginWidgetJSON("table", `{"x":0,"y":0,"w":6,"h":4}`, "record-table", `{"pageSize":3}`))
	edited := findingsForRule(saveReport("demo", changed, stored, unboundedFindings, nil).findings(), "plugin.config")
	require.Len(t, edited, 1)
	require.Equal(t, insightsv1.Severity_SEVERITY_ERROR, edited[0].Severity)
}

// Grandfathering is keyed by the widget id, its plugin and its exact configuration. Moving the stored configuration to
// another widget, or keeping the widget and configuration but switching to another plugin that also refuses it, is a
// new invalid configuration and an error.
func TestStoredInvalidPluginConfigDoesNotMoveOrChangePlugin(t *testing.T) {
	layout := `{"x":0,"y":0,"w":6,"h":4}`
	stored := documentWithWidgets("demo", pluginWidgetJSON("table", layout, "record-table", `{"pageSize":2}`))
	for name, document := range map[string]Dashboard{
		"another widget": documentWithWidgets("demo", pluginWidgetJSON("table", layout, "record-table", `{}`), pluginWidgetJSON("copy", `{"x":6,"y":0,"w":6,"h":4}`, "record-table", `{"pageSize":2}`)),
		"renamed widget": documentWithWidgets("demo", pluginWidgetJSON("renamed", layout, "record-table", `{"pageSize":2}`)),
		"another plugin": documentWithWidgets("demo", pluginWidgetJSON("table", layout, "record-list", `{"pageSize":2}`)),
	} {
		t.Run(name, func(t *testing.T) {
			_, _, refused := pluginConfigProblem("record-list", json.RawMessage(`{"pageSize":2}`))
			require.True(t, refused, "the other plugin must refuse the configuration too, or this case proves nothing")
			findings := findingsForRule(saveReport("demo", document, stored, unboundedFindings, nil).findings(), "plugin.config")
			require.NotEmpty(t, findings)
			for _, finding := range findings {
				require.Equal(t, insightsv1.Severity_SEVERITY_ERROR, finding.Severity, finding.Pointer)
			}
		})
	}
}

// The grandfathered save goes through the HTTP path: a dashboard stored before the rule existed takes an unrelated
// edit, and the same edit with a changed configuration is refused at the member.
func TestSaveKeepsAStoredInvalidPluginConfigOnAnUnrelatedEdit(t *testing.T) {
	s, store := testService(t)
	h := s.Handler()
	stored := documentWithWidgets("demo", pluginWidgetJSON("table", `{"x":0,"y":0,"w":6,"h":4}`, "record-table", `{"pageSize":2}`))
	_, err := store.Put("demo", stored, "", "*")
	require.NoError(t, err)
	current := request(t, h, "GET", "/api/dashboards/demo", nil, nil)
	require.Equal(t, http.StatusOK, current.Code)
	tag := current.Header().Get("ETag")

	unrelated := documentWithWidgets("demo", pluginWidgetJSON("table", `{"x":0,"y":0,"w":5,"h":4}`, "record-table", `{"pageSize":2}`))
	saved := request(t, h, "PUT", "/api/dashboards/demo", unrelated, map[string]string{"If-Match": tag})
	require.Equal(t, http.StatusOK, saved.Code, saved.Body.String())

	changed := documentWithWidgets("demo", pluginWidgetJSON("table", `{"x":0,"y":0,"w":5,"h":4}`, "record-table", `{"pageSize":3}`))
	refused := request(t, h, "PUT", "/api/dashboards/demo", changed, map[string]string{"If-Match": saved.Header().Get("ETag")})
	require.Equal(t, http.StatusBadRequest, refused.Code, refused.Body.String())
	require.Contains(t, refused.Body.String(), "/widgets/0/config/pageSize")
}

// A plugin the bundle does not describe is not checked here, so a host plugin passes whatever its configuration.
func TestUnknownPluginIdIsNotCheckedAgainstAPublishedSchema(t *testing.T) {
	document := documentWithWidgets("demo", pluginWidgetJSON("host", `{"x":0,"y":0,"w":6,"h":4}`, "host-widget", `{"anything":true}`))
	require.Empty(t, findingsForRule(saveFindings("demo", document), "plugin.config"))
}

func TestPluginConfigProblemNamesAStableFirstMember(t *testing.T) {
	pointer, message, refused := pluginConfigProblem("record-table", json.RawMessage(`{"pageSize":2,"density":"loose"}`))
	require.True(t, refused)
	require.NotEmpty(t, pointer)
	require.Contains(t, message, `plugin "record-table" config is invalid`)
	require.LessOrEqual(t, len([]rune(message)), maxPluginConfigMessageRunes)
	for range 20 {
		again, againMessage, _ := pluginConfigProblem("record-table", json.RawMessage(`{"pageSize":2,"density":"loose"}`))
		require.Equal(t, pointer, again)
		require.Equal(t, message, againMessage)
	}
}

// The HTTP save names the refused member in the same finding the lint command reports.
func TestSaveResponseNamesTheRefusedPluginConfigMember(t *testing.T) {
	s, _ := testService(t)
	h := s.Handler()
	document := documentWithWidgets("demo", pluginWidgetJSON("table", `{"x":0,"y":0,"w":6,"h":4}`, "record-table", `{"pageSize":2}`))
	created := request(t, h, "PUT", "/api/dashboards/demo", document, map[string]string{"If-None-Match": "*"})
	require.Equal(t, http.StatusBadRequest, created.Code, created.Body.String())
	var saved savedBody
	require.NoError(t, json.Unmarshal(created.Body.Bytes(), &saved))
	var pointers []string
	for _, issue := range saved.Issues {
		if issue["ruleId"] == "plugin.config" {
			pointers = append(pointers, fmt.Sprint(issue["pointer"]))
		}
	}
	require.Equal(t, []string{"/widgets/0/config/pageSize"}, pointers)
}

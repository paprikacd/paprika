package observabilitygateway

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// variableResult is the capped golden after one step, which validates against the advertised schema, with the
// variable definitions and warnings that query-dashboard adds when a dashboard declares variables.
func variableResult(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(dashboardCappedGoldenPath(1))
	require.NoError(t, err)
	var document map[string]any
	require.NoError(t, json.Unmarshal(raw, &document))
	document["variables"] = map[string]any{"service": "prod"}
	document["variableDefinitions"] = []any{
		map[string]any{"name": "service", "label": "Service", "defaultValue": "checkout", "options": []any{"checkout", "api"}, "optionsOmitted": 0},
		map[string]any{"name": "cluster"},
	}
	document["warnings"] = []any{"service=prod is not one of the declared options"}
	return document
}

// The additive variable fields validate against the advertised output schema, and the schema still rejects a
// malformed definition, so the advertised contract constrains the new fields rather than admitting anything.
func TestDashboardVariableDefinitionsAndWarningsValidateAgainstTheSchema(t *testing.T) {
	resolved := loadDashboardQuerySchema(t, []byte(dashboardQueryOutputSchema))
	document := variableResult(t)
	require.NoError(t, resolved.Validate(document))
	document["variableDefinitions"] = []any{map[string]any{"name": "service", "detailOmitted": true, "optionsOmitted": 3}}
	require.NoError(t, resolved.Validate(document), "detailOmitted is an advertised, additive field")

	document["variableDefinitions"] = []any{map[string]any{"options": []any{"checkout"}}}
	require.Error(t, resolved.Validate(document), "a definition without a name must not validate")
	document["variableDefinitions"] = []any{map[string]any{"name": "service", "options": []any{1}}}
	require.Error(t, resolved.Validate(document), "non-string options must not validate")
}

// A multi-value variable's list value, its multi and allowAll flags, a list default, and a sourced variable's
// missingValues all validate against the advertised schema. The sourceOptions object is closed, so a field the
// server emits must be declared there or a validating client refuses the whole result.
func TestDashboardMultiValueVariablesValidateAgainstTheSchema(t *testing.T) {
	resolved := loadDashboardQuerySchema(t, []byte(dashboardQueryOutputSchema))
	document := variableResult(t)
	document["variables"] = map[string]any{"service": "prod", "cluster": []any{"omega", "delta"}, "region": []any{}}
	document["variableDefinitions"] = []any{
		map[string]any{"name": "cluster", "multi": true, "defaultValue": []any{"omega"}, "options": []any{"omega", "delta"}},
		map[string]any{"name": "region", "multi": true, "allowAll": true, "defaultValue": []any{}, "source": "labelValues",
			"sourceOptions": map[string]any{"state": "ready", "values": []any{"eu"}, "currentValue": "not_in_values", "missingValues": []any{"us"}}},
	}
	require.NoError(t, resolved.Validate(document))

	document["variables"] = map[string]any{"cluster": []any{1}}
	require.Error(t, resolved.Validate(document), "a list of non-strings must not validate")
}

// The text synopsis names each warning in quoted form, so a text-only client reads what was accepted.
func TestDashboardVariableWarningsAppearInTheTextSynopsis(t *testing.T) {
	raw, err := json.Marshal(variableResult(t))
	require.NoError(t, err)
	text, err := dashboardQueryText(raw)
	require.NoError(t, err)
	require.Contains(t, text, `Warning: "service=prod is not one of the declared options".`)

	var document map[string]any
	require.NoError(t, json.Unmarshal(raw, &document))
	delete(document, "warnings")
	raw, err = json.Marshal(document)
	require.NoError(t, err)
	text, err = dashboardQueryText(raw)
	require.NoError(t, err)
	require.NotContains(t, text, "Warning", "a result without warnings adds no warning line")
}

func TestDashboardVariableWarningsAreBoundedInTheTextSynopsis(t *testing.T) {
	document := variableResult(t)
	names := []string{"a", "b", "c", "d", "e", "f", "g"}
	warnings := make([]any, 0, len(names))
	for _, name := range names {
		warnings = append(warnings, name+"=x is not one of the declared options")
	}
	document["warnings"] = warnings
	raw, err := json.Marshal(document)
	require.NoError(t, err)
	text, err := dashboardQueryText(raw)
	require.NoError(t, err)
	require.Equal(t, 5, strings.Count(text, "Warning: "))
	require.Contains(t, text, "Warnings: 2 more; see structuredContent.")
}

// The text synopsis names each declared variable with its label, default and options, in declaration order, so a
// text-only client can choose values without a get_dashboard read.
func TestDashboardDeclaredVariablesAppearInTheTextSynopsis(t *testing.T) {
	raw, err := json.Marshal(variableResult(t))
	require.NoError(t, err)
	text, err := dashboardQueryText(raw)
	require.NoError(t, err)
	require.Contains(t, text, `Declared variables: "service" ("Service") default "checkout" options "checkout", "api"; "cluster".`+"\n")
	require.Less(t, strings.Index(text, "Declared variables:"), strings.Index(text, "Warning:"), "definitions come before warnings")

	var document map[string]any
	require.NoError(t, json.Unmarshal(raw, &document))
	delete(document, "variableDefinitions")
	raw, err = json.Marshal(document)
	require.NoError(t, err)
	text, err = dashboardQueryText(raw)
	require.NoError(t, err)
	require.NotContains(t, text, "Declared variables", "a result without definitions adds no definitions line")
}

// Many variables with long options keep the declared-variables line bounded: later variables are counted, not
// named. A variable whose label and default were left out says so.
func TestDashboardDeclaredVariablesTextIsBounded(t *testing.T) {
	document := variableResult(t)
	definitions := make([]any, 0, 30)
	for index := range 30 {
		options := make([]any, 0, 12)
		for range 12 {
			options = append(options, strings.Repeat("o", 48))
		}
		definitions = append(definitions, map[string]any{"name": "v" + strconv.Itoa(index), "options": options})
	}
	document["variableDefinitions"] = definitions
	raw, err := json.Marshal(document)
	require.NoError(t, err)
	text, err := dashboardQueryText(raw)
	require.NoError(t, err)
	var line string
	for _, candidate := range strings.Split(text, "\n") {
		if strings.HasPrefix(candidate, "Declared variables:") {
			line = candidate
		}
	}
	require.NotEmpty(t, line)
	require.Contains(t, line, "(28 more; see structuredContent).")
	require.LessOrEqual(t, len(line), 1000+500, "the line stays near its bound")
	require.Contains(t, line, "(+4 more; see structuredContent)", "each variable names 8 of its 12 options")

	document = variableResult(t)
	document["variableDefinitions"] = []any{map[string]any{"name": "big", "detailOmitted": true}}
	raw, err = json.Marshal(document)
	require.NoError(t, err)
	text, err = dashboardQueryText(raw)
	require.NoError(t, err)
	require.Contains(t, text, `Declared variables: "big" (label and default omitted; see structuredContent).`)
}

// A sourced variable names its source type, and the schema refuses any other source word.
func TestDashboardVariableSourceValidatesAgainstTheSchema(t *testing.T) {
	resolved := loadDashboardQuerySchema(t, []byte(dashboardQueryOutputSchema))
	document := variableResult(t)
	document["variableDefinitions"] = []any{map[string]any{"name": "service", "source": "labelValues", "options": []any{"api"}}}
	require.NoError(t, resolved.Validate(document))
	document["variableDefinitions"] = []any{map[string]any{"name": "service", "source": "sql"}}
	require.Error(t, resolved.Validate(document), "an unknown source type must not validate")
}

// The text synopsis says a sourced variable takes its values from a source, names its options as a fallback and
// tells the agent to pass an explicit value.
func TestDashboardVariableSourceAppearsInTheTextSynopsis(t *testing.T) {
	document := variableResult(t)
	document["variableDefinitions"] = []any{map[string]any{"name": "service", "source": "labelValues", "fallbackOptions": []any{"api"}}}
	raw, err := json.Marshal(document)
	require.NoError(t, err)
	text, err := dashboardQueryText(raw)
	require.NoError(t, err)
	require.Contains(t, text, `"service" takes its values from a labelValues source; pass an explicit value; fallback options "api"`)
}

// A resolved source says in plain words what its state means for the values. Each state's sentence is kept
// apart, so an agent can tell an empty source from a failed one, and a ready list shows its values.
func TestDashboardVariableSourceOptionsAppearInTheTextSynopsis(t *testing.T) {
	resolved := loadDashboardQuerySchema(t, []byte(dashboardQueryOutputSchema))
	for _, tc := range []struct {
		name    string
		options map[string]any
		want    string
	}{
		{"ready", map[string]any{"state": "ready", "values": []any{"api", "db"}, "currentValue": "not_in_values"},
			`"service" values from its labelValues source "api", "db" (current value not in source values; kept)`},
		{"empty", map[string]any{"state": "empty"}, `"service"; its source returned no values`},
		{"failed", map[string]any{"state": "failed", "error": map[string]any{"code": "invalid_query", "message": "bad selector"}}, `"service"; its source failed (invalid_query)`},
		{"needs variable", map[string]any{"state": "needs_variable", "needsVariable": "zone"}, `"service"; set zone to load its values`},
		{"not run", map[string]any{"state": "not_run"}, `"service"; its source was not queried in time`},
		{"values past the budget", map[string]any{"state": "ready", "values": []any{"api"}, "valuesOmitted": 4},
			`"service" values from its labelValues source "api" (+4 more not listed in this result)`},
		{"values dropped by the ladder", map[string]any{"state": "ready", "valuesOmitted": 9, "currentValue": "in_values"},
			`"service"; its labelValues source returned 9 values, not listed in this result`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			document := variableResult(t)
			document["variableDefinitions"] = []any{map[string]any{"name": "service", "source": "labelValues", "sourceSummary": map[string]any{"kind": "labelValues", "dependsOnVariables": false}, "sourceOptions": tc.options}}
			require.NoError(t, resolved.Validate(document), "the resolved source must validate against the advertised schema")
			raw, err := json.Marshal(document)
			require.NoError(t, err)
			text, err := dashboardQueryText(raw)
			require.NoError(t, err)
			require.Contains(t, text, tc.want)
			require.NotContains(t, text, "see structuredContent", "values outside structuredContent are never sent there")
		})
	}
}

// A source that gave no list leaves the console on its fallback options, so the text names them. A ready source
// replaces them, so they are not named.
func TestDashboardVariableFallbackOptionsFollowTheSourceState(t *testing.T) {
	for _, tc := range []struct {
		state string
		want  bool
	}{{"failed", true}, {"needs_variable", true}, {"not_run", true}, {"empty", true}, {"ready", false}} {
		t.Run(tc.state, func(t *testing.T) {
			document := variableResult(t)
			document["variableDefinitions"] = []any{map[string]any{"name": "service", "source": "labelValues", "fallbackOptions": []any{"api"},
				"sourceSummary": map[string]any{"kind": "labelValues", "dependsOnVariables": false}, "sourceOptions": map[string]any{"state": tc.state, "values": []any{"db"}}}}
			raw, err := json.Marshal(document)
			require.NoError(t, err)
			text, err := dashboardQueryText(raw)
			require.NoError(t, err)
			require.Equal(t, tc.want, strings.Contains(text, `fallback options "api"`), text)
		})
	}
}

// The source summary and fallback options validate against the advertised schema, and the summary rejects an
// unknown kind, so the schema constrains the new fields.
func TestDashboardVariableSourceSummaryValidatesAgainstTheSchema(t *testing.T) {
	resolved := loadDashboardQuerySchema(t, []byte(dashboardQueryOutputSchema))
	document := variableResult(t)
	document["variableDefinitions"] = []any{map[string]any{
		"name":            "service",
		"source":          "labelValues",
		"fallbackOptions": []any{"api"},
		"sourceSummary":   map[string]any{"kind": "labelValues", "providerId": "prom-1", "label": "service", "dependsOnVariables": true},
	}}
	require.NoError(t, resolved.Validate(document))
	document["variableDefinitions"] = []any{map[string]any{"name": "service", "sourceSummary": map[string]any{"kind": "traces", "dependsOnVariables": false}}}
	require.Error(t, resolved.Validate(document), "a traces kind must not validate as a variable source")
	document["variableDefinitions"] = []any{map[string]any{"name": "service", "sourceSummary": map[string]any{"kind": "labelValues"}}}
	require.Error(t, resolved.Validate(document), "dependsOnVariables is required in a source summary")
}

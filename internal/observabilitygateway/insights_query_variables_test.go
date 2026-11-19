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

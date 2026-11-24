package insights

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/insights/variablevalue"
)

func TestSavedQueryListParameterValidation(t *testing.T) {
	sqlTemplate := `{"sql":"SELECT host FROM hosts WHERE ($1::text[] IS NULL OR zone = ANY($1::text[]))","parameters":[{{zone}}]}`
	document := func(query string, parameter string) json.RawMessage {
		return json.RawMessage(`{"schemaVersion":1,"id":"hosts","name":"Hosts","providerId":"records","kind":"records","query":` +
			strconvQuote(query) + `,"parameters":[` + parameter + `]}`)
	}

	_, err := validateSavedQuery("hosts", document(sqlTemplate, `{"name":"zone","type":"string","multi":true,"defaultValue":["omega","delta"]}`))
	require.NoError(t, err, "a list parameter with a list default and a SQL array position")

	_, err = validateSavedQuery("hosts", document(sqlTemplate, `{"name":"zone","type":"string","multi":true,"defaultValue":[]}`))
	require.NoError(t, err, "an empty default is All")

	_, err = validateSavedQuery("hosts", document(sqlTemplate, `{"name":"zone","type":"string","multi":true,"defaultValue":"omega"}`))
	require.Error(t, err, "a single string default for a list parameter")

	_, err = validateSavedQuery("hosts", document(sqlTemplate, `{"name":"zone","type":"number","multi":true}`))
	require.Error(t, err, "several values need a string type")

	_, err = validateSavedQuery("hosts", document(`up{zone={{zone}}}`, `{"name":"zone","type":"string","multi":true}`))
	require.Error(t, err, "a list after equality is refused when the query is saved")
}

func TestDashboardSavedQueryBindsListsAndSingleValues(t *testing.T) {
	saved := &SavedQuery{
		Query:      `{"sql":"SELECT 1 WHERE zone = ANY($1::text[])","parameters":[{{zone}}]}`,
		Parameters: []SavedQueryParameter{{Name: "zone", Type: "string", Multi: true}},
	}
	bindings := dashboardReadReference{Bindings: []dashboardReadBinding{{Parameter: "zone", Source: "variable", Variable: "zone"}}}

	text, err := resolveDashboardSavedQuery(saved, bindings, map[string]variablevalue.Value{"zone": variablevalue.List([]string{"omega", "delta"})})
	require.NoError(t, err)
	require.Equal(t, `{"sql":"SELECT 1 WHERE zone = ANY($1::text[])","parameters":[["omega","delta"]]}`, text)

	text, err = resolveDashboardSavedQuery(saved, bindings, map[string]variablevalue.Value{"zone": variablevalue.List(nil)})
	require.NoError(t, err)
	require.Contains(t, text, `"parameters":[null]`, "All binds NULL, so the query needs its IS NULL guard")

	text, err = resolveDashboardSavedQuery(saved, bindings, map[string]variablevalue.Value{"zone": variablevalue.Single("omega")})
	require.NoError(t, err)
	require.Contains(t, text, `"parameters":[["omega"]]`, "a single variable fills a list parameter as one item")
}

func TestDashboardListVariableCannotBindASingleParameter(t *testing.T) {
	saved := &SavedQuery{
		Query:      `{"sql":"SELECT 1 WHERE zone = $1","parameters":[{{zone}}]}`,
		Parameters: []SavedQueryParameter{{Name: "zone", Type: "string"}},
	}
	bindings := dashboardReadReference{Bindings: []dashboardReadBinding{{Parameter: "zone", Source: "variable", Variable: "zone"}}}
	_, err := resolveDashboardSavedQuery(saved, bindings, map[string]variablevalue.Value{"zone": variablevalue.List([]string{"omega"})})
	require.Error(t, err)
}

// strconvQuote quotes a template for embedding in a JSON document built by hand.
func strconvQuote(text string) string {
	encoded, _ := json.Marshal(text)
	return string(encoded)
}

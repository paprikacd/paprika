package insights

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestMultiOperatorRuleAcceptsRegexAndArrayPositions(t *testing.T) {
	cases := []struct {
		name  string
		query string
		hits  int
	}{
		{name: "regex match", query: `up{cluster=~{{cluster}}}`},
		{name: "negated regex", query: `up{cluster!~{{cluster}}}`},
		{name: "log line filter", query: `{app="x"} |~ {{cluster}}`},
		{name: "SQL array element", query: `{"sql":"SELECT 1","parameters":[{{cluster}}]}`},
		{name: "equality is refused", query: `up{cluster={{cluster}}}`, hits: 1},
		{name: "function argument is refused", query: `topk({{cluster}}, up)`, hits: 1},
		// A "[" or "," outside a SQL parameters array is a PromQL range or argument: a JSON array there fails at the provider.
		{name: "PromQL range is refused", query: `rate(up[{{cluster}}])`, hits: 1},
		{name: "PromQL later argument is refused", query: `label_replace(up, "dst", {{cluster}}, "src", "(.*)")`, hits: 1},
		{name: "second SQL array element", query: `{"sql":"SELECT 1","parameters":["x", {{cluster}}]}`},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			doc := &lintDocument{
				multi:   map[string]bool{"cluster": true},
				widgets: []lintWidget{{index: 0, id: "w", query: test.query}},
			}
			require.Len(t, checkMultiOperator(doc), test.hits)
		})
	}
}

func TestMultiOperatorRuleChecksSourceSelectors(t *testing.T) {
	selector := `up{cluster={{cluster}}}`
	doc := &lintDocument{
		multi:           map[string]bool{"cluster": true},
		sourceVariables: []lintVariable{{index: 1, name: "service", sourceType: "labelValues", selector: &selector}},
	}
	hits := checkMultiOperator(doc)
	require.Len(t, hits, 1)
	require.Equal(t, "/variables/1/source/selector", hits[0].pointer)
}

func TestMultiBindingRuleRefusesASingleParameter(t *testing.T) {
	ref := lintVariableRef{pointer: "/widgets/0/queryRef/bindings/0/variable", variable: "zone", queryRefID: "hosts", parameter: "zone"}
	doc := &lintDocument{
		multi:         map[string]bool{"zone": true},
		widgets:       []lintWidget{{index: 0, id: "w", variables: []lintVariableRef{ref}}},
		providerTypes: map[string]string{savedQueryParameterKey("hosts", "zone"): "single"},
	}
	require.Len(t, checkMultiBinding(doc), 1)

	doc.providerTypes[savedQueryParameterKey("hosts", "zone")] = "multi"
	require.Empty(t, checkMultiBinding(doc), "a parameter of several values takes the list")
}

// The dashboard event source and a variable source bind saved query parameters too.
func TestMultiBindingRuleCoversEventAndVariableSources(t *testing.T) {
	event := lintVariableRef{pointer: "/annotationSource/queryRef/bindings/0/variable", variable: "zone", queryRefID: "deploys", parameter: "zone"}
	source := lintVariableRef{pointer: "/variables/1/source/queryRef/bindings/0/variable", variable: "zone", queryRefID: "hosts", parameter: "zone"}
	doc := &lintDocument{
		multi:               map[string]bool{"zone": true},
		annotationVariables: []lintVariableRef{event},
		sourceVariables:     []lintVariable{{index: 1, name: "host", sourceType: "savedQuery", queryRefID: "hosts", refs: []lintVariableRef{source}}},
		providerTypes: map[string]string{
			savedQueryParameterKey("deploys", "zone"): "single",
			savedQueryParameterKey("hosts", "zone"):   "single",
		},
	}
	hits := checkMultiBinding(doc)
	require.Len(t, hits, 2)
	require.Equal(t, event.pointer, hits[0].pointer)
	require.Equal(t, source.pointer, hits[1].pointer)
	require.ElementsMatch(t, []string{"deploys", "hosts"}, lintBoundSavedQueryIDs(doc))
}

func TestMultiSQLAllRuleNeedsANullGuard(t *testing.T) {
	cases := []struct {
		name  string
		query string
		hits  int
	}{
		{name: "bare ANY", query: `{"sql":"SELECT 1 FROM t WHERE zone = ANY($1::text[])","parameters":[{{zone}}]}`, hits: 1},
		{name: "cast guard", query: `{"sql":"SELECT 1 FROM t WHERE ($1::text[] IS NULL OR zone = ANY($1::text[]))","parameters":[{{zone}}]}`},
		{name: "plain guard, lower case", query: `{"sql":"select 1 from t where ($1 is null or zone = any($1))","parameters":[{{zone}}]}`},
		{name: "guard on another parameter", query: `{"sql":"SELECT 1 FROM t WHERE ($1 IS NULL OR a = $1) AND zone = ANY($2::text[])","parameters":["x", {{zone}}]}`, hits: 1},
		{name: "$10 is not $1", query: `{"sql":"SELECT 1 FROM t WHERE $10 IS NULL AND zone = ANY($1)","parameters":[{{zone}}]}`, hits: 1},
		{name: "not a SQL template", query: `up{zone=~{{zone}}}`},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			doc := &lintDocument{
				multi:    map[string]bool{"zone": true},
				allowAll: map[string]bool{"zone": true},
				widgets:  []lintWidget{{index: 0, id: "w", query: test.query}},
			}
			require.Len(t, checkMultiSQLAll(doc), test.hits)
			doc.allowAll["zone"] = false
			require.Empty(t, checkMultiSQLAll(doc), "a variable without Include All is never NULL")
		})
	}
}

// A save resolves the saved queries that widgets bind, not only those that variable sources read, so the
// several-values rules see a widget's parameter kinds and SQL template.
func TestLintResolvesWidgetSavedQueriesForTheMultiRules(t *testing.T) {
	s, _ := testService(t, ProviderConfig{ID: "metrics", Name: "Metrics", Type: "prometheus", URL: "http://127.0.0.1:9"})
	store := func(id, parameter string) {
		query := `{"schemaVersion":1,"id":"` + id + `","name":"Hosts","providerId":"metrics","kind":"records","query":` +
			strconvQuote(`{"sql":"SELECT host FROM hosts WHERE zone = ANY($1::text[])","parameters":[{{z}}]}`) + `,"parameters":[` + parameter + `]}`
		_, err := s.savedQueries.put(id, []byte(query), "", "*")
		require.NoError(t, err)
	}
	store("single", `{"name":"z","type":"string"}`)
	store("several", `{"name":"z","type":"string","multi":true}`)
	widget := func(id string, y int, queryID string) string {
		return `{"id":"` + id + `","title":"Hosts","type":"table","dataKind":"records","providerId":"metrics","query":"","queryRef":{"id":"` + queryID +
			`","bindings":[{"parameter":"z","source":"variable","variable":"zone"}]},"layout":{"x":0,"y":` + strconv.Itoa(y) + `,"w":6,"h":4}}`
	}
	document := json.RawMessage(`{"schemaVersion":1,"id":"demo","title":"Checks","timeRange":"1h","refreshInterval":30,` +
		`"variables":[{"name":"zone","multi":true,"allowAll":true,"options":["a","b"]}],"widgets":[` + widget("one", 0, "single") + `,` + widget("two", 4, "several") + `]}`)

	types := s.providerTypesOf(httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/", nil), document)
	require.Equal(t, "single", types[savedQueryParameterKey("single", "z")])
	require.Equal(t, "multi", types[savedQueryParameterKey("several", "z")])
	findings := findingsWithProviders(document, types)
	requireOneHit(t, findings, "variables.multi-binding", "/widgets/0/queryRef/bindings/0/variable")
	requireOneHit(t, findings, "variables.multi-sql-all", "/widgets/1/queryRef/bindings/0/variable")
}

func TestMultiSQLAllRuleReadsResolvedSavedQueries(t *testing.T) {
	ref := lintVariableRef{pointer: "/widgets/0/queryRef/bindings/0/variable", variable: "zone", queryRefID: "hosts", parameter: "z"}
	doc := &lintDocument{
		multi:         map[string]bool{"zone": true},
		allowAll:      map[string]bool{"zone": true},
		widgets:       []lintWidget{{index: 0, id: "w", hasQueryRef: true, variables: []lintVariableRef{ref}}},
		providerTypes: map[string]string{savedQueryTextKey("hosts"): `{"sql":"SELECT host FROM hosts WHERE zone = ANY($1::text[])","parameters":[{{z}}]}`},
	}
	hits := checkMultiSQLAll(doc)
	require.Len(t, hits, 1)
	require.Equal(t, ref.pointer, hits[0].pointer)

	delete(doc.providerTypes, savedQueryTextKey("hosts"))
	require.Empty(t, checkMultiSQLAll(doc), "an unresolved saved query stays quiet")
}

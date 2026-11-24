package insights

import (
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

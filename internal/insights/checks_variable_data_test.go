package insights

import (
	"testing"

	"github.com/stretchr/testify/require"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/insights/variablevalue"
)

// TestDataVariableRulesFireOnlyForActionableSourceOutcomes checks each variable source rule against the outcomes it
// reads. A transient failure, a fetch that did not run and a truncated list stay silent.
func TestDataVariableRulesFireOnlyForActionableSourceOutcomes(t *testing.T) {
	variables := []dataVariable{
		{index: 0, name: "zone", value: variablevalue.Single("a"), hasValue: true, outcome: variableSourceOutcome{sourced: true, state: "failed", failure: &DashboardQueryError{Code: "invalid_query"}}},
		{index: 1, name: "pod", value: variablevalue.Single("x"), hasValue: true, outcome: variableSourceOutcome{sourced: true, state: "failed", failure: &DashboardQueryError{Code: "timeout"}}},
		{index: 2, name: "service", outcome: variableSourceOutcome{sourced: true, state: "empty"}},
		{index: 3, name: "region", value: variablevalue.Single("eu"), hasValue: true, outcome: variableSourceOutcome{sourced: true, state: "ready", values: []string{"us"}}},
		{index: 4, name: "tier", value: variablevalue.Single("gold"), hasValue: true, outcome: variableSourceOutcome{sourced: true, state: "ready", values: []string{"a"}, truncated: true}},
		{index: 5, name: "team", value: variablevalue.Single("x"), hasValue: true, outcome: variableSourceOutcome{sourced: true, state: "not_run"}},
		{index: 6, name: "env", value: variablevalue.Single("prod"), hasValue: true, outcome: variableSourceOutcome{sourced: true, state: "ready", values: []string{"prod", "dev"}}},
	}
	findings := dataFindings(nil, variables)
	require.Len(t, findings, 3)

	require.Equal(t, "data.variable-source-error", findings[0].RuleId)
	require.Equal(t, insightsv1.Severity_SEVERITY_WARNING, findings[0].Severity)
	require.Equal(t, "/variables/0/source", findings[0].Pointer)
	require.Empty(t, findings[0].WidgetId, "a variable finding names no widget")
	require.Equal(t, `Variable "zone" source failed: the provider rejected the query or the query is invalid (invalid_query)`, findings[0].Message)

	require.Equal(t, "data.variable-source-empty", findings[1].RuleId)
	require.Equal(t, insightsv1.Severity_SEVERITY_INFO, findings[1].Severity)
	require.Equal(t, "/variables/2/source", findings[1].Pointer)

	require.Equal(t, "data.variable-value-not-in-source", findings[2].RuleId)
	require.Equal(t, insightsv1.Severity_SEVERITY_INFO, findings[2].Severity)
	require.Equal(t, "/variables/3", findings[2].Pointer)
	require.Equal(t, `Variable "region" value "eu" is not one of the values its source returned`, findings[2].Message)
}

// TestDataVariableValueRuleSkipsAnEmptyOverride checks that an empty value is left to the query's own warning,
// so the dry run does not name it twice.
func TestDataVariableValueRuleSkipsAnEmptyOverride(t *testing.T) {
	variables := []dataVariable{{index: 0, name: "zone", value: variablevalue.Single(""), hasValue: true, outcome: variableSourceOutcome{sourced: true, state: "ready", values: []string{"a"}}}}
	require.Empty(t, dataFindings(nil, variables))
}

// TestDryRunResolvesVariableSources runs the validate endpoint with execute, so the rules read the sources the
// dry run resolved itself: a default outside its source, an empty source and a missing saved query.
func TestDryRunResolvesVariableSources(t *testing.T) {
	s, _ := variableOptionsTestService(t)
	document := `{"schemaVersion":1,"id":"sourced","title":"Sourced","timeRange":"1h","refreshInterval":30,"widgets":[],"variables":[
		{"name":"zone","label":"Zone","defaultValue":"zz","source":{"type":"labelValues","providerId":"prometheus","label":"zone"}},
		{"name":"rack","label":"Rack","source":{"type":"labelValues","providerId":"prometheus","label":"rack"}},
		{"name":"host","label":"Host","source":{"type":"savedQuery","queryRef":{"id":"gone"},"field":"host"}}]}`
	report, raw := executeDryRunRequest(t, s, document, nil)
	require.Equal(t, []string{
		"data.variable-source-error /variables/2/source",
		"data.variable-source-empty /variables/1/source",
		"data.variable-value-not-in-source /variables/0",
	}, dataFindingsOf(report), raw)
}

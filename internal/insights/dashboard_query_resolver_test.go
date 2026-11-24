package insights

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/benebsworth/paprika/internal/insights/variablevalue"
)

func TestDashboardSavedQueryTypedBindingsAndExplicitDefaults(t *testing.T) {
	saved := SavedQuery{ProviderID: "prometheus", Kind: "metrics", Query: `metric{service={{service}}} > {{threshold}}`, Parameters: []SavedQueryParameter{{Name: "service", Type: "string", DefaultValue: json.RawMessage(`"saved-service"`)}, {Name: "threshold", Type: "number", DefaultValue: json.RawMessage(`5`)}}}
	for _, test := range []struct {
		name       string
		bindings   []dashboardReadBinding
		variables  map[string]variablevalue.Value
		expression string
		wantError  bool
	}{
		{name: "saved defaults do not implicitly bind a same-named dashboard variable", variables: variableValues(map[string]string{"service": "dashboard-service"}), expression: `metric{service="saved-service"} > 5`},
		{name: "explicit variable and numeric conversion", bindings: []dashboardReadBinding{{Parameter: "service", Source: "variable", Variable: "service"}, {Parameter: "threshold", Source: "variable", Variable: "limit"}}, variables: variableValues(map[string]string{"service": "api", "limit": "1e3"}), expression: `metric{service="api"} > 1000`},
		{name: "constant", bindings: []dashboardReadBinding{{Parameter: "service", Source: "constant", Value: json.RawMessage(`"constant"`)}}, expression: `metric{service="constant"} > 5`},
		{name: "missing explicit variable must not use default", bindings: []dashboardReadBinding{{Parameter: "service", Source: "variable", Variable: "unknown"}}, wantError: true},
		{name: "numeric whitespace rejected", bindings: []dashboardReadBinding{{Parameter: "threshold", Source: "variable", Variable: "limit"}}, variables: variableValues(map[string]string{"limit": " 1 "}), wantError: true},
		{name: "numeric expression rejected", bindings: []dashboardReadBinding{{Parameter: "threshold", Source: "variable", Variable: "limit"}}, variables: variableValues(map[string]string{"limit": "1 + 2"}), wantError: true},
		{name: "string cannot accept numeric constant", bindings: []dashboardReadBinding{{Parameter: "service", Source: "constant", Value: json.RawMessage(`123`)}}, wantError: true},
		{name: "unknown parameter", bindings: []dashboardReadBinding{{Parameter: "other", Source: "constant", Value: json.RawMessage(`"x"`)}}, wantError: true},
		{name: "hover-only binding rejected", bindings: []dashboardReadBinding{{Parameter: "service", Source: "label"}}, wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			actual, err := resolveDashboardSavedQuery(&saved, dashboardReadReference{Bindings: test.bindings}, test.variables)
			if (err != nil) != test.wantError || (!test.wantError && actual != test.expression) {
				t.Fatalf("resolved=%q err=%v", actual, err)
			}
		})
	}
	saved.Parameters[0].DefaultValue = nil
	if _, err := resolveDashboardSavedQuery(&saved, dashboardReadReference{}, variableValues(map[string]string{"service": "implicit"})); err == nil {
		t.Fatal("required parameter was implicitly bound or silently defaulted")
	}
}

func TestDashboardLiteralInterpolationMatchesBrowserBoundaries(t *testing.T) {
	types := map[string]string{"service": "string", "limit": "number"}
	for _, template := range []string{`metric{service="{{service}}"}`, `prefix{{service}}suffix`, "up # {{service}}", `up /* {{service}} */`, `up + {{missing}}`, `up + {{service}`} {
		if _, err := interpolateDashboardLiterals(template, types, map[string]any{"service": "api", "limit": 1.0}); err == nil {
			t.Fatalf("unsafe template accepted: %q", template)
		}
	}
	literal := "quote\" slash\\ newline\n tab\t back\b form\f return\r control\x01 <>\u2028\u2029 {{limit}}"
	actual, err := interpolateDashboardLiterals(" \ufeffmetric{service={{service}}} @{{limit}} \n", types, map[string]any{"service": literal, "limit": math.Copysign(0, -1)})
	if err != nil || actual != `metric{service=`+dashboardStringLiteral(literal)+`} @0` {
		t.Fatalf("literal mismatch: %q %v", actual, err)
	}
	var decoded string
	if err := json.Unmarshal([]byte(dashboardStringLiteral(literal)), &decoded); err != nil || decoded != literal {
		t.Fatalf("literal failed roundtrip: %q %v", decoded, err)
	}
	if _, err := interpolateDashboardLiterals(strings.Repeat("{{service}} + ", 9)+"1", types, map[string]any{"service": strings.Repeat("x", 1024)}); err == nil {
		t.Fatal("expanded query exceeded the browser's 8192 character limit")
	}
	if padded, err := interpolateDashboardLiterals(strings.Repeat(" ", 8200)+"up", nil, nil); err != nil || padded != "up" {
		t.Fatalf("valid padded query must normalize like the UI: %q %v", padded, err)
	}
}

func TestDashboardQueryVariablesReportDefinitionsAndBudgetOptions(t *testing.T) {
	label := "Service"
	service := "checkout"
	definitions := []dashboardReadVariable{
		{Name: "service", Label: label, DefaultValue: valuePtr(service), Options: []string{"checkout", "api"}},
		{Name: "free"},
		{Name: "large", Options: []string{strings.Repeat("a", 2000), strings.Repeat("b", 2000), strings.Repeat("c", 2000)}},
		{Name: "after", Options: []string{strings.Repeat("y", 200)}},
	}
	variables := dashboardQueryVariables(definitions)
	if len(variables) != 4 || variables[0].Name != "service" || variables[0].Label != label || valueText(*variables[0].DefaultValue) != "checkout" || len(variables[0].Options) != 2 || variables[0].OptionsOmitted != 0 {
		t.Fatalf("declared definition not reported in order: %+v", variables)
	}
	if variables[1].DefaultValue != nil || variables[1].Options != nil || variables[1].OptionsOmitted != 0 {
		t.Fatalf("free variable must report no default or options: %+v", variables[1])
	}
	// The 4 KiB budget lists two 2000-byte options, then counts the third as omitted; the budget left for later variables is small.
	if len(variables[2].Options) != 2 || variables[2].OptionsOmitted != 1 {
		t.Fatalf("options past the byte budget must be counted, not listed: %+v", variables[2])
	}
	if len(variables[3].Options) != 0 || variables[3].OptionsOmitted != 1 {
		t.Fatalf("budget exhausted by an earlier variable must omit later options: %+v", variables[3])
	}
	if dashboardQueryVariables(nil) != nil {
		t.Fatal("a dashboard without variables must report none")
	}
}

func TestDashboardVariableWarningsNameOverridesOutsideDeclaredOptions(t *testing.T) {
	definitions := []dashboardReadVariable{
		{Name: "service", Options: []string{"omega", "delta"}},
		{Name: "free"},
	}
	if warnings := dashboardVariableWarnings(definitions, variableValues(map[string]string{"service": "prod", "free": "anything"})); len(warnings) != 1 || warnings[0] != "service=prod is not one of the declared options" {
		t.Fatalf("override outside options must warn once and never a variable without options: %v", warnings)
	}
	if warnings := dashboardVariableWarnings(definitions, variableValues(map[string]string{"service": "delta"})); len(warnings) != 0 {
		t.Fatalf("declared option warned: %v", warnings)
	}
	if warnings := dashboardVariableWarnings(definitions, nil); len(warnings) != 0 {
		t.Fatalf("no override must not warn: %v", warnings)
	}
}

// The option budget counts the bytes the encoder writes, so escaped text cannot push the reported definitions past
// the 4 KiB budget. Ten 400-character options escape to 2402 bytes each: one fits, and the rest are counted.
func TestDashboardQueryVariablesBudgetCountsEncodedBytes(t *testing.T) {
	options := make([]string, 10)
	for index := range options {
		options[index] = strings.Repeat("<", 400)
	}
	variables := dashboardQueryVariables([]dashboardReadVariable{{Name: "service", Options: options}})
	if len(variables[0].Options) != 1 || variables[0].OptionsOmitted != 9 {
		t.Fatalf("escaped options must count against the encoded budget: listed=%d omitted=%d", len(variables[0].Options), variables[0].OptionsOmitted)
	}
	encoded, err := json.Marshal(variables)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) > dashboardVariableDetailBytes+256 {
		t.Fatalf("definitions encode to %d bytes, past the %d byte budget", len(encoded), dashboardVariableDetailBytes)
	}
}

// A label and default that do not fit the budget are left out with detailOmitted, and a later variable still
// reports its own label and default. The budget is not spent on the omitted detail.
func TestDashboardQueryVariablesOmitDetailPastBudgetAndKeepLaterDetail(t *testing.T) {
	large := strings.Repeat("<", 1024)
	small := "Region"
	fallback := "eu"
	variables := dashboardQueryVariables([]dashboardReadVariable{
		{Name: "service", Label: large, DefaultValue: valuePtr(large)},
		{Name: "region", Label: small, DefaultValue: valuePtr(fallback)},
	})
	if !variables[0].DetailOmitted || variables[0].Label != "" || variables[0].DefaultValue != nil {
		t.Fatalf("oversized label and default must be omitted with detailOmitted: %+v", variables[0])
	}
	if variables[1].DetailOmitted || variables[1].Label != small || variables[1].DefaultValue == nil || valueText(*variables[1].DefaultValue) != fallback {
		t.Fatalf("later variable must keep its detail: %+v", variables[1])
	}
}

// A warning names an override value shortened to a bounded length, so a long value keeps the reason visible.
func TestDashboardVariableWarningsBoundTheOverrideValue(t *testing.T) {
	definitions := []dashboardReadVariable{{Name: "service", Options: []string{"omega"}}}
	long := strings.Repeat("x", 300)
	warnings := dashboardVariableWarnings(definitions, variableValues(map[string]string{"service": long}))
	if len(warnings) != 1 {
		t.Fatalf("warnings = %v", warnings)
	}
	if !strings.HasSuffix(warnings[0], " is not one of the declared options") || len(warnings[0]) > 200 {
		t.Fatalf("warning must keep its reason inside 200 bytes: %q (%d bytes)", warnings[0], len(warnings[0]))
	}
	if !strings.Contains(warnings[0], "…") {
		t.Fatalf("a shortened value must be marked: %q", warnings[0])
	}
	multibyte := strings.Repeat("é", 40)
	warnings = dashboardVariableWarnings(definitions, variableValues(map[string]string{"service": multibyte}))
	if len(warnings) != 1 || !utf8.ValidString(warnings[0]) {
		t.Fatalf("a shortened multibyte value must stay valid UTF-8: %q", warnings)
	}
}

func TestDashboardQueryVariablesMarkSourcedFallbacks(t *testing.T) {
	definitions := []dashboardReadVariable{
		{Name: "service", Options: []string{"api"}, Source: &dashboardReadVariableSource{Type: "labelValues"}},
	}
	variables := dashboardQueryVariables(definitions)
	if len(variables) != 1 || variables[0].Source != "labelValues" || len(variables[0].FallbackOptions) != 1 || len(variables[0].Options) != 0 {
		t.Fatalf("sourced variable must report its static options as fallback options, not choices: %+v", variables)
	}
	// The fallback list is not the choice list, and the source is not resolved, so an override is not warned about.
	if warnings := dashboardVariableWarnings(definitions, variableValues(map[string]string{"service": "delta"})); len(warnings) != 0 {
		t.Fatalf("override of a sourced variable warned against its fallback options: %v", warnings)
	}
}

// An empty override of a sourced variable is still named, since no source value can be empty.
func TestDashboardVariableWarningsFlagEmptySourcedOverrides(t *testing.T) {
	definitions := []dashboardReadVariable{
		{Name: "service", Options: []string{"api"}, Source: &dashboardReadVariableSource{Type: "savedQuery"}},
	}
	warnings := dashboardVariableWarnings(definitions, variableValues(map[string]string{"service": ""}))
	if len(warnings) != 1 || !strings.HasPrefix(warnings[0], "service= is empty") {
		t.Fatalf("empty override of a sourced variable must warn: %v", warnings)
	}
	if warnings := dashboardVariableWarnings(definitions, variableValues(map[string]string{"service": "not-in-fallback"})); len(warnings) != 0 {
		t.Fatalf("sourced override must not warn against fallback options: %v", warnings)
	}
}

// Each sourced variable reports a source summary with its kind, identifiers and whether it depends on another
// variable. Selector and binding text is not reported.
func TestDashboardQueryVariablesReportSourceSummaries(t *testing.T) {
	selector := `up{cluster={{cluster}}}`
	plain := "up"
	definitions := []dashboardReadVariable{
		{Name: "cluster", Source: &dashboardReadVariableSource{Type: "labelValues", ProviderID: "prom-1", Label: "cluster"}},
		{Name: "service", Source: &dashboardReadVariableSource{Type: "labelValues", ProviderID: "prom-1", Label: "service", Selector: &selector}},
		{Name: "pod", Source: &dashboardReadVariableSource{Type: "labelValues", ProviderID: "prom-1", Label: "pod", Selector: &plain}},
		{Name: "owner", Source: &dashboardReadVariableSource{Type: "savedQuery", Field: "owner", QueryRef: &dashboardReadReference{ID: "sq-1", Bindings: []dashboardReadBinding{{Parameter: "team", Source: "variable", Variable: "cluster"}}}}},
		{Name: "team", Source: &dashboardReadVariableSource{Type: "savedQuery", Field: "team", QueryRef: &dashboardReadReference{ID: "sq-2", Bindings: []dashboardReadBinding{{Parameter: "x", Source: "constant", Value: json.RawMessage(`"a"`)}}}}},
	}
	variables := dashboardQueryVariables(definitions)
	want := []DashboardQueryVariableSource{
		{Kind: "labelValues", ProviderID: "prom-1", Label: "cluster"},
		{Kind: "labelValues", ProviderID: "prom-1", Label: "service", DependsOnVariables: true},
		{Kind: "labelValues", ProviderID: "prom-1", Label: "pod"},
		{Kind: "savedQuery", SavedQueryID: "sq-1", Field: "owner", DependsOnVariables: true},
		{Kind: "savedQuery", SavedQueryID: "sq-2", Field: "team"},
	}
	for index, variable := range variables {
		if variable.SourceSummary == nil || *variable.SourceSummary != want[index] {
			t.Fatalf("%s: source summary = %+v, want %+v", variable.Name, variable.SourceSummary, want[index])
		}
	}
	unsourced := dashboardQueryVariables([]dashboardReadVariable{{Name: "free"}})
	if unsourced[0].SourceSummary != nil {
		t.Fatal("a variable without a source must report no source summary")
	}
	encoded, err := json.Marshal(variables[1])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "{{cluster}}") {
		t.Fatalf("source summary must not echo the selector text: %s", encoded)
	}
}

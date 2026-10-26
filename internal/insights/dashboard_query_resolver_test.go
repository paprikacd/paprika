package insights

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestDashboardSavedQueryTypedBindingsAndExplicitDefaults(t *testing.T) {
	saved := SavedQuery{ProviderID: "prometheus", Kind: "metrics", Query: `metric{service={{service}}} > {{threshold}}`, Parameters: []SavedQueryParameter{{Name: "service", Type: "string", DefaultValue: json.RawMessage(`"saved-service"`)}, {Name: "threshold", Type: "number", DefaultValue: json.RawMessage(`5`)}}}
	for _, test := range []struct {
		name       string
		bindings   []dashboardReadBinding
		variables  map[string]string
		expression string
		wantError  bool
	}{
		{name: "saved defaults do not implicitly bind a same-named dashboard variable", variables: map[string]string{"service": "dashboard-service"}, expression: `metric{service="saved-service"} > 5`},
		{name: "explicit variable and numeric conversion", bindings: []dashboardReadBinding{{Parameter: "service", Source: "variable", Variable: "service"}, {Parameter: "threshold", Source: "variable", Variable: "limit"}}, variables: map[string]string{"service": "api", "limit": "1e3"}, expression: `metric{service="api"} > 1000`},
		{name: "constant", bindings: []dashboardReadBinding{{Parameter: "service", Source: "constant", Value: json.RawMessage(`"constant"`)}}, expression: `metric{service="constant"} > 5`},
		{name: "missing explicit variable must not use default", bindings: []dashboardReadBinding{{Parameter: "service", Source: "variable", Variable: "unknown"}}, wantError: true},
		{name: "numeric whitespace rejected", bindings: []dashboardReadBinding{{Parameter: "threshold", Source: "variable", Variable: "limit"}}, variables: map[string]string{"limit": " 1 "}, wantError: true},
		{name: "numeric expression rejected", bindings: []dashboardReadBinding{{Parameter: "threshold", Source: "variable", Variable: "limit"}}, variables: map[string]string{"limit": "1 + 2"}, wantError: true},
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
	if _, err := resolveDashboardSavedQuery(&saved, dashboardReadReference{}, map[string]string{"service": "implicit"}); err == nil {
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

package insights

import (
	"encoding/json"
	"strings"
	"testing"
)

func variablesWithSource(t *testing.T, variables ...map[string]any) error {
	t.Helper()
	raw, err := json.Marshal(variables)
	if err != nil {
		t.Fatal(err)
	}
	return validateDashboardVariables(raw)
}

func TestDashboardVariableSourcesAccepted(t *testing.T) {
	cases := map[string][]map[string]any{
		"label values": {
			{"name": "cluster", "source": map[string]any{"type": "labelValues", "providerId": "prom", "label": "cluster"}},
		},
		"selector with placeholder": {
			{"name": "cluster", "defaultValue": "omega"},
			{"name": "service", "source": map[string]any{"type": "labelValues", "providerId": "prom", "label": "service", "selector": `up{cluster={{cluster}}}`, "limit": 50}},
		},
		"bare metric selector": {
			{"name": "service", "source": map[string]any{"type": "labelValues", "providerId": "prom", "label": "service", "selector": "up"}},
		},
		"saved query column with variable and constant bindings": {
			{"name": "cluster", "options": []string{"omega", "delta"}},
			{"name": "service", "source": map[string]any{
				"type":     "savedQuery",
				"field":    "service",
				"queryRef": map[string]any{"id": "services", "bindings": []map[string]any{{"parameter": "cluster", "source": "variable", "variable": "cluster"}, {"parameter": "window", "source": "constant", "value": "1h"}}},
				"limit":    100,
			}},
		},
		"source with static fallback": {
			{"name": "service", "options": []string{"api", "worker"}, "source": map[string]any{"type": "labelValues", "providerId": "prom", "label": "service"}},
		},
	}
	for name, variables := range cases {
		t.Run(name, func(t *testing.T) {
			if err := variablesWithSource(t, variables...); err != nil {
				t.Fatalf("valid source rejected: %v", err)
			}
		})
	}
}

func TestDashboardVariableSourcesRejected(t *testing.T) {
	label := func(overrides map[string]any) map[string]any {
		source := map[string]any{"type": "labelValues", "providerId": "prom", "label": "service"}
		for key, value := range overrides {
			if value == nil {
				delete(source, key)
				continue
			}
			source[key] = value
		}
		return map[string]any{"name": "service", "source": source}
	}
	cases := map[string][]map[string]any{
		"unknown source type":        {{"name": "service", "source": map[string]any{"type": "sql", "providerId": "prom", "label": "service"}}},
		"source is a string":         {{"name": "service", "source": "labelValues"}},
		"source is an array":         {{"name": "service", "source": []any{}}},
		"unknown source member":      {label(map[string]any{"refresh": "load"})},
		"missing provider":           {label(map[string]any{"providerId": nil})},
		"bad provider":               {label(map[string]any{"providerId": "bad id"})},
		"empty label":                {label(map[string]any{"label": ""})},
		"long label":                 {label(map[string]any{"label": strings.Repeat("l", 129)})},
		"limit zero":                 {label(map[string]any{"limit": 0})},
		"limit over 100":             {label(map[string]any{"limit": 101})},
		"empty selector":             {label(map[string]any{"selector": ""})},
		"long selector":              {label(map[string]any{"selector": "up{a=\"" + strings.Repeat("x", 1025) + "\"}"})},
		"selector two matcher lists": {label(map[string]any{"selector": `up{a="1"}{b="2"}`})},
		"selector with spaces":       {label(map[string]any{"selector": "up {a=\"1\"}"})},
		"placeholder undeclared":     {label(map[string]any{"selector": `up{cluster={{cluster}}}`})},
		"placeholder not a name":     {label(map[string]any{"selector": `up{cluster={{a-b}}}`})},
		"selector self reference": {
			{"name": "service", "source": map[string]any{"type": "labelValues", "providerId": "prom", "label": "service", "selector": `up{service={{service}}}`}},
		},
		"two variable cycle": {
			{"name": "cluster", "source": map[string]any{"type": "labelValues", "providerId": "prom", "label": "cluster", "selector": `up{service={{service}}}`}},
			{"name": "service", "source": map[string]any{"type": "savedQuery", "field": "service", "queryRef": map[string]any{"id": "services", "bindings": []map[string]any{{"parameter": "cluster", "source": "variable", "variable": "cluster"}}}}},
		},
		"saved query binding self reference": {
			{"name": "service", "source": map[string]any{"type": "savedQuery", "field": "service", "queryRef": map[string]any{"id": "services", "bindings": []map[string]any{{"parameter": "service", "source": "variable", "variable": "service"}}}}},
		},
		"saved query binding undeclared": {
			{"name": "service", "source": map[string]any{"type": "savedQuery", "field": "service", "queryRef": map[string]any{"id": "services", "bindings": []map[string]any{{"parameter": "cluster", "source": "variable", "variable": "cluster"}}}}},
		},
		"saved query label binding refused": {
			{"name": "service", "source": map[string]any{"type": "savedQuery", "field": "service", "queryRef": map[string]any{"id": "services", "bindings": []map[string]any{{"parameter": "cluster", "source": "label", "label": "cluster"}}}}},
		},
		"saved query missing id": {
			{"name": "service", "source": map[string]any{"type": "savedQuery", "field": "service", "queryRef": map[string]any{}}},
		},
		"saved query empty field": {
			{"name": "service", "source": map[string]any{"type": "savedQuery", "field": "", "queryRef": map[string]any{"id": "services"}}},
		},
		"saved query limit over 100": {
			{"name": "service", "source": map[string]any{"type": "savedQuery", "field": "service", "queryRef": map[string]any{"id": "services"}, "limit": 101}},
		},
	}
	for name, variables := range cases {
		t.Run(name, func(t *testing.T) {
			if err := variablesWithSource(t, variables...); err == nil {
				t.Fatal("invalid variable source accepted")
			}
		})
	}
}

func TestDashboardVariableSourceCycleMessage(t *testing.T) {
	err := variablesWithSource(t,
		map[string]any{"name": "cluster", "source": map[string]any{"type": "labelValues", "providerId": "prom", "label": "cluster", "selector": `up{service={{service}}}`}},
		map[string]any{"name": "service", "source": map[string]any{"type": "labelValues", "providerId": "prom", "label": "service", "selector": `up{cluster={{cluster}}}`}},
	)
	if err == nil || !strings.Contains(err.Error(), "must not depend on themselves or form a cycle") {
		t.Fatalf("cycle not reported as a cycle: %v", err)
	}
}

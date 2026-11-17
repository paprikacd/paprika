package insights

import (
	"encoding/json"
	"strings"
	"testing"
)

func queryReferenceDashboard(t *testing.T, ref any, tooltip bool) []byte {
	t.Helper()
	var document map[string]any
	_ = json.Unmarshal(dashboard("portable", "Portable"), &document)
	widget := testFixtureObject(t, document, "widgets", 0)
	if tooltip {
		widget["options"] = map[string]any{"tooltipView": map[string]any{"type": "stat", "source": map[string]any{"type": "saved", "ref": ref}}}
	} else {
		widget["queryRef"] = ref
	}
	return savedQueryJSON(t, document)
}

func TestSavedQueryReferenceValidationAndPortablePersistence(t *testing.T) {
	baseBindings := []any{
		map[string]any{"parameter": "service", "source": "variable", "variable": "dashboard_service"},
		map[string]any{"parameter": "minimum", "source": "constant", "value": -7.25},
		map[string]any{"parameter": "pattern", "source": "constant", "value": "quotes\"\\\n{{literal}}"},
	}
	for _, tooltip := range []bool{false, true} {
		bindings := append([]any{}, baseBindings...)
		if tooltip {
			bindings = append(bindings,
				map[string]any{"parameter": "label", "source": "label", "label": "service.name"},
				map[string]any{"parameter": "value", "source": "field", "field": "value"},
				map[string]any{"parameter": "time", "source": "field", "field": "timestamp"},
				map[string]any{"parameter": "series", "source": "field", "field": "series"},
			)
		}
		// Missing library, parameter names and dashboard variables are checked at
		// runtime, so portable imports may retain these references losslessly.
		ref := map[string]any{"id": "not-installed", "bindings": bindings}
		raw := queryReferenceDashboard(t, ref, tooltip)
		if err := validateDashboard("portable", raw); err != nil {
			t.Fatalf("portable reference, tooltip=%v: %v", tooltip, err)
		}
		s, store := testService(t)
		w := request(t, s.Handler(), "PUT", "/api/dashboards/portable", raw, nil)
		if w.Code != 200 {
			t.Fatalf("save portable reference: %d %s", w.Code, w.Body)
		}
		reopened, err := OpenStore(store.dir)
		if err != nil {
			t.Fatal(err)
		}
		got, _, err := reopened.Get("portable")
		if err != nil || string(got) != string(raw) {
			t.Fatalf("reference lost on restart: %v", err)
		}
	}
}

func TestSavedQueryReferencesRejectMixedUnknownNullOrUnboundedFields(t *testing.T) {
	for _, tooltip := range []bool{false, true} {
		invalid := []any{
			nil, "query", map[string]any{}, map[string]any{"id": "../query"}, map[string]any{"id": "query", "version": 1},
			map[string]any{"id": "query", "bindings": nil}, map[string]any{"id": "query", "bindings": make([]any, 21)},
		}
		for _, binding := range []any{
			nil,
			map[string]any{"parameter": "p", "source": "variable"},
			map[string]any{"parameter": "p", "source": "variable", "variable": "constructor"},
			map[string]any{"parameter": "constructor", "source": "constant", "value": 1},
			map[string]any{"parameter": "p", "source": "variable", "variable": "x", "value": 1},
			map[string]any{"parameter": "p", "source": "constant", "value": true},
			map[string]any{"parameter": "p", "source": "constant", "value": nil},
			map[string]any{"parameter": "p", "source": "constant", "value": strings.Repeat("界", 1025)},
			map[string]any{"parameter": "p", "source": "constant", "value": 1, "label": "x"},
			map[string]any{"parameter": "p", "source": "field", "field": "invalid"},
			map[string]any{"parameter": "p", "source": "field", "field": "value", "label": "x"},
			map[string]any{"parameter": "p", "source": "label", "label": ""},
			map[string]any{"parameter": "p", "source": "label", "label": strings.Repeat("x", 129)},
			map[string]any{"parameter": "p", "source": "query", "query": "up"},
		} {
			invalid = append(invalid, map[string]any{"id": "query", "bindings": []any{binding}})
		}
		invalid = append(invalid, map[string]any{"id": "query", "bindings": []any{
			map[string]any{"parameter": "duplicate", "source": "variable", "variable": "x"},
			map[string]any{"parameter": "duplicate", "source": "constant", "value": 1},
		}})
		if !tooltip {
			for _, binding := range []any{
				map[string]any{"parameter": "p", "source": "field", "field": "value"},
				map[string]any{"parameter": "p", "source": "label", "label": "service"},
			} {
				invalid = append(invalid, map[string]any{"id": "query", "bindings": []any{binding}})
			}
		}
		for _, ref := range invalid {
			raw := queryReferenceDashboard(t, ref, tooltip)
			if err := validateDashboard("portable", raw); err == nil {
				t.Fatalf("invalid reference accepted, tooltip=%v: %s", tooltip, raw)
			}
		}
	}
}

func TestTooltipWidgetResultSourceAndSavedSourceStrictness(t *testing.T) {
	for _, source := range []string{`{"type":"widget"}`, `{"type":"saved","ref":{"id":"query"}}`} {
		for _, viewType := range []string{"stat", "traces"} {
			raw := json.RawMessage(`{"type":"` + viewType + `","source":` + source + `}`)
			if err := validateTooltipView(raw); err != nil {
				t.Fatalf("valid source %s type %s: %v", source, viewType, err)
			}
		}
	}
	for _, source := range []string{
		`{"type":"widget","widgetId":"other"}`, `{"type":"widget","bindings":[]}`, `{"type":"saved"}`,
		`{"type":"saved","ref":null}`, `{"type":"saved","ref":{"id":"query"},"query":"up"}`,
	} {
		if err := validateTooltipView(json.RawMessage(`{"type":"stat","source":` + source + `}`)); err == nil {
			t.Fatalf("invalid source accepted: %s", source)
		}
	}
}

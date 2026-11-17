package insights

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTooltipPresentationContract(t *testing.T) {
	valid := `{"tooltipTitle":"Checkout latency","tooltipValueLabel":"p95","tooltipShowUnit":false,"tooltipDecimals":3,"decimals":1}`
	s, _ := testService(t)
	document := extendedDashboard(`"type":"stat","options":`+valid, "")
	w := request(t, s.Handler(), "PUT", "/api/dashboards/demo", document, nil)
	if w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body)
	}
	w = request(t, s.Handler(), "GET", "/api/dashboards/demo", nil, nil)
	var result struct {
		Widgets []struct {
			Options map[string]any `json:"options"`
		} `json:"widgets"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if got := result.Widgets[0].Options; got["tooltipTitle"] != "Checkout latency" || got["tooltipValueLabel"] != "p95" || got["tooltipShowUnit"] != false || got["tooltipDecimals"] != float64(3) || got["decimals"] != float64(1) {
		t.Fatalf("settings lost: %#v", got)
	}
	for _, invalid := range []string{
		`{"tooltipTitle":null}`, `{"tooltipTitle":1}`, `{"tooltipValueLabel":null}`, `{"tooltipShowUnit":null}`, `{"tooltipShowUnit":"yes"}`, `{"tooltipDecimals":null}`, `{"tooltipDecimals":-1}`, `{"tooltipDecimals":9}`, `{"tooltipDecimals":1.5}`, `{"tooltipDecimals":1e400}`, `{"tooltipStyle":"color:red"}`,
		`{"tooltipTitle":"` + strings.Repeat("x", 121) + `"}`, `{"tooltipValueLabel":"` + strings.Repeat("x", 81) + `"}`,
	} {
		if err := validateWidgetOptions(json.RawMessage(invalid)); err == nil {
			t.Errorf("accepted invalid %s", invalid)
		}
	}
	for _, allowed := range []string{`{}`, `{"tooltipTitle":"","tooltipValueLabel":""}`, `{"tooltipDecimals":0}`, `{"tooltipDecimals":8}`} {
		if err := validateWidgetOptions(json.RawMessage(allowed)); err != nil {
			t.Errorf("rejected %s: %v", allowed, err)
		}
	}
}

func TestWidgetNumberBoundsPreservesValidationOrder(t *testing.T) {
	cases := []struct {
		name   string
		values map[string]float64
		want   string
	}{
		{"defaults", nil, ""},
		{"precision endpoints", map[string]float64{"tooltipDecimals": 0, "decimals": 8}, ""},
		{"tooltip negative", map[string]float64{"tooltipDecimals": -1}, "tooltip decimals must be an integer from 0 to 8"},
		{"tooltip fraction", map[string]float64{"tooltipDecimals": 1.5}, "tooltip decimals must be an integer from 0 to 8"},
		{"tooltip above maximum", map[string]float64{"tooltipDecimals": 9}, "tooltip decimals must be an integer from 0 to 8"},
		{"widget precision", map[string]float64{"decimals": 9}, "decimals must be an integer from 0 to 8"},
		{"stale first", map[string]float64{"staleAfterSeconds": 0, "tooltipDecimals": 9}, "stale sample threshold must be an integer from 1 to 2678400 seconds"},
		{"tooltip before widget", map[string]float64{"tooltipDecimals": 9, "decimals": 9}, "tooltip decimals must be an integer from 0 to 8"},
		{"precision before appearance", map[string]float64{"decimals": 9, "lineWidth": 0}, "decimals must be an integer from 0 to 8"},
		{"line width", map[string]float64{"lineWidth": 0}, "line width must be from 0.5 to 8"},
		{"opacity", map[string]float64{"fillOpacity": 2}, "fill opacity must be from 0 to 1"},
		{"range", map[string]float64{"min": 5, "max": 5}, "maximum must exceed minimum"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateWidgetNumberBounds(tc.values)
			got := ""
			if err != nil {
				got = err.Error()
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestWidgetOptionRefactorsPreserveValidationOrder(t *testing.T) {
	cases := []struct{ name, raw, want string }{
		{"valid presentation", `{"display":"area","sparklinePlacement":"side","statIcon":"activity","curve":"step","showStatBar":true,"min":0,"max":100,"tooltipDecimals":3}`, ""},
		{"color before display", `{"background":"red","display":"bad"}`, "widget colors must be six-digit hex colors"},
		{"display before icon", `{"display":"bad","statIcon":"bad"}`, "display must be line or area"},
		{"icon before curve", `{"statIcon":"bad","curve":"bad"}`, "invalid statIcon"},
		{"placement", `{"sparklinePlacement":"bad"}`, "invalid sparklinePlacement"},
		{"curve type", `{"curve":42}`, "curve must be linear, step, or monotone"},
		{"numeric type before absent bar bounds", `{"tooltipDecimals":"invalid","showStatBar":true}`, "widget numeric settings must be finite"},
		{"bar minimum before precision", `{"tooltipDecimals":9,"showStatBar":true}`, "stat bar requires an explicit minimum"},
		{"bar maximum before precision", `{"tooltipDecimals":9,"showStatBar":true,"min":0}`, "stat bar requires an explicit maximum"},
		{"disabled bar", `{"showStatBar":false}`, ""},
		{"valid rule", `{"seriesColors":[{"label":"service","value":"checkout","color":"#112233"}]}`, ""},
		{"duplicate rule", `{"seriesColors":[{"label":"service","value":"checkout","color":"#112233"},{"label":"service","value":"checkout","color":"#445566"}]}`, "duplicate series color label and value"},
		{"malformed duplicate before duplicate detection", `{"seriesColors":[{"label":"service","value":"checkout","color":"#112233"},{"label":"service","value":"checkout","color":"red"}]}`, "series colors require a valid metric label, nonempty value, and six-digit hex color"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateWidgetOptions(json.RawMessage(tc.raw))
			got := ""
			if err != nil {
				got = err.Error()
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestWidgetAnnotationRefactorPreservesValidationOrder(t *testing.T) {
	cases := []struct{ name, raw, want string }{
		{"invalid type before malformed annotation", `{"type":false,"annotationSource":null}`, "event queries require a time-series or directional-traffic widget"},
		{"invalid plugin before malformed annotation", `{"type":"plugin","pluginId":3,"annotationSource":null}`, "event queries require a time-series or directional-traffic widget"},
		{"column before widget query reference", `{"type":"timeseries","queryRef":null,"annotationSource":{"queryRef":{"id":"events"},"timestampColumn":" date ","labelColumn":"label"}}`, "event query column names must contain 1–128 characters"},
		{"valid optional columns", `{"type":"timeseries","annotationSource":{"queryRef":{"id":"events"},"timestampColumn":"date","labelColumn":"label","endColumn":"end","severityColumn":"severity"}}`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var widget map[string]json.RawMessage
			if err := json.Unmarshal([]byte(tc.raw), &widget); err != nil {
				t.Fatal(err)
			}
			err := validateWidgetExtensions(widget)
			got := ""
			if err != nil {
				got = err.Error()
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

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

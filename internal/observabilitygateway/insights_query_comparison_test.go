package observabilitygateway

import (
	"encoding/json"
	"strings"
	"testing"
)

// A stat's comparison reaches the text synopsis with its state and direction, and a state that is not a change says why.
func TestDashboardQueryTextNamesEachStatsComparison(t *testing.T) {
	summary := `{"schemaVersion":1,"dashboard":{"id":"overview","etag":"e"},"signals":[],"widgets":[` +
		`{"id":"rate","title":"Rate","type":"stat","unit":"req/s","comparison":{"state":"ok","window":"previous","offsetSeconds":3600,"delta":12,"percent":12,"changeUnit":"req/s","direction":"up","assessment":"better"}},` +
		`{"id":"errors","title":"Errors","type":"stat","unit":"%","comparison":{"state":"not_run","window":"1d","offsetSeconds":86400,"changeUnit":"pp","reason":"time_budget"}}` +
		`],"queryCount":{"planned":0,"executed":0,"deduplicated":0}}`
	text, err := dashboardQueryText(json.RawMessage(summary))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`widget "rate": change vs 1 h earlier: state="ok" delta=+12 req/s percent=+12% direction=up assessment=better`, `widget "errors": change vs 1 d earlier: state="not_run" reason="time_budget"`} {
		if !strings.Contains(text, want) {
			t.Fatalf("text lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, `widget "errors": change vs "1d" earlier: state="not_run" delta=`) {
		t.Fatal("a comparison that did not run must not show a change")
	}
}

// The change follows the widget's decimals, and a percentage change keeps its percent unit.
func TestDashboardQueryTextFormatsComparisonAtTheWidgetDecimals(t *testing.T) {
	summary := `{"schemaVersion":1,"dashboard":{"id":"overview","etag":"e"},"signals":[],"widgets":[` +
		`{"id":"rate","title":"Rate","type":"stat","unit":"req/s","decimals":2,"comparison":{"state":"ok","window":"previous","offsetSeconds":3600,"delta":12,"percent":50,"changeUnit":"req/s","direction":"up"}},` +
		`{"id":"errors","title":"Errors","type":"stat","unit":"%","decimals":1,"comparison":{"state":"ok","window":"1d","offsetSeconds":86400,"delta":0.25,"percent":12.5,"changeUnit":"pp","direction":"up"}}` +
		`],"queryCount":{"planned":0,"executed":0,"deduplicated":0}}`
	text, err := dashboardQueryText(json.RawMessage(summary))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`delta=+12.00 req/s percent=+50.00%`, `delta=+0.3 pp percent=+12.5%`} {
		if !strings.Contains(text, want) {
			t.Fatalf("text lacks %q:\n%s", want, text)
		}
	}
}

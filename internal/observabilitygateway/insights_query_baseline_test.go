package observabilitygateway

import (
	"encoding/json"
	"strings"
	"testing"
)

// A time series' band reaches the text synopsis with its window and the share outside it. The share follows the widget's
// decimals, Auto keeps three significant figures, and a share with an outside sample never reads as zero.
func TestDashboardQueryTextNamesEachBaseline(t *testing.T) {
	summary := `{"schemaVersion":1,"dashboard":{"id":"overview","etag":"e"},"signals":[],"widgets":[` +
		`{"id":"rate","title":"Rate","type":"timeseries","unit":"req/s","baseline":{"state":"ok","window":"previous","band":"range","offsetSeconds":3600,"evaluated":240,"outside":30,"fraction":0.125}},` +
		`{"id":"cpu","title":"CPU","type":"timeseries","unit":"%","decimals":1,"baseline":{"state":"ok","window":"rolling","band":"range","evaluated":1000,"outside":1,"fraction":0.001}},` +
		`{"id":"mem","title":"Memory","type":"timeseries","unit":"B","decimals":2,"baseline":{"state":"partial","window":"1d","band":"p10p90","offsetSeconds":86400,"evaluated":3,"outside":1,"fraction":0.3333333333333333}}` +
		`],"queryCount":{"planned":0,"executed":0,"deduplicated":0}}`
	text, err := dashboardQueryText(json.RawMessage(summary))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`widget "rate": baseline 1 h earlier: state="ok" outside the 1 h earlier range in 12.5% of samples evaluated=240 outside=30`,
		`widget "cpu": baseline rolling: state="ok" outside the rolling range in 0.1% of samples evaluated=1000 outside=1`,
		`widget "mem": baseline 1 d earlier: state="partial" outside the 1 d earlier range in 33.33% of samples evaluated=3 outside=1`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("text lacks %q:\n%s", want, text)
		}
	}
}

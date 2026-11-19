package insights

import (
	"strings"
	"testing"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
)

// A rank with a status source the UI can draw passes. The status-badge case names a mapping; the numeric case
// names a status through the widget's bands or the column's own.
func TestRecordRankAcceptsAStatusSource(t *testing.T) {
	badge := lintFor(t, documentWithWidgets("badge", tableWidget("badge",
		`{"rank":{"status":"health","value":"cpu"},"cellStyles":[{"column":"health","display":"status-badge","mappings":[{"value":"Down","status":"critical"}]}]}`, false)))
	requireNoHits(t, badge, "plugin.record-rank")
	numeric := lintFor(t, documentWithWidgets("numeric", tableWidget("numeric",
		`{"rank":{"status":"cpu"}}`, true)))
	requireNoHits(t, numeric, "plugin.record-rank")
	own := lintFor(t, documentWithWidgets("own", tableWidget("own",
		`{"rank":{"status":"budget"},"cellStyles":[{"column":"budget","display":"bar","min":0,"max":100,"thresholds":[{"value":0,"status":"critical"}]}]}`, false)))
	requireNoHits(t, own, "plugin.record-rank")
}

// A rank whose status names no mapping, no status band, or a colour-only band cannot rank. The hit is an error
// that blocks the save, and its pointer names the rank.
func TestRecordRankWithoutAStatusSourceIsAnError(t *testing.T) {
	cases := map[string]string{
		"unmapped badge":   `{"rank":{"status":"health"},"cellStyles":[{"column":"health","display":"status-badge","mappings":[{"value":"Down","color":"#aa0000"}]}]}`,
		"colour-only band": `{"rank":{"status":"budget"},"cellStyles":[{"column":"budget","display":"bar","min":0,"max":100,"thresholds":[{"value":0,"color":"#112233"}]}]}`,
		"sparkline column": `{"rank":{"status":"trend"},"cellStyles":[{"column":"trend","display":"sparkline"}]}`,
		"no bands at all":  `{"rank":{"status":"cpu"}}`,
		"same column":      `{"rank":{"status":"cpu","value":"cpu"}}`,
	}
	for name, config := range cases {
		t.Run(name, func(t *testing.T) {
			findings := lintFor(t, documentWithWidgets("rank", tableWidget("rank", config, false)))
			finding := requireOneHitAmong(t, findings, "plugin.record-rank", "/widgets/0/config/rank")
			if finding.GetSeverity() != insightsv1.Severity_SEVERITY_ERROR {
				t.Fatalf("severity = %v, want error", finding.GetSeverity())
			}
			if !strings.Contains(finding.GetMessage(), "ranks by status column") {
				t.Fatalf("message %q does not name the rank", finding.GetMessage())
			}
		})
	}
}

// A table that declares no rank is not checked by this rule.
func TestRecordRankIgnoresTablesWithoutRank(t *testing.T) {
	findings := lintFor(t, documentWithWidgets("plain", tableWidget("plain",
		`{"cellStyles":[{"column":"health","display":"status-badge","mappings":[{"value":"Down","color":"#aa0000"}]}]}`, false)))
	requireNoHits(t, findings, "plugin.record-rank")
}

// A rank whose own options cannot render is an error too, even when its status has a source. The schema refuses
// the same options at Apply, so this rule is the save-time guard for a rank authored through the API.
func TestRecordRankRejectsInvalidOptions(t *testing.T) {
	cases := map[string]struct {
		config  string
		message string
	}{
		"empty status":    {`{"rank":{"status":""}}`, "status is empty"},
		"limit zero":      {`{"rank":{"status":"cpu","limit":0}}`, "between 1 and 100"},
		"limit above 100": {`{"rank":{"status":"cpu","limit":101}}`, "between 1 and 100"},
		"unknown order":   {`{"rank":{"status":"cpu","order":"worst"}}`, "not descending or ascending"},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			findings := lintFor(t, documentWithWidgets("rank", tableWidget("rank", testCase.config, true)))
			finding := requireOneHitAmong(t, findings, "plugin.record-rank", "/widgets/0/config/rank")
			if finding.GetSeverity() != insightsv1.Severity_SEVERITY_ERROR {
				t.Fatalf("severity = %v, want error", finding.GetSeverity())
			}
			if !strings.Contains(finding.GetMessage(), testCase.message) {
				t.Fatalf("message %q does not contain %q", finding.GetMessage(), testCase.message)
			}
		})
	}
	valid := lintFor(t, documentWithWidgets("valid", tableWidget("valid", `{"rank":{"status":"cpu","order":"ascending","limit":100}}`, true)))
	requireNoHits(t, valid, "plugin.record-rank")
}

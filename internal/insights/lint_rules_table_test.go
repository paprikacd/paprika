package insights

import (
	"strings"
	"testing"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
)

// tableWidget is a record-table with the given config and, when thresholds is set, a widget Value band set.
func tableWidget(id, config string, thresholds bool) string {
	extra := `"dataKind":"records","config":` + config
	if thresholds {
		extra += `,"options":{"thresholds":[{"value":0,"status":"ok"},{"value":60,"status":"warning"},{"value":80,"status":"critical"}]}`
	}
	return pluginTestWidget(id, "record-table", extra)
}

// Fleet-style columns share one unit and one bar range, so they may share the widget bands. This is the
// shape the lint must leave alone.
func TestSharedThresholdsAcceptsColumnsOnOneScale(t *testing.T) {
	findings := lintFor(t, documentWithWidgets("fleet", tableWidget("resources",
		`{"cellStyles":[{"column":"cpu","display":"bar-segments","min":0,"max":100,"segments":20,"unit":"%"},{"column":"memory","display":"bar","min":0,"max":100,"unit":"%"},{"column":"disk","display":"color-text","unit":"%"}]}`, true)))
	requireNoHits(t, findings, "table.shared-thresholds")
}

// Two bars on different ranges, or different units, cannot share one band set without one reading on the
// wrong scale. The hit names the second column that differs from the first.
func TestSharedThresholdsWarnsOnColumnsWithDifferentScales(t *testing.T) {
	findings := lintFor(t, documentWithWidgets("scales", tableWidget("latency",
		`{"cellStyles":[{"column":"cpu","display":"bar","min":0,"max":100,"unit":"%"},{"column":"latency","display":"bar","min":0,"max":1000,"unit":"ms"}]}`, true)))
	finding := requireOneHitAmong(t, findings, "table.shared-thresholds", "/widgets/0/config/cellStyles/1")
	if finding.GetSeverity() != insightsv1.Severity_SEVERITY_WARNING {
		t.Fatalf("severity = %v, want warning", finding.GetSeverity())
	}
	if !strings.Contains(finding.GetMessage(), `column "latency"`) || !strings.Contains(finding.GetMessage(), "bar range 0 to 1000") {
		t.Fatalf("message %q does not name the columns and scales", finding.GetMessage())
	}
	if count := countRule(findings, "table.shared-thresholds"); count != 1 {
		t.Fatalf("table.shared-thresholds hits = %d, want one per widget", count)
	}
}

// A unit-only difference is a difference of scale too, even when neither column is a bar.
func TestSharedThresholdsWarnsOnDifferentUnitsWithoutBars(t *testing.T) {
	findings := lintFor(t, documentWithWidgets("units", tableWidget("mixed",
		`{"cellStyles":[{"column":"availability","display":"color-text","unit":"%"},{"column":"latency","display":"color-text","unit":"ms"}]}`, true)))
	requireOneHitAmong(t, findings, "table.shared-thresholds", "/widgets/0/config/cellStyles/1")
}

// A column with its own thresholds is not sharing the widget's set, so its scale does not matter. A
// widget without Value thresholds shares nothing, and a status badge never reads a band set.
func TestSharedThresholdsIgnoresOwnBandsAndWidgetsWithoutBands(t *testing.T) {
	ownBands := lintFor(t, documentWithWidgets("own", tableWidget("own",
		`{"cellStyles":[{"column":"cpu","display":"bar","min":0,"max":100,"unit":"%"},{"column":"latency","display":"bar","min":0,"max":1000,"unit":"ms","thresholds":[{"value":0,"status":"ok"}]}]}`, true)))
	requireNoHits(t, ownBands, "table.shared-thresholds")
	noBands := lintFor(t, documentWithWidgets("none", tableWidget("none",
		`{"cellStyles":[{"column":"cpu","display":"bar","min":0,"max":100,"unit":"%"},{"column":"latency","display":"bar","min":0,"max":1000,"unit":"ms"}]}`, false)))
	requireNoHits(t, noBands, "table.shared-thresholds")
	badge := lintFor(t, documentWithWidgets("badge", tableWidget("badge",
		`{"cellStyles":[{"column":"state","display":"status-badge","mappings":[{"value":"Up","status":"ok"}]},{"column":"cpu","display":"bar","min":0,"max":100,"unit":"%"}]}`, true)))
	requireNoHits(t, badge, "table.shared-thresholds")
}

// Only authored units are compared. A column that omits its unit may take the result column's unit at
// render time, so a unit-less column beside a percent column is not reported.
func TestSharedThresholdsDoesNotCompareOmittedUnits(t *testing.T) {
	findings := lintFor(t, documentWithWidgets("omitted", tableWidget("omitted",
		`{"cellStyles":[{"column":"availability","display":"color-text","unit":"%"},{"column":"uptime","display":"color-text"},{"column":"ratio","display":"color-text"}]}`, true)))
	requireNoHits(t, findings, "table.shared-thresholds")
}

// The rule reports one hit per widget, at the first column whose scale differs. A third column on another
// scale must not add a second hit.
func TestSharedThresholdsReportsOnlyTheFirstDifferingColumn(t *testing.T) {
	findings := lintFor(t, documentWithWidgets("three", tableWidget("three",
		`{"cellStyles":[{"column":"cpu","display":"bar","min":0,"max":100,"unit":"%"},{"column":"latency","display":"bar","min":0,"max":1000,"unit":"ms"},{"column":"memory","display":"bar","min":0,"max":500,"unit":"MB"}]}`, true)))
	requireOneHitAmong(t, findings, "table.shared-thresholds", "/widgets/0/config/cellStyles/1")
	if count := countRule(findings, "table.shared-thresholds"); count != 1 {
		t.Fatalf("table.shared-thresholds hits = %d, want one per widget", count)
	}
}

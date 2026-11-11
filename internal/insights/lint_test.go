package insights

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
	"github.com/benebsworth/paprika/internal/insights/guidance"
)

// lintFor runs the lint rules over a document and returns each finding as a
// rule id, pointer and message. Schema validity is the caller's job: the
// fixtures here are schema-valid unless a test says otherwise.
func lintFor(t *testing.T, document Dashboard) []*insightsv1.CheckFinding {
	t.Helper()
	return lintFindings(document)
}

func statWidget(id, layout, extra string) string {
	return widgetJSON(id, layout, `"type":"stat"`+withComma(extra))
}

func pluginTestWidget(id, pluginID, extra string) string {
	return widgetJSON(id, "", `"type":"plugin","pluginId":`+fmt.Sprintf("%q", pluginID)+`,"dataKind":"metrics"`+withComma(extra))
}

func withComma(extra string) string {
	if extra == "" {
		return ""
	}
	return "," + extra
}

func requireOneHit(t *testing.T, findings []*insightsv1.CheckFinding, ruleID, pointer string) *insightsv1.CheckFinding {
	t.Helper()
	var matched []*insightsv1.CheckFinding
	for _, finding := range findings {
		if finding.GetRuleId() == ruleID {
			matched = append(matched, finding)
		}
	}
	if len(matched) != 1 {
		t.Fatalf("%s hits = %d, want 1; findings = %v", ruleID, len(matched), findings)
	}
	if matched[0].GetPointer() != pointer {
		t.Fatalf("%s pointer = %q, want %q", ruleID, matched[0].GetPointer(), pointer)
	}
	if matched[0].GetSource() != insightsv1.Source_SOURCE_LINT {
		t.Fatalf("%s source = %v, want lint", ruleID, matched[0].GetSource())
	}
	return matched[0]
}

func requireNoHits(t *testing.T, findings []*insightsv1.CheckFinding, ruleID string) {
	t.Helper()
	for _, finding := range findings {
		if finding.GetRuleId() == ruleID {
			t.Fatalf("%s fired unexpectedly: %v", ruleID, finding)
		}
	}
}

func TestLintRegistryIsWellFormed(t *testing.T) {
	seen := map[string]bool{}
	want := map[string]insightsv1.Severity{
		"layout.overlap":             insightsv1.Severity_SEVERITY_ERROR,
		"layout.hole":                insightsv1.Severity_SEVERITY_WARNING,
		"variables.undeclared":       insightsv1.Severity_SEVERITY_WARNING,
		"stat.density":               insightsv1.Severity_SEVERITY_WARNING,
		"stat.unbounded-percent-bar": insightsv1.Severity_SEVERITY_WARNING,
		"description.provenance":     insightsv1.Severity_SEVERITY_WARNING,
		"axis.unit-in-label":         insightsv1.Severity_SEVERITY_WARNING,
		"plugin.unknown":             insightsv1.Severity_SEVERITY_WARNING,
	}
	if len(lintRules) != len(want) {
		t.Fatalf("registry has %d rules, want %d", len(lintRules), len(want))
	}
	for _, rule := range lintRules {
		if seen[rule.ID] {
			t.Fatalf("duplicate rule id %s", rule.ID)
		}
		seen[rule.ID] = true
		if severity, ok := want[rule.ID]; !ok || severity != rule.Severity {
			t.Fatalf("rule %s severity = %v, want %v", rule.ID, rule.Severity, want[rule.ID])
		}
		if !strings.HasSuffix(rule.Summary, ".") || strings.ContainsAny(rule.Summary, `"\`) {
			t.Fatalf("summary of %s must be quote-free and end with a full stop: %q", rule.ID, rule.Summary)
		}
		if rule.Fix == "" || rule.check == nil {
			t.Fatalf("rule %s needs a fix and a check", rule.ID)
		}
	}
}

// The composition guidance must carry every rule's summary verbatim, so an agent
// reads the same rule the lint enforces. This fails when either side changes alone.
func TestLintSummariesAreComposed(t *testing.T) {
	composed := guidance.DashboardComposition()
	for _, summary := range lintSummaries() {
		found := false
		for _, line := range composed {
			if line == summary {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("composition guidance is missing the lint summary %q; add it to internal/insights/guidance", summary)
		}
	}
}

// registeredWidgetPlugins must match the plugins the UI registers. Each id must
// still be registered in the UI source; a new UI plugin must be added to the map.
func TestRegisteredWidgetPluginsMatchTheUI(t *testing.T) {
	root := filepath.Join("..", "..", "ui", "src", "features", "insights")
	var source strings.Builder
	for _, pattern := range []string{"plugins/*.tsx", "*.tsx"} {
		files, err := filepath.Glob(filepath.Join(root, pattern))
		if err != nil {
			t.Fatal(err)
		}
		for _, file := range files {
			if strings.Contains(file, ".test.") {
				continue
			}
			data, err := os.ReadFile(file) //nolint:gosec // Fixed source paths under the repository.
			if err != nil {
				t.Fatal(err)
			}
			source.Write(data)
		}
	}
	text := source.String()
	for id := range registeredWidgetPlugins {
		pattern := regexp.MustCompile(`\bid\s*:\s*"` + regexp.QuoteMeta(id) + `"`)
		if !pattern.MatchString(text) {
			t.Fatalf("plugin %q is no longer registered in the UI source", id)
		}
	}
}

func TestLintOverlapIsAnErrorAtTheLaterWidget(t *testing.T) {
	document := documentWithWidgets("demo",
		widgetJSON("a", `{"x":0,"y":0,"w":6,"h":4}`, ""),
		widgetJSON("b", `{"x":4,"y":0,"w":6,"h":4}`, ""),
	)
	finding := requireOneHit(t, lintFor(t, document), "layout.overlap", "/widgets/1/layout")
	if finding.GetSeverity() != insightsv1.Severity_SEVERITY_ERROR || finding.GetMessage() != `widget "b" overlaps widget "a"` || finding.GetWidgetId() != "b" {
		t.Fatalf("overlap finding = %v", finding)
	}
}

func TestLintOverlapIgnoresTouchingEdges(t *testing.T) {
	side := documentWithWidgets("demo", widgetJSON("a", `{"x":0,"y":0,"w":6,"h":4}`, ""), widgetJSON("b", `{"x":6,"y":0,"w":6,"h":4}`, ""))
	stacked := documentWithWidgets("demo", widgetJSON("a", `{"x":0,"y":0,"w":6,"h":4}`, ""), widgetJSON("b", `{"x":0,"y":4,"w":6,"h":4}`, ""))
	requireNoHits(t, lintFor(t, side), "layout.overlap")
	requireNoHits(t, lintFor(t, stacked), "layout.overlap")
}

func TestLintHoleIsAnEmptyBandBetweenWidgets(t *testing.T) {
	gap := documentWithWidgets("demo", widgetJSON("a", `{"x":0,"y":0,"w":12,"h":2}`, ""), widgetJSON("b", `{"x":0,"y":5,"w":12,"h":2}`, ""))
	finding := requireOneHit(t, lintFor(t, gap), "layout.hole", "/widgets/1/layout/y")
	if finding.GetMessage() != "grid rows 2 to 4 hold no widget between the widgets above and below" || finding.GetSeverity() != insightsv1.Severity_SEVERITY_WARNING {
		t.Fatalf("hole finding = %v", finding)
	}
}

func TestLintHoleReportsEachGapAndIgnoresLeadingSpace(t *testing.T) {
	twoGaps := documentWithWidgets("demo",
		widgetJSON("a", `{"x":0,"y":0,"w":12,"h":1}`, ""),
		widgetJSON("b", `{"x":0,"y":3,"w":12,"h":1}`, ""),
		widgetJSON("c", `{"x":0,"y":6,"w":12,"h":1}`, ""),
	)
	var holes []string
	for _, finding := range lintFor(t, twoGaps) {
		if finding.GetRuleId() == "layout.hole" {
			holes = append(holes, finding.GetPointer())
		}
	}
	if strings.Join(holes, " ") != "/widgets/1/layout/y /widgets/2/layout/y" {
		t.Fatalf("hole pointers = %v", holes)
	}

	contiguous := documentWithWidgets("demo", widgetJSON("a", `{"x":0,"y":0,"w":6,"h":2}`, ""), widgetJSON("b", `{"x":6,"y":0,"w":6,"h":2}`, ""), widgetJSON("c", `{"x":0,"y":2,"w":12,"h":2}`, ""))
	requireNoHits(t, lintFor(t, contiguous), "layout.hole")

	leading := documentWithWidgets("demo", widgetJSON("a", `{"x":0,"y":3,"w":12,"h":2}`, ""))
	requireNoHits(t, lintFor(t, leading), "layout.hole")
}

func TestLintUndeclaredVariablePointsAtTheBinding(t *testing.T) {
	binding := `"queryRef":{"id":"q","bindings":[{"parameter":"p","source":"variable","variable":"svc"}]}`
	undeclared := documentWithWidgets("demo", widgetJSON("a", "", binding))
	requireOneHit(t, lintFor(t, undeclared), "variables.undeclared", "/widgets/0/queryRef/bindings/0/variable")

	declared := json.RawMessage(`{"schemaVersion":1,"id":"demo","title":"Checks","timeRange":"1h","refreshInterval":30,"variables":[{"name":"svc"}],"widgets":[` + widgetJSON("a", "", binding) + `]}`)
	requireNoHits(t, lintFor(t, declared), "variables.undeclared")

	constant := documentWithWidgets("demo", widgetJSON("a", "", `"queryRef":{"id":"q","bindings":[{"parameter":"p","source":"constant","value":"svc"}]}`))
	requireNoHits(t, lintFor(t, constant), "variables.undeclared")
}

func TestLintUndeclaredVariableInAnnotationAndTooltipReferences(t *testing.T) {
	annotation := documentWithWidgets("demo", widgetJSON("a", "", `"annotationSource":{"queryRef":{"id":"q","bindings":[{"parameter":"p","source":"variable","variable":"svc"}]},"timestampColumn":"ts","labelColumn":"lbl"}`))
	requireOneHit(t, lintFor(t, annotation), "variables.undeclared", "/widgets/0/annotationSource/queryRef/bindings/0/variable")

	tooltip := documentWithWidgets("demo", widgetJSON("a", "", `"options":{"tooltipView":{"type":"timeseries","source":{"type":"saved","ref":{"id":"q","bindings":[{"parameter":"p","source":"variable","variable":"svc"}]}}}}`))
	requireOneHit(t, lintFor(t, tooltip), "variables.undeclared", "/widgets/0/options/tooltipView/source/ref/bindings/0/variable")
}

func TestLintStatDensityNeedsCompactHeightBarAndSparkline(t *testing.T) {
	both := documentWithWidgets("demo", statWidget("a", `{"x":0,"y":0,"w":4,"h":2}`, `"options":{"showStatBar":true,"min":0,"max":100,"showSparkline":true}`))
	requireOneHit(t, lintFor(t, both), "stat.density", "/widgets/0/options/showStatBar")

	taller := documentWithWidgets("demo", statWidget("a", `{"x":0,"y":0,"w":4,"h":3}`, `"options":{"showStatBar":true,"min":0,"max":100,"showSparkline":true}`))
	noSparkline := documentWithWidgets("demo", statWidget("a", `{"x":0,"y":0,"w":4,"h":2}`, `"options":{"showStatBar":true,"min":0,"max":100}`))
	noBar := documentWithWidgets("demo", statWidget("a", `{"x":0,"y":0,"w":4,"h":2}`, `"options":{"showSparkline":true}`))
	timeseries := documentWithWidgets("demo", widgetJSON("a", `{"x":0,"y":0,"w":4,"h":2}`, `"options":{"showStatBar":true,"min":0,"max":100,"showSparkline":true}`))
	for name, document := range map[string]Dashboard{"taller": taller, "no sparkline": noSparkline, "no bar": noBar, "timeseries": timeseries} {
		t.Run(name, func(t *testing.T) {
			requireNoHits(t, lintFor(t, document), "stat.density")
		})
	}
}

func TestLintPercentBarOnCompactStat(t *testing.T) {
	compactPercent := documentWithWidgets("demo", statWidget("a", `{"x":0,"y":0,"w":4,"h":2}`, `"unit":"%","options":{"showStatBar":true,"min":0,"max":100}`))
	requireOneHit(t, lintFor(t, compactPercent), "stat.unbounded-percent-bar", "/widgets/0/options/showStatBar")

	// A bar on a stat at least three rows tall is the bounded-budget pattern the
	// guidance allows, so it is not reported.
	tall := documentWithWidgets("demo", statWidget("a", `{"x":0,"y":0,"w":4,"h":3}`, `"unit":"%","options":{"showStatBar":true,"min":0,"max":100}`))
	requireNoHits(t, lintFor(t, tall), "stat.unbounded-percent-bar")

	notPercent := documentWithWidgets("demo", statWidget("a", `{"x":0,"y":0,"w":4,"h":2}`, `"unit":"req/s","options":{"showStatBar":true,"min":0,"max":100}`))
	requireNoHits(t, lintFor(t, notPercent), "stat.unbounded-percent-bar")
}

func TestLintProvenanceInDescriptions(t *testing.T) {
	for _, description := range []string{
		"Live telemetry through the shared saved query",
		"Plotted from PromQL over five minutes",
		"Query: sum(rate(requests[5m]))",
		"Source: the Prometheus scrape",
	} {
		document := documentWithWidgets("demo", widgetJSON("a", "", fmt.Sprintf(`"description":%q`, description)))
		requireOneHit(t, lintFor(t, document), "description.provenance", "/widgets/0/description")
	}
	clean := documentWithWidgets("demo", widgetJSON("a", "", `"description":"Requests served per second, excluding health checks."`))
	requireNoHits(t, lintFor(t, clean), "description.provenance")
	titleOnly := documentWithWidgets("demo", widgetJSON("a", "", `"title":"Prometheus requests"`))
	requireNoHits(t, lintFor(t, titleOnly), "description.provenance")
}

func TestLintAxisLabelRepeatsTheUnit(t *testing.T) {
	cases := map[string]struct{ unit, options, pointer string }{
		"bracketed unit":    {"ms", `"yAxisLabel":"Latency (ms)"`, "/widgets/0/options/yAxisLabel"},
		"unit token":        {"req/s", `"xAxisLabel":"Requests [req/s]"`, "/widgets/0/options/xAxisLabel"},
		"label is the unit": {"ms", `"yAxisLabel":"ms"`, "/widgets/0/options/yAxisLabel"},
		"percent token":     {"", `"yAxisLabel":"Share (%)"`, "/widgets/0/options/yAxisLabel"},
	}
	for name, tc := range cases {
		document := documentWithWidgets("demo", widgetJSON("a", "", fmt.Sprintf(`"unit":%q,"options":{%s}`, tc.unit, tc.options)))
		t.Run(name, func(t *testing.T) {
			requireOneHit(t, lintFor(t, document), "axis.unit-in-label", tc.pointer)
		})
	}
	clean := documentWithWidgets("demo", widgetJSON("a", "", `"unit":"ms","options":{"yAxisLabel":"Latency","xAxisLabel":"Time (UTC)"}`))
	requireNoHits(t, lintFor(t, clean), "axis.unit-in-label")
}

func TestLintUnknownPlugin(t *testing.T) {
	unknown := documentWithWidgets("demo", pluginTestWidget("a", "made-up-plugin", ""))
	requireOneHit(t, lintFor(t, unknown), "plugin.unknown", "/widgets/0/pluginId")

	known := documentWithWidgets("demo", pluginTestWidget("a", "stacked-timeseries", ""))
	requireNoHits(t, lintFor(t, known), "plugin.unknown")
}

// A finding takes its severity and fix from the rule, never from the document.
func TestLintFindingsCarryTheRuleSeverityAndFix(t *testing.T) {
	document := documentWithWidgets("demo",
		widgetJSON("a", `{"x":0,"y":0,"w":6,"h":4}`, ""),
		widgetJSON("b", `{"x":4,"y":0,"w":6,"h":4}`, `"description":"Plotted from PromQL"`),
	)
	for _, finding := range lintFor(t, document) {
		if finding.GetFix() == "" || finding.GetSource() != insightsv1.Source_SOURCE_LINT {
			t.Fatalf("finding without fix or source: %v", finding)
		}
	}
}

// Lint is linear: the largest allowed document, with every widget overlapping
// every other, must stay well under a second.
func TestLintCostIsBoundedForLargeDocuments(t *testing.T) {
	widgets := make([]string, 0, maxDashboardWidgets)
	for i := range maxDashboardWidgets {
		widgets = append(widgets, widgetJSON(fmt.Sprintf("w%02d", i), `{"x":0,"y":0,"w":12,"h":12}`, `"description":"Plotted from PromQL"`))
	}
	document := documentWithWidgets("demo", widgets...)
	start := time.Now()
	findings := lintFor(t, document)
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("linting %d widgets took %s", len(widgets), elapsed)
	}
	if len(findings) == 0 {
		t.Fatal("overlapping widgets must produce findings")
	}
}

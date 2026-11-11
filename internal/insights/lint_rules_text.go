package insights

import (
	"fmt"
	"regexp"
	"strings"
)

var textLintRules = []lintRule{
	{
		ID:       "description.provenance",
		Severity: warningSeverity,
		Summary:  "Keep provenance out of descriptions: name the source or query in a tooltip or authoring metadata, not in the description.",
		Fix:      "Rewrite the description as what the viewer learns, and move the provider or query detail to the tooltip or metadata.",
		check:    checkDescriptionProvenance,
	},
	{
		ID:       "axis.unit-in-label",
		Severity: warningSeverity,
		Summary:  "Do not repeat a unit in an axis label; the widget unit already shows it.",
		Fix:      "Remove the unit from the axis label; the widget unit is shown once.",
		check:    checkAxisUnitInLabel,
	},
}

// provenancePattern matches the names of data sources and query languages, and
// the words "source:" and "query:". A description that uses any of them repeats
// implementation detail that belongs in a tooltip.
var provenancePattern = regexp.MustCompile(`(?i)\b(?:promql|prometheus|tempo|loki|postgres|postgresql|clickhouse|datasource|saved quer(?:y|ies))\b|\b(?:source|query):`)

// checkDescriptionProvenance fires for each widget description that matches
// provenancePattern. Titles are not checked.
func checkDescriptionProvenance(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		if match := provenancePattern.FindString(widget.description); match != "" {
			hits = append(hits, lintHit{
				pointer:  widgetBase(widget.index) + "/description",
				widgetID: widget.id,
				message:  fmt.Sprintf("description names its data source or query (%q)", match),
			})
		}
	}
	return hits
}

// unitTokens are the units an axis label should not repeat in brackets, besides
// the widget's own unit. They are unambiguous; a bare "s" or "h" is not listed
// because it reads as a word in parentheses too often.
var unitTokens = []string{"%", "ms", "µs", "ns", "bytes", "KB", "MB", "GB", "TB", "KiB", "MiB", "GiB", "req/s", "ops/s", "bit/s", "°C", "cores"}

// checkAxisUnitInLabel fires for each axis label that equals the widget unit, or
// that contains the unit, or a unit token from unitTokens, in parentheses or
// square brackets. The pointer names the label member.
func checkAxisUnitInLabel(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		for _, axis := range []struct{ field, label string }{{"xAxisLabel", widget.xAxisLabel}, {"yAxisLabel", widget.yAxisLabel}} {
			if !labelRepeatsUnit(axis.label, widget.unit) {
				continue
			}
			hits = append(hits, lintHit{
				pointer:  widgetBase(widget.index) + "/options/" + axis.field,
				widgetID: widget.id,
				message:  axis.field + " repeats the widget unit",
			})
		}
	}
	return hits
}

// labelRepeatsUnit reports whether an axis label carries a unit: the widget's
// own unit as the whole label or inside brackets, or a known unit token inside brackets.
func labelRepeatsUnit(label, unit string) bool {
	trimmed := strings.TrimSpace(label)
	if trimmed == "" {
		return false
	}
	if unit != "" && (trimmed == unit || strings.Contains(trimmed, "("+unit+")") || strings.Contains(trimmed, "["+unit+"]")) {
		return true
	}
	for _, token := range unitTokens {
		if strings.Contains(trimmed, "("+token+")") || strings.Contains(trimmed, "["+token+"]") {
			return true
		}
	}
	return false
}

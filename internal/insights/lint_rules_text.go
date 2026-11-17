package insights

import (
	"fmt"
	"regexp"
	"strings"
)

// guidanceProvenance and guidanceUnit are the guidance lines the text rules map to.
const (
	guidanceProvenance = "Keep provenance out of titles and descriptions: source and query detail belongs in tooltips or authoring metadata. Write a description only when it adds meaning the viewer needs."
	guidanceUnit       = "Show a unit once, as the widget unit, not in axis labels, tick labels or titles."
)

var textLintRules = []lintRule{
	{
		ID:       "description.provenance",
		Severity: warningSeverity,
		Summary:  guidanceProvenance,
		Fix:      "Rewrite the description as what the viewer learns, and move the query or data source to the tooltip or metadata.",
		check:    checkDescriptionProvenance,
	},
	{
		ID:       "axis.unit-in-label",
		Severity: warningSeverity,
		Summary:  guidanceUnit,
		Fix:      "Remove the unit from the axis label; the widget unit already shows it.",
		check:    checkAxisUnitInLabel,
	},
}

// queryFragment matches query syntax: a PromQL call or aggregation, a label
// matcher, a range selector, a TraceQL attribute filter, a complete SQL select, or a
// raw variable placeholder. Plain comparisons ("latency > 500 ms", "status = 5xx")
// and sentences that happen to use the word select do not match.
var queryFragment = regexp.MustCompile(`(?i)\b(?:rate|irate|increase|histogram_quantile|avg_over_time|sum_over_time|clamp_min|clamp_max|topk|bottomk|sum|avg|min|max|count)\(|\b(?:sum|avg|min|max|count)\s+(?:by|without)\s*\(|[a-z_:][a-z0-9_:]*\{\s*[a-z_][a-z0-9_]*\s*(?:=~|!~|!=|=)|\{\s*(?:span|resource)\.|\[\d+[smhdwy]\]|\bselect\s+(?:\*|[a-z_][\w.]*(?:\s*,\s*[a-z_][\w.]*)*)\s+from\s+[a-z_][\w.]*(?:\s+(?:where|join|group|order|limit)\b|\s*;?\s*$)|\{\{[a-z_][a-z0-9_]*\}\}`)

// attribution matches a sentence that says where the data came from. Either a
// query language or a data source is named after from, via, through or using; or a
// labelled source, provider or datasource names a real connector. A bare "Source:"
// or "Query:" label is prose and does not match.
var attribution = regexp.MustCompile(`(?i)\b(?:from|via|through|using)\s+(?:the\s+)?(?:[a-z-]+\s+){0,2}(?:promql|traceql|logql|sql|provider|datasource|data source|saved quer(?:y|ies))\b|\b(?:source|provider|datasource|data source)\s*[:=]\s*(?:the\s+)?(?:prometheus|promql|tempo|traceql|loki|logql|postgres(?:ql)?|clickhouse|sql)\b`)

// checkDescriptionProvenance fires for a widget description that contains query
// text or attributes its data to a source, provider or saved query. The match is
// quoted in the message. Plain prose that names a technology does not fire.
func checkDescriptionProvenance(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		match := queryFragment.FindString(widget.description)
		if match == "" {
			match = attribution.FindString(widget.description)
		}
		if match == "" {
			continue
		}
		hits = append(hits, lintHit{
			pointer:  widgetBase(widget.index) + "/description",
			widgetID: widget.id,
			message:  fmt.Sprintf("description has query text or a data source (%q)", match),
		})
	}
	return hits
}

// checkAxisUnitInLabel fires for an axis label that repeats the widget's unit,
// when the widget has one. The label repeats it when it equals the unit, or holds
// it in parentheses or square brackets. A widget with no unit never fires, since
// its label is then the only place the unit appears. The pointer names the label.
func checkAxisUnitInLabel(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		if widget.unit == "" {
			continue
		}
		for _, axis := range []struct{ field, label string }{{"xAxisLabel", widget.xAxisLabel}, {"yAxisLabel", widget.yAxisLabel}} {
			if !labelRepeatsUnit(axis.label, widget.unit) {
				continue
			}
			hits = append(hits, lintHit{
				pointer:  widgetBase(widget.index) + "/options/" + axis.field,
				widgetID: widget.id,
				message:  axis.field + " repeats the widget unit " + strings.TrimSpace(widget.unit),
			})
		}
	}
	return hits
}

// labelRepeatsUnit reports whether an axis label carries the widget's unit as
// the whole label or inside parentheses or square brackets.
func labelRepeatsUnit(label, unit string) bool {
	trimmed := strings.TrimSpace(label)
	return trimmed != "" && (trimmed == unit || strings.Contains(trimmed, "("+unit+")") || strings.Contains(trimmed, "["+unit+"]"))
}

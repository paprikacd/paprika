package insights

import (
	"fmt"
	"strings"
)

// Guidance lines the selection rules map to. Each is also a line of the composition guidance; TestLintSummariesAreComposed
// fails when a rule's summary is missing there.
// Both selection rules share one line: the inactive-binding and self-filter rules teach the same selection model.
const guidanceSelection = "selectionBindings activate only on a timeseries, bar, table, heatmap or traces widget, or a selectable plugin; on any other widget they are retained but inactive. Do not let a selecting widget read the variable it sets; drive filtered panels from an unfiltered overview chart grouped by that label."

// selectableWidgetTypes and selectablePluginIDs are the widgets whose renderers can activate a selection. They mirror
// selectableBuiltins and selectablePlugins in ui/src/features/insights/selection-support.ts, and
// TestSelectableWidgetsMatchTheUI reads that file so the two lists cannot drift.
var selectableWidgetTypes = map[string]bool{"timeseries": true, "bar": true, "table": true, "heatmap": true, "traces": true}

var selectablePluginIDs = map[string]bool{
	"record-treemap": true, "record-table": true, "record-list": true, "record-matrix": true,
	"records-line": true, "records-bar": true, "pie": true, "status-history": true, "geo-heatmap": true, "connection-map": true,
}

var selectionLintRules = []lintRule{
	{
		ID:       "selection.inactive-binding",
		Severity: warningSeverity,
		Summary:  guidanceSelection,
		Fix:      "Remove selectionBindings from this widget, or move the filter to a timeseries, bar, table, heatmap or traces widget, or a selectable plugin.",
		check:    checkInactiveSelectionBindings,
	},
	{
		ID:       "selection.self-filter",
		Severity: warningSeverity,
		Summary:  guidanceSelection,
		Fix:      "Point the selection at an unfiltered source widget, and remove the selected variable from this widget's own query or saved query bindings.",
		check:    checkSelfFilteringSelection,
	},
}

// canActivateSelection reports whether a widget's renderer can set a selection on a deliberate activation.
func canActivateSelection(widget *lintWidget) bool {
	if widget.widgetType != "plugin" {
		return selectableWidgetTypes[widget.widgetType]
	}
	return selectablePluginIDs[widget.pluginID]
}

// selectionRefs lists the variables a widget's selectionBindings set, with the pointers of their variable members.
func selectionRefs(widget *lintWidget) []lintVariableRef {
	prefix := widgetBase(widget.index) + "/selectionBindings/"
	var refs []lintVariableRef
	for _, ref := range widget.variables {
		if strings.HasPrefix(ref.pointer, prefix) {
			refs = append(refs, ref)
		}
	}
	return refs
}

// checkInactiveSelectionBindings fires for a widget that keeps selectionBindings but whose type cannot activate a
// selection, such as a stat. The bindings are retained and never filter. The pointer names the selectionBindings member.
func checkInactiveSelectionBindings(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		if len(selectionRefs(widget)) == 0 || canActivateSelection(widget) {
			continue
		}
		hits = append(hits, lintHit{
			pointer:  widgetBase(widget.index) + "/selectionBindings",
			widgetID: widget.id,
			message:  widgetLabel(widget) + " keeps selectionBindings, but its type cannot activate a selection, so they stay inactive",
		})
	}
	return hits
}

// checkSelfFilteringSelection fires for a selecting widget that also reads a variable its own selection sets: a raw
// placeholder in its query, or a variable binding of its saved query. Selecting one of its marks would narrow the
// widget to that one choice. The pointer names the selectionBindings variable member.
func checkSelfFilteringSelection(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		refs := selectionRefs(widget)
		if len(refs) == 0 || !canActivateSelection(widget) {
			continue
		}
		reads := map[string]bool{}
		if !widget.hasQueryRef {
			for _, match := range placeholder.FindAllStringSubmatch(widget.query, -1) {
				reads[match[1]] = true
			}
		}
		queryRefPrefix := widgetBase(widget.index) + "/queryRef/bindings/"
		for _, ref := range widget.variables {
			if strings.HasPrefix(ref.pointer, queryRefPrefix) {
				reads[ref.variable] = true
			}
		}
		for _, ref := range refs {
			if reads[ref.variable] {
				hits = append(hits, lintHit{
					pointer:  ref.pointer,
					widgetID: widget.id,
					message:  fmt.Sprintf("%s selects variable %q and also reads it, so selecting one of its marks narrows this widget to that choice", widgetLabel(widget), ref.variable),
				})
			}
		}
	}
	return hits
}

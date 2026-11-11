package insights

import "strings"

var widgetLintRules = []lintRule{
	{
		ID:       "stat.density",
		Severity: warningSeverity,
		Summary:  "Do not combine a bar and a sparkline on a compact stat (layout h<=2).",
		Fix:      "Keep one trend on a stat with layout h<=2: remove showStatBar, or give the stat layout h of at least 3.",
		check:    checkStatDensity,
	},
	{
		ID:       "stat.unbounded-percent-bar",
		Severity: warningSeverity,
		Summary:  "Do not add a percentage bar to a compact stat (layout h<=2); the bar needs layout h>=3.",
		Fix:      "Remove showStatBar from the compact percentage stat, or make the stat at least layout h 3 when the bar is the reading.",
		check:    checkStatPercentBar,
	},
}

// checkStatDensity fires for a stat whose layout is at most two rows tall and
// that shows both a bar (showStatBar) and a sparkline (showSparkline true). Both
// settings must be on; an unset sparkline is off.
func checkStatDensity(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		if widget.widgetType == "stat" && widget.h <= 2 && widget.showBar && widget.showSpark {
			hits = append(hits, lintHit{
				pointer:  widgetBase(widget.index) + "/options/showStatBar",
				widgetID: widget.id,
				message:  "stat is at most two grid rows tall but shows both a bar and a sparkline",
			})
		}
	}
	return hits
}

// checkStatPercentBar fires for a stat whose layout is at most two rows tall,
// that enables showStatBar, and whose unit contains a percent sign. The bar only
// reads when it shows a bounded quantity with room to draw it, so a percentage
// bar on a compact card is treated as unbounded decoration. The rule cannot tell
// a bounded ratio from a rate, so a bar at h 3 or more is not checked.
func checkStatPercentBar(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		if widget.widgetType == "stat" && widget.h <= 2 && widget.showBar && strings.Contains(widget.unit, "%") {
			hits = append(hits, lintHit{
				pointer:  widgetBase(widget.index) + "/options/showStatBar",
				widgetID: widget.id,
				message:  "percentage stat bar on a stat at most two grid rows tall",
			})
		}
	}
	return hits
}

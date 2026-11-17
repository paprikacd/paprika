package insights

// Guidance lines a rule maps to. Each one is also a line of the composition
// guidance in internal/insights/guidance; TestLintSummariesAreComposed fails when
// a rule's summary is not there verbatim.
const (
	guidanceCompactStat = "Compact stat cards (layout h<=2) show a short title, the exact value and at most one sparkline. Do not add showStatBar, a long description or min and max to them by default."
	guidanceStatBar     = "Use showStatBar only when the bar length is the reading: a bounded quantity such as the percent of an error budget that remains, with explicit min and max and layout h>=3. Do not add a bar to a rate or a count, or because a metric is a percentage."
)

var widgetLintRules = []lintRule{
	{
		ID:       "stat.density",
		Severity: warningSeverity,
		Summary:  guidanceCompactStat,
		Fix:      "Keep one trend on a stat with layout h<=2: remove either showStatBar or the sparkline, or give the stat layout h of at least 3.",
		check:    checkStatDensity,
	},
	{
		ID:       "stat.compact-bar",
		Severity: warningSeverity,
		Summary:  guidanceStatBar,
		Fix:      "Remove showStatBar from the compact stat, or give the stat layout h of at least 3 when the bar is the reading.",
		check:    checkCompactStatBar,
	},
}

// checkStatDensity fires for a stat whose layout is at most two rows tall and
// that stacks a bar (showStatBar) on a sparkline (showSparkline true). An unset
// sparkline is off. The pointer names the bar setting. checkCompactStatBar covers
// the bar without a sparkline, so the two rules never fire on the same stat.
func checkStatDensity(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		if widget.widgetType == "stat" && widget.h <= 2 && widget.showBar && widget.showSpark {
			hits = append(hits, lintHit{
				pointer:  widgetBase(widget.index) + "/options/showStatBar",
				widgetID: widget.id,
				message:  widgetLabel(widget) + " is at most two grid rows tall and stacks a bar on a sparkline",
			})
		}
	}
	return hits
}

// checkCompactStatBar fires for a stat whose layout is at most two rows tall that
// enables showStatBar without a sparkline. A bar needs room to read, so a bar on a
// card this short adds length the viewer cannot use. A bar on a stat at layout h 3
// or more is not checked. A bar with a sparkline is checked by stat.density.
func checkCompactStatBar(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		if widget.widgetType == "stat" && widget.h <= 2 && widget.showBar && !widget.showSpark {
			hits = append(hits, lintHit{
				pointer:  widgetBase(widget.index) + "/options/showStatBar",
				widgetID: widget.id,
				message:  widgetLabel(widget) + " has a bar on a stat at most two grid rows tall, without a sparkline",
			})
		}
	}
	return hits
}

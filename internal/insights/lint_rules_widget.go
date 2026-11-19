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
		ID:       "stat.compare-arrow",
		Severity: warningSeverity,
		Summary:  guidanceStatCompare,
		Fix:      "Remove the arrow statIcon from a stat that shows a change against an earlier window, or drop compare: the change chip already carries its own direction.",
		check:    checkStatCompareArrow,
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

// guidanceStatCompare is the guidance line for a stat that shows a change against an earlier window.
const guidanceStatCompare = "A stat may set options.compare to show its change from an earlier window: the previous range, or 1d or 7d earlier. The change compares the displayed sample with the latest valid earlier sample, so it is a point-to-point change, not an average, and it costs one extra query per refresh. The direction word is neutral unless good names the better direction. Use it only when the earlier window answers the reader's question. Do not add an arrow statIcon to such a stat: the change chip already names the direction."

// checkStatCompareArrow fires for a stat that compares with an earlier window and also shows an arrow icon. The change
// chip already names its direction with a glyph, so the arrow says the same thing twice and can read as a second verdict.
// The pointer names the icon setting.
func checkStatCompareArrow(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		if widget.widgetType == "stat" && widget.compares && (widget.statIcon == "arrow-up" || widget.statIcon == "arrow-down") {
			hits = append(hits, lintHit{
				pointer:  widgetBase(widget.index) + "/options/statIcon",
				widgetID: widget.id,
				message:  widgetLabel(widget) + " shows an arrow icon and a change against an earlier window",
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

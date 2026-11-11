// Package guidance holds the dashboard composition and breach-encoding rules
// that every Insights authoring surface must show: get_insights_schema notes
// in the insights service, and MCP initialize instructions in the observability
// gateway. It is a leaf package so both binaries can import it cheaply. The UI
// copy in ui/src/features/insights/authoring-guidance.ts must match these lines;
// TestDashboardAuthoringGuidanceMatchesUI enforces that.
package guidance

import "slices"

// Each line is an imperative rule. Keep lines free of double quotes and
// backslashes so the UI parity check can compare them as plain text.
var dashboardAuthoring = []string{
	"Compact stat cards (layout h:2) show a short title, the exact value and at most one sparkline. Do not add showStatBar, a long description or min/max to them by default.",
	"Use showStatBar only for an intentional bounded scale with an explained objective, explicit min and max, and layout h:3 or taller. Remove min/max that exist only for the bar.",
	"Do not add a progress bar because a metric is a percentage. A 4xx ratio or a 0% 5xx rate is not progress toward completion.",
	"When a metric has a supplied or named objective, encode the breach: stat options.thresholds (ascending values, hex colors, labels) show severity, and a time series uses labelled referenceLines for the objective.",
	"Set options.staleAfterSeconds from the metric's known scrape or evaluation interval, and omit it when that interval is unknown. It measures returned samples, not source health.",
	"Keep provenance out of titles and descriptions: source and query detail belongs in tooltips or authoring metadata. Write a description only when it adds meaning the viewer needs.",
	"Do not repeat units across axis captions, tick labels and titles. Do not force max:100 on rate charts unless the full 0 to 100 range is essential.",
	"Do not combine a bar, a sparkline, a long description and a two-row height on one KPI card.",
	"Avoid overlapping widgets and widget-internal scrolling; a KPI that needs a scrollbar is too small or too dense.",
	"When only presentation changes, keep saved queries, provider IDs and variable bindings unchanged. Patch only the widget IDs you intend to change, using the current ETag.",
	"Verify presentation at 1512px and 390px, in light and dark: no widget-internal scrollbar, clipped value or unit, overlap, clipped chart or horizontal page overflow.",
	"Inspect a real hover or pinned observation tooltip. Accepting tooltip options in a schema does not show how they render.",
	"A valid schema, a saved ETag or a successful query_dashboard is not visual proof. Without a screenshot or browser, report visual QA as NOT RUN.",
	"Record the previous rendering, apply the smallest patch, and revert any regression with another targeted patch.",
}

// DashboardAuthoring returns the composition rules in display order.
func DashboardAuthoring() []string { return slices.Clone(dashboardAuthoring) }

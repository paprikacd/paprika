// Package guidance holds the dashboard rules that Insights authoring surfaces
// show. There are two lists with different audiences:
//
//   - DashboardComposition is what a dashboard should look like. It is served in
//     get_insights_schema notes, in the observe MCP server instructions, and in
//     the Build with AI prompt.
//   - DashboardWorkflow is how an MCP agent verifies and saves a change. It names
//     MCP tools, so it is served only in the MCP server instructions and schema
//     notes. The Build with AI prompt returns a document for review and applies
//     nothing, so it must not receive these rules.
//
// The Build with AI copy in ui/src/features/insights/authoring-guidance.ts is
// generated from these lists. TestAuthoringGuidanceTypeScriptIsGenerated fails
// when it is stale.
package guidance

//go:generate go test . -run TestAuthoringGuidanceTypeScriptIsGenerated -update

import "slices"

// Each line is an imperative rule ending in a full stop. Lines contain no double
// quotes or backslashes, so they can be emitted as plain JavaScript strings.
//
// Each lint rule maps to one of these lines, and the rule's summary is that
// line verbatim. Several rules share a line where they teach the same thing. The
// insights package fails TestLintSummariesAreComposed when a summary is missing
// here, so the lint registry and this guidance cannot drift apart.
var dashboardComposition = []string{
	"Compact stat cards (layout h<=2) show a short title, the exact value and at most one sparkline. Do not add showStatBar, a long description or min and max to them by default.",
	"Use showStatBar only when the bar length is the reading: a bounded quantity such as the percent of an error budget that remains, with explicit min and max and layout h>=3. Do not add a bar to a rate or a count, or because a metric is a percentage.",
	"On a stat, thresholds colour the reading or its bar; a stat card does not draw threshold labels. Show labelled thresholds where labels appear: heatmap legends, labelled referenceLines on time series, threshold-gauge labels and status-badge table mappings.",
	"When a metric has a supplied or named objective, encode the breach: give the stat options.thresholds in ascending order, each naming a status. Start with the lowest meaningful value and the status that applies there, since a reading below the first threshold takes that threshold's status; for latency use 0 ok, then 300 warning and 500 critical, so a healthy reading stays ok. Escalate with warning at the objective and critical at the breach. A hex color is only an optional hue override. On a time series, a labelled referenceLines entry marks the objective but never shades; to shade breach intervals, give options.thresholds the same statuses with an ok band at the lowest meaningful value, because a lone or first warning threshold makes the whole plot warning.",
	"Set options.staleAfterSeconds only when the metric's scrape or evaluation interval is known, and make it at least twice that interval so one late sample does not flap. It applies to stat and time-series widgets and measures returned samples, not source health.",
	"Keep provenance out of titles and descriptions: source and query detail belongs in tooltips or authoring metadata. Write a description only when it adds meaning the viewer needs.",
	"Show a unit once, as the widget unit, not in axis labels, tick labels or titles.",
	"Do not force max to 100 on rate charts unless the full 0 to 100 range is essential.",
	"Place widgets without overlaps and fill each row; a gap beside a widget is not closed automatically.",
	"Declare every variable a query placeholder or binding uses, and give each plugin widget a built-in plugin id.",
	"On a stat, set min and max only together with showStatBar, which requires both. A bar that is switched off may keep bounds it already has; do not remove them to tidy the document.",
	"Avoid widget-internal scrolling; a KPI that needs a scrollbar is too small or too dense.",
}

var dashboardWorkflow = []string{
	"Read the current dashboard and its exact ETag, then change only the widget IDs you intend, with patch_dashboard and widget_edits. Keep unchanged widgets, saved queries, provider IDs and variable bindings as they are when only presentation changes.",
	"After saving, read the document back with get_dashboard and check that the saved widgets match the intended edits.",
	"Run one bounded query_dashboard to confirm signals, freshness and unchanged query bindings. A successful query is not visual evidence.",
	"When render_dashboard is available, render the dashboard at 1512px and 390px in light and dark, and check each compact KPI for a widget-internal scrollbar, a clipped value or unit, an overlap, a clipped chart or horizontal page overflow.",
	"Inspect a real hover or pinned observation tooltip in the UI; accepting tooltip options in a schema does not show how they render.",
	"Before editing, record the previous rendering when a screenshot is available. Revert any regression with another targeted, ETag-safe patch rather than restyling other widgets.",
	"Read the first line of a render_dashboard result and its visualStatus. failed means at least one error finding: fix every error and render again. passed means no error findings, but each warning still needs a look. not_run means the renderer ran no checks. Report visual QA as PASS only when the latest render has visualStatus passed and you looked at its screenshot; otherwise report NOT RUN. Never claim visual verification from a valid schema, a saved ETag or query_dashboard.",
}

// DashboardComposition returns the composition rules in display order.
func DashboardComposition() []string { return slices.Clone(dashboardComposition) }

// DashboardWorkflow returns the MCP workflow rules in display order.
func DashboardWorkflow() []string { return slices.Clone(dashboardWorkflow) }

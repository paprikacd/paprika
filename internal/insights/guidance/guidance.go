// Package guidance holds the dashboard rules that Insights authoring surfaces
// show. There are two lists with different audiences:
//
//   - DashboardComposition is what a dashboard should look like. It is served in
//     get_insights_schema notes and in the Build with AI prompt. The observe MCP
//     server instructions serve MCPDashboardComposition, a compact variant.
//   - DashboardWorkflow is how an MCP agent verifies and saves a change. It names
//     MCP tools, so it is served only in schema notes and, compactly, through
//     MCPDashboardWorkflow in the MCP server instructions. The Build with AI prompt
//     returns a document for review and applies nothing, so it must not receive
//     these rules.
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
	"On a stat, warning and critical bands show a status chip and ok, info and unknown bands show none; a colour-only band shows its label, or its value after the first band. The reading stays in ink; bars and sparklines take the band colour.",
	"When a metric has a supplied or named objective, encode the breach: give the stat options.thresholds in ascending order, each naming a status. Start with the lowest meaningful value and the status that applies there, since a reading below the first threshold takes that threshold's status; for latency use 0 ok, then 300 warning and 500 critical, so a healthy reading stays ok. Escalate with warning at the objective and critical at the breach. A hex color is only an optional hue override. On a time series, a labelled referenceLines entry marks the objective but never shades; to shade breach intervals, give options.thresholds the same statuses with an ok band at the lowest meaningful value, because a lone or first warning threshold makes the whole plot warning.",
	"Name a status for a threshold and a series role for a series colour. A hex colour is an override only where it has its own meaning, and it must not look like a status colour.",
	"Set options.staleAfterSeconds only when the metric's scrape or evaluation interval is known, and make it at least twice that interval so one late sample does not flap. It applies to stat and time-series widgets only, which warn or hatch when stale; other widgets are not judged stale. It measures returned samples, not source health.",
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
	"Read the first line of a render_dashboard result and its visualStatus. Report visual QA as FAIL when visualStatus is failed, or when the screenshot shows a clipped or scrolling KPI, an overlapping or out-of-bounds tooltip, a clipped chart or horizontal page overflow; fix every defect and render again. Report PASS only when visualStatus is passed, you looked at the screenshot at 1512px and 390px, reviewed each warning finding, and saw none of those defects. Report NOT RUN when there is no renderer, the capture returns an error, or visualStatus is not_run. Checks are DOM heuristics, so a pass does not prove good design, and a valid schema, a saved ETag or query_dashboard is never visual evidence.",
}

// Claude Code keeps only the first 4096 characters of MCP server instructions, so
// the observe instructions carry compact variants of both lists. Each compact line
// states its full rule's substance in fewer words. The full rules stay in the
// get_insights_schema notes and the Build with AI prompt, which have no limit.
var mcpDashboardComposition = []string{
	"Compact stat cards (h<=2) show a short title, the exact value and at most one sparkline, with no showStatBar, long description, or min and max by default.",
	"Use showStatBar only when the bar is the reading: a bounded quantity with explicit min and max at h>=3. Never add a bar to a rate or a count, or because a metric is a percentage.",
	"Give stat thresholds ascending, each naming a status, starting at the lowest meaningful value. Warn at the objective and go critical at the breach.",
	"Name a status for a threshold and a series role for a series colour. A hex colour is an override only where it has its own meaning.",
	"On a stat, warning and critical bands show a chip, and a colour-only band takes a label or value. The reading stays in ink. A labelled referenceLines entry marks an objective on a time series and never shades.",
	"Set staleAfterSeconds only when the scrape or evaluation interval is known, at least twice that interval, on stat and time-series widgets.",
	"Keep provenance out of titles and descriptions. Show a unit once, as the widget unit.",
	"Place widgets without overlaps and fill each row. Avoid widget-internal scrolling, and do not force max to 100 on rate charts.",
	"Declare every variable a query placeholder or binding uses, and give each plugin widget a built-in plugin id.",
	"On a stat, set min and max only with showStatBar, which requires both.",
}

var mcpDashboardWorkflow = []string{
	"Change only intended widget IDs with patch_dashboard and widget_edits, keeping unchanged widgets, queries, provider IDs and bindings. Then get_dashboard reads the saved document back.",
	"Run one bounded query_dashboard to confirm signals and freshness. A successful query is not visual evidence.",
	"When render_dashboard is available, render at 1512px and 390px in light and dark. Check each compact KPI for a scrollbar, clipped value or unit, overlap, clipped chart or horizontal overflow, and inspect a real hover or pinned tooltip.",
	"Record the previous rendering when possible; revert a regression with a targeted, ETag-safe patch, not by restyling other widgets.",
	"Read the first line of a render_dashboard result and its visualStatus. Report visual QA as FAIL when visualStatus is failed or a screenshot shows a defect, then fix and render again. Report PASS only when visualStatus is passed, you viewed both screenshots, reviewed each warning and saw no defect. Report NOT RUN when there is no renderer, the capture errors or visualStatus is not_run. A valid schema, saved ETag or query_dashboard is never visual evidence.",
}

// DashboardComposition returns the composition rules in display order.
func DashboardComposition() []string { return slices.Clone(dashboardComposition) }

// DashboardWorkflow returns the MCP workflow rules in display order.
func DashboardWorkflow() []string { return slices.Clone(dashboardWorkflow) }

// MCPDashboardComposition returns the compact composition rules served in MCP
// instructions, in display order.
func MCPDashboardComposition() []string { return slices.Clone(mcpDashboardComposition) }

// MCPDashboardWorkflow returns the compact MCP workflow rules served in MCP
// instructions, in display order.
func MCPDashboardWorkflow() []string { return slices.Clone(mcpDashboardWorkflow) }

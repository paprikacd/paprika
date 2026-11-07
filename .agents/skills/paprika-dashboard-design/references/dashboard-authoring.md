# Dashboard and chart authoring

## Contents

- Compose a useful editing workspace
- Keep one validated draft
- Offer only compatible visualizations
- Separate presentation from querying
- Make apply, discard and persistence explicit
- Validate the complete editing path

## Compose a useful editing workspace

Use the supplied editor references to identify the work regions: a large live preview, organized visual options on the right, and a data/query workspace beneath the preview. Preserve those relationships when adapting the UI to Paprika. In explicit literal reproduction, follow [pixel reproduction](pixel-reproduction.md) first rather than substituting this adaptation layout.

Make the preview the largest useful area. Keep its title, units, axes, legend and selected states representative of the dashboard component. Render the registered widget through the same host with the same normalized result; an attractive placeholder preview does not verify the configuration being edited.

Organize the options by task: visualization, panel title/description, value formatting, graph styles, axes/grid, legend/inspection and family-specific display fields. Use searchable groups and contextual controls. Show only implemented capabilities, using trusted registry metadata where available. A universal collection of toggles that silently do nothing is not an editor.

Keep the lower workspace focused on **Data**, **Query** and **Configuration** or equivalent real capabilities. Expose exact loaded values, timestamps, missingness and units in a bounded searchable/paged table. Disclose caps and preserve nulls. A chart/table toggle must inspect the same result. Query metadata and execution state must be truthful.

Keep Apply/Discard, change state and Undo/Redo visible and distinct from chart inspection. Avoid placing configuration machinery inside an ordinary dashboard panel. A direct Edit action should identify its panel and return to that panel predictably.

## Keep one validated draft

Use the existing `Widget`/dashboard schema and registered plugin parser. Keep these states separate:

| State | Responsibility |
| --- | --- |
| Applied configuration | Last accepted panel configuration; unchanged by uncommitted edits. |
| Draft | User-entered guided or structured configuration, including invalid input that needs correction. |
| Last valid preview | Most recent draft accepted by schema, family and data-compatibility validation. |
| Edit history | Bounded Undo/Redo states, with defined treatment of unvalidated structured text. |
| Source result/revision | Existing normalized observations and their identity; presentation changes do not rewrite them. |

Guide controls and JSON/YAML/OpenUI through the same validation owner. Preserve source identifiers and unrelated fields. A user changing line width must not silently replace the provider, query or plugin mapping.

On invalid input, retain the entered draft and last valid preview, show the actionable error, and block Apply. Do not silently clamp a clearly invalid value or render a different default while claiming the edit succeeded. Validate again at Apply, including the plugin parser and source compatibility.

When structured text is edited, explicitly validate it into the shared draft before preview/apply, or parse it continuously with equivalent last-valid behavior. Do not allow stale guided state to overwrite pending JSON without an explicit user action. Preserve a valid route to revert the structured draft. Handle absent optional values by removing their keys rather than inserting unsupported values into serialized configuration.

Read the values actually displayed by native forms at submission. React draft state, a browser date picker and autofill can be temporarily out of step; test real input and submission rather than only calling a reducer. Preserve explicit units/timezone in time inputs.

## Offer only compatible visualizations

Resolve choices from registered renderers, then validate both **data kind and required field semantics**. Metrics, records and traces are different contracts. Matching `records` is insufficient when a treemap needs numeric value/change fields or a map needs valid geographic columns. A parser accepting field-name strings does not prove those columns exist in the result.

Offer a conversion only when a complete mapping already exists, can be inferred unambiguously, or is supplied through a visible guided step. Verify names, types, required labels, units and relevant geometry assumptions against the loaded result. Examples include cumulative bucket labels for a distribution, direction identity for mirrored traffic, valid coordinate mappings for a map and nonnegative magnitude for allocation area.

Keep the original custom renderer reachable after a user switches to a compatible table or another chart. Retain or restore its validated mapping; do not reconstruct it from unrelated defaults. Preserve compatible presentation fields deliberately and remove unsupported ones. Isolate renderer errors so the options and draft remain recoverable.

Keep a compatibility rule close to its owner and test it with independent datasets. Do not rely on visiting another route to register a family. A family shown in the chooser must resolve on a clean entry.

Run compatibility validation when editing mappings, not only when filtering the visualization chooser. A configuration such as `value: "missing_column"` can pass a string-valued parser while its adapter fails. Keep the actual result/descriptor in validation before promoting preview or enabling Apply. Return a named field/role diagnostic and repair candidates; preserve the draft and valid chart. Renderer error isolation is a fallback, not binding validation.

For richer discovery/mapping, follow [schema discovery and generation](schema-discovery-and-generation.md). Show required roles, bound columns, unit/grain/identity context and compatibility status beside the visual choice. Let chart selection focus its existing options group. Separate source/query, semantic mapping, supported transforms, presentation and interaction scope while retaining one validated draft. Label inferred mappings as suggestions until evidence establishes their meaning.

## Separate presentation from querying

Reuse the same loaded result for title, color, interpolation, grid, legend, precision, inspection, preview width and other presentation edits. Check that these changes neither issue provider requests nor alter semantic summaries. A unit text field changes formatting/labels only unless a real conversion is explicitly implemented.

If the host has no query execution capability, present the existing query and provider as read-only context and identify the loaded fixture. Do not create a fake Run query control or imply that editing a query string generated the previewed observations.

When actual query editing is in scope, use the maintained provider/query owner for available metrics, validation, parameter binding, execution, cancellation, deduplication, errors and stale-result rejection. Distinguish a query draft from the result of the last execution. A preview using old results must retain their time/scope context. Do not introduce renderer-owned network requests or another query schema.

Keep transformations, overrides and alert controls absent or explicitly unavailable until their supported owner and behavior exist. Visual resemblance to a Grafana editor does not establish Grafana feature parity.

## Make apply, discard and persistence explicit

Apply commits the validated draft to the stated editing owner; Discard leaves the prior applied configuration unchanged. Closing with Escape or the close button must have a consistent, stated relationship to the draft. Keep Undo/Redo bounded, restore both draft and valid preview coherently, and do not let invalid structured text silently disappear during history travel.

State the persistence boundary. **Applied in this lab session**, saved in a dashboard draft, and durably saved to a backend are different outcomes. Never label a local component override as a durable save. When durable saving is available, reuse the canonical conditional-write/conflict flow, preserve drafts on failure and verify reload against the saved revision.

Use native/Gamma controls and the existing theme/portal owner. Trap focus within a modal editor, include portalled nested menus correctly, support keyboard tabs/options and restore focus to the initiating Edit action on close. Nested inspector/menu dismissal must not accidentally discard the whole editor.

At narrow widths, reflow the workbench and option groups, retain reachable Apply/Discard, and keep data tables in local scroll regions. Recompute preview geometry at the actual container width. Test popup collision and scrolling with an inspector open. A desktop 390px preview validates constrained layout, not physical touch or a complete small-viewport focus path.

## Validate the complete editing path

Exercise the actual rendered workflow, not only schema helpers:

1. Open Edit from a known panel; confirm its current configuration and source values.
2. Change a visible property; observe the same renderer update without replacing data or issuing a query.
3. Enter invalid bounds/configuration; retain the draft and last valid preview while Apply is blocked.
4. Correct the error, use Undo/Redo, and compare the resulting preview with its exact configuration.
5. Switch to a compatible family and back to the original custom renderer without losing its required mapping. Verify incompatible field shapes stay unavailable or request mapping.
6. Apply, reopen and verify the accepted panel configuration; then change and Discard to verify the applied version remains intact.
7. Test keyboard focus, Escape and nested popups, an open inspector, narrow preview and actual small-viewport/text-zoom layout.
8. For durable saves, test reload and conflict/error recovery through the real persistence owner. For session edits, verify and label that narrower boundary.

Record model/schema tests, browser actions, request behavior and persistence evidence separately. Keep the authoring workspace functional when a chart fails, and retain the user's entered work through recoverable errors.

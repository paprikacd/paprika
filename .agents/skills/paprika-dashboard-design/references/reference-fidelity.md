# Match references through measurable design decisions

## Contents

- Select the matching mode
- Inspect the actual references
- Budget the composition before styling
- Extend the chart owner
- Give synthetic telemetry a truthful cadence
- Compose a compact inspector
- Compare, correct, and report

## Select the matching mode

Use **adaptation** when the user requests inspiration or a visual improvement to existing analytics. Use **literal reproduction** when the user asks for a replica, exact match, pixel reproduction, or corrects an interpretation that still looks substantially different. In that case, read [pixel reproduction](pixel-reproduction.md) and use its measured-canvas workflow instead of the exploratory budgets below.

Do not let generic analytical-product guidance override an explicit request to reproduce a clearly labelled concept. A literal fixture may copy its visible labels and values, preserve its initial selected state, and implement its authored chart geometry. Disclose synthetic status and document source inconsistencies or reconstructed occluded paths. Do not claim those paths are recovered observations or that a copied “Live” label proves a provider connection.

## Inspect the actual references

Open the supplied [Edge Watch image](../assets/reference-edge-watch.png) and [Reliability Room image](../assets/reference-reliability-room.png) with an image viewer when matching this direction. Reading these notes is not a substitute for inspecting the images. Also inspect a current rendered target, including its selected state; source code alone cannot establish visual fidelity.

In adaptation, borrow the concepts' dense composition, clear cyan/violet traces, fading magnitude fills, quiet instrument grid, aligned quantitative table marks, explicit unknown-state hatching, and compact observation cards. Derive values, scales and budget accounting from the actual analytical contract. In literal reproduction, copy the requested authored fixture content and distinguish it from operational evidence; document rather than silently reconcile illustrative inconsistencies.

For literal reproduction, compare **the same 1592 × 988 canvas**, with matching state and unscaled screenshots. For adaptation, a common content width can support proportional review but does not establish pixel fidelity. Record viewport, canvas and capture dimensions, device scale, theme, fixture identity, fonts, cadence and selected state. Keep lab controls or explanatory material outside the reference artboard. Do not force Edge's full-height rail and compact cards onto Reliability's separate header/rail and taller cards.

Write a short delta table before editing: reference characteristic → observed target difference → concrete change → evidence needed. Choose the few differences with the greatest effect on reading. For example, “the main plot has thirty samples spread over 700px” calls for checking cadence; changing its border does not resolve the sparse trace.

## Budget the composition before styling

In **adaptation mode only**, set a row-height and plot-area budget at the intended desktop width, then fit content within it while retaining readable product typography. For a roughly 1340px-wide Edge Watch study, these are useful **initial exploration budgets**, not requirements or measurements for a replica. In literal mode use the bounding boxes in [pixel reproduction](pixel-reproduction.md):

| Region | Starting height | Content decision |
| --- | --- | --- |
| KPI strip | 76–84px | Compact icon, label, 25–27px value, aligned unit/delta, useful sparkline |
| Main plot and ranked table | 290–315px | Shared visual weight; keep the plot itself dominant |
| Supporting panels | 200–220px | One clear comparison per panel; concise legends |
| Recent events | 175–210px | Four initial rows with a real expand/detail action |

Adapt these budgets to the actual font, content, viewport, and analytical task. Do not compress a usable table just to meet a page-height target. Use approximately 26–28px event rows only if the established typography and controls fit; preserve appropriate interaction targets through the real control design.

Remove duplicated explanations before reducing text size. Keep scope, units, aggregation, missingness, stale state, and consequential overrides visible. Put lengthy definitions, fixture accounting, and optional provenance in a reachable information or detail view. Keep lab instructions outside the product canvas.

Give compact KPI cards a deliberate arrangement: icon at one side, label over the value, unit beside the number, and trend in the remaining space. Avoid a separate large empty row for each item. Name the delta's comparison period and meaning; a positive change in blocked requests is not automatically favorable.

Make ranked tables visually quantitative. Give bars enough width to compare, with aligned numeric columns and stable row geometry. For a percentage encoding, preserve the 0–100% domain. For a traffic encoding, use a common zero-based traffic domain and show the actual percentage separately. Never normalize “share” bars to the largest share without changing their stated meaning.

## Extend the chart owner

Inspect the installed renderer definition, released API, configuration schema, and editor controls before choosing implementation details. A desired appearance does not prove an option exists. Do not write unsupported fields, cast around strict validation, or rely on silently ignored configuration.

Build grid lines from the chart owner's actual x/y scales, plot rectangle, and tick values. Use time-aware ticks and timezone formatting for time axes. Adapt tick density to available width; roughly 5–6 y divisions and 6–10 x divisions can be useful for a broad primary plot, but small panels need fewer. Distinguish the zero/reference line from the quiet grid and retain a visible unit. Never place a decorative CSS grid behind the plot as a substitute: it will drift from ticks, zoom, clipping, and selection.

Check the temporal scale factory's channel contract: some require `Date` values despite numeric source timestamps. Keep the original exact numeric timestamp for cursor/inspection and compile the real scene, following [the time contract](chart-grammar.md#time-contract). A calendar-aware factory name alone does not establish that numeric channels work.

Implement gradients, selection rings, and transitions through supported chart capabilities or an explicit owner extension. Keep plot clipping, domains, hit testing, selection, and renderer variants coherent. See [motion and effects](motion-and-effects.md) for signed area fills, restrained focus, and interruption behavior.

For a published lab that vendors pinned owners, record the upstream repository and base commit, pinned dependency versions, and the exact patch/diff. Preserve applicable licenses. Identify the changed owner and how to integrate it upstream; do not describe a patched copy as unchanged canonical code. A trusted Paprika registry extension may own a native HTML/SVG concept renderer when literal reference geometry requires it. Document that extension's input contract and provenance; do not represent it as a live-query renderer or use the screenshot itself as the application background.

## Give synthetic telemetry a truthful cadence

Apply the accounting rules below to generated analytical fixtures and real result adapters. When tracing a literal screenshot, name the result **authored concept geometry** and record source/reconstruction bounds; do not infer a sample cadence, measurement precision, or conserved telemetry population from pixels alone.

Distinguish sample cadence, query step, aggregation bucket, and screen resolution. A fixture with thirty one-minute observations does not contain hundreds merely because the reference looks dense. If a synthetic study needs a finer trace, generate actual deterministic ten-second fixture observations and label that cadence. State whether timestamps represent interval starts, ends, or instantaneous samples. Never manufacture intermediate observations, decorative jitter, or false extrema for real provider results.

Conserve the fixture's accounting when refining cadence. For example, partition each one-minute integer request total across six ten-second intervals using deterministic weights and exact remainder allocation. Preserve outcome totals and derive ratios from those counts. For rates, preserve the relevant integrated quantity using the interval durations and the fixture's stated measurement convention. Keep missing intervals missing; increased visual density must not improve coverage by invention.

Key observations by absolute timestamp and stable entity, not moving array position. The same entity/timestamp must retain the same value in overlapping snapshots. Anchor incident starts, resolved ends, gaps, and deployments to absolute time; an active episode may extend its end according to its stated policy. Refresh must not rewrite historical measurements to make a nicer current window.

Set plot extent through a supported domain or reference-series contract. Do not append null data points solely to stretch a measured series to the boundary: an embedded history can count them as missing observations. Do not copy a first value backward or replace an unknown boundary with zero. A genuine lookback observation may supply context if labelled and excluded from selected-window accounting. Verify both the visible range and the inspector's missingness calculation.

## Compose a compact inspector

In adaptation, explore an initial inspector near **280–300px wide × 300–350px tall**, with a 70–90px history. For literal reproduction use the measured inspector: Edge approximately **242 × 251px**, Reliability **214 × 243px**, both initially open at their reference positions. Match the actual content order and miniature histories before adding new headings, statistics, or controls. Reflow or use the existing mobile detail pattern when subsequently adapting to constrained space.

Order content by the investigation: name and selected timestamp → selected value(s) with units → relevant gateway/service context → short history → concise min/max and coverage → reachable pin/dismiss and detail actions. Put verbose metadata in an accessible disclosure. Keep exact values, full identifiers, and omitted fields reachable by keyboard and touch; compact must not mean incomplete.

Keep selected and latest observations distinct. Preserve series identity in the main trace, selected row, legend, and mini-history. If a tooltip source causes one series to inherit another selected series' color, fix or constrain the canonical source contract; do not hard-code replacement values or miscolor the remaining series.

The Edge reference uses negative values for mirrored outbound traffic. That is a valid display convention when the series and inspector explicitly identify mirrored egress; follow [directional traffic semantics](chart-grammar.md#specialized-chart-contracts) to keep raw rates, accounting, exports, and drilldowns positive. Do not reuse the signed display `QueryResult` as a raw source. Name the mini-history and its min/max for the selected series, such as “Egress — mirrored,” so signed statistics cannot be mistaken for generic history or positive outbound magnitudes.

Set nested display precision explicitly. In Paprika's current tooltip configuration, `tooltipView.decimals` is separate from `widget.options.decimals`; do not assume one inherits from the other. Check the rendered history's min/max, selected values, units, and exact-data view against the underlying observations. Display rounding must not change calculations or stored values.

## Compare, correct, and report

Capture a settled dashboard and an active inspector. For literal reproduction, follow the equal-size capture, overlay/difference and region-review procedure in [pixel reproduction](pixel-reproduction.md); comparable width is insufficient. Review structural alignment first, then typography/content density, plot texture, assets and interaction detail. Test narrow panels or alternate themes when they belong to the requested scope; they do not replace the primary reference match.

Use [validation](validation.md) for snapshot identity, conserved cadence, boundary missingness, nested precision, and focus cleanup checks. Use a recording or timed behavioral test for motion; a settled screenshot cannot prove interruption or reduced-motion behavior.

Fix a bounded batch of concrete differences and recapture. Describe observable improvements and remaining limits rather than assigning an arbitrary fidelity percentage or beauty score. Separate proposals, implemented behavior, static inspection, and executed browser evidence. Stop additional testing once the affected risks and required gates are covered; continue design iteration when the user requests it or a concrete material finding remains.

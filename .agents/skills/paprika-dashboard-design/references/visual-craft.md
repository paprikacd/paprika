# Visual craft for Paprika dashboards

## Contents

- Visual thesis and hierarchy
- Tokens and color roles
- Typography and geometry
- Panel composition and density
- Observation and annotation
- Concrete critique

## Visual thesis and hierarchy

Design a precise workspace for reasoning about telemetry. At the first viewport, users should recognize the operating scope, the important signal, and how to inspect it. The distinctive quality should survive an ordinary real dataset and a failure state.

For new dashboards and substantial adaptation, apply [the transferable visual system](visual-system.md) and [family anatomy](chart-families.md). Translate the references into information roles, layer relationships, compact compositions and selected states. A matching palette and rounded cards do not establish the same visual quality. Require family-by-family completeness, including the supporting map, state view or quantitative table when those are part of the requested evidence.

Preserve the Insights identity described in current `DESIGN.md`: compact Gamma controls around clear light or dark plots, with paprika reserved for actions/focus and restrained series colors. Do not force one global dark theme, a marketing display face, or an entirely new aesthetic onto a chart extension.

Arrange by analytical importance. A service investigation may favor a broad latency/distribution view with aligned error and traffic tracks, then deployment context and a breakdown table. A fleet overview may favor compact comparison rows and a single exception detail. These are compositions to adapt, not mandatory templates.

Do not confuse premium with large blank cards. Use grouping, alignment, proximity, and shared axes to remove reading effort. Vary panel size when the question needs it; avoid arbitrary asymmetry that makes related plots harder to compare.

## Tokens and color roles

Resolve actual values from `gamma/gamma-theme.module.css` and its consumers. The documented snapshot uses primary `#b65332`, light background `#ffffff`, light surface `#f5f7f7`, and ink `#223139`; these are orientation, not instructions to duplicate literal values into components. Read current tokens before editing.

Keep these roles independent:

| Role | Intended use | Check |
| --- | --- | --- |
| Canvas / panel / plot | Hierarchy of surfaces | Clear grouping without nested-card clutter |
| Border / grid | Structure and reference | Quieter than data; not relied on as the only essential cue if too faint |
| Primary / secondary / axis text | Reading hierarchy | Normal text contrast; labels remain legible |
| Categorical series | Entity identity | Stable assignment, distinguishable with labels or line styles |
| Sequential scale | Ordered intensity | Monotonic perceptual progression and labelled legend |
| Diverging scale | Deviation around a real midpoint | Named center; balanced interpretation |
| Status | Known semantic condition | Policy-backed, text/icon/pattern companion |
| Selection / focus | Current interaction | Visible independently of category and status |
| Comparison | Prior/reference population | Clear line/shape/label difference, not opacity alone |

Choose palettes appropriate to the actual backgrounds and supported themes. Do not simply invert hex colors between themes. Test the rendered/composited colors, including fills and overlays. A color-blindness preview helps find collisions but does not replace non-color encoding or contrast measurement.

Use explicit authored colors when present. Otherwise prefer a shared stable mapping based on a canonical series identity, with a collision strategy and a consistent palette order. Hashing alone does not guarantee distinct colors. Reuse the same entity's identity across panels, refresh, filtering, and sorting. The current indexed palette is an implementation to inspect and improve when in scope, not proof that this invariant already holds.

Keep a series distinguishable when selected, in alarm, or shown against its prior period. Use an outline, marker, dash or label when another color would overload the visual language.

## Typography and geometry

Use the host product sans. Enable tabular numerals for aligned values and changing readouts. Use monospace for technical identifiers and queries, not every label. Keep units close to values with correct spacing and casing.

Use a compact hierarchy that remains readable at actual widget dimensions. A working starting range, subject to existing tokens, is 12–14px labels, 13–14px titles, and 24–32px summary values. These are craft defaults, not WCAG font-size requirements or permission to shrink text below the product baseline. Use rem-based product scales where established.

Maintain stable widths for values where possible. Do not let changing digits move controls or entire columns. Align numeric columns on their numeric edge and give decimal precision a consistent rule. Preserve full precision in details when it matters.

Give data marks sufficient contrast and weight. As a proposed starting point, a 1.5–2 CSS-pixel primary line often reads better than a subpixel hairline; test actual density and device pixel ratio. Use thinner/quieter reference geometry. Avoid line glow and shadows that enlarge the perceived mark or obscure intersections.

Derive grids from the plot owner's scales and ticks, with a distinct zero or reference line where meaningful. Keep axes, guides, clipping, and selection in the same coordinate system. A CSS background grid cannot stand in for quantitative reference geometry. Use a visible axis unit and deliberate tick precision without repeating long suffixes unnecessarily.

Retain current compact radius tokens (snapshot: controls 5px, panels 6px, small surfaces 4px). Do not introduce arbitrary radii per chart. Overlays may use the established soft shadow; resting plots generally rely on boundaries and space.

## Panel composition and density

Treat the panel as title/context, plotting region, and optional legend/detail. Reserve a consistent plot region while loading or failing. Place units where users can see them without querying a tooltip.

For the supplied Edge Watch and Reliability Room direction, follow [reference fidelity](reference-fidelity.md): inspect the images, budget row heights at comparable width, and reduce redundant chrome before reducing typography. Relocate optional explanations to reachable details while retaining consequential scope, aggregation, coverage, and stale state. Keep lab commentary outside the product canvas.

For related panels, align actual plot rectangles, not just outer cards. Account for y-axis label width, titles, legends, and footers. Shared time is useful only if the same instant appears at the same horizontal position in comparable tracks.

Treat tables as quantitative compositions: align exact numbers and comparable marks, define each column's domain, and preserve stable entity histories through filtering/sorting. Carry a consistent unknown/coverage vocabulary across plots, tables, timelines, maps and calendars; the absence of a colored mark alone cannot identify every degraded state.

Prefer readable legends that answer what the line represents and, when useful, show aligned values. Keep legend order stable unless the question explicitly calls for ranking. If ranked, preserve the entity-color map. Do not let a long legend squeeze a chart to an unusable sliver.

Responsive adaptation is a change in composition:

- Reduce axis tick density while preserving range meaning.
- Move or collapse legends into an accessible control.
- Switch comparison panels to stacked tracks or small multiples.
- Keep tables internally scrollable, with exact identifiers available.
- Use the existing responsive layout projection; never rewrite saved placement when the viewport narrows.
- Preserve a reachable inspector and editing controls on narrow devices.

Measure the available **panel** width, not only the browser width. A 1440px viewport can contain a 250px widget. If the requested widget cannot truthfully support its data at that size, offer a clear expanded/detail view rather than compressing every label.

## Observation and annotation

Use the selected moment to organize detail. A well-positioned observation card, a clear crosshair, and aligned selected values can create a strong product signature without adding decoration.

Give the inspector a stable relationship to the selected track while allowing collision handling. Keep selected and latest samples separately labelled. Retain the selected series color in its history and respect authored overrides. Do not fabricate a delta or combine incompatible units to resemble a reference image.

Use the compact inspector content profile in [reference fidelity](reference-fidelity.md) when matching those studies. Keep an initially concise surface with full exact data available through accessible details. Verify nested history precision and missingness independently from the parent widget's settings.

Treat deployments, incidents, and configuration changes as contextual events. Use understated markers with accessible names and selected states. Cluster dense events visibly; do not silently discard them. Show exact event time and drilldown when available. An event marker is not evidence that the event caused an anomaly.

Use motion for state changes, focus, and navigation. Prefer the product easing and reduced-motion behavior. Avoid animating data from zero on every refresh, continuous shimmer over usable results, elastic meters, or ambient activity that competes with an incident.

For concrete treatments, read [motion and effects](motion-and-effects.md): series focus, comparison cards, interval selection, controlled gradients, rounded bar ends, range marks, and scoped SVG resources. The [Mebius study](mebius-patterns.md) records specific observed/reference techniques and how to translate them into the established Paprika identity. Do not equate a rendering-library change with a visual upgrade; select capabilities through [frameworks and rendering](frameworks-and-rendering.md).

## Concrete critique

Ask these questions against a real render, including a dense panel:

1. Can a user identify the primary signal, scope, and time without opening the editor?
2. Can related values be compared on a shared visual reference?
3. Are data, threshold, grid, and selection distinguishable in both themes?
4. Do typography, units, and spacing still work with long labels, tiny values, large values, and negative values?
5. Does each accent, border, shadow, and animation have a reading or action purpose?
6. Does the panel belong in Paprika beside an existing sibling?
7. Does the failure/empty/partial state look deliberately designed rather than accidentally broken?

Review hierarchy, comparison, legibility, coherence, restraint, and finish through concrete findings and the actual task. Record the affected dimension, visible consequence, and remedy; mark uninspected states as unverified. Do not turn a subjective craft rating into an objective quality score or average away a truth/accessibility failure.

Write findings as observable effects: “The legend wraps to five rows and leaves 72px of plot height at 320px panel width; move it to an expandable list.” Avoid “make it pop” or “needs premium polish.”

# Transfer the reference quality into a reusable chart system

## Contents

- Diagnose the source of resemblance
- Keep three contracts separate
- Preserve the visual relationships
- Turn the relationships into a build sequence
- Promote a successful fixture into a chart capability
- Evaluate transfer with different data

## Diagnose the source of resemblance

Use the bundled Edge Watch and Reliability Room references as evidence of an instrument-panel visual language. Inspect their pixels and the actual target; do not reduce that language to “dark, cyan, glowing, dense.” A dashboard can share those adjectives yet have a different hierarchy, reading rhythm and information density.

The early Paprika studies were recognizably related but substantially different. Their broad composition, plausible typography and synthetic traces did not preserve the source's actual proportions, mark cadence, table pitch, inspector state or content. The literal reconstruction improved after measuring those properties and comparing aligned renders. Encode that causal lesson: **measure the relationships that determine reading before polishing effects**. Numerical tests can establish analytical correctness while the visual composition remains wrong.

Translate recurring observations into rules with an owner and an acceptance case. For example, a selected point needs an exact observation, a scale-derived position, a visible ring, an inspector, keyboard access and invalidation on result replacement. “Add a rich tooltip” does not specify that capability.

## Keep three contracts separate

| Contract | Owns | Must survive changes |
| --- | --- | --- |
| Semantic model | Population, time, units, reductions, nulls, identity, thresholds, source coverage | The same values and meaning across size, theme, zoom and renderer |
| Visual grammar | Hierarchy, alignment, plot proportions, type roles, mark treatment, surface and color roles, inspection behavior | Recognizable quality with different entities, real data and failure states |
| Reference fixture | Exact artwork canvas, labels, authored trace profiles, repeated-mark counts, initial pins and illustrative contradictions | Literal reproduction of that particular source |

Keep screenshot tracing, nonuniform illustrative axis calibration, hardcoded inspector placement, decorative geographic speckles and copied concept accounting in the reference fixture. Do not promote them to the analytical model. Conversely, do not rewrite a clearly labelled literal fixture merely to reconcile its illustrative numbers. Record the boundary.

For a new dashboard, reuse the visual grammar with actual normalized results. Let the real metric's cadence and complexity determine trace texture. Preserve genuine spikes and gaps even when they look less polished than the reference. Keep the original reference available as a visual anchor, not as a data-generation algorithm.

## Preserve the visual relationships

### 1. Compose from evidence to investigation

Give the primary changing signal the most useful plotting area. Pair it with a ranked breakdown when the question is “what contributes to this change?” Put state, geography or outcome composition beneath it when these explain a different dimension. End with exact evidence when the task needs individual records. Do not repeat the same information in a KPI, donut, bar and table merely to populate the grid.

Make a compact KPI an integrated component: identity/icon, label, value/unit, comparison, and a subordinate miniature history. Compare its numerical weight with the main chart rather than maximize its font size. Keep the value readable without allowing four cards to become the dominant page feature.

### 2. Spend height on data

Budget title/action, plot, legend and padding separately. Outer card equality does not establish aligned plot rectangles. Compare the actual plot-to-chrome ratio, row pitch, visible records and legend wrapping at the intended panel width. Remove redundant captions and empty bands before reducing text. Keep operational meaning—unit, time, coverage, overrides—visible or directly reachable as appropriate.

Match literal geometry when requested; use the numbers in [pixel reproduction](pixel-reproduction.md) only for those fixtures. The references' 28 outcome bars, approximately 85 timeline columns and 26px destination-row pitch are measurements of specific artwork, not defaults for arbitrary data.

### 3. Use a small optical hierarchy

Keep canvas, panel and plot close in luminance, with a fine structural boundary. Make data strokes and selected values the dominant accents. Make grids quieter than data and inspector surfaces sufficiently opaque for exact reading. Reserve the strongest red/amber/green for a declared status policy. Keep selection rings independent of severity.

Preserve crisp quantitative edges. Use a single controlled fade for area under a line; anchor magnitude areas to their real baseline. Use localized halos only for geographic presence or selection when their meaning is explicit. A bloom field must not stand in for measured density, and blur must not change the perceived width of a bar or threshold.

### 4. Match text geometry, not just font names

Inspect glyph width, x-height, numeral shape, weight, line-height and baseline alignment on actual content. A superficially similar condensed font can make the dashboard materially sparser. Test long identifiers, proportional letters, tabular figures, units, decimals and negative signs in the same columns.

Use the product's established typography in adaptation. In literal reproduction compare candidate faces against the source before choosing; the Barlow/Roboto combination used in the lab is an observed approximation, not a universal Paprika mandate. Preserve full content through inspection and deliberate wrapping rather than scaling the whole interface until text becomes unreadable.

### 5. Give each visual family its own grammar

Use [chart families](chart-families.md) to map every visible element to an implemented owner. A ranked table combines exact values, aligned bars and records; a state timeline encodes temporal state; a calendar provides date context; a map provides spatial context. These need different data contracts and interactions even when they share a panel shell.

Avoid substituting an available generic chart for a defining visual without recording the design change. Extend the existing family when its needed behavior is absent. Reuse low-level scales, strokes, legends, data cells and inspection contracts; do not force every family into one all-purpose component with unrelated flags.

### 6. Treat inspection as part of the composition

Inspect both resting and selected states. An observation card should order timestamp, exact series values, entity scope, short histories and named actions. Preserve visual identity across main trace, legend, marker and mini-history. Give it a collision policy, useful keyboard/touch access and dismissal that returns focus.

Keep a reference's initial inspector and exact placement in literal mode. In an analytical dashboard, derive placement from the selected point, panel bounds and viewport. Never pin a fabricated default observation just to make a screenshot look complete.

### 7. Make motion explain a state transition

Write the transition before choosing an effect: direct inspection, deliberate filter, camera change, new sample, changed status or reordered entity. Keep direct manipulation immediate and measured values exact. Prefer a coherent bounded camera or domain transition to separately animated marks. Keep settled history still. Route interruption, reduced motion and resource cleanup to one owner; use [motion and effects](motion-and-effects.md).

### 8. Keep visual identity stable through ordinary use

Key observations and decorations by stable entity and timestamp. Filtering a risk table must not regenerate the same ASN's miniature history from its new row index. Sorting must not reassign severity, series color or selection. A camera change must not change a geographic value or the population used by adjacent summaries.

## Turn the relationships into a build sequence

1. **Record intent and mode.** Identify the question, data contract and whether the user wants adaptation, literal reproduction or promotion of a successful study into reusable components.
2. **Inventory visual families.** Map each reference region to its registered renderer, data-driven primitive or remaining scene fixture. Identify real capability gaps before layout work.
3. **Measure the important relationships.** For literal work record exact bounds; for adaptation record relative hierarchy, plot share, row/tick/mark density, type roles and selected-state composition. Capture the current target and write the largest concrete deltas.
4. **Build the semantic and geometric skeleton.** Use real normalized data, scales, clipping, axes, row structure and correct missingness. Align inner plots and quantitative columns. Establish data-derived summaries before styling them.
5. **Apply family recipes.** Add restrained fills, meaningful bars, timeline hatching, stable symbols and compact inspectors using the same owners and tokens. Check sharpness at the actual rendering scale.
6. **Exercise interaction.** Verify selection, keyboard, reset, scope changes, view state, live/replay behavior and reduced motion. A static visual acceptance does not close this step.
7. **Compare and generalize.** Correct the largest observed mismatches, then perform the transfer checks below. Record residuals rather than assert a beauty or fidelity percentage.

## Promote a successful fixture into a chart capability

Require a complete vertical slice: declared normalized input → pure transformation → validated configuration → renderer → exact inspection/context → implemented controls → relevant tests and a working example. Use the existing registry and document schema. A reusable React component is not automatically an authorable Paprika widget; a widget file is not necessarily imported or registered on a clean route.

Keep model changes separate from camera, theme, size and selection changes. Extend only the owner's supported configuration and expose controls for behavior that actually exists. Never cast unknown options through strict validation or introduce arbitrary executable cell templates in saved documents.

Demonstrate a family outside the reference scene using different entities and values. Preserve the same hierarchy and inspection behavior while removing fixture labels, copied profiles and fixed dimensions. Keep literal studies as visual acceptance fixtures and use a separate analytical example to establish data correctness.

## Evaluate transfer with different data

Use a bounded representative set, not an unending cosmetic review:

| Change | Required evidence |
| --- | --- |
| New entities and row order | Stable colors, histories, IDs and selected entity; exact values remain attached to the right labels |
| Sparse, irregular or missing data | Actual timestamps, visible gaps, unknown state, no invented texture or false continuity |
| Larger/smaller values and long labels | Correct units and baseline, preserved negative/overflow values, aligned columns, accessible full labels |
| Narrow panel or text zoom | Deliberate reflow/tick reduction or reachable detail; summaries unchanged; controls usable |
| Alternate supported theme and two instances | Readable composed colors, independent SVG resources, no cross-instance selection/zoom leakage |
| Selection, filtering, zoom and replacement | Immediate exact inspection, explicit local/query scope, stale selection cleanup, predictable reset and focus |

Keep visual, analytical, interaction, integration and performance evidence separate. Passing one does not substitute for another. Report what remains fixture-only or unverified before calling the work a reusable chart system.

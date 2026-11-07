# Motion and effects that improve chart reading

## Contents

- Ownership and visual state
- Motion recipes
- Simulated cadence and focus lifecycle
- Styling and effect recipes
- Framework translation
- Validation

## Ownership and visual state

Treat animation as a view of a defined state transition. Specify the trigger, semantic source and target, stable entity key, duration/easing, interrupted behavior, reduced-motion outcome, and exact-value inspection during the transition. Do not animate an unidentified “chart update.”

Keep data identity, scale/domain, position, selection, and visibility separate. An updated datum is not a new series merely because its array index changed. A re-sort, new query, resize, and background sample arrival have different semantics and need different transitions.

Choose one owner per animated property: the rendering engine, a React animation component, CSS/WAAPI, or a D3-owned subtree. Do not have React, D3 transitions and CSS simultaneously write a mark's geometry. Cancel or retarget active work when a result is superseded or a widget unmounts.

Check the actual installed definition, renderer API, and strict configuration schema before specifying an effect. Extend the canonical owner and its supported configuration when a capability is absent; never add an inert option or a CSS patch that detaches the effect from scales and clipping. For a published lab with pinned source, preserve base provenance and its exact patch as described in [reference fidelity](reference-fidelity.md).

Use Paprika's existing motion tokens and decelerating easing first. The timing ranges below are **proposed fallbacks**, not source measurements or mandatory constants. Never add elastic overshoot to measured magnitude or a status threshold. Motion should settle comfortably before the next refresh and remain optional for the analytical task.

## Motion recipes

| Interaction | Deliberate treatment | Proposed fallback | Correctness constraint |
| --- | --- | --- | --- |
| Cursor and direct manipulation | Track the actual pointer/focus position; coalesce paint work with the existing scheduler | No easing delay; at most one scheduled frame | Exact sample time/value; never lag across a different observation |
| Series hover/focus | Strengthen selected stroke/marker; soften unrelated marks within contrast limits | 80–120ms color/opacity change | Do not alter values, domains or identity; preserve non-color identification |
| Inspector open/close | Fade a stable anchored surface; optional movement of no more than 3–4px | 120–160ms opacity; zero movement for reduced motion | Keep numbers stable; preserve collision handling, focus, dismissal, and touch access |
| Pin a selected observation | Briefly settle the existing selection, then hold it still | One short emphasis, then static | Pin the actual result/time/entity; do not follow the pointer or imply subsequent data is pinned |
| Deliberate filter or period change | Update keyed marks or use a brief labelled crossfade if topology changes | 160–240ms monotonic transition | A new population must not masquerade as the old one; commit exact readouts deliberately |
| Sort/reorder | Move entities by stable key, retaining color and selection | 160–240ms when movement aids tracking | Avoid reordering a live ranked view while someone is inspecting it without a clear policy |
| Zoom to a range | Transform one coherent time domain and annotations together, or snap if clarity is better | Up to 200–300ms for a user action | Axes, marks, thresholds and selected time must remain consistent |
| Dashboard layout resize | Reserve geometry and recompute responsive layout; use host behavior | Prefer immediate geometry for direct resize | No KPI change or saved-layout mutation caused by projection |
| New live sample / critical status | Update the measured state directly; optionally emphasize a real changed status once | Immediate value; short non-looping emphasis if needed | Do not count through fictional values, hide a breach, or defer important status |
| Initial plot appearance | Present complete data promptly; a subtle one-time opacity reveal is optional | 0–160ms | Do not stagger a whole operational dashboard or draw from zero on every mount |

For a stable line topology, a renderer-supported geometry transition may help track a deliberate change. Do not morph paths indiscriminately when point count, gap segments, order, or scale type changes. Generic SVG string interpolation does not establish meaningful point correspondence. For different topology, prefer a snapshot replacement or brief crossfade with clear population/time context.

During a transition, an inspector must expose an actual observation from the current result. Never label an in-between animated coordinate as a measurement. Clear selected observations, pins and their cursors when the result is replaced or its scope changes, following Paprika's current invalidation contract. Re-resolve an observation after a geometry change only within the same result version. Keyed mark animation does not authorize silently retaining or retargeting a pin into new data; a future snapshot feature would need its own explicit contract.

For reduced motion, jump to the final coherent state; keep static focus, selection, loading and status cues. Do not simply set a duration to zero while leaving delayed stagger timers, repeating effects, or out-of-sync axes running.

## Simulated cadence and focus lifecycle

If a lab needs replay, label it **simulated**, expose pause/resume, and advance actual deterministic fixture snapshots. Do not pulse a “Live” badge or animate a trace to suggest an attached provider. Preserve same-timestamp observations and conserved totals under the cadence policy in [reference fidelity](reference-fidelity.md). A one-shot freshness cue may mark a real newly accepted sample; keep settled historical marks static.

Let result values become exact immediately, even when a view transition continues. Treat replay clocks, animation frames, delayed effects, and tooltip listeners as owned resources: stop or suspend relevant work when paused, hidden, superseded, or unmounted. Test rapid replay/pause, result replacement, and reduced motion; do not claim those behaviors from source declarations alone.

Use the canonical selection source for transient pointer and keyboard focus. Clear that source on pointer exit/blur without clearing an explicitly pinned observation. Give custom pin controls a reachable clear action. Escape must dismiss without throwing away keyboard focus. Clear stale pins/cursors when scope or result identity changes; theme and geometry changes must not manufacture a replacement semantic result merely to reset the view.

## Styling and effect recipes

| Desired quality | Implementation recipe | Validation |
| --- | --- | --- |
| Crisp traces | A clear primary stroke, quieter references, intentional line caps/joins, and a separate generous hit region | Stroke stays legible at actual panel size/DPR; the hit region changes interaction, not the data mark's apparent magnitude |
| Subtle volume under a trend | A single series-colored vertical fade clipped to the plot; keep the trace visually dominant | Use an honest zero baseline for magnitude area; avoid filling a cropped line domain as if it represented absolute volume |
| Prior-period comparison | A labelled secondary line with a distinct dash or shape and sufficient contrast | Equal/aligned windows, actual time context, stable identity; do not communicate reference status through faintness alone |
| Selected time interval | A quiet interval tint plus handles/labels or selected-series emphasis, with surrounding context still readable | Range edges map to exact timestamps; non-drag controls exist; selection is distinct from alarm severity |
| Precise selected point | A small series-colored core with a contrasting selection ring; shared timestamp guide | Marker center represents the actual observation; no enlarging values or selecting a different point due to animation |
| Rich comparison tooltip | Aligned series swatches, exact values/units, actual sample times, and a separately labelled absolute/relative difference | Compute from compatible observations; handle zero baseline/missing counterpart; keyboard/touch parity and viewport collision |
| Rounded bars | Small terminal corner radii, bounded by bar width/height; preserve the measured baseline | Tiny bars remain readable; negative bars round the appropriate end; internal stack joins are not rounded into gaps |
| Compact range marks | Explicit low/high endpoints or an interval mark, with selected segments emphasized | Use only real interval data; rounded caps do not imply an invented distribution or ambiguous endpoint |
| Meaningful threshold | A restrained labelled rule or band behind the measured signal | Threshold source, comparison operator, unit and window are known; relevant breaches remain visible |
| Distribution texture | A perceptually ordered color scale with explicit bounds and legend | Color maps to actual count/rate/density; missing bins differ from zero density; no decorative rainbow |
| Quiet depth | Established Gamma boundary and overlay shadow; opaque enough tooltip surface | No glass/blur that reduces text or plot clarity; no altered product radius or bevel language from another kit |

For the supplied dark references, explore a fill around 15–22% opacity near the trace fading to roughly 2–4% at its zero baseline, with a crisp primary stroke. These are aesthetic starting ranges, not contrast guarantees. Anchor positive and negative fills correctly on either side of zero; a sign change must not reverse the intended fade or fill outside its truthful area. Measure the composited result in each theme. Do not add a gradient to every series or stack; solid fills may make composition more readable.

Keep focus effects local: a small contrasting selected-point ring or restrained under-stroke can identify a trace without broad glow. Do not blur quantitative bars or use halos that merge nearby lines. Keep the exact marker center and direct crosshair response immediate; a short visual emphasis must not delay selection.

Order layers deliberately: plot background → reference grid/interval bands → area fills → data strokes/bars → event/threshold emphasis where appropriate → focus/selection → axis labels and portalled inspection. Adjust this order when an important threshold would otherwise be obscured; verify real overlap cases.

Use stable widget-scoped IDs for gradients, masks, patterns and clip paths. Repeated dashboards commonly duplicate definitions; a global `id="gradient"` can cause one widget to reference another widget's paint server. Reuse the engine's verified ID-prefix facility or the established React ID owner, retaining SSR/client consistency. Theme changes must update the same owned resources.

Use a consistent sequential palette for ordered magnitude, a diverging palette only around a meaningful midpoint, and stable categories for entity identity. Color interpolation must not invent a severity transition; an actual status change can switch discrete state immediately.

## Framework translation

Read [frameworks and rendering](frameworks-and-rendering.md) for current verified APIs and release constraints.

- **TanStack:** use the released definition/mark styling and theme system, and one compatible motion path when needed. The default host's `svgAnimation` and the optional `motion()` renderer are separate owners; the latter ignores the former. Definition-level motion is SVG-only, while Canvas has different transition semantics. Override long entrance defaults, keep inspection immediate, and use a separate focus overlay if continuous data motion would defer inline focus styling. Keep optional imports deliberate and reuse Paprika's existing definition and host.
- **D3:** use scales, shapes, interpolation and layout as isolated mathematical utilities under React, or give D3 explicit ownership of a bounded subtree. D3's transition interpolation is a mechanism; the application still owns identity, gaps, interruption, reduced motion, and exact-value semantics.
- **visx:** compose its React primitives and, where suitable, XYChart animated components/providers. The package supplies building blocks; define the Paprika-level state, appearance, accessibility and performance policy explicitly. Do not add it solely to reproduce a gradient or rounded bar already supported by the current stack.
- **Mebius:** inspect a specific component's actual source and license before reusing code. Translate the useful visual/interaction behavior into the current host. A registry component's motion dependency or Tailwind setup is not automatically a justified dependency for Paprika.

Canvas marks do not inherit CSS selectors aimed at SVG descendants. Resolve theme colors, line widths, dashes, gradients, DPR and hit geometry through the rendering API. Keep semantic access and exact-value inspection independent of paint technology. Verify unsupported effects or fallback differences rather than assuming SVG/Canvas parity.

## Validation

Add focused checks for the new effect rather than a broad cosmetic test suite:

1. Trigger a second update halfway through the first. The result must settle on the latest valid state without jumping back, duplicating marks or leaving stale labels.
2. Change theme, resize, and open a second instance. Gradients, masks, clipping, selected series and portals must remain local and consistent.
3. Inspect a gap, missing tail, counter reset, threshold breach and reordered entities during the relevant transition. Exact-value evidence must remain truthful.
4. Exercise keyboard/touch, pointer-free inspection, and non-drag range controls. A polished hover effect is an enhancement, not the only interaction.
5. Enable reduced motion before load and while the app runs. Verify final geometry and all controls; no repeating animation or leftover delay.
6. Navigate away or replace the result mid-animation. Cleanup must stop timers/listeners and prevent stale data from returning.
7. Profile the effect on the representative dashboard workload. Record pointer-to-paint, main-thread work, memory and request behavior; no new fetches for pure styling.
8. When switching SVG/Canvas, compare values, clipping, colors, axes, focus/inspection and exported/alternative data. Treat renderer parity as measured, not presumed.

Capture settled renders for visual comparison and, where the actual transition matters, an interaction recording or a timed behavioral test. A final screenshot alone cannot validate interruption or motion quality.

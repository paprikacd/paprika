# Interaction, access, and performance

## Contents

- Shared investigation state
- Time-window brushing
- Rich inspection content
- Responsive composition
- Accessible inspection
- Geographic navigation and interaction scope
- Resilience and authoring
- Performance without changing meaning

## Shared investigation state

Use the existing dashboard state for range, timezone, filters, and refresh mode. Make panel overrides visible. If pinning or zooming changes the live mode, explain that state explicitly and provide a clear resume/reset action.

Synchronize exact timestamps, not array positions or normalized x percentages. Compare returned domains with the selected range; a sparse series starting late must not stretch a different interval across the same width. If nearest samples are shown, retain their actual timestamps and sampling offsets.

Honor current Paprika behavior: hover is transient; click/tap or Enter pins the inspector; Escape dismisses; new result data invalidates stale observations and cursors. Do not preserve a pin over a different query/result merely for continuity. A future pinned snapshot must own its immutable data, timestamp and visible stale/snapshot state.

Allow selection and inspection without triggering a drilldown accidentally. Give navigation a named action. Carry only applicable variables and time to a destination; a view override must not overwrite the destination's saved defaults. Preserve the expected Back/reset experience.

Keep chart interactions local unless they deliberately change query scope. Legend hiding usually changes presentation; changing a provider/query/range changes data. Document any different contract. Do not refetch because a user changes a line color, opens a details-only tooltip, or resizes a panel.

Record whether each action inspects, highlights, filters a panel, changes the dashboard population/time, or navigates. For a linked calendar, timeline, table and map, specify the affected panels, visible selected state and clear/reset behavior. A local incident-date filter must not accidentally recalculate an SLO against only incident records.

## Time-window brushing

Treat drag-to-zoom as a semantic domain operation. Keep the source extent, accepted window, temporary brush and timestamp cursor separate. Identify whether a commit changes only the **chart window** or the shared dashboard/query window. Show that scope; preserve adjacent KPI populations for a local window, and route shared query changes through the existing dashboard/query owner. A clipped picture alone is not evidence that query scope changed.

Use the installed host's brush/zoom facilities when they fit the interaction. If its brush overlay consumes exact-observation hit testing, explicitly arbitrate one small pointer owner rather than installing a second chart system. A down/up below the movement threshold remains a click; a real drag previews a translucent interval and commits only a finite, increasing, bounded range. Suppress the trailing click, release pointer capture, and cancel without changing the accepted range on Escape, pointer cancellation or lost capture.

Convert screen coordinates through the actual plot transform. Derive endpoints from the X scale, not the data-array index; irregular samples and a reference's authored calibration make those different. In a literal fixture, invert its actual authored mapping for the first selection, then use timestamp-derived geometry for analytical zoom. Move axes, annotations, gaps and inspection consistently with the selected domain. Do not fabricate boundary observations to make a selected window look populated.

Define a meaningful minimum duration and bound navigation to the source extent. Preserve the full source for reset. Provide Undo/reset and a non-drag equivalent such as labelled exact start/end controls, with timezone, validation and a real Apply action. Zooming into no observations must remain an empty window; reset must still be reachable. Source/scope replacement cancels obsolete gestures and inspection. Theme or layout changes must not reset a legitimate window merely by allocating a new result object.

Keep the brush preview immediate. Suspend hover/pinning during a real drag and resume it after release. If animating the domain transition, use one coherent, interruptible owner and keep exact readouts tied to actual observations; reduced motion reaches the same state directly. Record browser evidence for drag in either direction, click without drag, repeated narrowing, empty selections, cancel, non-drag input, undo/reset and source replacement.

## Rich inspection content

Build an inspector from actual observations in a predictable order: title/entity and pin state → timestamp with timezone → same-timestamp series values → short histories → explicit summary/coverage context → useful metadata and actions. Keep swatches, selected markers and miniatures aligned to stable series identity. An absent counterpart is missing; do not silently substitute its nearest sample. If nearest-sample comparison is explicitly requested, label each real timestamp and offset.

Label the population behind min/max, means, latest values and coverage. Sample coverage is an observed/total sample count unless a duration calculation actually establishes time coverage. Compute statistics before visual reduction; preserve zeros, nulls and fractional precision. A miniature should locate its selected point by timestamp, retain gaps, and disclose its own history window. Multiple tiny histories can use independent scales only when their purpose and lack of shared magnitude comparison are clear.

Provide functional actions: pin/unpin, close, exact data, or a verified destination. Do not add decorative query/events buttons without a working destination and applicable context. Keep transient content hoverable, pinned content stable, dismissal keyboard-reachable, and focus predictable. Reserve space or use a constrained scroll area for long metadata; never let richer content clip outside a narrow viewport. Test theme changes and source replacement while the inspector is open.

## Responsive composition

Keep a literal source-size/compare mode when reproducing a screenshot. For an operational responsive view, reflow the shell and panels; uniformly shrinking a desktop artboard does not provide readable mobile UI. Wrap the scope toolbar, move supporting panels into a deliberate reading order, keep tables in labelled internal scroll regions, and preserve usable controls.

Measure the chart's actual container. Recompute plot bounds and tick density at that width; keep SVG labels and interaction targets at usable CSS-pixel sizes. Do not fix tiny text by stretching geographic axes or distorting a time scale. Reposition rich inspectors within the panel/viewport or into a reachable detail region. Check source-width, tablet, narrow panel and actual small-viewport/text-zoom behavior separately. A desktop 390px preview establishes constrained-layout evidence, not physical touch testing. In auto-height reflow, make each widget wrapper contribute the plot, controls, legend and inspector to normal block flow. Replace block-size containment and cyclic `height:100%` with an appropriate inline-size container and automatic height. Compare panel bounds with all rendered child bounds; a correctly sized SVG can still overflow a zero-height wrapper and overlap the next panel.

## Geographic navigation and interaction scope

Read [geographic charts](geographic-charts.md). Treat projection and camera state as separate from source coordinates, values and query scope. Supply zoom buttons, pan without dragging, reset and keyboard equivalents. Declare wheel ownership: honor an explicit request for ordinary scroll-to-zoom, scope it to the map, preserve Ctrl/Meta browser zoom, and provide page-scroll escape outside the map or at outward zoom bounds. Validate selection after transform, source/filter replacement, click-versus-drag, pointer cancellation, overlapping points and outer CSS scaling. Unit-tested camera arithmetic does not establish physical touch behavior. Keep ordinary refresh from resetting the camera unnecessarily, while invalidating obsolete selected observations under the host contract.

## Accessible inspection

Target the existing WCAG 2.2 AA product contract. Apply the relevant criteria rather than claiming that a chart library guarantees conformance.

| Need | Implementation and verification |
| --- | --- |
| Identify the chart | Accessible name that identifies metric, population and range; concise useful description. |
| Understand exact values | Accessible bounded data view or inspector with the same source values, units, coverage and selected observation. CSV may supplement it, not replace it. |
| Explore by keyboard | Visible focus and a documented route to relevant observations/series, details, legend actions, reset and drilldown. Avoid thousands of tab stops; use a suitable roving or table pattern. |
| Use a pointer without dragging | Range inputs, click/tap controls or another equivalent for brush, resize and reorder. Keyboard support alone does not satisfy the non-drag pointer requirement. |
| Read tooltip content | Focus/touch equivalents, Escape dismissal, hoverability where appropriate, sufficient persistence, no viewport clipping, and a path to long content. |
| Distinguish color roles | Labels, line styles, symbols or patterns in addition to color; preserve focus independently of series/status colors. |
| See content | Normal text 4.5:1; qualifying large text 3:1; essential graphical objects/UI states 3:1 against applicable adjacent colors. Measure actual composited colors. |
| Reach controls | Apply WCAG 2.2 target-size requirements (24×24 CSS px or applicable spacing/other exception). Larger comfortable touch targets can be a design goal, not a falsely stated universal AA rule. |
| Zoom/reflow | Test 200% text zoom and narrow/400% page-zoom behavior as applicable. Keep controls and text usable; a genuinely two-dimensional plot/table may need its own scroll region without making the entire shell unusable. |
| Reduce motion | Respect the user's preference, keep static pending/selected cues, and avoid essential information conveyed only by motion. |

A short chart summary should describe what the displayed evidence supports. Do not generate an unsupported incident conclusion. Include unknown/partial coverage when it changes interpretation.

Use native controls and the maintained Gamma primitives. An SVG `aria-label` alone does not expose the operation of an interactive chart. Canvas/WebGL still needs a semantic companion and equivalent controls. Automated accessibility scans cannot evaluate the truth or completeness of the alternative representation.

For a continuously updating view, provide a deliberate pause/refresh route where required. Do not flood live regions on each point, move keyboard focus during refresh, or repeatedly announce the entire dataset. Announce concise user-relevant status changes.

## Resilience and authoring

Implement and inspect these states distinctly:

| State | Required behavior |
| --- | --- |
| Initial loading | Reserve useful geometry with the canonical loading treatment. |
| Refreshing valid data | Retain valid content where the host contract permits; show update state and reject stale response races. |
| Empty result | Explain that the query returned no observations; offer a relevant time/filter check. |
| Missing/null tail | Mark current availability honestly; an older finite value remains historical. |
| Partial/truncated result | Keep useful results with visible coverage/limit information; do not claim totals from a cap. |
| Query/provider failure | Actionable local failure; identify configuration only where useful; avoid misleading healthy remnants. |
| Stale/offline data | Visible last-observed/freshness context and a recovery path. |
| Missing or broken renderer | Isolate failure to the widget; keep dashboard/editor usable. |
| Invalid editor config | Preserve the last valid preview and entered draft; explain the error and respect Save blocking. |
| Save conflict | Preserve draft and authoritative revision context; do not silently overwrite. |

Use the existing preview, explicit Save, undo/redo, and conditional-write lifecycle. Retain schema bounds and trusted plugin IDs. A JSON/YAML/OpenUI import is data, never executable code. Reject unsupported plugin capabilities through current validation rather than accepting controls that do nothing.

Keep query interpolation/parameter binding in its maintained owner. Do not concatenate selected values into PromQL/SQL or put secrets in URL context. This is part of faithful integration, not permission to redesign authentication.

## Performance without changing meaning

Profile before swapping engines. Current Paprika uses TanStack-backed built-ins and specialized SVG plugins; renderer choice is an implementation decision based on measured load, capability, and maintainability. SVG, Canvas, or WebGL are not quality levels.

Separate query time, normalization, semantic calculation, display reduction, React work, drawing, and pointer handling. Record actual browser/device, panel count, series count, sample count, viewport, refresh rate, and build mode with measurements. A fast synthetic one-series demo does not validate a dense operational dashboard.

Use the existing min/max sampler and pure transformations where appropriate. Preserve endpoints, gaps, and task-critical extrema; inspect rich-plugin helpers before duplicating them. Do not claim LTTB or a visually representative sample guarantees every incident spike survives. A necessary extremum may require a min/max envelope or explicit retention.

Bound requested data, rendered marks, retained streaming history, concurrent work, and tooltip results. Share/deduplicate host queries where semantics allow it; cancel obsolete work, ignore late responses, and clean up observers/listeners/frames. Backpressure and pause/visibility policies must preserve the product's freshness contract rather than quietly hiding stalled data.

Avoid entire-dashboard rerenders on pointer movement. Use the existing cursor owner, stable data references, memoized transformations where warranted, and animation-frame scheduling for high-frequency interaction. Keep decimation outside pointer handlers. Offscreen suspension should be deliberate and show freshness when the panel returns.

Set or inherit a measured performance budget. If none exists, propose a provisional workload and budget explicitly rather than inventing an achieved target. A useful starter benchmark is 12 visible panels, 8 series each, 2,000 raw samples per series, plus a larger single-panel stress case; this is a test proposal, not Paprika's supported limit. Choose an interaction target appropriate to the device (for example, p95 pointer-to-paint ≤50ms) and report measurement method and baseline. Do not claim it passes without measurement.

Test sustained refresh, resize, filter changes, repeated tooltip open/close, and dashboard navigation for bounded memory and request counts. Check that a presentation-only change performs no data request. Confirm a slower previous query cannot overwrite the latest selection.

Apply performance improvements without changing the semantic result, losing accessibility, or weakening data coverage disclosure.

# Geographic chart contract

## Contents

- Choose a geographic encoding
- Normalize locations and preserve meaning
- Separate projection, camera and marks
- Implement usable navigation and selection
- Keep density and effects truthful
- Validate the interaction and transfer
- Primary references

## Choose a geographic encoding

Use a map when location or spatial relationships help answer the question. Pair it with ranked exact values when comparison matters. Choose one primary encoding and identify any secondary channel:

| Encoding | Appropriate question | Required contract |
| --- | --- | --- |
| Point presence / classified locations | Where are observed entities or events? | Supplied locations, classification and coverage; fixed-size points do not encode count |
| Proportional symbols | Where is observed magnitude concentrated? | A declared area mapping, unit, common domain and size key; use square-root radius for linear area |
| Clusters / spatial bins | How is a dense set distributed at this scale? | Aggregate membership/count, binning/zoom policy, exact expansion/list and undisplayed count |
| Choropleth | How do comparable rates vary by geographic unit? | Stable geometry join, population/denominator and unknown regions; raw counts can mostly reveal population size |
| Flows | Which locations exchange a measured quantity? | Real source/destination and direction, quantity/window, overlap treatment and meaningful path precision |

Do not assume all encodings are implemented by `connection-map`. The inspected owner renders supplied point locations. Add another encoding only through a verified owner/configuration with appropriate data and tests. Topology is a relationship graph, not a geographic map unless nodes have valid geographic positions.

## Normalize locations and preserve meaning

Accept stable entity ID, human label, supplied longitude/latitude, metric value/unit, classification, time/window and coverage as applicable. State the coordinate system and geographic precision. Use one declared order, conventionally `[longitude, latitude]` for geographic coordinates; do not silently swap fields.

Reject non-finite or out-of-range coordinates, invalid magnitudes and duplicate IDs according to an explicit policy. Preserve zero latitude/longitude and legitimate zero values. Never coerce an absent coordinate to zero or move an unlocated event to an invented city. Retain and disclose omitted/unlocated counts separately from located observations. Clarify whether summaries cover all source rows or only located rows.

Keep location precision honest. An approximate IP location, country centroid and measured site coordinate have different meanings. Do not derive precise city locations or a risk class from a country/ASN/name. Consume supplied risk/classification and keep it separate from country context. Treat labels and record values as untrusted content, never executable markup.

Use existing `QueryResult.records` and the current `connectionMapConfig` / `buildConnectionMap` adapter when extending Paprika's registered family. A reusable `GeoMap` primitive may consume typed normalized locations, but its wrapper must preserve validation, metadata, omitted counts and context emission. Do not replace the product schema with a private map-only document format.

## Separate projection, camera and marks

Use one geographic projection and one base coordinate frame for land, locations, annotations and hit testing. Keep its aspect ratio. Use a suitable fit/clip policy rather than stretch latitude independently of longitude. Record the geographic asset source and license. Do not make fetching third-party tiles or geocoding a hidden requirement for a local map.

Represent a flat map camera separately as uniform scale and translation: `screen = scale × projectedPoint + translation`. Keep source geographic coordinates immutable. Convert input points through the actual element screen transform, including outer CSS scaling and SVG viewBox fitting. Browser-client pixels, SVG coordinates and geographic coordinates are different spaces.

For pointer-anchored zoom from `(k,t)` to `k′` around point `a`, preserve the projected anchor `p = (a − t) / k` and use `t′ = a − k′p`, then apply bounds. At a pan boundary, clamping may deliberately move the anchor; document that exception rather than hide it with an overly broad test tolerance.

For a base world filling width `W` and height `H`, a scale at least 1 permits bounded translation `W − kW ≤ tx ≤ 0` and `H − kH ≤ ty ≤ 0`. Adapt bounds to the actual fitted geographic extent when letterboxing is present. Verify finite transforms at every entry point, including reset, programmatic fit, wheel, keyboard and pinch.

Choose a finite zoom range. A flat dashboard overview can start with 1×–8×; this is a proposed usable range, not a universal geographic limit. At 1×, reset returns the exact declared world view. Camera changes are presentation state: preserve values, classification, selected entity, query window and adjacent KPI populations. Preserve camera across ordinary refresh/resize unless a documented change of geographic scope resets it.

Render quantitative symbols and interaction geometry in screen space, or compensate correctly for camera scale. Otherwise zoom makes count-encoded circles appear to increase in value, hit targets become huge, and strokes consume the map. Keep the selected ring and border weight stable. If the entire reference artboard is CSS-scaled, verify final CSS-pixel target dimensions, not only unscaled SVG radii.

## Implement usable navigation and selection

Provide the following together when map navigation is requested:

| Operation | Required behavior |
| --- | --- |
| Zoom in/out | Labelled reachable buttons; bounded steps; stable center or intentional anchor |
| Pan | Direct drag plus equivalent directional buttons or another single-pointer non-drag control |
| Reset / fit | Named action returning to the declared world/data extent without changing values or filters |
| Wheel / trackpad | Declare ordinary, focus-activated or modifier zoom according to the task; honor explicit ordinary scroll-to-zoom requests; keep Ctrl/Meta browser zoom and a route back to page scrolling |
| Keyboard | Reachable camera owner; arrows for pan, `+`/`−` for zoom, Home/reset; visible focus and shortcut guidance |
| Touch | Distinguish selection, drag and two-contact pinch; preserve browser/page navigation through an explicit gesture mode when needed |
| Location selection | Click/tap/Enter exposes the same entity and values; visible selected treatment; clear/Escape and predictable focus |
| Dense/overlapping points | List, disambiguation or honest clustering; no point becomes unreachable solely due to overlap |

Do not claim keyboard shortcuts alone satisfy the non-drag pointer requirement. Native buttons can serve keyboard, mouse, touch and assistive input. Keep them discoverable without hovering. Quiet visual styling is compatible with adequate target size and a visible focus indicator.

For ordinary wheel zoom, normalize pixel/line/page delta modes, use bounded pointer-anchored transforms, and prevent default only for a consumed zoom. Let outward input at minimum/maximum zoom return to page scrolling; ignore zero/non-finite input, Ctrl/Meta browser zoom, Shift scrolling and horizontal-dominant trackpad gestures. Explain the gesture in the map, keep its listener local, and exercise it with real browser wheel input. A modifier-only implementation does not satisfy an explicit ordinary-scroll request.

Separate the painted point from its hit target. Use stable IDs for selection; a filter/reorder must not select another record by index. If the selected record disappears or is excluded by a filter, clear it or explicitly retain a labelled snapshot according to the host contract. Ensure the marker remains visibly selected and its inspector is anchored to the transformed point or an intentional fixed detail region. Pan/zoom must not leave the inspector describing a different point.

Arbitrate gestures: a drag exceeding a small threshold suppresses click selection; a pinch must not produce a trailing tap. Capture and release pointers correctly, handle cancellation/lost capture, and clear gesture state on unmount or mode changes. Define how a one-pointer gesture transitions to two pointers and back. Scope wheel/touch listeners to the map and remove them on cleanup.

Use a roving selection, searchable location list or bounded semantic table for larger sets rather than thousands of tab stops. Let the list disclose full labels, exact values, coordinates/precision and omitted counts. Keep selection and its clear/reset actions available when a point moves outside the viewport.

## Keep density and effects truthful

Keep the base map subordinate, use restrained land contrast and thin borders, and give observed marks a clear foreground. Layer land → data → selected/focused mark → inspector and controls. For two map instances, use widget-scoped IDs for gradients, masks and clips.

Use glow sparingly. A fixed presence halo may aid visibility; a data-driven radius must have a declared mapping. Do not let blur suggest measurement uncertainty, density or spatial reach unless it actually encodes that quantity. Never add jittered dots or random clusters to real results to resemble the reference's authored texture. In a labelled concept fixture, keep decorative points in a separate non-interactive, accessibility-hidden layer with provenance.

For dense inputs, cap or aggregate deliberately and display the consequence. Choose deterministic cluster/bin identity; specify whether color represents a count, maximum severity or another aggregate. Do not silently render the first N points while presenting an uncapped total as though every event is mapped. Test antimeridian handling, polar projection limits and duplicate coordinates when the selected geographic extent requires them.

Keep direct pan and pinch immediate, with no inertial drift or competing interpolation. A user-triggered reset/fit may use one short interruptible camera transition if it helps orientation. Reduced motion should reach the same final extent immediately. Zoom must not rebuild data adapters, refetch observations or animate counts.

## Validate the interaction and transfer

Use pure tests for coordinate normalization, duplicate policy, min/max scale, finite transforms, every pan boundary, anchor preservation away from bounds, exact reset and screen/world round trips. Cover empty input, invalid coordinates, legitimate zero coordinates, negative/zero values according to the contract, alternate location sets and reordered IDs.

Then test the actual browser surface:

1. Zoom with buttons at world and maximum extent; pan to all boundaries and reset exactly.
2. Zoom around a visible off-centre point; confirm pointer-to-map conversion at native size and in a CSS-scaled reference artboard.
3. Select an entity, zoom/pan, and compare its exact values and identity. Reorder/filter/replace data and verify the declared selection policy.
4. Drag without accidental selection; exercise cancellation and two-contact transitions through supported test tooling. Mark physical touch unverified unless actually tested.
5. Use keyboard and non-drag pan/zoom/reset controls. Inspect focus and usable target geometry at the rendered scale.
6. Exercise the declared wheel mode with real input. Verify map anchoring and browser Ctrl/Meta zoom preservation; for ordinary wheel zoom, verify outward boundary scrolling and scrolling outside the map. For activation/modifier modes, verify inactive scrolling passes through.
7. Render two maps, change one camera, and verify independent state, SVG resources and listeners.
8. Inspect ready, empty, partial/unlocated and dense cases; verify exact-data alternatives and no unnecessary queries.

Record the tested browser, viewport, map rectangle, device scale and input methods. Unit-tested viewport arithmetic does not establish gesture handling, touch usability, performance or accessibility conformance. A screenshot of a zoomed map establishes only that rendered state.

## Primary references

- [D3 zoom](https://d3js.org/d3-zoom): transform, input filtering, extent and programmatic camera controls. Inspect the installed library before using its APIs; an equivalent owned React/SVG viewport can satisfy the same contract without adding a dependency.
- [D3 projections](https://d3js.org/d3-geo/projection): geographic-to-planar mapping, fitting and clipping. Preserve one projection across every layer.
- [W3C dragging movements guidance](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html): provide a single-pointer alternative to author-defined dragging; keyboard equivalence alone is insufficient.

Retrieved 31 October 2026 (Australia/Melbourne). Treat the preceding choices as Paprika implementation guidance; the linked references do not establish that a particular map has passed those checks.

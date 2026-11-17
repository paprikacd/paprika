# Iteration 05 — reusable charts and interactive geography

This is the historical iteration-05 record. Iteration 06 changes map wheel ownership to ordinary scrolling and adds rich inspection, responsive reflow and chart-window selection; see [the current report](iteration-06-interaction.md).

## Outcome

The lab now exposes **eleven working examples through ten canonical renderer identities** at `#charts`, alongside the preserved Edge Watch and Reliability Room reference studies. The catalogue uses typed `Widget`/`QueryResult` inputs, strict owner configuration, explicit registration and `WidgetVisualization`. It demonstrates stat, time series, directional traffic, stacked outcomes, distribution heatmap, status history, record table, threshold gauge in linear and segmented forms, incident calendar and connection map.

Wide/narrow and theme controls preserve the input. Ready, missing, empty and query-failure presets are available where meaningful, with a context readout and normalized configuration/data disclosure. The incident-start calendar deliberately has no fabricated coverage-gap preset. See the [capability matrix](chart-capabilities.md) and [copied-owner provenance](chart-catalog-provenance.md) for boundaries and source ownership.

## Shared geography

The reference and reusable map share a viewport with **1–8× zoom**, drag, directional pan buttons, keyboard controls and reset. **Alt/Option + wheel** zooms the map; ordinary wheel scrolling remains available. Touch drag/pinch requires an explicit opt-in, and reset disables that mode. Each map keeps a projection appropriate to its own land geometry.

Stable location IDs preserve source identity. Camera changes preserve values and inspection; result replacement clears obsolete inspection while retaining the camera, and a filter clears a selected point that is no longer present. Fixed-size marks show location presence and supplied classification. Null values and unknown classification remain distinct from zero or low risk; invalid, duplicate and omitted records are disclosed. Concept decoration is separate from supplied observations. Embedded maps are static; tooltip-disabled interactive maps retain navigation without point inspection.

## Lessons carried into the skill

The iteration-04 reference geometry remains a visual acceptance fixture. Its transferable lessons are hierarchy, aligned scales, dense readable evidence, restrained effects, and exact inspection. Authored traces, illustrative lengths and fixed inspector positions must stay labelled as reproduction choices. Reusable claims require a registered owner, a parsed schema, valid variable input and meaningful interaction evidence.

The skill's independent forward exercise used a new **eight-region capacity and incident brief**. It completed the structural design and contract exercise; it did not produce or validate a new running dashboard. That distinction prevents a written plan from being counted as runtime evidence.

## Verification record

Closing review completed 31 October 2026 (Australia/Melbourne). The captures below are unmodified browser views of the tested implementation.

| Check | Observed evidence |
| --- | --- |
| Closing automated run | **119 tests across 9 files passed** after the final code changes. `npm run build` passed TypeScript and the production Vite build. Tests cover fixture/configuration contracts, registration, rendering, exact semantics and map transformation/selection behavior. |
| Catalogue browser execution | All eleven examples rendered through their actual owners. Null values and invalid-map-record disclosure were exercised. |
| Reference map | At **225%**, real pointer dragging, non-drag pan and Home reset worked. Ordinary wheel input preserved the camera. Selecting London then applying the high-risk filter cleared the hidden selection. |
| Stable row identity | AS16509 retained the same risk-history data before and after filtering. |
| Catalogue refresh | At **150%**, changing the result preset preserved the map camera and cleared the old selection. |
| Theme and layout review | Reviewed light/narrow and dark/wide maps. Corrected dark letterbox backgrounds in the light theme. Wide catalogue panels place exact observations beside the map; narrow panels stack them. |
| Bounds and failure recovery | The map reached **800%** with further zoom disabled, then reset. Empty and provider-failure presets displayed their distinct states and recovered to observed data. |
| Skill verification | Skill structure and local references validated; its declared-contract checker passed **22 tests**. The saved skill contains the new visual-system, chart-family and geographic-chart guides and updated brief/review templates. |
| Unexercised gestures | Physical touch and Alt-wheel browser input have **not** been exercised. Source inspection and transformation tests are narrower evidence than those gestures. |

### Captured views

- [Chart library: selected London at 150%](screenshots/iteration-05-chart-library-map.jpg)
- [Light theme: narrow map at 150%](screenshots/iteration-05-map-light-narrow.jpg)
- [Edge Watch: shared map at 225%](screenshots/iteration-05-edge-map-zoom.jpg)

## Remaining capability gaps

- **Elapsed-duration intervals:** sampled status-history cells do not yet provide a general irregular start/end interval contract.
- **Typed time bands:** incident and no-data bands in the literal burn chart have not become a reusable annotation schema.
- **Rich record cells:** trend arrays, country flags and segmented status cells remain scene compositions beyond the current general bar/color cell contract.
- **Local episode calendar:** the reusable calendar aggregates UTC incident starts; episode intersection, timezone boundaries and coverage remain in the retained analytical implementation.
- **Upstream integration:** this is a local lab extension of pinned copied owners. It does not establish production integration, editor support or deployment in Paprika itself.

Historical [iteration-04 evidence](iteration-04-pixel-reproduction.md) remains unchanged. The saved Site version records the exact source revision used to build this iteration; copied Paprika ownership is recorded in the linked provenance files.

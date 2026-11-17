# Paprika Widget Lab iteration 04

Recorded 30 October 2026 UTC. The user explicitly requested pixel reproduction after finding iteration 03 significantly different from the supplied concepts. This pass uses the two **1592 × 988** images as literal visual specifications.

## Scope and implementation

The reference studies are native HTML/CSS/SVG under `src/reference/`. Edge Watch and Reliability Room retain their distinct shell geometry, source typography hierarchy, panel bounds, content density, dates, values and initially open inspectors. The earlier analytical studies remain reachable through `#lab-edge` and `#lab-reliability`; their fixture contracts remain independent of the authored reference concepts.

The reference canvas is 1592 × 988 CSS pixels. Fit-to-window mode scales that artboard for viewing; **Actual size** exposes the unscaled reference canvas for comparison. A fit-mode screenshot is not evidence of an equal-size pixel match. Comparison evidence must record the browser viewport, canvas dimensions, capture dimensions, selected study and inspector state.

The new `reference-timeseries` renderer is registered through Paprika's trusted widget registry and displayed by `WidgetVisualization`. Its strict configuration selects Edge or Reliability, service/gateway labels and a bounded replay phase. It uses the existing D3 dependencies for native vector geometry, publishes selection through the shared cursor owner, and supports pointer/keyboard inspection, pinning, dismissal and local detail views. Its contract is an authored concept reconstruction, not a live-query plugin.

## Literal composition targets

| Surface | Edge Watch | Reliability Room |
| --- | --- | --- |
| Rail | Full-height, x0–79 | Below title, x12/y65/w66/h917 |
| Metrics | Four cards, y120–207 | Three cards, y121–264 |
| Primary plot panel | x98/y218/w948/h332 | x90/y273/w935/h306 |
| Right-hand comparison | Ten destinations | Six services |
| Supporting row | Geography, stacked outcomes, source risk | Six-row state history and incident calendar |
| Inspector target | x717/y269/w242/h251 | x602/y307/w214/h243 |
| Final evidence table | Four blocked requests | Four incidents |

Edge adds the defining map, flags, small source sparklines and segmented risk marks. Reliability restores the taller availability/target/budget cards, dense state cells, incident and unknown bands, May 2024 calendar and source table composition. Font candidates and colours are taken from actual image inspection rather than inherited unchanged from iteration 03.

## Authored fixture and provenance

The source concept values are intentionally retained for visual comparison. Edge's headline totals, destination table and displayed time captions do not form one reconciled measurement population. Reliability's main uptime budget example is arithmetically coherent, while several service-row budgets and the source bar length are independently authored examples. The reference inspector's miniature history captions also come from the artwork; they do not establish the original sampling or measurement process.

The trace script measures visible cyan/violet geometry and deterministically reconstructs occluded spans. Each public result has 361 aligned timestamps per series. Initial selected labels are explicit fixture anchors: Edge 912.36 and −312.18 Mb/s at May 29, 2024 13:32:08 UTC; Reliability 1.42x and 0.81x at May 16, 2024 10:40 UTC. Reliability preserves an explicit 36-point unknown span in both main series. These are authored coordinates and labels, not recovered telemetry.

See [reference asset provenance](reference-asset-provenance.md) for original screenshot hashes, tracing bounds and omissions, font files and OFL notices, Natural Earth map input and synthetic location attribution. The screenshots are not embedded as dashboard backgrounds.

## Automated verification

The new `tests/reference-chart.test.ts` passed **19 tests** using Vitest, and TypeScript checking passed after the renderer edge-case corrections. They exercise the public configuration/result functions and trusted registry rather than mirroring CSS:

- Strict configuration defaults and rejection of unsupported fields, modes, oversize labels and invalid replay phases.
- Exactly one registered reference plugin, strict parser use and preservation of the built-in time-series definition.
- Exact initial selected fixture values, timestamps, signed Edge conventions and synthetic identity.
- Increasing, cross-series-aligned integer timestamps and finite-or-null values across both complete profiles.
- Preservation of the Reliability unknown span, including finite observations immediately before and after it.
- Determinism, isolation from prior result mutation, replay timestamp movement and unchanged missingness.
- Service-fixture changes that retain the timestamp and missingness contract.
- Selected gateway identity carried into the public result without changing authored chart geometry.
- Server rendering through the registered owner, preservation of Mb/s versus burn-multiple units, and suppression of nested inspectors in embedded mode.
- Safe empty states for absent series, an empty series list and empty point arrays.
- Unavailable values retained as “No data” in both the selected Reliability legend and inspector.

The review found and corrected gateway labels that remained on `edge-01` after selecting `edge-02`, a missing-value legend fallback to default numbers, and an invalid timestamp render when the plugin received an empty result. The miniature-history renderer was also updated to retain null gaps instead of filtering them out before drawing.

The earlier suite contains 57 numerical/adapter tests; the final combined suite contains 79, including 19 reference-chart tests and 3 reference-reliability tests. Server-rendered markup tests establish these contract boundaries; they do not establish browser layout, focus behavior or screenshot fidelity.

## Browser and comparison evidence

The final implementation captures are [Edge Watch](screenshots/iteration-04-edge.jpg) and [Reliability Room](screenshots/iteration-04-reliability.jpg). Both were captured in the browser at a **1363 × 936** viewport. The 1592 × 988 artboard fits uniformly at 0.8561558, producing a 1363 × 845.882 dashboard with unused viewport space below. They are unchanged browser captures, not composited mockups.

The unscaled **1592 × 988** DOM artboard and the measured main component bounds were checked in Actual size mode. Edge's 13 major boxes, including the 717/269/242/251 inspector, matched the reproduction manifest. Reliability's 11 boxes also matched after the recent-incidents panel was corrected from y827/h155 to y826/h156. Geometry coordinates are based on the measured reference and are not a claim that every source pixel is identical. Full-page and clipped screenshot capture returned a browser capture timeout; only viewport captures succeeded, so no full-size1592 × 988 screenshot comparison is claimed.

The live **View settings → Compare to reference** control overlays the original image on the exact same artboard. Its opacity slider, Hide/Show and Escape/Close were exercised. The shared transform keeps source and implementation registered. A focus-induced scroll in the fit container was found and fixed using overflow clipping; keyboard interaction no longer moves the artboard away from its origin.

Runtime checks exercised:

- Gateway selection reaching both the inspector and result identity; destination filtering from 10 to 5 rows; rule filtering from 4 to 1 event.
- Keyboard observation movement and pinning; query details; nested Escape dismissal with focus returned to the inspector action.
- Synthetic replay advancing the selected timestamp; manual Reduced motion reporting no indicator animation while observations continue to advance.
- Reliability service selection changing the headline and inspector source; calendar selection filtering incidents from 4 to 1 without changing the selected service metric; clearing the filter restoring 4 incidents.
- Timeline arrow-key movement and Enter selection on 510 cells (85 per service), with real UTC interval labels; explicit detail dismissal.
- Opt-in source comparison, native-canvas geometry, fit-mode clipping, and the retained analytical routes.

Visual comparison corrected separate shell geometry, panel order and sizes, main curve silhouettes, default inspectors, fills, title/body width, clock-control padding, 28 measured outcome bars with gaps, denser map points, risk sparkline width, top KPI histories and approximately 9.5px timeline cell pitch. Remaining visible differences include exact source font rasterization, the hand-drawn brand/icon contours, the map projection/detail and individual point placement, and reconstructed trace spans hidden behind the reference inspectors. These are still review items; this pass is not represented as pixel-perfect.

**Final checks:** 79 tests passed across 7 files; the production build, including TypeScript, passed. The build emitted only existing third-party annotation notices. These checks establish numerical/registry/runtime contracts, not pixel identity, full accessibility, physical mobile behavior or live-provider performance.

## Skill correction

The Paprika Dashboard Design skill now explicitly selects **adaptation** or **literal reproduction** from user intent. Pixel mode requires exact canvas/state matching, measured panel and content geometry, preserved separate shells, literal concept fixture content, native components and equal-size comparison. It records source inconsistencies instead of silently replacing the requested layout with different analytical data. The new reference guide includes measured boxes, inspector sizes, row/cell counts, typography candidates and sampled colours for both screenshots.

The final timeline refinement measures about 9.5px cell pitch in the source, replacing the initial 144-cell guess with 85 authored display bins per service. State colours are sampled from the reference; the local interactive bins divide the 30-day fixture uniformly and do not assert an original telemetry cadence. The Edge KPI/history profiles are also measured from visible coloured ridges by `scripts/trace-reference-mini-profiles.py`.

# Iteration 11 — responsive Edge Watch and Reliability Room

## Outcome

The default `#edge` and `#reliability` routes now use fluid container-based composition at every width. Previously, windows at or above 1200px used a fixed 1592 × 988 artboard and scaled the entire dashboard. That reduced text and marker sizes, constrained panel height and left wider displays tied to the source canvas.

Normal mode now uses measured width, content-driven heights, desktop grid columns, tablet rows and mobile stacking. The source-size and comparison modes remain explicit controls. Existing fixtures, chart windows, selected observations, map cameras and exact values retain their identity during a resize.

This iteration extends the existing 85-example, 26-lens application. The full application, including the four iteration-10 widgets and source-aware configuration editor, is included in the Paprika repository delivery under `labs/widget-lab/`.

## Implementation

| Area | Change |
| --- | --- |
| Shell and summary cards | `ReferenceStudio` observes its available parent width. Normal mode never transforms an artboard. Cards use intrinsic grid rows, bounded typography and fluid traces. |
| Network traffic and burn rate | The registered chart owner measures content width, derives a 210–360px plot height, and remaps all Y geometry together. Time grids and labels respond to available space; narrow interval annotations retain hatching and accessible titles when their text cannot fit. |
| Pinned observation | Details remain below the plot, using two or three columns when the chart's own width permits. Exact values, source/SLO metadata, histories and actions remain available. |
| Connection geography | Responsive map stage preserves projection aspect and camera. Symbols, selection rings and a 28px hit diameter remain in CSS pixels. Selected location details flow below the map. |
| Request outcomes | Measured bars preserve all reconstructed bucket counts and authored relative placement. Narrow panels reduce tick density and provide keyboard/native bucket inspection. |
| Risk by source | Flags preserve their 11:7 ratio. Below 520px panel width, each source becomes a labelled compact record with requests, risk, country and status. |
| SLO timeline | All 85 bins per service remain visible. Tick count adapts; native service and UTC interval pickers plus an Inspect action provide usable exact inspection. |
| Records and settings | Tables share available width and wrap prose. Complete dense records scroll inside named focusable regions. Settings menus fit short viewports. |

The shared map behavior is opt-in, preserving existing hosts and source comparison. No new rendering dependency was introduced. The copied canonical owner patch remains unchanged and passes its provenance check.

## Browser evidence

`docs/qa/responsive.html` is a development-only same-origin iframe harness. Each width creates a real browsing-context viewport with its own `innerWidth`, layout and media queries. Width changes keep the same document, allowing state-retention checks. This HTML is not an entry point in the production Vite build.

| Viewport width | Available document width | Edge plot width | Reliability plot width | Page overflow |
| --- | --- | --- | --- | --- |
| 320px | 305px | 263px | 263px | None |
| 390px | 375px | 333px | 333px | None |
| 768px | 753px | 699px | 699px | None |
| 1024px | 1009px | 955px | 955px | None |
| 1280px | 1265px | 649.41px | 649.41px | None |
| 1592px | 1577px | 831.41px | 831.41px | None |
| 1920px | 1905px | 1022.75px | 1022.75px | None |

The 15px difference is the browser scrollbar. Desktop plots share a row with supporting records, so crossing into desktop composition changes their available width. All panels stayed within the document width. Metric values remained within their cards, and chart viewBox widths matched the actual content within subpixel rounding.

Executed interaction checks:

- Selected **San Francisco · 3,120 connections**, zoomed to **150%**, and resized through all seven widths. The selected location, value and camera were retained. The map hit diameter stayed **28px**, and the selected medium-risk mark stayed **8.4px** wide.
- At 390px, all five country flags measured **22 × 14px**, preserving their 11:7 proportions. Source-risk records retained their labels and statuses.
- Selected **payment-api · May 16 04:14 to May 16 12:42 UTC · risk** and resized through all seven widths. The detail remained selected, with **510 timeline cells** retained. The visible timeline ticks reduce to May 01, May 16 and May 31 at narrow widths.
- Reliability observation rings measured approximately **12.2px** across widths. The error-budget track retained a **20px** height. Its exact values did not change with layout.
- Closed the timeline detail and used **Inspect interval** with the displayed default pair. It opened **uptime-api · May 01 00:00 to May 01 08:28 UTC · healthy** without requiring a change away and back.
- Opened settings at **320 × 600px**. The menu occupied x=12–293px and y=66–584px, with its own vertical scroll and no page widening. Escape dismissed it.
- Explicit source-size mode retained a **1592 × 988** app, Edge's **946 × 253** chart viewBox and Reliability's **933 × 235** chart viewBox. Returning to Responsive auto restored fluid mode.

Raw measurements are in [`qa/iteration-11-browser-evidence.json`](qa/iteration-11-browser-evidence.json). Actual browser screenshots:

- [`screenshots/iteration-11-edge-desktop.jpg`](screenshots/iteration-11-edge-desktop.jpg)
- [`screenshots/iteration-11-reliability-desktop.jpg`](screenshots/iteration-11-reliability-desktop.jpg)
- [`screenshots/iteration-11-edge-map-390.jpg`](screenshots/iteration-11-edge-map-390.jpg)
- [`screenshots/iteration-11-edge-risk-390.jpg`](screenshots/iteration-11-edge-risk-390.jpg)
- [`screenshots/iteration-11-reliability-320.jpg`](screenshots/iteration-11-reliability-320.jpg)

## Automated verification

- **575 tests passed in 41 files** with `npm test -- --maxWorkers=2`.
- `npm run build` passes, including TypeScript checking.
- New geometry tests cover responsive and literal layouts, coordinated Y mapping, annotation fitting, bounded outcome bars, conserved authored counts, roving bucket focus and map symbol/hit sizing.
- Existing transport, widget registry, field mapping, editor, clinical, wafer, orbital, SRE and numerical-contract tests remain included.
- Provenance check passes for **65 copied files**, with unchanged patch SHA-256 `66e2736d5d452541c57723685dca81f41551f84b700898462f9626c83bb229e6`.
- Scoped whitespace checking passes.

The initial unconstrained test run overlapped a production build and hit the existing 5-second timeout in one wafer fixture test; 574 tests passed. The complete rerun with two workers passed all 575 tests without changing assertions or increasing timeouts.

## Scope and delivery

The data remains synthetic. Dense destination, service and incident tables retain intentional local horizontal scrolling at the narrowest widths. Browser viewport checks are separate from physical-device touch, screen-reader and browser text-zoom testing; those are not claimed here.

The `paprikacd/paprika` contribution is the complete independently runnable application under `labs/widget-lab/`, with tests, assets, source references and an exact canonical-owner delta. It does not wire the evaluation fixtures into production provider clients, authentication or saved dashboard documents. The repository guide explains the canonical integration boundary and the export manifest records the committed source identity.

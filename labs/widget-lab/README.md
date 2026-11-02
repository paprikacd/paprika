# Paprika Widget Lab

Dashboard studies built with the **Paprika Dashboard Design** skill and Paprika's chart host, trusted widget registry and shared cursor. The lab now includes **85 working chart examples and 26 dashboard lenses**, with typed field mapping, guided configuration and exact inspection. **Iteration 11 makes Edge Watch and Reliability Room fluid at every available width**: panels reflow, charts measure their content, and map points, flags, controls and labels keep usable sizes. The original **1592 × 988** artboards remain available explicitly through source-size and comparison modes.

The latest shared tooltip and dashboard authoring changes are in the [tooltip and authoring report](docs/iteration-12-tooltip-and-dashboard-authoring.md). Earlier responsive implementation and browser evidence are in the [responsive dashboard report](docs/iteration-11-responsive-reference-dashboards.md). The preceding [domain-widget and configuration report](docs/iteration-10-authoring-and-domain-widgets.md) covers the four new registered families and source-aware editor.

The default studies use **authored synthetic reference fixtures**. Visible values and dates follow the concept artwork; traced line profiles and reconstructed hidden spans are not recovered telemetry. Some source labels, time captions and budget examples are independently authored and do not reconcile into one query population. The earlier analytical studies retain their separately tested numerical contracts. This lab has no live provider connection, query backend or dashboard persistence.

## Dashboard studies

The visible navigation bar exposes **all 26 lenses and the Chart library**, including Edge Watch, Reliability Room, the domain studies and the SRE investigations. It wraps at narrow widths and keeps every destination available through the labelled lens picker. Navigation stays outside the optional source artboards.

| View | Route | What to evaluate |
| --- | --- | --- |
| **Edge Watch reference** | `#edge` (default) | Responsive composition: four compact metrics, signed traffic, ten destinations, connection map, 28 outcome stacks, five source-risk rows and blocked requests. |
| **Reliability Room reference** | `#reliability` | Responsive composition: availability/target/budget cards, burn plot, six services, six-row state timeline, May 2024 calendar and incidents. |
| **Chart catalogue** | [Open `#charts`](#charts) | 85 working examples grouped by core, concept, domain and SRE families, with strict configuration, normalized input, context readout, meaningful result presets and the shared editor. |
| **Finance lens** | [Open `#finance`](#finance) | Portfolio valuation, a sector/holding allocation treemap, performance against a synthetic reference, sector contribution and exact holdings. |
| **Website lens** | [Open `#website`](#website) | Event summaries, memory/CPU, sessions, request stacks, exclusive page-load buckets and directional transfer; one-hour/three-hour population selection. |
| **Infrastructure lens** | [Open `#infrastructure`](#infrastructure) | Current health, two independently navigable maps, compact capacity metrics, host trends, storage evidence and network traffic. |
| **Market Risk** | `#market-risk` | 35-position allocation, cumulative returns/drawdown, reconciled contribution waterfall, paired-return correlation matrix, liquidity horizons and exact holdings. |
| **Inference Fleet** | `#inference-fleet` | 128-device rack matrix, GPU inspection, pooled latency histogram and shared-window queue, conserved request routing, log scatter and workload evidence. |
| **Incident Room** | `#incident-room` | Three aligned telemetry lanes, deployments/incidents, nested trace with relative-time zoom, directed dependency graph, linked geography, session notes and source evidence. |
| **Grid Operations** | `#grid-operations` | Zoomable geographic network, dispatch scenarios, supply/demand balance, battery power/energy, forecast intervals, asset states and constraints. |
| Edge Watch analytical lab | `#lab-edge` | Retained iteration-03 gateway telemetry, conserved byte/request populations, 10s/1m observations and exact intervals. |
| Reliability Room analytical lab | `#lab-reliability` | Retained iteration-03 request-based availability, pooled burn rates, SLO accounting, service history and incident evidence. |
| Original widget lab | `#baseline` | Retained iteration-01 checkout-service investigation: latency, regional ranges, traffic, errors and a histogram heatmap. |

## Complex concept lenses — iteration 07

The four new lenses translate the generated concepts into real components. They retain the dense dark visual hierarchy, fine gridlines, restrained fills, exact inspection and chart-specific controls. Their numerical fixtures are derived and validated independently of the illustrative numbers in the generated artwork. They are adaptive implementations, not claims of pixel identity.

The existing React/TypeScript, Paprika `Widget`/`QueryResult` host, trusted registry, TanStack Charts, D3 primitives, shared map viewport and chart editor remain the foundation. No new charting framework was added. New renderer families are registered explicitly on a clean Chart library route; each also accepts independent normalized data in contract tests.

All four lenses expose panel **Edit** actions. The new families are also available through **Chart library**, including applicable missing, empty and failure fixtures. The generated source images and their identities are retained in `docs/references/`; actual implementation screenshots and verification evidence are in the [iteration-07 report](docs/iteration-07-complex-lenses.md).

## Interaction improvements — iteration 06

- Core time series and the two reference primary plots support horizontal drag selection, a local **Chart window** with keyboard handles and **Apply window**, **Undo zoom**, and **Reset zoom**. Exact UTC start/end entry is production's Compare window, which lab families do not yet supply series for. The complete source result remains available; dashboard-wide KPIs and query bounds are unchanged.
- Canonical time-series, directional, stacked and distribution inspectors show exact same-timestamp values, gap-preserving histories, raw window statistics, entity labels and an unrounded-data disclosure. The literal reference inspectors retain their evidence content inside the same pointer-following, viewport-bounded popup.
- The reference studies now reflow at **every width**, with desktop, tablet and mobile composition derived from the available container. Inspectors participate in panel height. **View settings** provides 390px and 768px layout previews; actual-size and source-overlay comparison remain explicit modes. See iteration 11 for actual browser viewport checks.
- The shared map supports ordinary pointer-centred wheel zoom, drag pan, explicit pan/zoom controls and reset. Outward wheel input at a zoom limit returns to page scrolling. Ctrl/Command, Shift and horizontal-dominant gestures pass through.

See the [framework inventory](docs/framework-stack.md) for the actual React, TanStack Charts, D3 and SVG owners, and the [interaction report](docs/iteration-06-interaction.md) for executed evidence and scope.

## New lenses and chart editing

The new lenses adapt the dense operational hierarchy of the supplied dashboard references to Paprika's visual grammar. They use deterministic synthetic data and working chart owners; they are not claimed as pixel-matched replicas of the additional Grafana screenshots. The [reference register](docs/reference-register.md) records the source images and how each informs the implementation.

In **Finance**, open a sector in the allocation treemap, inspect or pin a holding, and use the Portfolio breadcrumb to reset. Rectangle area encodes nonnegative market value; a fixed, zero-centred scale encodes signed daily change. Exact inspection names each holding's weight in the whole portfolio. Sector and portfolio changes pool current and previous values, and the period return agrees with the plotted history endpoint. All valuations and prices are synthetic, in USD, with an explicit closing timestamp.

In **Website**, the Window selector rebuilds the summaries and plots from the selected loaded event population. The one-hour totals are **66 logins, 94 sign-ups and 90 sign-outs**; the three-hour totals are **190, 269 and 273**. Those are separate event populations. Dragging within an individual time series changes only its **Chart window**. In **Infrastructure**, each map has its own camera; zooming one leaves the other at its existing view.

Use **Edit dashboard** to reveal direct panel editing, or open a panel's **Actions → Edit panel** menu on any dashboard. The chart catalogue, baseline, analytical studies, literal references and domain lenses share the same workbench and editor. Panel menus also offer **Inspect loaded data**, **View configuration** and **Reset panel edits**. It combines a live chart/table preview, grouped options on the right, and Data, Query and Configuration below. Guided controls and JSON share validation; invalid input retains the last valid preview and blocks Apply. Undo/Redo, Apply/reopen and Discard operate on the panel's local configuration. Visualization choices preserve the original custom mapping and offer only supported conversions.

The property rail has a separate **Tooltip** section for visibility, density, preferred placement, pointer gap, maximum width and maximum height. Placement automatically flips and shifts within the current viewport; oversized evidence scrolls within its popup. Hover follows the pointer, keyboard inspection anchors to its focused mark, and explicit click/Enter pins retain their position until dismissed or invalidated.

**Apply changes is local to the current dashboard session.** Done editing retains applied changes; leaving the route or reloading restores defaults. The dashboard menu can reset all session edits. The editor does not execute queries or durably save a dashboard. The Query workspace exposes the loaded fixture's context. Canvas controls provide 768px and 390px layout previews; a constrained desktop canvas is not a physical mobile-device test. Executed checks and remaining limits are recorded in the interaction report.

## Reusable charts


Open **`#charts`** from the lab navigation to evaluate stat, time series, directional traffic, stacked outcomes, distribution heatmap, status history, record table, linear and segmented threshold gauges, incident calendar and connection map. Every example renders a typed `Widget` and `QueryResult` through `WidgetVisualization`; it is an integration surface with real configuration and data contracts. Width and theme controls preserve the same input. Result presets cover ready, missing, empty and query failure where their semantics apply.

The shared map supports **1–8× zoom**, drag, non-drag pan controls, keyboard navigation, reset, **ordinary wheel zoom**, and explicitly enabled touch navigation. Scrolling outside the map and outward at its zoom bounds remains available. Stable location IDs connect selection to exact records; result replacement clears stale inspection while retaining the camera. Unknown classifications and null values remain visible, and invalid or omitted records are disclosed.

The [iteration-05 report](docs/iteration-05-reusable-charts.md) separates implemented behavior, executed browser checks and remaining validation. See [chart capabilities](docs/chart-capabilities.md) for the reference-to-owner matrix and explicit gaps, and [catalogue provenance](docs/chart-catalog-provenance.md) for copied owners and local extensions. The literal reference fixtures remain separate from the reusable analytical examples; these local changes do not establish upstream Paprika integration.

## Compare the reference studies

1. Open `#edge` or `#reliability`. The initial fixture and paused replay establish the reference state. Hover or focus a chart to inspect; click or press Enter to pin. Reload the route to restore its default configuration.
2. Open the rail's **View settings** gear, then **Compare to reference**. The source overlay is registered to the same 1592 × 988 canvas. Use **Source overlay** to move between the implementation at 0% and the supplied image at 100%, or use **Hide source / Show source**. The percentage controls opacity; it is not a fidelity score.
3. Compare shell edges, card and panel boundaries, typography, plot envelopes, and row counts. The interactive tooltip now uses the common pointer/viewport placement policy, so its position intentionally differs from the fixed popup in the historical artwork. Close comparison with **Escape** or its close button to return to the interactive dashboard. The reference image appears only in this opt-in diagnostic layer; the dashboard itself is rendered as native components.
4. Choose **Actual size · 1592 × 988** in View settings for unscaled inspection, or **Responsive auto** to return to the fluid dashboard. A fitted screenshot does not establish an equal-size pixel match; capture dimensions and state belong in the comparison record.
5. Open **Reference fixture notes** for the source limitations, **Motion · Auto / Reduced** for the motion preference, or **Interactive analytical lab** to evaluate the earlier numerical contracts. Controls and replay operate on local fixtures; the source's “Live” label does not indicate a provider connection.

See the [iteration-04 report](docs/iteration-04-pixel-reproduction.md) for implementation and verification evidence, and [reference asset provenance](docs/reference-asset-provenance.md) for screenshot hashes, tracing, fonts and map geometry.

## Run locally

Use Node.js 22.12 or later and npm.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. Reference studies retain the dates shown in the supplied concepts. The retained analytical labs display the browser's timezone; their source timestamps remain epoch milliseconds.

```sh
npm test
npm run typecheck
npm run build
```

The production build is emitted to `dist/`. `npm run build` includes TypeScript checking. The automated tests cover numerical semantics and the chart adapters; browser interaction and visual evaluation remain separate checks.

## Motion and loading extension

The current PR extends the existing Kubernetes Fleet (`#kubernetes-fleet`), Performance Workbench (`#performance-workbench`) and Distributed Systems (`#distributed-systems`) lenses with exact point rings, linked hover/focus emphasis, keyboard-operated quantile legends and clearer selected marks. Geometry and values update immediately; short appearance transitions honor the shared Motion preference and the operating system.

In **Chart library** (`#charts`), use **Loading preview** to inspect initial loading and retained-data refresh for each chart family. These are labelled simulations held until you choose Ready. Real lazy-route loading uses the same visual language. Line, bars, table, matrix and topology placeholders are presentation only and cannot be inspected as observations. The refresh indicator preserves the current chart, including its empty state. No new chart or animation dependency is added.

The design borrows interaction patterns from [Bklit charts](https://bklit.com/charts), preserving Paprika's existing Gamma theme, normalized data and trusted renderer registry. See [DESIGN.md](DESIGN.md#states-and-motion) and [UX-CONTRACT.md](UX-CONTRACT.md#motion-and-demo-replay) for ownership, reduced motion and selection invalidation. This remains the isolated evaluation application introduced by PR #168.

For a resource-constrained test runner, `npm test -- --maxWorkers=2` runs the complete suite with bounded concurrency. Build, semantic/render tests and source review are separate from rendered browser validation.

## Iteration 04 implementation

The reference studies use Barlow for body/table text and Roboto for panel titles and metric digits, with separate Edge and Reliability palettes. Native SVG supplies the line and area geometry, map, outcome stacks and state marks. The `reference-timeseries` plugin is a local trusted-registry extension with strict configuration, deterministic results, preserved null gaps and Mb/s or burn-multiple units. Its authored source geometry is independent of the retained analytical adapters.

| Location | Responsibility |
| --- | --- |
| `src/reference/ReferenceStudio.tsx`, `reference-base.css` | Fluid dashboard shells, route navigation and settings; explicit 1592 × 988 source mode. |
| `src/reference/ReferenceCompare.tsx` | Optional registered source overlay and opacity controls. |
| `src/reference/ReferenceEdge.tsx`, `EdgeSupporting.tsx` | Edge metrics, destinations, geography, 28 outcome stacks, risk and event table. |
| `src/reference/ReferenceReliability.tsx` | Reliability metrics, six service rows, 85 authored state display bins per service, calendar and incidents. |
| `src/reference/ReferenceCharts.tsx`, `ReferenceShared.tsx` | Registered chart owner, concept fixtures, inspection and shared visual primitives. |
| `tests/reference-chart.test.ts` | Configuration, registry, deterministic fixtures, selection, units and empty/missing-value regressions. |

Automated contract tests, browser interaction and screenshot comparison establish different properties. The [iteration-04 report](docs/iteration-04-pixel-reproduction.md) records the available evidence and remaining comparison limits; passing data tests alone does not establish a pixel match.

## Retained analytical lab — iteration 03

Open **`#lab-edge`** or **`#lab-reliability`** for the analytical studies described in this section. Their shell offers dark/light themes, a **390px content canvas** for narrow composition, **Motion Auto / Reduced**, controlled **Demo replay**, evaluation notes and links to the references. These controls and numerical contracts describe the retained lab, not the default reference fixtures.

Iteration 03 made the two analytical studies denser and developed the supplied references in the actual chart owner: scale-aligned vertical and horizontal grids, calendar-aware time ticks, zero-anchored signed area gradients, unit captions, reference rules, and a compact inspector with an 80px selected-series history. Since WP-B1b those capabilities are production's: the lab renders them from `ui/src/features/insights` and keeps no copy of the renderer or its strict schema. [`src/renderer-extensions/README.md`](src/renderer-extensions/README.md) lists the few lab-only wrappers that remain and the production gap each covers. [Source provenance](docs/paprika-source.md) records the upstream base of the copies that WP-B1b removed.

Shared metric cards target an approximately 80px height, and panel explanations move behind keyboard-accessible information disclosures. The main Edge plot retains a 250px container; all seven destination rows compare mean traffic on one common 0-to-highest domain, with percentage share shown separately. Recent event rows have a bounded default view and an explicit Show all control. Reliability adds a calendar of incident presence in the displayed timezone and keeps exact request-based budget accounting in a disclosure.

Demo replay starts paused. When started, it advances one real synthetic snapshot every **1.8 seconds**: **one minute in Edge Watch**, **one hour in Reliability Room**. It pauses when the document is hidden or the active study unmounts. Changed KPI values update immediately, with a **360ms** color/surface emphasis; the compact inspector uses a **150ms** reveal. Motion Reduced and the operating system's reduced-motion preference remove decorative effects while retaining the same data and replay cadence. No numerical count tween or path-morph animation is used. See the [motion owner](src/components/lab/motion.tsx) and [behavior contract](UX-CONTRACT.md).

### Retained analytical controls and semantics

**Edge Watch** offers all gateways or an individual Sydney/Singapore gateway, 15/30/60-minute windows, and Traffic surge, Steady traffic or Missing samples fixtures. The scope flows through its summaries, traffic chart, rankings, outcomes and exact data. A local rule filter affects only the blocked-request table. Next snapshot advances one minute while preserving observations at overlapping timestamps.

The traffic plot defaults to a visibly labelled **10s synthetic fixture** and can switch to **1m**. Each original minute is partitioned into six integer-count observations per gateway; their ingress bytes, egress bytes, requests, allowed, challenged and blocked counts sum exactly to the original minute. Request counts also equal the three exclusive outcomes in each ten-second observation. A missing minute produces six missing observations, and absolute observation times keep overlapping samples stable across scope, window and snapshot changes. This fixture construction does not interpolate measured provider data. Existing summaries, destination/protocol accounting, minute outcome bars and minute connection gauges continue to use their original minute source. Inspection distinguishes a 10s traffic observation from a 1m outcome bucket even when both share an interval-end timestamp.

Ingress and egress rates come from byte counts in decimal Mb/s. Egress is mirrored only in the traffic plot; the source and exact table retain its positive magnitude. Request outcomes conserve the same request population, destination shares conserve observed inbound bytes, and missing intervals remain unavailable. The latest connection gauge identifies its actual observation time. Complete-window deltas compare equal halves; the 15-minute view excludes the first minute from its seven-minute versus seven-minute comparison.

**Reliability Room** offers all services or one of four services, 24-hour/seven-day/30-day windows, and Incident replay, Steady service or Missing samples fixtures. Service and window selection update the investigation and budget accounting; the fleet comparison and history rows remain available for navigation. Next hour advances the window without moving resolved incidents or rewriting earlier observations.

Availability is `1 − failures / requests`; allowed failures are `0.001 × observed requests`. Remaining error budget can be negative and remains visible when exhausted. Six-hour burn uses pooled counts rather than an average of hourly ratios. The history cells represent the worst hourly burn in each stated interval, and incomplete cells remain missing/partial.

The incident calendar counts distinct episodes overlapping a local calendar date within the selected query window. Dates outside that window are disabled. Active/resolved describe episode state, not severity. Selecting a date filters the incident evidence only; availability, burn and budget keep the complete selected query population. The calendar includes the actual weeks needed by its month and uses civil-date handling across daylight-saving changes.

The main plots use the canonical inspector with selected-series mini-history and shared timestamp readouts. Custom request-outcome bars publish into the same cursor store, support keyboard navigation and pinning, and provide an explicit Clear pin action. Fixture, resource, window and snapshot changes clear obsolete inspection.

### Evaluate the retained analytical studies

1. Open **Edge Watch at `#lab-edge`** with Traffic surge, All gateways and 30m. Compare the mean rates with the traffic history, then inspect a point with pointer or keyboard.
2. Use ArrowRight and Enter in the canonical chart to pin an observation; Escape closes the native inspector. Pin an outcomes bucket and use **Clear pin**. Advance the snapshot and check that obsolete inspection clears.
3. Select a gateway, switch between **10s** and **1m**, and open **Exact intervals**. A 15/30/60m window contains 90/180/360 ten-second observations or 15/30/60 minute observations. Confirm the resolution switch preserves summaries and that six subintervals roll up to their original minute. The policy-rule filter is local to its event table.
4. Switch to **Missing samples**. Check unavailable intervals, observed coverage and the timestamp of the last collected gauge; missing data must not turn into zero.
5. Open **Reliability Room at `#lab-reliability`**, select `payment-api`, and choose **Last 24 hours** with Incident replay. Inspect its negative budget, failed-request allowance and current burn. Return to All services to compare request-weighted fleet results.
6. Select a reliability-history cell with the pointer or arrow keys. Home/End reach the boundary cells; the detail row gives the actual interval, counts, worst hourly burn and coverage.
7. Compare both studies in light and dark themes and with the narrow content canvas. For unchanged fixture, scope and snapshot, measurements must remain invariant. The narrow control does not simulate touch or change the actual browser viewport.
8. Use the Reliability calendar to filter incident evidence, then confirm availability and budget still describe the full selected window. Open exact accounting and a panel information disclosure; check Escape and focus return.
9. Start **Demo replay**, pause it, and switch to **Motion Reduced**. Check real snapshot advancement, unchanged observation cadence, immediate exact values and cancellation of decorative effects. Background the document to check that replay pauses.
10. Use **Compare original lab** or `#baseline` to revisit the original latency and distribution investigation below.

### Analytical implementation and historical verification

The analytical lab composes Paprika's chart and Gamma APIs with owned panels, sparklines, outcome bars, tables, a reliability timeline and an incident calendar. Iteration 03 added **`d3-scale` 4.0.2** as a direct dependency, with **`@types/d3-scale` 4.0.9** for type checking, and patched the copied chart/schema/inspector owners. TanStack Charts remains pinned to 1.1.0. Selected-series mini-history preserves the selected series' identity inside the native inspector. All dates passed into calendar scale channels are derived from the original numeric timestamp; exact tooltip and cursor data retain epoch milliseconds.

| Location | Responsibility |
| --- | --- |
| `src/App.tsx`, `src/observatory.css` | Route selection, analytical study navigation, theme scope and responsive canvas. |
| `src/components/lab/StudyPrimitives.tsx` | Shared panels, metrics, sparklines, status and empty-state presentation. |
| `src/components/lab/motion.tsx` | Effective motion preference, replay registration, timer lifecycle and visibility cleanup. |
| `src/studies/EdgeWatch.tsx` and its CSS Module | Edge dashboard and outcomes interaction. |
| `src/data/edge-telemetry.ts` | Deterministic gateways, rates, request/byte partitions, coverage and chart adaptation. |
| `src/studies/ReliabilityRoom.tsx` and its CSS Module | Reliability dashboard, timeline selection and budget presentation. |
| `src/data/reliability.ts` | Request-based availability, pooled burn rates, budgets, history and incident identity. |
| `src/renderer-extensions/` | Lab-only wrappers and the zoomable connection map that extend production's Insights renderer. No copies: production is imported from `ui/src/features/insights` through `@insights/*`. |
| `src/BaselineApp.tsx` | Original iteration-01 lab, retained at `#baseline`. |

Verification is recorded per iteration. The [iteration-02 report](docs/iteration-02.md) retains its historical 40-test run and browser checks. The [iteration-03 report](docs/iteration-03.md) records that iteration's tests, screenshots and remaining limits. Neither report establishes verification of the newer reference reconstruction. Numerical tests, type/build checks, browser interaction, actual viewport resizing, reduced motion, touch, screen-reader behavior and production telemetry performance are separate checks; source inspection is not a browser-validation claim. The original [evaluation report](docs/evaluation-report.md), [data contract](docs/data-contract.md), and [Paprika source provenance](docs/paprika-source.md) remain available.

## Original baseline — iteration 01

Open `#baseline` for the original fictional checkout-service investigation. The material below records its five widgets, fixtures, evaluation sequence and numerical checkpoints; it does not describe the Edge or Reliability datasets.

### Five widgets

| Widget | Question | Implementation |
| --- | --- | --- |
| Request latency | How did the median and tail change? | Canonical Paprika time-series renderer; pooled one-minute p50/p95 estimates, window p95 and equal-window comparison. |
| Where is the tail? | Which region contributes the slower requests? | New `RegionalLatency` component with p50-to-p95 ranges on a shared zero-based scale. Selecting a row filters the other widgets. |
| Request volume | Did throughput change? | Canonical time-series area renderer; collected interval counts divided by 60 seconds. |
| Error rate | What fraction of requests failed? | Canonical time-series renderer; failures divided by requests, with explicit fraction-to-percent conversion. |
| Latency distribution | Where is the request population concentrated? | Canonical distribution heatmap plugin; cumulative adapter input is differenced once into bucket counts. |

The three time-series widgets use Paprika's existing TanStack Charts host. The distribution plugin and regional comparison use SVG geometry. The regional component supplies new composition and interaction without adding a chart-library dependency.

### Three fixtures

| Fixture | Intended stress case |
| --- | --- |
| Deployment regression | Complete telemetry; Sydney's latency distribution shifts after the synthetic deployment, while the other regions stay broadly stable. |
| Missing samples | Five internal missing intervals and three missing final intervals at the initial snapshot. Missing observations remain unavailable; partial comparisons show each side's coverage. |
| Quiet service | Sparse requests interspersed with collected zero traffic. A zero-request interval has a known request rate of zero and an undefined latency percentile/error ratio. |

Each fixture covers three regions and 60 one-minute intervals. Snapshot one ends at **2026-10-30 05:00 UTC**, which is **16:00 AEDT**. `Next snapshot` advances the window by one minute and replaces the result, clearing obsolete selections and pins.

### Baseline evaluation walkthrough

1. Start with **Deployment regression**, **All regions**, **60m**. Compare the p95/p50 traces and the earlier/later summaries.
2. Select **Sydney** in the regional widget. Verify the scope, chart values, summaries and exact-data table follow that population. Clear the selection to return to all regions.
3. Inspect a time using pointer or keyboard; click or Enter to pin and Escape to dismiss. The shared observation strip should report the same sample timestamp and values.
4. Open **Exact data** to compare observed request/error counts, percentile estimates and regional coverage. Displayed numbers are rounded for reading; calculations retain numerical precision.
5. Switch to **Missing samples**. Inspect the internal gaps, unavailable final intervals, stale-data notice, partial-population comparison and outlined missing heatmap cells.
6. Switch to **Quiet service**. Check that zero request counts remain visible while absent percentiles and zero-denominator ratios remain unavailable.
7. Change **Narrow canvas**, theme and browser width. For an unchanged fixture, scope and snapshot, numerical summaries should remain invariant. Check clipping, legends, focus and inspection surfaces separately.
8. Open **Evaluation guide** and try **Loading**, **Error** and **Empty**. These controls affect the latency panel only. Restore **Data** to continue investigation.
9. Test a new snapshot while an observation is pinned. Also test reduced motion, keyboard-only navigation, touch inspection and the 15/30/60-minute views.

The 15-minute view compares adjacent **7-minute** windows and explicitly excludes the first minute from that comparison. The 30- and 60-minute views compare 15- and 30-minute halves respectively.

### Baseline numerical checkpoints

Initial snapshot, 60-minute range, all regions, deployment-regression fixture:

| Quantity | Expected calculation |
| --- | ---: |
| Observed requests | 1,070,502 |
| Mean request rate over complete intervals | 297.3617 req/s |
| Population-weighted error percentage | 0.500793% |
| Pooled full-window p95 | 616.6701 ms |
| Earlier 30-minute p95 | 271.6633 ms |
| Later 30-minute p95 | 731.4900 ms |
| Sydney earlier/later p95 | 272.0419 / 864.4277 ms |

The initial missing-samples fixture has **52/60 complete intervals (86.67%)** and a final observed timestamp three minutes before the requested end. Its comparison coverage is **25/30 intervals before (83.33%)** and **27/30 after (90%)**. The quiet-service fixture contains **63 observed requests** across the hour.

These quantiles are estimates obtained by pooling compatible histogram counts and interpolating within buckets. They are not averages of regional percentiles or exact quantiles from raw request durations.

### Baseline source and structure

The renderer is production's `ui/src/features/insights`. The lab consumes it: `@insights/*` resolves there through `vite.config.ts` and `tsconfig.json`, and the lab's packages supply its dependencies, so one React and one TanStack Charts serve both. The lab adds no copy of production code, and it does not edit `ui/`. A change to production appears in the lab on its next build. The lab's own extensions are in `src/renderer-extensions/`. Upstream license and Gamma attribution files are kept in `attribution/`.

| Location | Responsibility |
| --- | --- |
| `src/BaselineApp.tsx` | Original evaluation layout, scope, fixture selection and state controls. |
| `src/data/telemetry.ts` | Deterministic observations, histogram estimates, coverage, filtering and canonical summaries. |
| `src/data/chart-adapter.ts` | Paprika widget definitions, common time-domain anchors, percentage conversion and cumulative histogram input. |
| `src/components/RegionalLatency.tsx` | New regional interval comparison and filtering control. |
| `src/components/ObservationBar.tsx` | Shared timestamp inspection readout. |
| `src/components/ExactData.tsx` | Accessible interval data table. |
| `tests/` | Numerical and adapter acceptance tests. |

Read the [data contract](docs/data-contract.md) for interval, missingness, comparison and aggregation semantics. Read [Paprika source provenance and integration](docs/paprika-source.md) for the exact reused exports, dependencies and runtime boundaries.

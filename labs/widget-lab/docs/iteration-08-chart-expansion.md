# Iteration 08 — ten lenses and chart-family expansion

**Status: implemented in the Widget Lab; 354 automated tests and TypeScript validation passed; all ten lenses reviewed in the browser.** The final build and publication result are recorded by the publishing workflow after source packaging. This report distinguishes completed checks from untested production and physical-device behavior.

This iteration implements the ten generated dashboard use cases using the existing Paprika components and trusted extension path. It adds **27 plugin identities**, **29 chart-library examples**, and **ten dashboard lenses**. The library now contains **51 examples**, and the visible navigation contains **19 dashboard lenses**, including the two original reference studies. The requested profiling work includes deterministic Pyroscope-shaped mock profiles and a distinct chronological flamechart with sampled input.

Generated images guide composition, density, palette, linked inspection and distinctive chart structure. Source records and mathematical constraints determine the rendered values. This report records component implementation; equal-size pixel parity with every generated image remains a separate visual acceptance claim.

## Inventory and navigation

The source of truth is [`allChartCatalog`](../src/catalog/chart-fixtures.ts), [`lensRoutes`](../src/lenses/lens-routes.ts), [`DashboardNavigation`](../src/components/DashboardNavigation.tsx) and the registration bundles composed by [`registerConceptCharts`](../src/charts/register-concept-charts.ts).

| Lens and route | Main decision and preserved visual structure | New registered plugin IDs |
| --- | --- | --- |
| Query Atlas — `#query-atlas` | Compare sampled cost, stack ancestry, chronological execution and a supplied query plan; large flame view, exact frame details, hot functions and local import/export. | `profile-flamegraph`, `sampled-flamechart`, `query-plan` |
| Journey & Retention — `#journey-retention` | Compare signup cohorts at the same age, then follow one population through activation and first-session paths. | `cohort-matrix`, `conversion-funnel`, `stage-flow` |
| Logistics Control — `#logistics-control` | Locate illustrative shipments, compare arrival intervals with promises and inspect port dwell evidence. | `route-map`, `eta-windows`, `dwell-boxplot` |
| Factory Quality — `#factory-quality` | Separate process-control signals, raw dimension distributions, machine variation and defect contributions. | `statistical-control`, `sample-distribution`, `pareto-bars` |
| Threat Hunt — `#threat-hunt` | Move from directed relationship density to a bounded observed neighbourhood and exact event evidence. | `adjacency-matrix`, `entity-neighbourhood`, `event-swimlanes` |
| Experiment Studio — `#experiment-studio` | Compare treatment estimates, uncertainty, supplied effect distributions and assignment/observation populations. | `interval-estimates`, shared `sample-distribution` |
| Spectrum Observatory — `#spectrum-observatory` | Inspect frequency-time power, aligned spectrum and complex-sample deviation, alongside channel occupancy. | `spectrum-analyzer`, `iq-constellation` |
| Coastal Observatory — `#coastal-observatory` | Select a buoy, inspect geographic current vectors, directional populations and the depth/time temperature field. | `coastal-vector-map`, `directional-rose`, `depth-curtain` |
| Production Planner — `#production-planner` | Review resource allocation and dependency timing, propose a task shift and inspect its capacity consequences before Apply. | `resource-gantt`, `resource-load`, `schedule-dependencies` |
| Materials Lab — `#materials-lab` | Explore composition, strength/density tradeoffs and multivariate constraints while retaining the same candidate identities. | `ternary-composition`, `pareto-scatter`, `parallel-coordinates` |

The new catalogue contribution is **3 profiling + 9 analytics + 8 spatial + 9 exploration = 29 examples**. The analytics bundle has seven registered owners: `sample-histogram`, `sample-violin` and `sample-ridgeline` are three configurations of `sample-distribution`. This accounts for the difference between 29 examples and 27 new identities. The eleven original catalogue examples and eleven iteration-07 examples remain present: **11 + 11 + 29 = 51**.

Global navigation has a labelled dashboard picker as well as links. Lens Studio keeps the same auto, 768px and 390px presentation controls for each route. Routes, catalogue examples and registered rendering identities are intentionally counted separately.

## Architecture and source ownership

Every new chart is a records plugin registered through the existing trusted registry. The common path is:

1. A deterministic fixture or accepted local profile import produces normalized records with stable identities and declared units.
2. A strict configuration parser and pure model adapter validate the chart's required semantics.
3. `WidgetVisualization` owns data-kind checks, renderer selection and error presentation.
4. The registered renderer owns marks, axes, inspection and its declared local interaction; the lens owns cross-panel scope and reversible proposals.

| Bundle | Chart owners and models | Lens/fixture owners | Catalogue / tests |
| --- | --- | --- | --- |
| Profiling | `src/charts/profiling/`: `ProfileCharts`, `QueryPlan`, `profile-model`, `register`. | `src/lenses/profiling/`: `QueryAtlasLens`, `profile-fixtures`. | `profiling-fixtures.ts`; `tests/profile-model.test.ts`. |
| Analytics | `src/charts/analytics/`: `AnalyticsCharts`, `data`, `register`. | `src/lenses/analytics/`: the three lenses and `analytics-data`. | `analytics-fixtures.ts`; `tests/analytics-lenses.test.ts`. |
| Spatial | `src/charts/spatial/`: maps, distributions, field renderers, shared interaction/model and registration. | `src/lenses/spatial/`: the three lenses and `fixtures`. | `spatial-fixtures.ts`; `tests/spatial-lenses.test.ts`. |
| Exploration | `src/charts/exploration/`: threat, schedule and materials renderers, shared inspection, pure model and registration. | `src/lenses/exploration/`: the three lenses, shared panel host and `data`. | `exploration-fixtures.ts`; `tests/exploration-lenses.test.ts`. |

No new dependencies were added. The implementation retains React, existing D3 modules, SVG and canvas, Zod, Gamma controls and the existing geographic/time-window primitives. No extra dashboard document schema, backend service, durable settings store or live provider was introduced.

### Intrinsic chart layout

Several new owners include axes, controls, legends and a rich inspector in their natural block flow. Treating these as fixed-height plots can collapse containment or overlap the next section.

[`src/charts/intrinsic-chart-families.ts`](../src/charts/intrinsic-chart-families.ts) centralizes the **27 new plugin IDs in one `Set`** and exports `hasIntrinsicChartLayout`. Both the catalogue and editor derive their expanded-layout attribute from the active widget, including when an editor changes the visual. The expanded wrapper uses `height: auto` and `container-type: inline-size`; existing fill-height renderers retain their established host. Lens wrappers apply the corresponding intrinsic containment. Dense matrices, schedule geometry, parallel coordinates and exact tables can scroll inside their panels while surrounding composition reflows.

This is an implemented sizing contract, not evidence that every narrow viewport, browser and device has passed visual QA.

## Profiling data and import/export boundaries

### Mock datasets

The profile selector exposes four deterministic synthetic fixtures:

| Fixture | Declared source character | Cost and chronology |
| --- | --- | --- |
| `postgres-cpu` | `orders-db`, PostgreSQL-style native call stacks. | CPU samples plus authored time samples; the supplied query plan is shown for this fixture. |
| `go-cpu` | `checkout-api`, Go HTTP/pgx stack names. | CPU samples plus authored time samples. |
| `python-cpu` | `forecast-worker`, Python/pandas/NumPy stack names. | CPU samples plus authored time samples. |
| `go-alloc` | `checkout-api`, Go allocation stack names. | Allocated bytes; aggregate-only presentation. |

These are authored workloads, not captures from the named runtimes or a connected Pyroscope service. Fixture sample weights align with the declared 100 Hz CPU sampling interval. Byte allocation cost retains its own unit and does not acquire a fabricated elapsed-time axis.

### Accepted formats

[`profile-model.ts`](../src/charts/profiling/profile-model.ts) is the actual compatibility boundary. Public format documentation is context; it does not broaden the implemented adapter.

| Input | Supported interpretation | Explicit limit |
| --- | --- | --- |
| Pyroscope Flamebearer JSON | Version 1 `single` profiles, symbol names and four-value frame tuples; inclusive/self values, ancestry, metadata units and sample rate. | Differential profiles are rejected. Frame positions, parent containment, sibling overlap and accounting must validate. |
| Current Pyroscope Querier `FlameGraph` JSON | Supported `names`, `levels[].values` and `total` shape, either direct or under the accepted flamegraph wrapper. | Unannotated input defaults to CPU nanoseconds. Another cost unit requires appropriate supported metadata. This is a JSON adapter, not a live Querier connection or a generic protobuf decoder. |
| Folded/collapsed stacks | Semicolon-delimited symbols and nonnegative counts interpreted as **CPU samples at 100 Hz**. | Aggregate only. The text does not establish chronology or preserve arbitrary units/sample rates. |
| Speedscope sampled JSON | Shared frame table, aligned stack/weight arrays and time units: seconds, milliseconds, microseconds or nanoseconds. | Only `type: 'sampled'`; weights must reconcile with the declared extent. Bytes/unitless weights and evented profiles cannot establish the supported time chart. |

**Binary pprof is not supported.** The lab also has no differential-profile renderer, symbolizer, live collection pipeline or live Pyroscope query connection. Grafana's [server API documentation](https://grafana.com/docs/pyroscope/latest/reference-server-api/) describes its broader query and transport surface; none of that transport is invoked by this local importer. The [official Speedscope schema](https://www.speedscope.app/file-format-schema.json) defines both evented and sampled profiles, while this implementation deliberately supports the sampled subset.

The visible import workflow limits files to 4 MB and accepted host results to **1,000 frames and 1,000 chronological samples**. Parser-level upper bounds are not a claim that the current UI accepts larger imports. Invalid input retains the currently displayed profile and reports a validation error. Imported content remains in the browser session.

The download actions produce Flamebearer JSON, folded stacks or Speedscope sampled JSON when their source semantics permit it. Flamebearer encoding requires integer costs and rejects fractional time weights instead of rounding them. Folded export requires a 100 Hz sample profile with named stacks; byte profiles and unrepresented root self cost are excluded. Speedscope export requires actual samples. Aggregate imports do not synthesize a time-order export.

The same fixture builders produce a reusable file set under `public/fixtures/profiling/`: four Flamebearer JSON profiles, three CPU Speedscope files, three folded CPU stack files and a manifest. Run `npm run fixtures:profiles` to regenerate them. The Go allocations fixture is aggregate-only and has no Speedscope or folded-sample export. The README records the supported subset and mock provenance.

### Flamegraph and flamechart semantics

An aggregate frame satisfies `inclusive = self + sum(immediate child inclusive)`. A flamegraph's x position is an ancestry layout over cost. Focusing a subtree changes the view, while profile-share calculations keep the complete original denominator. Search dims unrelated frames; it does not silently reduce that denominator. Hot-function self cost sums occurrences, and inclusive aggregation avoids double-counting recursive descendants.

A sampled flamechart has actual elapsed start/end intervals and thread identity. It merges adjacent equal ancestry only when intervals are contiguous. Gaps remain gaps; overlapping samples within a thread are rejected. Thread selection and time-window zoom change the view. Exact elapsed seconds, Undo/Reset and selected-span focus are alternatives to dragging. The root profile and elapsed sample window are separate quantities even when displayed in the same lens.

Query-plan nodes retain supplied ancestry, inclusive elapsed time, actual/estimated rows and loops. Adding their inclusive times would double-count nested work. Plan evidence is a separate synthetic input, not a reconstruction of an imported profile.

## Numerical contracts exercised by the lenses

### Cohorts, quality and experiments

Retention cells keep their initial cohort size and observation age. Future ages are unobserved, observed null values are missing, and observed zero is a measured count. A selected cohort changes the activation/path population coherently. The funnel decreases through sequential stages; the path-flow links reconcile to one original-session population.

Factory charts separate supplied subgroup control limits from dimensional specification limits. Missing subgroup measurements break the control path. Histogram bins conserve finite sample counts, including the final endpoint; violin/box and ridge summaries derive their quantiles and density from the same samples. Defect Pareto shares use the defect population denominator, not every inspected part.

Experiment estimates retain their eligible population and nested supplied 80%/95% intervals. Their ridgelines show deterministic illustrative effect draws. Assignment, observed, pending and missing counts remain explicit; the dashboard is not running a statistical experiment or fitting a live posterior.

### Geography, frequency and depth

Shipment and coastal observations use coordinates consistent with their fitted geometry. Their shared camera supports ordinary wheel zoom, bounded pan, keyboard/buttons and reset. Camera movement changes presentation without changing selected record identity, route risk or buoy values. Geographic routes and synthetic basin geometry remain labelled illustrations.

ETA intervals validate `P10 ≤ median ≤ P90`, and promise markers share the same UTC scale. Port dwell summaries preserve ordered min/quartiles/median/max, separate outliers and sample counts.

The spectrum's dense canvas and line spectrum use the same frequency bounds and plot insets. The source distinguishes absent acquisitions from low power. Brushing has exact bounds, Undo and Reset; peak hold excludes missing bins. Complex samples retain paired I/Q and supplied ideal coordinates. RMS EVM is the square root of summed error energy divided by summed ideal-symbol energy, expressed as a percentage.

Coastal vector components are paired observations; a missing component does not become zero. The directional rose uses flow-toward angles and area-proportional count segments. The depth curtain increases depth downward, retains its temperature unit/domain and hatches missing acquisitions. Its selected time can synchronize exact tidal inspection without changing the source series.

### Investigation, planning and formulation

Threat Hunt aggregates counts by an ordered source/target pair and retains the original event IDs. One event can occupy both source and destination lanes without becoming two events. The bounded graph includes only observed relationships. A declared ingestion gap is hatched and leaves missing history bins. Pair selection links the matrix, neighbourhood and evidence table. Local review changes update the displayed records but do not write an external case-management system.

Production Planner separates original baseline, applied local schedule and proposed schedule. A drag or exact UTC start proposes an immutable task shift. Optional downstream propagation preserves durations and resources. Precedence, double-booked resources and the 21-day planning horizon are validated; conflicts block Apply. Discard restores the applied schedule, and Undo restores the previous applied schedule. The capacity profile sums interval overlap in each UTC day under the explicitly declared 24-hour resource-availability assumption. The critical path sums a longest DAG duration chain, excluding parallel work and resource waits.

Materials Lab requires nonnegative matrix/fibre/filler percentages totaling 100 and maps them with barycentric coordinates. Pending physical measurements remain null while known composition stays visible. Strength/density Pareto membership is global nondomination: no candidate has lower/equal density and higher/equal strength with at least one strict improvement. A composition brush and numeric property constraints intersect stable IDs across ternary, scatter, parallel coordinates and records. A selected candidate remains identifiable outside the current feasible population.

## Editor, states and interaction lifecycle

The shared editor provides guided plugin options, exact normalized Data, read-only Query, validated JSON, preview, Apply/Discard and bounded Undo/Redo. Configuration and presentation overrides remain session-only. A chart's accepted field mapping is preserved; broad `records` compatibility does not invent columns for an unrelated family. Registry fields expose implemented options such as distribution mode, frame orientation, row height, labels, limits and inspection.

The catalogue exposes ready, empty and synthetic-error states for all new examples. Thirteen of the 29 new examples also declare a meaningful missing-observation fixture; complete event, graph, count or schedule inputs do not receive a decorative gap state. A provider-error preset uses the shared error presentation and recovery path without contacting a provider.

Host-controlled selected IDs take precedence over old local pins. Data replacement clears stale local inspection or gesture state. Active inspection/drag consumes Escape and returns focus where appropriate; an idle chart leaves Escape available to the editor. The resource Gantt requires a host proposal callback before enabling drag edits, so its standalone editor preview is read-only. Dense content uses local scrolling and non-drag controls rather than shrinking every label to fit.

Effects are attached to actual selection, hover, missing coverage and pending changes. Reduced-motion styling is retained. There is no fabricated live feed, ornamental replay requirement or animation-based proof of performance.

### Corrections identified during integration

- Compound chart layout now uses one shared intrinsic-family `Set` across catalogue and editor, with inline-size containment and natural height.
- Local Escape handling consumes only active chart state, preventing the same event from also discarding an editor draft.
- Linked exploration selections no longer let an old local pin override the host's current candidate or task.
- Planner drag editing is disabled when there is no host proposal callback.
- Browser QA identified a native datetime submission discrepancy. The Planner now reads the named start input through `FormData` at submission, then interprets it as UTC, matching the shared exact-time approach. Exact proposal, Apply and Undo passed the browser retest.
- Factory sample fixtures now contain 160 observations for each of six machines (960 total); all distribution and headline calculations use that complete population within the canonical 1,000-row host limit. The universal catalogue gate validates every advertised preset through `parseRecordFrame`.
- Logistics maps deduplicate repeated port labels and paint the selected route last; camera movement and linked shipment selection remain independent.
- Pending Materials Lab measurements have an explicit pending label instead of being described as an infeasible measurement.

## Validation record

### Final automated checks

| Gate | Recorded checkpoint | Limit of the evidence |
| --- | --- | --- |
| Type validation | `npm run typecheck` passed. | A source/type gate; not a browser layout or gesture test. |
| Automated tests | `npm test`: **354 passed across 23 files**. | Synthetic, bounded fixture/model and renderer checks after the final source fixes. |
| New semantic suites | `profile-model`, `analytics-lenses`, `spatial-lenses`, `exploration-lenses`. | Covers accounting, geometry, domains, identity, invalid inputs and declared states; does not establish all device/browser behavior. |
| Browser QA | Desktop rendering and selected interactions checked in all ten lenses; every lens fits 390px and 768px canvas previews. | Container previews are not physical-device or screen-reader certification. |
| Build, source synchronization and publication | Performed after this report is included in the source package; see the returned Site version and publishing result. | A successful build/deployment is reported only after its terminal result. |

The new tests cover inclusive/self profile accounting, recursive symbols, chronological sample merging and gaps, importer boundaries, cohort denominators, conserved paths, control limits, raw-sample distributions, uncertainty nesting, geographic/interval data, EVM and polar population meaning, directed event evidence, DAG constraints, critical-path math, exact daily resource overlap, ternary mapping and Pareto/brush populations. The catalogue fixtures additionally exercise configuration validity and finite geometry in supported states. The source tree contains no new package dependency for these additions.

### Executed browser checks

All ten new routes were opened and visually inspected. The 390px and 768px canvas controls produced matching client and scroll widths in every lens, with no visible renderer alerts. Query Atlas also measured 1,348px client/scroll width in the desktop preview. A stalled browser automation control recovered after one reload; the tablet pass then completed normally.

| Surface | Action and observed result |
| --- | --- |
| Query Atlas | Pinned `ExecHashJoin`: 12.020s inclusive, 41.74% whole-profile share and 54.61% parent share. Branch focus/breadcrumb reset passed. Exact 4–8s time bounds, Undo, an actual drag window and Reset passed. |
| Profile input/output | Valid Flamebearer paste retained 33 frames and correctly omitted chronology. Malformed metadata showed an error and retained the previous 2,880-sample profile. Restore mock passed. The actual downloaded Go CPU JSON matched the generated fixture file. |
| Journey & Retention | Selecting Aug17 changed the cohort to 1,120 and built-dashboard count to 638 with matching path/evidence population. |
| Factory Quality | Stable-baseline selection produced zero mean breaches; shift selection produced two. The complete 960-record population passes canonical host validation. |
| Experiment Studio | Pro-workspace selection produced population 2,840 and effect 2.73pp with interval 0.64–4.82pp; the selected population remained consistent across panels. |
| Logistics Control | Ordinary wheel zoom changed scale from 1 to approximately 2.014; actual panning worked. Selecting PK2714 updated ETA evidence while preserving the camera. Reset and the five-shipment at-risk filter passed. |
| Spectrum Observatory | Exact bounds 2.4300–2.4600GHz enabled Undo; Reset restored 2.4–2.48GHz. The canvas field, aligned spectrum and constellation were visually inspected. |
| Coastal Observatory | Selected B03 after zooming to 1.5; directional, depth and tide views switched to B03 while the camera remained at 1.5. |
| Threat Hunt | Marking EV0041 reviewed changed its local evidence state and exposed Undo review. |
| Production Planner | Exact UTC input produced six proposed changes; Apply and Undo passed. An invalid early proposal reported two precedence conflicts and disabled Apply. A real Gantt drag produced a +12h proposal with baseline outlines retained; Discard passed. |
| Materials Lab | Strength minimum 250→400 reduced the feasible population from 107 to nine while retaining the selected outside-constraint candidate. Pending CMP180 exposed null measurements and zero replicates rather than fabricated values. |
| Chart library/editor | All 51 examples were present. The flamegraph preview retained natural height; orientation, frame height and title changes rendered. Invalid height60 blocked Apply and preserved the valid chart; height26 recovered. Escape closed an active frame inspector while leaving the editor and draft title intact. Apply reported a successful lab-session update. |

The final available console-log window contained no application warnings/errors after excluding browser-extension metadata messages. This is a bounded observation, not a claim about every browser execution.

Runtime captures, distinct from generated design references:

- [Query Atlas overview and navigation](screenshots/iteration-08-profiling-overview.jpg)
- [Profiling with pinned frame and chronological companion](screenshots/iteration-08-profiling.jpg)
- [Materials Lab linked composition and property views](screenshots/iteration-08-materials-final.jpg)
- [Shared chart editor with profiling options](screenshots/iteration-08-editor.jpg)
- [Coastal selection after zoom](screenshots/iteration-08-coastal.jpg)
- [Planner drag proposal and retained baseline](screenshots/iteration-08-planner.jpg)
- [Spectrum, constellation and occupancy detail](screenshots/iteration-08-spectrum.jpg)

## Production transfer boundary

These owners are implemented in the independently hosted Widget Lab. Source fixtures and labels are synthetic; local imports and applied edits persist only for the current browser session. The work does not claim upstream Paprika provider support, durable authoring, binary pprof ingestion, full Grafana import, production-scale performance or complete alternate-theme/physical-touch/accessibility certification.

Production transfer must preserve renderer registration, normalized units, null/zero distinctions, population denominators, stable identity and interaction ownership. Connect live queries through Paprika's existing data/query owner and retain the same validation gates. The [capability matrix](chart-capabilities.md) records every new registered ID and its boundary; earlier iteration reports retain their own historical evidence.

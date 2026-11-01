# Chart capability coverage

> **WP-B1a note:** `src/vendor/paprika/` no longer exists. Production files are imported through `@insights/*`, and the lab's holding copies live in `src/renderer-extensions/` (see [its README](../src/renderer-extensions/README.md)). Paths in this document name the pre-WP-B1a copy.

## Current additions — iteration 10

Four registered families extend the existing domain lenses through `Widget` / `QueryResult.records`, strict configuration parsers and semantic input validators. Each has an independent catalogue example and registry-owned intrinsic layout. They add evidence within existing investigations rather than introducing another dashboard document model.

| Registered ID | Lens and owner | Configuration and inspection | Analytical boundary |
| --- | --- | --- | --- |
| `followup-distribution` | Trial Evidence; `clinical/FollowupDistribution.tsx`, `clinical/model.ts` | Participant/arm/duration/event bindings; interval width; stacked/grouped endpoints; counts/cohort percentages; exact interval and arm evidence; linked participant marker. | One contribution per participant. Events and right-censors remain separate. Bins conserve the selected cohort; percentages retain the whole-cohort denominator. |
| `reserve-envelope` | Grid Balance; `energy/ReserveEnvelope.tsx`, `energy/reserve-model.ts` | Typed time, capacity, observed/median demand and interval mappings; optional paired 68% bounds; 68%/95% visibility; MW reference; exact time and linked storage guide. | Reserve subtracts required supply from supplied capacity. Interval bounds reverse under subtraction. Unknown demand/capacity remains unknown; selected time/reference changes preserve the dispatch snapshot. |
| `wafer-transect` | Wafer Intelligence; `wafer/WaferTransect.tsx`, `wafer/model.ts` | Physical X/Y/leakage mappings; row/column; fixed index or selected-die following; linear/log scale; adjacent connections; grid/reference; roving marks and paged exact values. | Coordinates agree with physical grid identities. Missing/absent observations break the trace; unmeasured positions occupy a separate lane. References do not reclassify supplied final bins. |
| `orbital-pass-profile` | Orbital Contact; `orbital/OrbitalPassProfile.tsx`, `orbital/pass-profile-model.ts` | Typed identity/time/elevation/margin/throughput bindings; elevation/margin thresholds; maximum gap; threshold/window/sample visibility; exact sample controls. | UTC lanes retain separate units. Qualification uses known adjacent samples under the declared interpolation/gap policy. Unresolved relevant evidence cannot produce falsely complete duration or volume. |

### Authoring and source discovery

`WidgetConfigField.binding` describes accepted primitive types, units/unit aliases, role meaning and optionality. The shared `field-bindings.ts` discovers actual loaded columns and validates structural bindings. Registered semantic adapters continue to own numerical accounting, geometry, interval ordering and other family invariants.

The editor's **Fields** tab shows declared metadata, loaded coverage, bounded samples and role assignments. Searchable GammaSelect controls expose compatible columns and explain disabled choices. Explicit optional **Not mapped** values survive default merging. Invalid mappings retain the draft and last valid preview while blocking Apply; guided, structured and history operations use the same validation path.

Renderer switching restores per-renderer settings within the editing session. `mergeDomainWidget` isolates unrelated family configuration and lens selection when applying an alternative, preserving current panel/provider/query identity. Native bounded sample and fixture selectors remain intentional; searchable GammaSelect owns authoring choices rather than every selector.

The editor improves reading hierarchy and field diagnostics within the Gamma/Barlow system. Grid Balance uses two-column comparisons with full-width evidence and a narrow single-column projection. Orbital Contact places its profile beside margin evidence and the schedule in a separate full-width row. All additions remain synthetic-data capabilities in the Widget Lab; this inventory does not establish live integration, durable persistence, physical-touch coverage or measured performance. Executed checks belong in the iteration report.

## Iteration 09 additions (historical)

Seven new domain and SRE lenses add **30 registered chart families**, bringing navigation to **26 lenses** and the library to **81 catalogue examples**. The original families remain available. The new owner bundles are `energy`, `clinical`, `wafer`, `orbital`, `kubernetes`, `performance` and `distributed` under `src/charts/`; corresponding compositions live under `src/lenses/`. Exact inventories, semantics and executed evidence are recorded in [iteration 09](iteration-09-domain-and-sre.md).

The shared registry now accepts optional input-validation and layout descriptors. New families validate their loaded source before an editor draft becomes the preview or can be applied. Intrinsic layout metadata removes the need to add new IDs to a second hard-coded host list. Shared panels retain source provenance, preserve a mark's own linked pin, overlay transient hover details, and respect the existing reduced-motion owner. The route catalogue drives every navigation surface and count.

| New lens | Families | Primary extension |
| --- | ---: | --- |
| Grid Balance | 4 | Conserved MW flows, integrated storage energy, contingency matrix, signed-price merit order. |
| Trial Evidence | 5 | Endpoint-derived survival, forest intervals, participant response, visit coverage and follow-up. |
| Wafer Intelligence | 5 | Physical die map and spatial signatures, yield accounting, chamber comparisons and process history. |
| Orbital Contact | 4 | Dateline-safe trajectories, polar skyplots, contact windows and reconciled link margin. |
| Kubernetes Fleet | 4 | Nested placement, resource accounting, count-based throttling and scoped resource strips. |
| Performance Workbench | 4 | Latency density, sampled trace, normalized differential profile and paired evidence. |
| Distributed Systems | 4 | Quorum topology, directed peer latency, replication indices and conserved shard movement. |

The following iteration sections are historical records, with the counts and validation status recorded at their respective checkpoints.

## Iteration 08 additions (historical)

Ten new dashboard lenses add **27 registered plugin identities and 29 catalogue examples**, bringing the chart library to **51 working examples**. There are **19 dashboard lenses** in navigation, including the two original reference studies. These counts describe different things: a dashboard composes several charts, and three distribution examples deliberately share one renderer identity. The current inventory comes from [`allChartCatalog`](../src/catalog/chart-fixtures.ts), the four new registration bundles and [`lensRoutes`](../src/lenses/lens-routes.ts).

| Catalogue source | New plugin identities | Catalogue examples | Scope |
| --- | ---: | ---: | --- |
| Earlier core catalogue | — | 11 | Existing canonical metrics, records, meters and connection map. |
| Iteration 07 concepts | — | 11 | Market Risk, Inference Fleet, Incident Room and Grid Operations. |
| [`profiling-fixtures.ts`](../src/catalog/profiling-fixtures.ts) | 3 | 3 | Query Atlas. |
| [`analytics-fixtures.ts`](../src/catalog/analytics-fixtures.ts) | 7 | 9 | Journey & Retention, Factory Quality and Experiment Studio. |
| [`spatial-fixtures.ts`](../src/catalog/spatial-fixtures.ts) | 8 | 8 | Logistics Control, Spectrum Observatory and Coastal Observatory. |
| [`exploration-fixtures.ts`](../src/catalog/exploration-fixtures.ts) | 9 | 9 | Threat Hunt, Production Planner and Materials Lab. |
| **Iteration 08 additions / complete catalogue** | **27 new identities** | **29 new / 51 total** | Existing charts remain available. |

`sample-histogram`, `sample-violin` and `sample-ridgeline` are catalogue example IDs. Their widget `pluginId` is **`sample-distribution`**, configured with `mode: 'histogram'`, `'violin'` or `'ridge'`. They are not three separately registered plugins. The earlier linear and segmented meters likewise remain examples of one `threshold-gauge` owner.

### Routes and registered owners

| Dashboard route | New registered IDs used by the lens | Main implementation owners |
| --- | --- | --- |
| `#query-atlas` | `profile-flamegraph`, `sampled-flamechart`, `query-plan` | `src/charts/profiling/`; `src/lenses/profiling/`. |
| `#journey-retention` | `cohort-matrix`, `conversion-funnel`, `stage-flow` | `src/charts/analytics/`; `JourneyRetentionLens`. |
| `#factory-quality` | `statistical-control`, `sample-distribution`, `pareto-bars` | Same analytics bundle; `FactoryQualityLens`. |
| `#experiment-studio` | `interval-estimates`, `sample-distribution` | Same analytics bundle; `ExperimentStudioLens`; existing time-series owner is reused. |
| `#logistics-control` | `route-map`, `eta-windows`, `dwell-boxplot` | `src/charts/spatial/`; `LogisticsLens`. |
| `#spectrum-observatory` | `spectrum-analyzer`, `iq-constellation` | Same spatial bundle; `SpectrumLens`; existing `status-history` is reused. |
| `#coastal-observatory` | `coastal-vector-map`, `directional-rose`, `depth-curtain` | Same spatial bundle; `CoastalLens`; existing tidal time-series presentation is reused. |
| `#threat-hunt` | `adjacency-matrix`, `entity-neighbourhood`, `event-swimlanes` | `src/charts/exploration/`; `ThreatHuntLens`. |
| `#production-planner` | `resource-gantt`, `resource-load`, `schedule-dependencies` | Same exploration bundle; `ProductionPlannerLens`. |
| `#materials-lab` | `ternary-composition`, `pareto-scatter`, `parallel-coordinates` | Same exploration bundle; `MaterialsLabLens`. |

The common registration entry remains [`registerConceptCharts`](../src/charts/register-concept-charts.ts). A clean chart-library entry loads the new bundles without requiring a previous visit to their dashboard. The complete route and source record is in [iteration 08](iteration-08-chart-expansion.md).

### Normalized chart contracts

All 27 additions are trusted **records plugins**. They receive the existing `Widget` and `QueryResult.records`/`RecordFrame` contracts and render through `WidgetVisualization`; they do not introduce parallel dashboard documents or new built-in widget types. Every family owns a strict configuration parser. Source records, unit interpretation and pure numerical adapters remain separate from SVG/canvas geometry.

| Registered ID | Meaning and implemented interaction | Boundary to preserve |
| --- | --- | --- |
| `profile-flamegraph` | Aggregated inclusive/self stack costs; symbol search, exact frame inspection, ancestry focus, reset, flame/icicle direction and package/cost color. | Width represents aggregate cost, not elapsed time. One validated root; each inclusive total equals self plus immediate children; recursive symbols do not inflate the hot-function inclusive total. |
| `sampled-flamechart` | Explicit ordered weighted samples; thread selection, exact span inspection, elapsed-time drag zoom, numeric windows, Undo/Reset and selected-interval focus. | Chronology must exist in the input. Merge only contiguous equal ancestry; preserve gaps and reject overlapping samples within a thread. Aggregate-only imports cannot populate this chart. |
| `query-plan` | Rooted plan ancestry with actual elapsed time, estimated/actual rows and loops; exact node selection. | Inclusive execution times overlap and cannot be summed as query duration. The supplied synthetic plan is distinct from the selected profile. |
| `cohort-matrix` | Retained counts and percentages at equal cohort ages; exact cell inspection, keyboard selection and linked cohort scope. | Keep the cohort denominator. Future ages, missing observed cells and observed zero are different states. |
| `conversion-funnel` | Sequential counts and initial/previous-stage conversion; exact stage inspection. | One fixed initial population with nonincreasing counts. Do not silently substitute independent event totals for sequential membership. |
| `stage-flow` | Three-stage paths whose widths and stage totals derive from the same records; exact ribbon inspection. | Original-session population conserves across both link stages. Later visits and retry attempts are not additive members of this population. |
| `statistical-control` | Subgroup means and ranges, baseline limits and breach classification; exact subgroup inspection and editable range/limits. | Baseline control limits and product specification limits are different inputs. Missing subgroup values interrupt paths. |
| `sample-distribution` | Histograms, violin/box summaries and ridgeline KDEs; configurable mode/bin count and exact bin/group inspection. | Every summary derives from supplied finite samples. Histogram bins conserve count; the last endpoint belongs to the final bin. Missing values are counted separately. Synthetic posterior draws are not live experimental inference. |
| `interval-estimates` | Signed estimates with nested 80% and 95% ranges and declared populations; exact treatment inspection. | Unknown intervals remove estimate/bounds together. An interval crossing zero is not replaced by a binary causal claim. |
| `pareto-bars` | Descending disjoint category counts and cumulative population share; exact category inspection. | Cumulative share divides by all supplied defects, not manufactured units. Distinct from Materials Lab's two-objective Pareto frontier. |
| `route-map` | Supplied port coordinates/waypoints, directed illustrative routes, stable shipment selection and shared geographic camera controls. | Map pan/zoom does not change shipment values or probabilities. Route paths are illustrative, not shipping instructions or live tracking. |
| `eta-windows` | P10–median–P90 arrival intervals and promise markers on one UTC scale; linked shipment inspection. | Interval order is validated. Supplied delay probabilities are synthetic estimates, not computed or calibrated from a live carrier feed. |
| `dwell-boxplot` | Ordered nonnegative min/quartiles/median/max, separate outliers and explicit sample count; port inspection. | Uses supplied summaries; it does not infer raw samples or manufacture outliers. |
| `spectrum-analyzer` | Canvas time-frequency field and aligned spectrum/peak hold; common frequency scale, band brushing, numeric bounds, Undo/Reset and exact cell inspection. | Null acquisitions remain unknown. Peak hold uses observed cells. Frequency zoom is a local frequency view, not a dashboard time query. |
| `iq-constellation` | Measured I/Q points with supplied ideal symbols; exact sample picker, keyboard/pointer inspection and RMS EVM. | EVM uses the ratio of summed error energy to summed ideal-symbol energy. Axes retain paired samples; magnitude/phase are not independent unpaired observations. |
| `coastal-vector-map` | Supplied eastward/northward vectors, buoy selection and bounded geographic camera; linked coastal evidence. | Both vector components are known or both unknown. Basin, bathymetry and currents are synthetic; zoom neither alters them nor implies a hydrodynamic solver. |
| `directional-rose` | Direction/speed-bin counts and exact segment population shares. | Direction is flow **toward**, north 0° and east 90°. Squared radius grows with cumulative count so sector area encodes population. |
| `depth-curtain` | UTC × increasing-depth temperature cells, hatching for missing acquisitions and exact/keyboard time selection. | Depth increases downward; the fixture's fixed 14–22 °C domain is separate from null. Selected time can synchronize tidal inspection without changing observations. |
| `adjacency-matrix` | Counts for directed source/target pairs, stable identities, selected row/column and exact relationship evidence. | A dark cell means no recorded events in the captured result, not proof that no relationship exists outside source coverage. |
| `entity-neighbourhood` | Bounded one-hop observed neighbours, directed links, entity-type icons and linked pair inspection. | Omitted neighbours are counted. Layout, edge direction and confidence do not establish causality or maliciousness. |
| `event-swimlanes` | Exact UTC event timestamps on entity lanes, local time zoom, exact event selection and declared gap hatching. | One event may appear on source and target lanes; markers are not additional records. Full-result relationship counts keep their original scope when the timeline zooms. |
| `resource-gantt` | Task duration, assigned resource, original baseline, progress, dependencies and exact selection; host-owned drag/exact-start proposals. | A standalone editor preview without a proposal callback is read-only. The Planner validates and reviews the pending schedule before session-local Apply; original baseline survives. |
| `resource-load` | Exact overlap of task intervals and UTC days, allocated resource-hours and available capacity; exact daily table. | The synthetic plan declares 24-hour availability per supplied resource. Capacity is separate from allocated hours. |
| `schedule-dependencies` | Validated predecessor DAG and longest duration chain; linked work-order selection. | Reject unknown parents/cycles. Parallel task durations, resource waits and calendar gaps are not added into dependency critical work. |
| `ternary-composition` | Nonnegative three-component composition totaling 100%, barycentric coordinates, rectangular region brush and candidate inspection. | Matrix/fibre/filler vertices are explicit. Known composition remains plotted when property measurements are pending. Brush results retain exact candidate IDs. |
| `pareto-scatter` | Measured strength/density pairs, global nondominated frontier and feasibility limits; linked exact candidate inspection. | Maximize strength and minimize density. Domination needs at least one strict improvement; equal points can both be nondominated. Pending pairs are excluded. |
| `parallel-coordinates` | Same candidate across seven unit-bearing dimensions, linked selection, strength/cost bounds and keyboard controls. | Missing measurements break lines. Composition region and property limits intersect one candidate population; an outside-filter selected candidate remains identifiable. |

### States, editor integration and layout

Every new example provides ready, empty and synthetic provider-error states. Missing-data examples are exposed only when their contract supports them: the cohort, control, three sample-distribution and interval examples; spectrum/coastal-vector/depth fields; ternary/Pareto/parallel material views; and sampled time flamechart. The catalogue reports the exact loaded source and inspection context. An error preset exercises the host's recovery presentation; it does not make a provider request.

Guided settings, validated JSON, exact Data, read-only Query, draft preview, Apply/Discard and Undo/Redo remain owned by the shared editor. Supported controls come from the selected plugin's registry definition. A new chart's `records` kind alone does not prove compatibility with another chart's required columns. Session overrides retain the original source population. Profile imports are also local to the current browser session.

[`intrinsic-chart-families.ts`](../src/charts/intrinsic-chart-families.ts) contains a **shared `Set` of the 27 new plugin IDs**. Both catalogue and editor consult `hasIntrinsicChartLayout` for the active widget. The corresponding host uses intrinsic block height and `container-type: inline-size`, allowing compound charts and their inspectors to contribute real height. Existing fill-height owners retain their established host. The same source fixtures are available at auto, 768px and 390px lens widths; dense geometry can scroll inside its own panel. Source responsiveness is not a completed browser or physical-device certification.

Local selections and brushes have explicit owners. Map transforms preserve source identity and values; plot zoom preserves loaded observations for reset; Planner changes remain proposals until Apply; material brushes intersect identities and constraints. Active local inspection/drag consumes Escape before the editor; an idle chart allows the next Escape to close the editor. Embedded owners suppress their edit/inspection controls. These implementation contracts remain subject to the browser evidence gate below.

### Profiling formats and production boundary

Query Atlas supplies deterministic mock PostgreSQL CPU, Go CPU, Python CPU and Go-allocation profiles. Its local parser accepts Flamebearer **v1 single** JSON, current Querier `FlameGraph` JSON in the supported shape, folded **100 Hz CPU sample counts**, and **sampled Speedscope profiles with time units**. Unannotated Querier JSON is interpreted as CPU nanoseconds. Aggregate imports populate a flamegraph; only explicit chronological samples populate a time flamechart. Binary pprof, differential Flamebearer, evented Speedscope and a live Pyroscope connection are not implemented. Full import/export limits and official format references are recorded in [the iteration-08 profiling section](iteration-08-chart-expansion.md#profiling-data-and-importexport-boundaries).

No new dependencies were added. React, the existing D3 scale/shape/hierarchy foundations, SVG/canvas, Zod, Gamma controls, trusted chart registry and shared interaction primitives remain the stack. This is a lab extension over synthetic/session data. Registration does not establish production provider execution, durable dashboard saving, full Grafana import, alternate-theme parity or production-scale performance.

**Recorded automated checkpoint:** the root workflow reported `npm test` passing **323 tests across 23 files**, plus a passing `npm run typecheck`. Browser QA and captures are in progress. Final browser findings, build/release evidence and any updated test counts belong in [iteration 08](iteration-08-chart-expansion.md); this capability inventory does not assert a final deployment or complete browser pass.

## Iteration 07 additions

Four new concept lenses compose **11 new registered chart identities** through the existing `Widget`, `QueryResult`, trusted registry and `WidgetVisualization` host. The routes are `#market-risk`, `#inference-fleet`, `#incident-room` and `#grid-operations`. Existing Edge Watch, Reliability, Finance, Website, Infrastructure and Chart library routes remain available. The new families are installed together by `src/charts/register-concept-charts.ts`; each lens also registers its own dependency bundle for direct entry.

This historical section records source ownership and implemented contracts. Executed browser checks, screenshots and release boundaries are recorded in [the iteration-07 report](iteration-07-complex-lenses.md). A registered family is not automatically verified in every dataset, theme, viewport or embedded state. The older iteration sections retain their original evidence and do not describe the current total inventory above.

| New registered ID | Data kind and actual owner | Implemented meaning and controls | Boundary to retain |
| --- | --- | --- | --- |
| `contribution-waterfall` | Records; `src/charts/market-risk/MarketCharts.tsx`; `waterfallSteps` and strict config in `market-chart-data.ts`. | Signed contributions start at the preceding cumulative value; optional reconciled total, labels, unit/precision and exact inspection. | At most 30 source contributions. Missing contributions make subsequent cumulative totals unknown. Period contribution is in percentage points, distinct from an individual holding's return. |
| `correlation-matrix` | Records; same market renderer module; `correlationCells` adapter. | Fixed −1 to +1 scale, exact pair details/sample count, optional values and legend, symmetric unknown cells. | Maximum 20 entities. The adapter rejects asymmetric values, non-unit observed diagonals and duplicate pairs. It consumes supplied correlations; the financial fixture computes Pearson values from paired returns. |
| `liquidity-ladder` | Records; same market renderer module; `liquiditySegments` adapter. | Nonnegative stacked market value by horizon/category; category legend, exact inspection, optional totals and a configurable hatched restricted category. | Missing bucket/category evidence does not become zero. This lens supplies an assumed liquidation horizon, not a contractual maturity schedule or execution guarantee. |
| `rack-matrix` | Records; `src/charts/inference/InferenceCharts.tsx`; `buildRackMatrix` in `data.ts`. | Stable device ID and rack/slot position, fixed 0–100% utilization, unavailable hatching, selected device metadata/history, keyboard inspection; labels/details can be edited. | Up to 1,024 input rows, with omissions disclosed. Reporting devices and installed device capacity are separate counts. Device history columns are an explicitly ordered fixture sequence, not arbitrary elapsed-time intervals. |
| `request-flow` | Records; same inference renderer module; `buildRequestFlow`. | A three-stage Sankey-style flow from original records; link widths and node totals share one population; optional values and exact link inspection. | Maximum 24 entities per stage and 2,000 input rows. Model-node incoming/outgoing totals conserve. The inference fixture excludes retries; no unrelated edge populations are silently combined. |
| `log-scatter` | Records; same inference renderer module; `buildLogScatter`. | Paired positive observations on logarithmic axes, stable model color, point inspection, local group filtering and editable point radius. | Missing, zero and negative pairs are disclosed and excluded from logarithmic geometry. This is a paired-observation plot; it does not establish causation or percentile aggregation. |
| `aligned-telemetry` | Metrics; `src/charts/incident/IncidentCharts.tsx`; strict tracks/events config and `telemetryAt` in `incident-model.ts`. | Separate-unit lanes with one actual time domain, same-timestamp inspection, typed deployment/incident events, local brush/exact window/Undo/Reset, editable fill/events/stroke/lane height. | One compound telemetry panel, not a dashboard-wide provider query controller. Up to six configured lanes and 32 events. Absent counterparts remain unknown. |
| `trace-waterfall` | Records; same incident renderer module; `buildTraceSpans`/`visibleTraceSpans`. | Parent-child spans use actual start offsets/durations, parallel overlap, search, collapse and selected-interval focus; editable row height and service labels. | One trace, at most 250 spans. Parent containment, unique IDs, nonnegative timing and acyclic parentage are validated. Summing parallel durations is not elapsed trace time. This is a records plugin, not new support in the built-in trace list. |
| `service-dependency` | Records; same incident renderer module; `buildDependencyGraph`. | Directed observed calls, supplied latency and error/request counts, pooled node error ratios, exact service inspection; labels and edge latency can be toggled. | Up to 64 edges/32 services. Zero request denominator is unknown. Node populations use incoming calls, or outgoing calls for a root; the graph does not prove causal fault propagation. |
| `grid-network-map` | Records; `src/charts/grid/GridNetworkMap.tsx`; `networkRecords` in `grid-model.ts`; shared `geo-viewport.ts`. | Located nodes and directed capacity links, exact substation details and timestamp-positioned history, pointer-centered wheel zoom, pan, bounded camera, keyboard/buttons/reset, opt-in touch navigation and location picker. | A hypothetical electrical-network lens with supplied MW/kV/capacity semantics. Node count is bounded by config. Zoom changes the camera; it neither calculates power flow nor changes telemetry. |
| `forecast-bands` | Records; `src/charts/grid/ForecastBands.tsx`; `forecastRecords`/strict config in `grid-model.ts`. | Observed values plus forecast median and nested 68%/95% intervals; unknown gaps, exact inspection, local brush/exact window/Undo/Reset; interval/grid/legend/unit controls. | All five forecast median/bound observations must be supplied together or all be unknown. The adapter rejects duplicate timestamps or inverted intervals. The fixture's bands are authored synthetic uncertainty, not calibrated operational predictions. |

### Reused owners and scoped compositions

Market Risk reuses `allocation-treemap`, built-in time series and `record-table`. Inference Fleet reuses the cumulative-bucket `distribution-heatmap`, built-in queue time series and `record-table`. Histogram and queue share one accepted five-minute window with common UTC axes/plot bounds, exact input, Undo and Reset. Incident Room reuses `GeoMap`, `Panel`, the cursor provider and shared time-window primitives; its evidence table and session notes are lens compositions. Grid Operations reuses signed `stacked-timeseries`, `status-history`, `record-table`, `MetricCard` and the geographic camera math. Its state-of-charge ring is a scoped composition over reconciled stored energy, not a twelfth registered chart family.

The source owners are grouped under `src/charts/{market-risk,inference,incident,grid}/`; numerical fixtures live under their corresponding `src/lenses/*-data.ts` modules. New families have pure-adapter tests in `tests/market-risk.test.ts`, `tests/inference-fleet.test.ts`, `tests/incident-room.test.ts` and `tests/grid-operations.test.ts`. Do not substitute the presence of these files for executed results; the report owns final test/build counts and browser evidence.

All new plugins use strict configuration and the existing editor's preview/Apply contract. The editor still preserves session-only overrides, the last valid preview and exact normalized source data; it does not execute fixture query text or durably save dashboards. Compatibility must include the family's required records fields or track semantics, not merely the broad `records`/`metrics` kind.

### Production boundary

These are **local lab extensions**, not a claim of upstream Paprika release support. No new persisted built-in widget types, chart library, provider backend or parallel dashboard document schema were introduced. Production transfer requires integrating the trusted renderer bundle, maintaining schema/config compatibility and provenance, connecting the existing data/query owner, and running Paprika's maintained production gates. Generated concept images are retained design inputs; they are neither the renderer nor numerical test fixtures.

## Iteration 06 additions

The catalogue's eleven examples remain available. New `#finance`, `#website` and `#infrastructure` routes compose additional dashboard questions from the same typed `Widget`/`QueryResult` host; they do not imply that every visual in the supplied references has become a general chart family. The [iteration-06 report](iteration-06-interaction.md) records executed evidence, and the [reference register](reference-register.md) separates adaptation from literal reproduction.

| Capability | Actual owner and support | Verified behavior and boundary |
| --- | --- | --- |
| Sector/holding allocation treemap | Local trusted plugin `allocation-treemap`, registered by `src/lenses/FinanceLens.tsx`; strict record mapping and pure calculations in `finance-data.ts`; D3 Hierarchy layout. | Nonnegative market-value area, fixed zero-centred signed-change color, sector drilldown/reset, exact holding inspection and keyboard selection. Browser checks covered Technology and a pinned MSFT holding. This is a distinct financial contract from the copied generic `record-treemap`. |
| Finance performance and ledger | Canonical time series and `record-table` through `WidgetVisualization`; local portfolio summaries, sector exposure and contribution compositions. | Current/previous values pool into sector/portfolio returns; weights name the whole-portfolio denominator. Synthetic 30/90/180-day histories rebase to the selected period. Exposure/contribution compositions are lens primitives, not new independently authorable plugin IDs. |
| Website operations | Existing stat, time-series, stacked and directional owners in `OperationsLenses.tsx`; deterministic `operations-data.ts`. | The one-hour/three-hour selector changes the loaded population and all associated summaries/plots. Local chart brushing remains independent. Duration stacks are exclusive bucket counts, not cumulative percentiles. |
| Infrastructure operations | Existing connection-map, stat, time-series, record-table and directional owners. | Two maps have independent cameras and distinct supplied classification meanings. Host/storage/network fixtures remain synthetic; maps do not query new observations when zoomed. |
| Chart editing | Shared `WidgetEditor` plus `editor-model`, invoked by catalogue and lens hosts. | Same-source live preview, grouped guided options, exact Data, read-only Query, validated JSON, bounded Undo/Redo, Apply/reopen and Discard. Apply is session-local; there is no durable dashboard Save or query execution. |
| Time-window selection and rich inspection | Shared pointer/time-window owner plus canonical and reference renderers. | Reverse and nested brushing, Undo/Reset and exact UTC input were exercised. Chart windows affect the local displayed domain; summaries and provider scope remain unchanged. Rich inspection uses normalized original values. |

The editor checks registered kinds and preserves the original custom configuration. For records, conversion is conservatively limited to the general record table unless an original compatible mapping is retained; schema-valid field-name strings alone do not prove that a different family's columns exist. Missing map, allocation or other semantic mappings are not silently invented.

Iteration 06's recorded automated run passed **168 tests across 14 files**. Numerical/schema tests, browser actions, screenshot comparison, performance and upstream integration remain separate evidence gates. New-reference pixel parity, production provider execution, durable authoring and physical mobile-device behavior were not established by that run. See iteration 07 above for newer source coverage.

## Iteration 05 working coverage

`src/catalog/ChartCatalog.tsx` now exports a working coverage view with **11 examples through 10 distinct canonical renderer identities**: stat, timeseries, directional-traffic, stacked-timeseries, distribution-heatmap, status-history, record-table, threshold-gauge (linear and segmented examples), incident-calendar and connection-map. `src/charts/register-lab-charts.ts` explicitly registers the imported canonical plugin bundle on catalogue load. Availability no longer requires opening the baseline study first.

Each example uses the existing `Widget`/`QueryResult` and `WidgetVisualization` contracts, a parsed configuration, and deterministic source fixtures. Wide/narrow widths preserve the same input; ready, missing, empty and query-failure presets are available where meaningful. The calendar deliberately omits a fabricated “gaps” preset because its input is recorded incident starts, not a coverage timeline. A context readout and a disclosure of the complete normalized input support evaluation.

The previously upstream-only record table, gauge, operational-record and record-chart dependency closure is now copied with provenance. The connection-map retains the original plugin ID, parser and pure adapter, and uses the shared `GeoMap` viewport via a local wrapper. The wrapper maps supplied record IDs (or deterministic coordinate/label identities), retains null values, shows invalid/omitted-record notes, and disables embedded interaction. The catalogue map uses equirectangular land geometry matching its coordinates; the literal reference map retains its separate authored projection.

`tests/chart-catalog.test.ts` covers registration/configuration/data-kind consistency; server rendering of supported fixtures; positive outbound data with mirrored display; stack conservation; histogram differencing; exact budget values including negative allowance; explicit table-bar domains and share denominators; UTC event counts; stable map identity and unknown classification; static embedded map behavior; and navigation when tooltips are disabled. These are source/runtime contract checks, not browser gesture or screenshot evidence. Final test counts, build validation and browser results are recorded in the iteration report by the owning workflow.

General elapsed-duration timelines, arbitrary interval annotations and trend/flag/segmented record-table cells remain explicit extensions. Reusing a compact sparkline or composing a literal risk row does not establish those general schemas. See [catalogue provenance](chart-catalog-provenance.md).

## Baseline audit

Audit date: 31 October 2026 (Australia/Melbourne). This records the **iteration 04 baseline**, before the shared map work in iteration 05. It distinguishes a rendered concept, a reusable component, a copied registered renderer, and a capability found only in the inspected upstream snapshot. A screenshot establishes none of the latter three by itself.

The inspected upstream snapshot is `bb52aed8ded8beb08534f6b190a3e7f37c1b19d8`. Upstream paths below start at `ui/src/features/insights/`; copied lab paths start at `src/vendor/paprika/ui/src/features/insights/`. This audit does not establish deployment or current support in a newer Paprika revision.

### Support levels

| Level | Meaning |
| --- | --- |
| Registered in lab | Reachable through `WidgetVisualization`, existing `Widget`/`QueryResult` contracts and the trusted registry, with configuration parsed by its owner. Registration still depends on loading the owning bundle. |
| Reusable primitive | Accepts values/props and renders independently of a study, but is not an independently authorable widget. |
| Scene fixture | Rendered and interactive within the literal screenshot study; hardcoded records, geometry, labels or state prevent a general capability claim. |
| Upstream source | An owner and schema exist in the inspected upstream tree, but this dependency closure is not present in the lab. |
| Proposed | No verified implementation in either inspected owner. |

## Reference-to-capability matrix

| Reference visual | Existing owner and exact ID/config | Iteration 04 support | Remaining transfer or behavior gap |
| --- | --- | --- | --- |
| KPI with miniature history | Built-in `type: 'stat'`, `chart-renderers.tsx::Stat`/`stat-sparkline.tsx`; `options.showSparkline`. Lab `components/lab/StudyPrimitives.tsx::MetricCard` and `Sparkline`; `reference/ReferenceShared.tsx::MiniTrace`. | Built-in registered; lab primitives reusable; literal card compositions remain scene fixtures. | Keep summary semantics outside the presentation primitive. Literal silhouettes must not become a provider-data algorithm. A slope/delta needs its own comparison population and time. |
| Ordinary time series / SLO target | Built-in `type: 'timeseries'`, `chart-renderers.tsx`; lab's strict `widgetOptionsSchema` adds `gridX`, `timeAxis`, `axisUnit`, `fillStyle`, `showZeroLine`, `referenceLines`, `inspectorDensity`. | Registered in lab with documented local owner patch. | Annotation intervals are not the same as `referenceLines`. The source's irregular authored axis calibration must not migrate into an analytical scale. |
| Mirrored ingress/egress | `plugins/rich-metrics.tsx::DirectionalTraffic`, plugin ID `directional-traffic`; `directionalConfigSchema`: `directionLabel`, `outboundValue`, bounded series/point limits and legend settings. Literal path: `reference/ReferenceCharts.tsx::ReferenceChartRenderer`, ID `reference-timeseries`, config `kind: 'edge'`. | General plugin copied and registered when `BaselineApp` loads; literal plugin registered when its reference module loads. | General renderer requires nonnegative source magnitudes and applies the mirrored sign only for display. Literal source includes authored signed values. These are different data contracts. |
| Burn rates with incident and no-data intervals | Built-in timeseries plus reference line; literal `reference-timeseries` with `kind: 'reliability'`. | General line/threshold support registered; measured incident rectangles, hatching and exact initial inspector are scene fixture behavior. | Promote typed time intervals to a general annotation layer before claiming reusable incident bands. Derive unknown intervals from coverage/gaps, never from decorative positions. |
| Stacked time-bucket outcomes | `plugins/rich-metrics.tsx::StackedTimeseries`, ID `stacked-timeseries`; `stackedConfigSchema.display: 'bar' | 'area'`. Literal `reference/EdgeSupporting.tsx::Outcomes`. | General plugin copied; module registration described above. Literal 28-bar composition remains scene fixture. | General counts must reconcile across exclusive outcomes; grouping must conserve counts and show interval semantics. Literal bar x positions, legend percentages and captions are independently authored. |
| Ranked destination table and in-cell bars | Upstream `plugins/records.tsx::RecordTable`, ID `record-table`; `tableConfig`, `tableCellStylesSchema`, `StyledRecordCell`, `tableBarGeometry`. `cellStyles` supports `bar`, `color-text`, `color-background`, with explicit numeric min/max for bars. Literal `reference/ReferenceEdge.tsx` destination table. | Literal scene fixture in lab; general styled table is upstream source only. | Preserve exact values alongside bars, specify common-domain or capacity-domain meaning, sort stably, and identify the percentage denominator. No arbitrary HTML renderer in document config. |
| Risk table with trend, country, segmented bar and status | Literal `reference/EdgeSupporting.tsx::RiskBySource`, `Flag`, `MiniTrace`. Upstream `record-table` supports numeric cell color/bar styles, not a trend-array or country-flag column contract. | MiniTrace reusable; composite is scene fixture. | Add typed trend/flag/status/segment cells through the existing table owner if needed. Keep supplied country separate from risk classification; never infer risk from nationality. Stable series IDs must survive row reordering. |
| Continuous or segmented budget/capacity meter | Upstream `plugins/threshold-gauge.tsx::ThresholdGauge`, ID `threshold-gauge`; `gaugeConfigSchema.display: 'linear' | 'segmented' | 'radial'`, orientation, segment count, series mode. Bounds in `widget.options.min/max`. Literal `reference/ReferenceReliability.tsx::BudgetMetric` and `ServicesTable`. | Upstream source only for general gauge; scene fixtures for literal budget and per-row bars. | A consumed-budget fill and remaining-budget headline must explicitly identify their roles. Retain negative remaining budget in values; clipping painted length does not clamp the semantic value. Literal source has intentional illustrative-length exceptions. |
| Multi-service state timeline | `plugins/metric-distributions.tsx::StatusHistory`, ID `status-history`; strict `historyConfig` bounds maxSeries/maxPoints. Literal `reference/ReferenceReliability.tsx::ServiceTimeline`. Analytical lab intervals in `data/reliability.ts` and `studies/ReliabilityRoom.tsx`. | General source copied but `registerMetricDistributionPlugins` is not invoked by current lab entry points. Literal 85-bin timeline is a scene fixture; analytical fixture transformation is reusable. | Equal-width sampled observations are not elapsed state durations. For interval semantics, preserve start/end boundaries, unknown intervals and aggregation rules; test irregular cadence and incidents shorter than a display bin. |
| Incident calendar | Upstream `plugins/operational-records.tsx::IncidentCalendar`, ID `incident-calendar`; `incidentCalendarConfig` fields date/value/label/status, aggregation `count|sum|max`, months/endDate; `buildIncidentCalendar`. Literal `reference/ReferenceReliability.tsx::IncidentCalendar`. | General upstream source only; literal scene fixture in lab. | General renderer currently aggregates UTC records; analytical lab handles episodes and query-window clipping. Specify UTC/event dates versus local episode intersection, distinguish no event from no coverage, and keep calendar filtering from changing the SLO denominator. |
| Exact incident/request records | Upstream `plugins/records.tsx::RecordTable`, ID `record-table`, strict `tableConfig`; built-in metric `type: 'table'` is a different input kind. Literal `RecentIncidents` and `ReferenceEdge` blocked table. | Scene fixtures for record tables; general upstream record-table absent from lab. | Use `QueryResult.records`/`RecordFrame` for arbitrary evidence rows. Do not force source/destination/rule/duration records into metric series merely to obtain a table. |
| Connection geography | Upstream `plugins/operational-records.tsx::ConnectionMap`, ID `connection-map`; strict `connectionMapConfig`, pure `buildConnectionMap`. Literal `reference/EdgeSupporting.tsx::Geography`, Natural Earth paths and synthetic city fixtures. | General upstream source only; literal scene fixture in lab. Both pre-iteration-05 implementations lack zoom/pan. | Shared viewport needed: anchor-preserving bounded zoom, pan, reset, non-drag controls, keyboard, selection after transform, input arbitration, stable marker sizing, coordinate validation, and explicit missing/omitted counts. |
| Rich selected observation / miniature histories | Canonical `chart-renderers.tsx`, `plot-tooltip.tsx`, `tooltip-widgets.tsx`, cursor/context owners. Literal `ReferenceChartRenderer` custom inspector. | Canonical system copied; literal inspector a registered scene-specific renderer. | Emit and synchronize by exact time/entity, never index. Embedded renders must be static, query-free and inspector-free. Reference pin-on-load is a reproduction state, not a generic analytic default. |

## Other existing chart families

The inspected owners already contain `distribution-heatmap`, `pie`, `records-line`, `records-bar`, `record-treemap`, `record-matrix`, `pipeline-topology`, and the built-in `bar`, `heatmap`, `table`, `traces`. A new catalogue should expose only the subset actually imported and registered in its runtime. `getWidgetDefinition`/`getWidgetPlugins` establish that runtime identity; a handwritten list of upstream IDs does not.

The lab currently imports `registerRichMetricPlugins()` from `BaselineApp.tsx`; the literal renderer self-registers from `ReferenceCharts.tsx`. It does not invoke the upstream all-family `registerDefaultWidgetPlugins()` (defined in upstream `threshold-gauge.tsx`). Avoid silently making chart availability depend on whether a visitor opened an unrelated route first.

## Minimum useful coverage view

Add one chart coverage route using the existing `WidgetVisualization` host and a single explicit lab registration module. The view should be a working integration check, not a decorative gallery or another dashboard document schema.

1. Define typed entries `{ id, title, capability, widget, result, expectedInteraction, evidenceStatus }` using existing `Widget` and `QueryResult`. Keep component primitives in a separate documented group; do not mislabel them as registered plugins.
2. Reuse existing deterministic analytical fixtures for ordinary time series, stat, mirrored traffic, stacked outcomes and histogram density. Keep authored screenshot fixtures separately identified.
3. Add bounded `RecordFrame` examples only for imported record families. Import the original owners and their dependency closure with provenance instead of independently recreating them.
4. Render one selected capability at meaningful wide/narrow sizes. Offer known available fixtures such as ready, gaps, empty, error and changed-result. Enable only states supported by that example.
5. Expose the parsed configuration and normalized input through an evaluation disclosure, outside ordinary product widget chrome. Show the result of deliberate selection so context emission can be checked.
6. Preserve dark/light token ownership, keyboard inspection, disabled interaction in embedded mode and query-free presentation changes. Do not include an unimplemented settings control just to complete a form.

### Bounded implementation order

- **First:** extract the shared geographic viewport and supplied-location renderer, use it in the reference map, and add an independent variable-data fixture. Make the map interactive without changing the fixed screenshot composition at its default viewport.
- **Next:** explicitly register and demonstrate the already-copied rich metric families and `status-history` through the canonical host. This proves existing chart coverage without adding another library.
- **Then:** import `record-table`, `threshold-gauge`, `incident-calendar` and their pure adapters only when integrating their working examples. Their current existence upstream should be reported, not reimplemented under new plugin names.
- **Later extension:** general interval annotations and typed visual table cells where the existing contracts have genuine gaps. Preserve the literal studies as visual acceptance fixtures while driving general renderers with reconciled data.

## Map contract and acceptance cases

Treat view transformation as presentation state. Keep source coordinates, selection identity, count values and severity unchanged when zooming. Use one projection for outlines and observations. Convert pointer positions through the SVG's current screen transform so controls work in the uniformly scaled 1592px artboard as well as at native size.

Require bounded zoom, pointer-anchor preservation, bounded pan, a world/reset action, zoom buttons, directional non-drag pan controls or equivalent accessible controls, keyboard shortcuts and clear gesture instructions. Ordinary wheel scrolling must remain available unless the map deliberately owns the gesture. Do not hijack browser pinch/page zoom. Distinguish click selection from a drag, handle pointer cancellation, and avoid hidden looping animation.

Hold marker radius and selection ring size in screen-space where they encode a value or need consistent hit targets; do not let zoom multiply their quantitative meaning. A decorative halo must not serve as an undisclosed probability or density encoding. For large data, aggregate with disclosed counts or show a bounded point limit and omitted count; a synthetic speckle field is not measured connection density.

Validate at least: min/max zoom; zoom at off-centre anchor; pan at each boundary; exact reset; coordinate conversion under outer CSS scaling; selection before/after zoom; click versus drag; filter invalidates hidden selection; empty locations; invalid latitude/longitude; duplicate identity; long location names; keyboard and button operation; reduced motion; independent state/resource IDs for two maps. Browser verification remains necessary for gestures and focus. Unit tests of the transform alone cannot establish them.

## Evidence limits

The historical baseline matrix above is a source audit. Current implementation and executed browser evidence are recorded separately in the iteration reports; later work does not retroactively validate an earlier audit. None of these records establishes that the local extensions are deployed upstream or that every schema is exposed in Paprika's production editor. The working lab editor and its session-only boundary are described in the iteration-06 additions.

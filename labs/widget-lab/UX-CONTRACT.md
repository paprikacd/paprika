# Widget Lab behavior contract

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Select/Listbox | GammaSelect for authoring/search; labelled native selects for bounded samples and compact lens scope | Paprika Gamma and maintained domain controls | Searchable field/visualization listbox; native observation, interval and fixture picker | Popup, selection, keyboard, narrow viewport; incompatible field choices explain their disabled state |
| Buttons | Imported GammaButton | Paprika Gamma | Primary, secondary, ghost | Focus, disabled, active |
| Chart inspection | WidgetVisualization, ChartCursorProvider and locally patched inspector owners | Pinned Paprika source plus `docs/paprika-reference-renderer.patch` | Hover, keyboard focus, pin, comfortable/compact inspector | Exact timestamp, pointer/keyboard ownership, dismissal and replacement cleanup |
| Chart presentation | Local strict schema and copied chart renderer | `docs/paprika-source.md` | Opt-in X grid, calendar scale, caption units, signed gradients, zero/reference lines | Accepted schema, scale-aligned geometry, numeric exact data, signed baseline |
| Theme | Imported Gamma contract with `src/observatory.css` study adapter | User references and DESIGN.md | Dark/light, original baseline | Composed contrast and portal inheritance |
| Scrollbar | App-wide stylesheet consuming Gamma | DESIGN.md | Document and bounded data table | Visible scroll access, no horizontal page overflow |
| Baseline summary | `src/data/telemetry.ts` | `docs/data-contract.md` | Scope and scenario | Numerical tests |
| Regional range | RegionalLatency | Explicit p50/p95 interval contract | All/selected region | Shared domain, exact labels, keyboard filter |
| Study navigation | App.tsx, DashboardNavigation native hash links and labelled native lens picker | `lensRoutes`, reference studies and catalogue | 19 dashboard lenses, chart library; retained analytical routes | Link grid above 1200px, grouped picker at 1200px and below, current route, keyboard selection, back/forward and preserved artboard geometry |
| Compact metric | StudyPrimitives MetricCard and Sparkline | Study data summaries | Semantic tone, optional bounded trend, actual-value emphasis | Values, units, gaps, unique SVG resources and unchanged-value stability |
| Panel information | StudyPrimitives Panel | The panel's metric/cadence contract | Information disclosure and optional visible caption | Keyboard activation, Escape focus return, outside/blur dismissal |
| Network study | EdgeWatch and edge-telemetry | Deterministic scoped byte/request counts | Gateway, duration, fixture, snapshot, 10s/1m display | Integer conservation, gateway aggregation, identity, gaps and mirrored display |
| Reliability study | ReliabilityRoom and reliability | Request-based SLO fixture | Service, duration, fixture, hourly snapshot | Budget arithmetic, pooled burn rates, coverage and stable incident identity |
| Incident calendar | ReliabilityRoom and incidentCalendar | Local civil dates and clipped episode intervals | Month navigation, date selection | DST/date boundaries, distinct episode counts, keyboard navigation and local-only evidence filtering |
| Motion and replay | `src/components/lab/motion.tsx`, App.tsx, MetricCard | Shared preference and mounted-study callback | Auto/Reduced; paused/playing synthetic replay | OS preference, portal tokens, interruption, explicit pause, visibility/unmount cleanup |

## Query scope, cadence and exact observations

Fixture, resource and query-window changes replace the displayed result and clear obsolete observations and pins. Snapshot replacement does the same while preserving observations that overlap at the same entity and timestamp. Theme, canvas width and motion preference are presentation choices and do not change the underlying population or values. Inspection must identify an actual observation in the current result. Query-backed tooltips and external network calls are not configured.

| View | Source cadence and displayed observations | Snapshot advance | Exact-data behavior |
| --- | --- | --- | --- |
| Original baseline | One-minute observations in a 15/30/60m window | One minute | Up to 60 observed/missing interval rows, with timestamps and units. |
| Edge Watch, 1m | Original one-minute byte and request counts | One minute | 15/30/60 rows for the chosen window. |
| Edge Watch, 10s | Six explicitly synthetic integer-count buckets per original minute | One minute, adding six buckets | 90/180/360 rows for the chosen window; the table scrolls within a bounded container and displays seconds. |
| Reliability Room | Hourly request/failure observations over 24h/7d/30d; history cells summarize 1h/3h/12h intervals | One hour | Selected history intervals expose exact counts, worst hourly burn and coverage. Exact budget accounting retains the full selected query population. |

The Edge 10s fixture must conserve every original minute's ingress bytes, egress bytes, requests, allowed, challenged and blocked counts. Each subinterval's requests equal its three exclusive outcomes. Partition each gateway deterministically before aggregation so the combined gateway result equals the selected contributors. A missing minute produces six null samples, not six zeros. Changing display resolution preserves minute summaries, destination/protocol accounting, outcome bars and the minute connection gauge. A 10s traffic observation and a 1m outcome bucket can share an ending timestamp but have different values; the sibling readout must identify its source cadence.

Network egress stays nonnegative in source counts, summaries, event accounting and exact tables. Its sign is reversed only for the labelled mirrored traffic display and that chart's exact plotted values. Ingress and egress use decimal Mb/s derived from their respective interval byte counts. Destination traffic bars share one domain from zero to the highest selected mean Mb/s; percentage share is separately calculated from observed inbound bytes.

Calendar time scales receive Date values only through the renderer's X accessor. Source timestamps, cursor identity and exact inspector data remain numeric epoch milliseconds. Tick labels use the displayed browser timezone. Grids, reference rules and zero lines must align with the same plot scales as the data. Local schema fields are documented owner extensions, not unvalidated options or claimed upstream behavior.

## Local interaction boundaries

The Edge policy-rule selector filters only its event table. Four recent rows are shown initially; Show all exposes the complete filtered set in a bounded scroll area. Exact intervals follows the selected 10s/1m display resolution. Data tables retain native table semantics and labelled times/units.

Reliability availability is `1 − failures / requests`; allowed failures are `0.001 × observed requests`. Six-hour burn pools counts. Negative remaining budget stays visible when exhausted. The incident calendar counts distinct episodes overlapping each local date within the selected query window. Dates outside that window are disabled, and active/resolved describes episode state rather than severity. A selected calendar day filters incident evidence only; it does not narrow availability, burn, budget or the exact accounting disclosure. Arrow keys navigate day/week positions, Home/End reach available date boundaries, and selecting the same date again clears that filter.

Transient inspection clears when focus/pointer ownership leaves, except when a pointer enters its interactive inspector. Pinned inspection persists until explicitly dismissed or its result is replaced. Escape and close actions restore focus to the originating owner where applicable. A missing observation remains inspectable as missing. Outcome bars retain an explicit Clear pin action. Panel information is available through native disclosure semantics with Escape, outside and blur dismissal; essential units, cadence and missingness remain visible without opening it.

## Motion and demo replay

Demo replay is shown only when the mounted study registers a real snapshot callback. It starts paused and, when explicitly started, calls that callback every 1.8 seconds: one synthetic minute in Edge or one synthetic hour in Reliability. It is not a live provider connection or a real-time clock. Explicit pause, hidden-document pause and unmount cleanup stop the timer. Changing studies registers a new paused owner. Reduced motion leaves the update cadence and values unchanged.

Metric values update immediately. Only an actual change in displayed KPI value may trigger the interruptible 360ms value/border/surface emphasis; no count tween, path morph or geometry overshoot is allowed. Compact inspector appearance uses the inherited 150ms motion token. Auto honors the operating system's reduced-motion preference; Reduced disables decorative effects. Inline `--gamma-*` duration tokens change on the theme root so open Gamma portals receive updated values. Do not continuously announce replay ticks.

## Evidence and scope

These are implementation and acceptance contracts, not a claim that every browser, assistive technology or performance boundary has been tested. Retained analytical evidence and limits are recorded in `docs/iteration-03.md`; current iteration-06 evidence is recorded in `docs/iteration-06-interaction.md`. Earlier reports remain historical. Regenerate `PROVENANCE.json` and the owner patch after final renderer changes.

This evaluation surface has no authentication backend, live provider, destructive action or durable dashboard persistence. Its chart editor applies validated presentation changes to the current lab session. Original license and Gamma attribution remain preserved in the copied source tree.

## Iteration 05 — catalogue and shared geography

The contracts above describe the retained analytical studies. The literal reference studies retain their authored fixture semantics; the new `#charts` route evaluates reusable owners independently of those compositions.

| Capability | Owner and contract | Acceptance behavior |
| --- | --- | --- |
| Chart coverage | `src/catalog/ChartCatalog.tsx`, `chart-fixtures.ts`, `src/charts/register-lab-charts.ts`; existing `Widget`/`QueryResult` and `WidgetVisualization` | Eleven examples use ten renderer identities, explicit registration, parsed configuration and matching data kinds. Context and normalized input can be inspected. |
| Presentation controls | Catalogue theme and wide/narrow controls | Preserve the same result and values. Result presets replace query input; missing is not zero. Offer presets only where the source contract supports them. |
| Shared map viewport | `src/charts/geo/GeoMap.tsx` and pure viewport functions | Clamp zoom to 1–8×; support drag, pan buttons, keyboard and reset. Ordinary wheel changes map zoom; outward input at camera limits returns to page scroll. Ctrl/Meta, Shift and horizontal-dominant gestures remain available to the browser. Touch navigation starts disabled and reset disables it again. |
| Map records | `src/catalog/ConnectionMap.tsx`, canonical `connection-map` parser and `buildConnectionMap` adapter | Use stable supplied IDs or deterministic label/coordinate identity. Apply one matching projection to outlines and locations. Null values stay explicit; supplied low/medium/high classifications remain distinct from unknown. Disclose invalid, duplicate and omitted locations. |
| Selection lifecycle | Shared map plus host context callback | Camera movement does not change the selected record or values. Filtering away a point or replacing its result clears obsolete inspection; result replacement preserves the camera. Drag completion must not masquerade as point selection. |
| Embedded and tooltip modes | `interactive` and `inspectable` map props | Embedded maps are static. Disabling tooltips removes point inspection and detail controls while preserving viewport navigation for an interactive map. |

Markers show location presence with a fixed visual size and supplied classification by color; zoom does not imply more traffic or greater risk. Reference-only decorative points are not observations. Risk histories follow stable source identity through filtering and reordering.

The reusable incident calendar counts UTC incident-start records; a blank cell is not evidence of healthy coverage. The retained analytical calendar's local episode-intersection behavior is a separate implementation. General elapsed-duration histories, typed interval bands and rich trend/flag/segment record cells remain gaps rather than implied features of the catalogue.

Executed tests, browser actions and unfinished checks are recorded separately in `docs/iteration-05-reusable-charts.md`. Implemented touch and Alt-wheel handlers do not establish physical-device or browser-gesture validation. No iteration-05 change establishes integration into the upstream Paprika product.


## Iteration 06 interaction contracts

| Behavior | Owner | Required outcome |
| --- | --- | --- |
| Chart window | Shared time-window math, pointer owner and controls | Finite, ordered, bounded timestamps; minimum source span; preview separate from committed state; click distinct from drag; exact UTC entry, Undo and Reset. The scope is local, without KPI/query mutation. |
| Rich observation | Shared observation inspector and canonical tooltip owner | Exact same-time values; missing/absent/ambiguous samples disclosed; gap-preserving histories; raw statistics independent of visual reduction; named window/population and exact-data action. |
| Responsive reference | ReferenceStudio, responsive CSS and measured reference SVG | Real reflow at every available width, with desktop columns, tablet rows and mobile stacking. Full chart content participates in panel height. Explicit source comparison retains literal geometry. |
| Map wheel | Shared geographic viewport | Pointer-anchored ordinary zoom from 1–8×; consumed-only preventDefault; browser/horizontal gestures and outward-boundary scroll pass through; selection identity and values preserved. |

Result replacement invalidates stale inspection and chart-window gestures. Layout/theme changes preserve legitimate navigation state. Transient pointer inspection remains separate from a deliberate pin. Source-preserving transformations and browser gestures are distinct validation gates.

## Lens and authoring contracts

The primary dashboard navigation is available above every routed view, including the default reference dashboard, outside the responsive dashboard and optional source artboard. Above 1200px, native hash links form a labelled grid with an active-page indication. At 1200px and below, a compact labelled native lens picker replaces that grid; grouped options retain every dashboard destination and the chart library. Selection updates the hash route and current value while preserving browser back/forward behavior. Search includes the new lenses with explicit destination mappings. Lens-local headers contain scope and presentation controls.

| Behavior | Owner | Required outcome |
| --- | --- | --- |
| Financial allocation | FinanceLens, finance-data and the strict allocation-treemap plugin | Nonnegative market value controls area; signed daily change controls a declared fixed color scale. Pool current/previous values for returns. Preserve whole-portfolio weight denominators through sector drilldown, and expose exact holdings. |
| Historical performance | Finance fixture and canonical time-series renderer | The selected history period and return headline reconcile. The closing valuation, cash balance and allocation remain the declared fixed snapshot. |
| Website window | operations-data and OperationsLenses | One-hour/three-hour selection changes the corresponding event population, totals and plots coherently. Exclusive page-load buckets conserve request counts. Presentation or local chart zoom does not replace the source population. |
| Independent geography | Two shared GeoMap instances | Map cameras and selections are instance-local. Risk thresholds name their metric; coordinates do not themselves imply risk. |
| Live authoring | WidgetEditor and editor-model with existing Widget/plugin schemas | Maintain applied configuration, editable draft and last valid preview. Guided controls and JSON share validation. Invalid input blocks Apply while keeping the draft and valid chart available. |
| Visualization compatibility | Editor model and trusted registry | Verify required fields/mappings as well as data kind. Preserve the authored custom mapping when switching to a compatible table and back. |
| Apply/Discard | Catalogue or lens panel state | Apply accepts a validated session override; Discard retains the previous configuration. No provider call or durable Save is implied. Restore focus to the initiating Edit action. |
| Data and query workspace | Loaded normalized result and read-only query context | Exact records retain nulls, units and timestamps; pagination/caps are disclosed. Query metadata never implies that an executable backend exists. |
| Lens reflow | LensStudio container and family CSS | Recompute at the measured width; stack panels, retain readable marks and use local table scrolling. Width previews are presentation choices with unchanged source values. |

## Iteration 07 — complex-lens contracts

The four concept routes and all eleven new registered families are independently reachable. Primary navigation includes Market Risk, Inference Fleet, Incident Room and Grid Operations on every view. Search and reference settings expose the same routes. Editor changes remain session-only and use the existing validation/last-valid-preview contract.

| Lens | Population and selection contract |
| --- | --- |
| Market Risk | Allocation uses positive closing market values. Historical period changes recompute returns, attribution, drawdown and correlations while preserving the labelled closing allocation/liquidity snapshot. Contributions reconcile to portfolio return; paired correlations disclose sample coverage. |
| Inference Fleet | Installed and reporting devices remain separate. Request-flow original requests conserve at each stage and exclude retries. Latency quantiles pool compatible histogram buckets. Histogram and queue share accepted five-minute time bounds, exact UTC input, Undo and Reset; rack, flow and snapshot summaries retain their declared population. |
| Incident Room | Request/error summaries pool counts; missing/zero-denominator ratios remain unknown. Every telemetry lane shares one time window. The trace preserves parent containment and parallel spans. Search/collapse hide marks without changing elapsed time and clear hidden inspection. Session notes stay reachable at narrow widths. |
| Grid Operations | Generation plus signed battery power equals demand plus exports. Battery energy integrates MW over elapsed hours. The geographic camera preserves exact values and stable IDs. Observed values, forecast median and nested uncertainty intervals remain distinct. Scenario replacement clears stale evidence. |

Controlled geography accepts an external selected ID atomically. Changed, removed, filtered or revised observations invalidate the old inspection once, while camera navigation stays independent. Selecting another region from the host or map must produce one consistent marker, picker, bar and inspector state. Disabled inspection removes details; an unchanged invalid host ID cannot silently restore them.

The authoring surface uses the registered owner and original normalized result. Invalid configuration blocks Apply and retains the last valid preview. Record timestamp declarations match cells: ISO strings use timestamp type; numeric epoch milliseconds use number with an explicit unit. Applying an option does not convert fixture queries into a backend.

Browser evidence and numerical validation are recorded separately in `docs/iteration-07-complex-lenses.md`. No upstream production integration, alternate-theme parity, physical-touch validation or measured frame-time guarantee is implied.

## Iteration 08 — expanded chart and investigation contracts

The ten new lenses add **27 registered plugin identities and 29 catalogue examples**; totals are **51 catalogue examples and 19 dashboard lenses**. Routes, renderer identities and configured examples are separate inventories. All new charts use the existing `Widget`/`QueryResult`, trusted registry and `WidgetVisualization` path. The [iteration-08 report](docs/iteration-08-chart-expansion.md) records the complete inventory and execution evidence.

| Behavior | Owner and required outcome |
| --- | --- |
| Canonical data acceptance | Every advertised catalogue preset passes `parseRecordFrame` for its complete normalized result, then the strict family adapter/configuration contract. Keep stable IDs, declared units, typed cells and the host's 1,000-row bound. Fixtures must fit as complete populations; silent truncation is not an acceptance strategy. |
| Intrinsic layout | `src/charts/intrinsic-chart-families.ts` centralizes the 27 identities in one Set. Catalogue/editor derive layout from the active widget, including a changed visualization. Compound wrappers use natural height and inline-size containment; existing fill-height charts retain their own sizing contract. |
| Linked selection | Lens-owned selected IDs take precedence over obsolete local pins. Cohort, treatment, source/target pair, shipment, buoy, task and material selection keep their corresponding marks and exact evidence coherent. Result replacement clears stale inspection or gestures. A camera or local time-window change preserves source values and population denominators. |
| Keyboard containment | Active inspection or drag handles Escape locally, consumes the event and restores focus where appropriate. The same key must not also discard an editor draft. An idle chart leaves Escape available to the surrounding editor. Hover/focus inspection, deliberate pinning and dismissing a pin remain distinct states. |
| Responsive evidence | Auto, 768px and 390px canvas controls change presentation only. Reflow panels and local controls; retain dense matrices, long labels, schedule geometry, multivariate axes and tables inside bounded panel scroll regions. Exact entry, buttons and reset provide alternatives to drag gestures. |
| Authoring and standalone previews | Expose only implemented options through the shared editor, preserve field mappings and the last valid preview, and block invalid Apply. A Gantt preview without a host proposal callback is read-only. Applied overrides remain local to the lab session. |

Missing-state semantics belong to the source contract. Future cohort ages are unobservable; an observed null is missing; zero is a measured count. Funnel and journey links conserve their original cohort population. Control limits classify subgroup behavior while specification limits classify individual dimensions; defect Pareto shares use defect counts. Histogram, violin and experiment interval/distribution views derive from the same declared observations. Experiment assignment counts distinguish observed, pending and missing outcomes. Frequency/depth acquisition gaps remain absent, paired vector components do not default to zero, and material candidates may retain known composition while physical measurements remain null. Offer gap presets only to families with a meaningful missing-observation contract.

### Profiling compatibility and evidence

Aggregate flamegraphs preserve `inclusive = self + immediate child inclusive`, ancestry, original-profile denominators and declared cost units. Recursive hotspot totals exclude recursive descendant double counting. Aggregate input never manufactures chronology. Time flamecharts require explicit start/end weighted samples, merge only contiguous equal ancestry, preserve gaps and reject overlap within a thread. Duplicate imported thread names receive distinct identities. Query-plan elapsed times are inclusive and must not be summed into query duration.

Local imports accept Flamebearer v1 single-profile JSON, the supported Querier FlameGraph JSON shape, folded CPU counts interpreted at 100 Hz, and Speedscope sampled JSON with time units. The visible workflow is bounded to **4 MB, 1,000 frames and 1,000 chronological samples**. Invalid input retains the current profile and reports its error. Differential profiles, binary pprof and Speedscope evented profiles require other adapters. Flamebearer export rejects fractional costs; folded export requires named 100 Hz sample stacks and cannot lose byte units, another sample rate or root self cost. Speedscope export requires actual contiguous samples and rejects gaps rather than compressing elapsed time. Import/export preserves the supported session data without implying a provider connection.

### Reversible planning proposals

Production Planner keeps baseline, applied schedule and pending proposal separate. Dragging or entering an exact UTC start creates an immutable proposal; optional downstream propagation preserves task duration and resources. Validate precedence, resource overlap and the planning horizon before Apply, and block conflicting proposals. Discard restores the applied schedule; Undo restores its previous applied version. Resource-load evidence derives from interval overlap under the declared availability assumption. No local proposal writes to an external scheduler.

## Iteration 09 — registered contracts, drill-downs and motion

Seven added lenses contribute 30 registered chart families; total 26 lenses and 81 examples. New intrinsic layout comes from the registry descriptor; the legacy ID set remains only a fallback. Optional `validateInput` runs with actual loaded results for preview, Apply and draft history. Config validity alone is insufficient: missing columns, wrong types, inconsistent dimensions and invalid domain accounting block promotion while preserving draft text and the last valid chart.

A shared selection hook distinguishes a host echo of the same selected entity from an unrelated external selection. Composite cells explicitly map to their host entity key. Hover is transient, pinned evidence persists, and Escape dismisses active inspection before an editor can close. Hover tooltips overlay their chart; committed details join normal flow. Drill-downs expose scope and a route back to the parent, and do not silently alter population denominators or local chart time windows.

Entrance animation changes surface opacity and a 4px offset over 280ms, never metric values, axes or a claimed live signal. The existing motion context applies both operating-system and explicit Reduced preferences. Short opacity emphasis supports hovering; decorative motion is removed under reduced mode. Current source provider/query identity survives presentation overrides as filters and entity scopes change.

Kubernetes separates allocatable/requested/used/limited resources and preserves unscheduled pods. Performance distinguishes aggregate distributions, sampled traces and aggregate CPU profiles, with explicit paired comparison denominators. Distributed replicas preserve applied/committed/received ordering, voting reachability and unknown stale observations. Cross-domain accounting rules and verification are recorded in `docs/iteration-09-domain-and-sre.md`.

## Iteration 10 — field discovery and recoverable configuration

| Capability | Maintained owner | Required behaviour |
| --- | --- | --- |
| Loaded source discovery | `field-bindings.ts::discoverRecordFields`, `FieldMapping.tsx::SourceSchema` | Fields lists declared type/unit, present/missing counts, bounded samples and bound roles. It describes the loaded result, not provider inventory, freshness or availability. Metrics and traces expose their distinct contracts rather than a fictitious records schema. |
| Typed field selection | Optional `WidgetConfigField.binding` and `FieldMapping` | Searchable GammaSelect exposes actual source columns and relevant metadata. Incompatible types or units are disabled with a reason; a missing current name remains visible as an invalid draft. Unit aliases are accepted only when the owner declares them. |
| Optional unmapping | `FieldMapping` and family parser | **Not mapped** writes an explicit empty string. Clearing a role must not revive its default. Paired optional roles, such as reserve's 68% bounds, must both be mapped or both unbound. |
| Last valid preview | `validateEditorWidget`, draft revision/history helpers | Guided fields, structured configuration, Undo/Redo and Apply use the same schema, binding and semantic checks against the result. Invalid names, units, types or relationships retain the draft and previous valid chart while blocking Apply. |
| Compatible renderer switching | `editorVisualizations`, `visualizationCandidate`, per-renderer draft cache | Primitive data kind alone is insufficient. Alternatives need compatible input validation; switching away and back restores that renderer's options/configuration within the editing session. The current renderer remains reachable while repairing its draft. |
| Applied panel isolation | `domain-widget.ts::mergeDomainWidget` | Same-renderer overrides merge with current lens selection. Another renderer receives its own accepted configuration; built-in alternatives shed plugin-only keys. Panel ID, provider and query remain current in every case. |
| Readable authoring | `WidgetEditor.css`, shared Gamma controls | Preserve preview, source roles, error text, data and actions. Narrow layouts reflow properties and contain tables locally. Nested popup/inspector dismissal preserves the editor draft. |

Existing native sample, interval and fixture selectors remain intentional bounded controls. Searchable GammaSelect owns field/visualization authoring, without implying replacement of all domain selectors. Presentation changes issue no provider queries. Apply commits to the current lab session; Discard retains the previous applied panel.

### Complementary domain widgets

| Registered widget | Data and interaction contract |
| --- | --- |
| `followup-distribution` | Each participant contributes once to an observed endpoint or right-censor duration bin. Intervals include their left boundary; the final interval includes its right boundary. Counts conserve the selected cohort, and percentages use that whole-cohort denominator. Arrangement and inspection do not alter survival estimates. |
| `reserve-envelope` | Reserve equals supplied capacity minus required supply at the same timestamp. Subtraction reverses demand interval endpoints. Unknown values remain unknown; optional 68% bounds are a pair. Time selection links the storage guide while preserving the dispatch snapshot; the MW threshold is a visual reference. |
| `wafer-transect` | Mapped X/Y/leakage retain mm/nA units and physical grid agreement. Follow a selected die or use an explicit row/column identity. Connect adjacent measured positions only; null/absent slots break traces. Linear scale preserves zero and log rejects it. Untested, tested-without-leakage and excluded positions remain distinct, with roving marks and paged exact values. |
| `orbital-pass-profile` | Elevation, margin and throughput occupy aligned UTC lanes with independent units. Planning thresholds qualify intervals using declared linear interpolation within the maximum gap. Unknown relevant evidence cannot become complete qualified duration or volume. Contact/sample inspection links supplied map and skyplot evidence. |

Grid Balance reflows its two-column comparisons into one column, with exact evidence spanning available width. Orbital Contact separates profile/budget comparison from its full-width schedule and keeps shared contact selection in the lens header. Source populations and fixed summaries survive presentation/selection changes. No live provider, scheduler, ephemeris engine or durable dashboard backend is introduced by these contracts.

## Iteration 11 — responsive reference dashboards

| Capability | Maintained owner | Required behaviour |
| --- | --- | --- |
| Fluid shell | `ReferenceStudio`, `reference-responsive.css` | Observe available container width; normal dashboard mode has no artboard transform or fixed height. Preserve explicit source-size and comparison modes. Resizing retains dashboard state. |
| Primary plots | `ReferenceCharts`, `reference-chart-layout` | Measured content width, bounded plot height and one Y transform for paths, points, thresholds and annotations. Keep text and point dimensions stable; adapt time tick density. |
| Geographic evidence | `GeoMap`, `geo-viewport` | Opt-in responsive stage preserves projection, camera and selected ID. Keep 28px hit circles and CSS-sized symbols; use normal-flow selected details and usable pan/zoom controls. |
| Supporting evidence | `EdgeSupporting`, `edge-supporting-layout` | Outcome grouping conserves authored counts and bounded plot geometry. Keep exact bucket selection. Preserve 11:7 country flags and readable risk records at narrow panel widths. |
| Dense timeline access | `ServiceTimeline` | Preserve six rows × 85 bins and exact UTC boundaries. Offer native service/interval controls plus Inspect; selected bins remain pressed and survive resize. Clear a selection only if a filter removes its service. |
| Tables and short viewports | `RefPanel`, responsive CSS | Complete records remain in named, focusable local scroll regions. The page does not widen. Menus and dialogs fit the visible viewport; dashboard content determines document height. |

Browser viewport verification and numerical geometry tests establish separate properties. This iteration checks 320–1920px browsing contexts and a 320 × 600px settings view. Physical-device touch, screen-reader and browser text-zoom coverage are not claimed.

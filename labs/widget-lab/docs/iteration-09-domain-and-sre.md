# Iteration 09 — domain lenses and SRE investigations

## Scope and design intent

Seven new lenses implement the four approved cross-domain concepts and three subsequent SRE concepts. The additions contribute 30 registered chart families to the existing registry; the verified integrated inventory is 26 dashboard lenses and 81 catalogue examples. Navigation, chart registration and catalogue fixtures derive from their source catalogues. The original Edge Watch and Reliability Room reference studies remain the visual baseline.

This is an analytical adaptation of generated compositions. Retained concept PNGs are design inputs, not rendered evidence or reliable source data. Compact surfaces, fine grid lines, cyan/violet series, semantic amber/red, exact inspectors and dense linked views guide the implementation. Values derive from deterministic fixtures with explicit population and unit contracts. No measured pixel-match percentage is claimed.

| Lens | Registered chart families | Investigation path |
| --- | --- | --- |
| Grid Balance | `power-flow`, `dispatch-flexibility`, `contingency-matrix`, `dispatch-merit`; reuses `forecast-bands` | Scenario → source or asset → simulated contingency evidence; forecast time → storage guide; local brush/Undo/Reset. |
| Trial Evidence | `survival-km`, `hazard-forest`, `response-waterfall`, `visit-completeness`, `participant-swimmer` | Population → participant → response, visits and follow-up; exact month → event-free estimates and aligned risk counts. |
| Wafer Intelligence | `wafer-die-map`, `wafer-signature`, `wafer-yield-waterfall`, `wafer-chamber-distribution`, `wafer-process-lineage` | Lot → wafer → physical die → process steps; camera remains independent of wafer population. |
| Orbital Contact | `orbital-ground-track`, `orbital-skyplot`, `orbital-contact-timeline`, `orbital-link-budget` | Contact → station and observation → trajectory, skyplot, local contact window and margin contributions. |
| Kubernetes Fleet | `kubernetes-placement`, `kubernetes-resource-bars`, `kubernetes-throttle-matrix`, `kubernetes-resource-trend` | Cluster → node → pod → container, with breadcrumbs/back, entity search and pending-pod evidence. |
| Performance Workbench | `performance-latency-density`, `performance-trace-waterfall`, `performance-differential-flamegraph`, `performance-paired-evidence` | Route → sampled request → span → CPU function; baseline/candidate comparisons and exact profile ancestry. |
| Distributed Systems | `distributed-quorum-topology`, `distributed-peer-latency`, `distributed-replication-tracks`, `distributed-shard-movement` | Shard → replica → directed peer evidence, progress indices and ownership history; reversible local time scope. |

## Shared implementation changes

`src/components/lab/DomainPrimitives.tsx` owns domain panel composition, metric strips, exact value lists, chart measurement and inspection presentation. Each panel uses the original `Widget`, `QueryResult` and `WidgetVisualization` host, not a second dashboard schema. Applied presentation overrides preserve the current source provider/query; lens selection merges after editable settings. Apply remains local to the browser session.

`src/charts/shared/inspection.ts` now owns the inspection lifecycle used by these compound charts and the existing exploration bundle. Hover/focus is distinct from a pin. A chart click can be echoed by a linked host without dismissing its own pin; compound mark IDs map to host selection IDs through an explicit selection-key function. A genuinely different selection or source revision clears stale evidence. Escape consumes active inspection and restores a connected trigger.

Transient hover evidence overlays its own plot instead of changing panel height. A committed pin joins normal layout and becomes closable evidence. No repeated decorative map pulse, fake live animation or metric count-up changes the apparent data. Panel entrance uses a short 280 ms opacity/4 px translation reveal with at most 90 ms stagger; hover emphasis is 120 ms. The existing motion provider owns both OS reduced-motion and the visible Auto/Reduced control. Values and axes are never tweened; reduced mode removes decorative motion.

The copied registry adds optional `validateInput(result, config)` and `layout` descriptors. New families colocate intrinsic layout and loaded-source validation with their registered owner. Legacy intrinsic IDs remain a fallback. Editor preview, Apply, undo/redo and JSON validation now receive the actual loaded result. A valid config pointing to a nonexistent or dimensionally incompatible field cannot replace the previous valid preview. The catalogue exercises every advertised canonical fixture and invokes registered input validation before embedded rendering.

Navigation now uses one route catalogue for its native picker, grouped All lenses directory and related links. The visible count derives from route length. This avoids a newly implemented lens being omitted from a hard-coded desktop menu or narrow picker.

## Numerical and semantic boundaries

### Energy

Power-flow input equals served demand plus separately accounted losses. Available reserve is available source capacity minus dispatched MW. Storage energy is MWh, and state of charge is a fraction of declared MWh capacity; the five-minute signed MW series integrates into the same energy history under a disclosed ideal-storage assumption. The 18:10 UTC snapshot remains fixed while forecast inspection changes the selected time. All three scenarios reconcile across flow, forecast capacity, storage and summary values.

Negative marginal prices use a signed price domain and nonnegative SVG geometry. Numeric epoch timestamps declare number/ms, not ISO timestamp strings. Adapters reject incompatible units and identity metadata. Simulated contingency gaps remain unknown. Existing forecast bands gain an optional available-supply line and exact selected reserve, using the same MW scale; 68% and 95% intervals retain their existing meaning.

### Research and manufacturing

Trial survival derives from individual event/censor observations, with risk counts aligned immediately before the labelled month, tied endpoints, censor marks and Greenwood log-log intervals. Supplied exploratory hazard-ratio estimates are explicitly separate from the endpoint-derived curves. Cohort estimates are not individual survival predictions. Visit coverage distinguishes observed, missed, post-event and after-censor states.

Each wafer has 709 physical die positions: 629 eligible plus 80 explicit edge exclusions. Each wafer has one etch chamber. Tested/pass/failure/untested accounting, spatial signatures and process lineage derive from the same die records. The chamber comparison retains its full lot population while a wafer selection highlights its chamber. Outlier display caps and source populations remain visible. Camera pan/zoom changes presentation only.

### Orbital

Trajectories are authored synthetic positions, not ephemeris propagation. Dateline crossings split at ±180°. The skyplot places north at zero azimuth, clockwise azimuth, zenith at the centre and horizon at the outer radius. Track and sky observations may have different sample cadences; inspectors retain the actual nearest sample timestamp. Contact volume integrates Mbps over elapsed seconds; incomplete signal coverage yields unknown complete volume. Relative dB contributions reconcile to the final margin. Local contact zoom never changes the pass population or totals.

### SRE investigations

Kubernetes node allocatable capacity, container requests, observed usage and limits remain different quantities. Resource aggregation sums container leaves once. Pending pods have no invented placement; missing-node observations remain unknown. CPU throttling uses throttled CFS periods divided by observed periods. Namespace filters scope workload populations while retaining physical node capacity. Explicit local/host selection ownership lets standalone catalogue clicks update selection without requiring an echo, while linked lens Back navigation remains authoritative. Drill-down selects existing stable entity IDs and provides a reversible path back.

Performance comparisons use declared baseline/candidate populations. A separately captured trace can remain available when its request metric is missing; the UI discloses the independent coverage. Root-span status follows the observed request outcome, while unsupplied child outcomes remain unknown. CPU share differences remain unknown when either profile total is zero, without discarding meaningful absolute CPU-per-request differences. Time-density bins and percentile overlays derive from supplied counts; a selected trace is an individual sample, not the aggregate p99. Parent/child spans retain overlap. Differential CPU comparisons use explicit paired normalized records and original-profile denominators; the existing single-profile Pyroscope importer is not advertised as supporting arbitrary native differential formats. Correlation with a deployment does not establish a measured causal optimisation effect.

Distributed replicas preserve applied ≤ local commit ≤ received and a separately supplied leader-committed index. A lagging but reachable voting replica still participates in reachability; unavailable replicas do not contribute fresh measurements. Directed peer latency is not forced symmetric. Shard movement retains the fixed shard population rather than inventing additive retry or replica counts. The fixture is illustrative evidence, not a consensus simulator or a live cluster connection.

## Executed evidence

### Automated verification

The final integrated suite passed **498 tests across 33 files** (9.58 s) after the Kubernetes catalogue-selection fix and Distributed width correction. The whole-project TypeScript check passed. Focused post-review checks also passed 19 Kubernetes tests, 18 Performance tests and 16 Distributed tests. Provenance regeneration/check, reverse-patch validation and `git diff --check` passed. The supported Sites source workflow runs the production build and binds the published artifact to the pushed commit. The catalogue contains 81 distinct IDs: 11 core examples plus 70 grouped examples. The seven additions contribute 30 examples/families.

### Browser acceptance

Checks used the managed desktop browser and the lab's 390 px / 768 px canvas controls. These are responsive composition checks, not physical mobile-device certification.

| Area | Observed result |
| --- | --- |
| Shared inspection | Transient hover is an absolute, non-interactive tooltip with exact evidence; committed pins remain after the host echoes selection. Escape closes active evidence and restores focus. |
| Motion | Auto computes the 280 ms panel entrance animation. Reduced computes no entrance animation; native OS preference is handled by the existing motion provider. |
| Editor | A nonexistent power field disabled Apply while retaining the previous valid preview. Correcting the mapping and changing the title applied successfully. Loaded-source unit validation also has regression coverage. |
| Grid Balance | Wind selection pinned 620 MW and 41.3%; selecting a contingency cell linked the exact asset/scenario evidence. The flow changes to readable source/load bars at narrow widths. |
| Trial Evidence | Marker-high population changed to 220 participants, with 76 events and 144 censors. Returning to all 480, selecting P017 and moving to month 16 kept follow-up, response and visit selection aligned. |
| Wafer Intelligence | Wheel zoom changed the camera from 1× to 2×; drag and Fit worked. Selecting the central pass die retained exact 2.939 nA / 0 mm / 0 mm evidence and linked process history. |
| Orbital Contact | Wheel zoom/Fit and exact observation selection worked. An actual drag changed the local time window to 11:33:38–12:33:25 UTC; Undo restored it. Missing signal coverage showed unknown margin/complete volume and 83.3% coverage. |
| Kubernetes Fleet | Pod → API container → Back to pod → Back to node retained the correct node highlight and detail dock. Pending-pod usage stayed unavailable. Namespace filtering changed requests while preserving 768 allocatable cores. Catalogue selection independently moved from node 18 to a pod on node 21 and updated its node picker and emitted context. |
| Performance Workbench | A latency drag selected 13:06:36–13:18:00 UTC and Reset restored the complete window. The selected span opened encoding/json.Marshal; Focus selected stack revealed the correct profile ancestry. Final desktop and narrow views remained contained. |
| Distributed Systems | Shard → replica detail, Network tab, Back and cluster → shard 043 worked. Quorum loss showed 2/5 reachable voters and unknown unavailable measurements. A topology click pinned eu-2 evidence. After width correction, replication and ownership SVGs both measured 815 px in 815 px plot viewports. |
| Responsive containment | All seven lenses were checked at 390 and 768 px canvas widths. Outer lenses and chart hosts did not overflow; dense topology/table geometry uses bounded local scrolling where appropriate. |
| Navigation | The native picker exposed all 26 lenses and the chart library; the catalogue visibly reported 81 examples and all seven new groups. |

Reviewed implementation screenshots (actual browser viewports):

- [Kubernetes Fleet](screenshots/iteration-09-kubernetes-fleet.jpg)
- [Performance Workbench](screenshots/iteration-09-performance-workbench.jpg)
- [Distributed Systems](screenshots/iteration-09-distributed-systems.jpg)

Generated concept references remain separate under `docs/references/`. Full-page browser captures were not retained as evidence because that capture path transiently changed chart measurement; reviewed viewport captures are the visible implementation evidence.

## Limits and follow-up

The work extends the owner-private Widget Lab. All seven lens datasets are synthetic. There is no new live Kubernetes, Pyroscope, clinical, fab, grid or ground-station provider. Local editor Apply, profile selection and drill-down do not establish durable whole-dashboard export/reopen. Existing Pyroscope import limits remain documented in iteration 08. Physical touch, alternate-theme parity and production-scale performance remain unverified; no frame-rate, throughput or pixel-fidelity claim is inferred from passing unit tests or browser screenshots.

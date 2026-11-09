# Local chart polish pass

Adapt the maintained Insights renderer and editor for an operator moving from a service trend to a workload investigation. Use explicit synthetic observations only. The local review uses the real Insights document service, canonical chart renderers, query scheduler, Gamma controls and dashboard navigation.

The questions are: can I compare related trends, identify the precise selected reading and time, follow a clearly named destination, and style a chart without reconstructing it?

| Panel | Meaning | Missing-data policy |
| --- | --- | --- |
| Request rate / p95 / server errors | Synthetic req/s, milliseconds and percent; one-minute observations | Null is unavailable, never zero |
| Request latency | Three independently supplied percentiles in milliseconds | Gaps stay gaps; no percentile calculation or interpolation change |
| CPU by workload | Three synthetic workload contributions in cores | Incomplete stacks retain unknown-state semantics; statistics use raw observations |

Fixed range: 9 November 2026 00:00–01:00 UTC. Refresh is manual. Stable label-based colours survive reordered provider results. A destination receives the deliberately selected value and service, plus the source time range; its saved defaults remain unchanged.

The changes target shared metric inspector hierarchy, discoverable dashboard-link actions, and opt-in appearance presets using existing widget options. Presets preserve metric colour rules, units, scales, thresholds, interpolation, provider and queries. Individual controls remain editable. Live preview is an unsaved document change; Undo/Redo and Save retain their existing boundaries.

Rendered review also found KPI sample times using the browser zone instead of the dashboard zone, and a vertical legend cue on a horizontally scrolling statistics table. Both are included in this pass. A second synthetic service uses different values and saved defaults to check that drilldown context does not overwrite the destination.

Required evidence: before/after desktop 1512px, tablet 768px and mobile 390px in light/dark; hover, keyboard pin/Escape and emulated touch; long labels and missing samples; exact historical drilldown and browser Back; style preview without query requests; invalid draft recovery; durable save/reload. Check query counts and bounded tooltips, and distinguish automated emulation from physical-device testing. Production deployment and live telemetry are outside this local pass.

## Demo comparison pass — 9 November

Adapt the Edge Watch and Reliability Room demo composition for an on-call engineer comparing changes and investigating recorded events. Local synthetic Prometheus, PostgreSQL and Tempo data provide the evidence; the saved queries, units, time ranges, missingness and authored colours remain authoritative.

| Reference relationship | Observed working gap | Change | Acceptance evidence |
| --- | --- | --- | --- |
| The changing signal dominates its panel | Compact burn-rate card spends 78px on its legend/actions and another 21px on events, leaving roughly 50px for marks | Share a footer row in short, wide charts; keep event details out of plot sizing | Measure actual mark area in both themes; open events without changing plot bounds |
| Small legends keep all ordinary series visible | Three outcome series wrap into a clipped legend with a scroll hint | Use one horizontal row for compact metric legends, with native scrolling only when needed | Three outcomes visible together; long independent labels remain keyboard reachable |
| Events support the chart without displacing it | Directional charts give comparison, events and source notes separate rows | Group footer actions and notes; use one shared event disclosure with bounded, scrollable details | Pointer/keyboard opening, Escape focus return, exact timestamps, no extra provider requests |
| Short entity labels lead inspection | Gauge tooltips repeated a generated provider expression despite already having a short gauge label | Reuse the gauge's display label; retain complete identity in Source details | Independent provider-label fixture and exact drilldown context |

Review at 1592px and 390px against the supplied images, then transfer checks at 768px and 320px with independent deterministic fixtures. Verify selected observations, missing values, comparison/reset, and persisted document/ETag stability. The existing native scrolling menus remain in place.

The broader browser pass also exposed a keyboard scrolling defect: an End/Home/Page key on the inspector's trigger scheduled a geometry update that could reset the requested scroll. The shared inspector now treats those as scrolling keys while preserving Home/End ownership for interactive histories. The existing responsive browser regression waits through rendering before checking the scroll position.

Embedded trace previews now also respect the readonly tooltip contract when the parent provides a trace fetcher. They cannot open a nested waterfall dialog through that inherited provider. Ordinary trace panels retain their waterfall action. The shared embedded-renderer test includes a valid trace ID and an available parent fetcher to exercise this boundary.

At a canvas layout-mode breakpoint, tiles remount and dismiss their old tooltip anchors. The rotation check explicitly reopens the same cached observation in the new layout, then checks containment and keyboard scrolling without additional provider requests; it does not claim pinned inspectors survive that remount.

The wider regressions exposed two additional interaction/layout defects. A pinned heatmap lost its pin when Retry took focus, so the successful response could disappear with its panel; focus transfer now retains the pin until explicit dismissal. A side sparkline could contribute its intrinsic SVG height to a stat row and overflow beneath a missing-data notice; the row now fits the available flex height while keeping the missing-data notice and exact historical samples.

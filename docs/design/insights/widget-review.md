# Insights widget review

Review scope: all six built-in renderers and the bundled Threshold gauge, their editor controls, provider/query connections, drilldowns, and shared Gamma interactions. The default example alone is insufficient: the audit fixture adds the metrics table and gauge. The results below distinguish widget fixtures, real-service integration and visual confirmation.

## Review authorities

- `paprika-widgets`: shared/per-type checklist and host/plugin/document boundaries.
- Impeccable: **Operate** mode, technical audit, craft checks, one initial visual batch and one confirmation batch. Its context command permitted scoped fixes to existing UI. The earlier spring/overshoot finding remains fixed through Gamma's emphasized easing alias.
- Frontend Design Premium and its upstream frontend-design: canonical component resolution, production states, focus, responsive behavior and static verification.
- Explicit local frontend-design: hierarchy, typography, visual restraint and existing product context.
- Design Taste: the earlier review incorrectly treated dashboards as excluded. Current app-screen guidance applies to the entire operating workspace: navigation, hierarchy, density, states and task flow. Preserve the existing Gamma identity; do not apply landing-page defaults. The 2026-10-30 review below supersedes the earlier scope exemption.
- Gamma MCP: current component checklist and maintained briefs/source. Consumer adapters retain source provenance; Gamma catalogue publishing checks are not claimed for Paprika.

The root `DESIGN.md` records the current light Insights island alongside the older dark main-app brief. `UX-CONTRACT.md` records the canonical owners. This review did not introduce another component library or change the saved dashboard schema.

Implementation-integrity verdict: coherent scoped Gamma components, normalized data boundaries and an inspectable review trail. The finished changed UI produced no Impeccable detector findings and no suppressions were added. The bounded technical assessment is **16/20 (Good)**: accessibility 3, performance 3, responsiveness 3, theming 3, implementation integrity 4. The first four scores retain the verification limits below rather than claiming certification, physical-device coverage or measured production performance.

## Findings fixed

| Severity | Finding and effect | Resolution |
| --- | --- | --- |
| P1 | Raw-series reconciliation overwrote a plugin's emitted derived/null value before navigation. | Renderer observations remain authoritative for the exact result/config; refresh invalidates selection until reselected. |
| P1 | Latest-null gauge data could revive an older healthy sample; all-null plugin results were intercepted by the generic empty state. | The gauge displays the latest scrape as unknown when missing; plugins receive normalized results and own their empty-state semantics. |
| P1 | Isolated samples around null gaps could produce a blank time-series plot, and heavy sampling could bridge repeated gaps. | Singleton runs receive visible marks; bounded downsampling retains gap separation and meaningful extrema. |
| P1 | Faint renderer labels bypassed Gamma and failed contrast on light surfaces. | Renderer text/surfaces now consume semantic Gamma tokens; muted text is `#626e65` (5.10:1 on `#fafaf7`, 4.74:1 on `#f1f2ed`). |
| P1 | TanStack independently reduced tick and axis-title opacity, weakening otherwise-correct Gamma colors. | Axis text explicitly uses full opacity through the pinned chart API; browser checks inspect effective text styling. |
| P1 | Native-modal dropdown menus portaled to the body became inert behind the modal. | Shared Gamma controls select the enclosing open dialog as their portal host. |
| P2 | Full metric identities, trace IDs/operations and exact observations depended on truncation or pointer tooltips. | Shared detail controls support focus/touch, viewport-aware pinned details and dismissal. Time/bar charts offer a paginated exact-data inspector independent of drilldown selection. |
| P2 | Hiding the chart legend hid the series-limit notice. | Limit notices remain visible independently of the legend. |
| P2 | Invalid timestamps could contaminate table extrema; invalid trace time/duration could print misleading values. | Invalid observations are excluded from valid statistics and rendered as explicit unavailable data. |
| P2 | Reordering result series could retarget a pinned heatmap or data-inspector selection. | Selection follows observation identity; stale detail state is dismissed rather than reassigned. |
| P2 | Irrelevant controls appeared for traces, line charts and arbitrary plugins; gauge reset discarded registered defaults. | Style controls are gated by supported renderer behavior; Reset appearance restores registered defaults. |
| P2 | Custom backgrounds could leave default text unreadable. | Default foreground adapts; explicit low-contrast choices retain a nonblocking contrast warning. Inspector surfaces retain independent Gamma colors. |
| P2 | Browser-native confirmations and folder suggestions broke the authored Gamma interaction contract. | In-app modal confirmations focus Cancel and preserve navigation guards; folder suggestions use the maintained Gamma combobox. |
| P2 | Forms relied partly on browser validation and textareas could disturb layout through manual resizing. | Product validation owns the three forms; shared textareas grow within a bounded scrollable region. |
| P2 | Mobile navigation intercepted Escape while a confirmation was above it. | The drawer yields keyboard handling to native modals; cancellation preserves the draft, drawer, focus and scroll ownership. |
| P2 | Detail-button wrappers allowed the stat caption to collapse and trace service/operation text to run together. | Stat content retains its height within the existing scroll region; trace operations occupy a separate line. |

## Per-widget checklist

“Pass” means the supported behavior was exercised by the listed project tests, not full accessibility certification or production-provider compatibility. Common state, styling, bounds, keyboard/touch and responsive checks also apply to every row. Plot-only controls are intentionally N/A for non-plot widgets.

| Widget | Status | Reviewed behavior | Evidence owners |
| --- | --- | --- | --- |
| Time series | Pass | Line/area, curve/width/fill, domains/precision, responsive ticks, null gaps/singletons, bounded data, legend/grid/tooltips/labels, exact historical inspector, latest-series drilldown | `charts.test.tsx`, audit/responsive/drilldown E2E |
| Bar chart | Pass | Latest-valid category values, negative/zero baseline, long category labels, exact data inspector, bounds/labels/legend/tooltips, exact selected context | `charts.test.tsx`, audit/drilldown E2E |
| Single value | Pass | Latest-valid semantics, zero/negative/null, exact value/unit/timestamp/labels, narrow cards, no decorative comparison | Chart/context tests, audit E2E; axes/grid N/A |
| Metrics table | Pass | Bounded rows, internal scrolling, latest/min/max correctness, full labels/details, accessible table name and selected row context | Chart/context tests, audit E2E; plot controls N/A |
| Trace explorer | Pass | ID/service/operation, duration in ms, status/time, invalid/empty states, full details and selected trace context | Chart/context tests, live/audit E2E; waterfall and metrics-unit controls N/A |
| Status heatmap | Pass | Latest scrape (including missing), threshold boundaries/ranges, independent labels/values, accessible hidden-text cells, pinned hover/focus/touch details, keyboard scrolling, selection stability | Chart tests, responsive/audit/drilldown E2E; histogram behavior N/A |
| Threshold gauge | Pass | Trusted registration/config, registered defaults, bounds/thresholds, exact/null observation, readable appearance, selectable context, error isolation | Registry/canvas/editor tests, advanced/audit E2E; axes/grid N/A |

## Shared and management checklist

| Check | Status | Evidence |
| --- | --- | --- |
| Provider/query compatibility and honest states | Pass | Query/client/provider tests; actual Go adapters and failure/persistence paths in live E2E; isolated audit edge-state fixtures |
| Clean canvas | Pass | Browser assertions reject provider names/IDs on ordinary cards; source selection remains in the editor |
| Gamma styling and accessibility | Pass | Semantic tokens, legible default colors, visible focus, 44px coarse-pointer controls, open-popup and detail interactions; explicit custom-color warning |
| Responsive layout | Pass | 1512/768/390px audit views, 320px editor/reflow checks, existing narrow canvas/inspector and saved-layout preservation tests |
| Performance boundaries | Pass | Four-request deduplicating/cancelable scheduler; 12 plotted series, 480 sampled points, 100 table/trace/heatmap rows; 25 exact observations per inspector page. These are implementation bounds, not a measured production performance guarantee. |
| Editing and persistence | Pass | Each widget's Query/Style edits, preview, Apply, Save and reload; cosmetic edits do not issue unchanged queries |
| Layout/history | Pass | Existing pointer drag/resize, accessible Layout controls, undo/redo and shrink/grow E2E |
| Documents/AI | Pass | Existing JSON/YAML/OpenUI semantic round trips, invalid/stale review rejection, shared Go validation |
| Library and lifecycle | Pass | Import/export/remapping/retry, duplicate/delete, actual backend conflicts, accessible confirmation cancel/accept |
| Links/variables | Pass | Every widget's selected exact context reaches a destination query; fixed time range and view-only defaults; Back/Forward/reload and stale requests |

## Validation evidence

The definitive machine reports are under `artifacts/insights/`, including `widget-audit/report.json` and its desktop/mobile screenshots. The new audit uses deterministic normalized API responses; it does not substitute a fake renderer. Existing live and drilldown suites exercise the actual Go service with deterministic HTTP providers.

| Check | Result |
| --- | --- |
| All-widget browser audit | Final production build: 206 checks pass; four trace-state cases explicitly N/A. Zero page errors. Desktop/tablet/mobile, all seven types, all 14 desktop/mobile drilldowns, modal dropdowns and nested confirmations. |
| Existing browser suites | 7 editor, 7 advanced, 8 responsive, 9 real-service and 5 drilldown scenarios pass (36 total). These were run through the runner and individual continuation commands; the new audit is also wired into the runner. |
| `rtk proxy npm --prefix ui test -- --maxWorkers=4` | 343 tests across 50 files pass. A preceding run concurrent with the production build timed out in one navigation assertion; the full rerun with bounded workers passes. |
| `rtk proxy npm --prefix ui run build` | Final production static export and TypeScript validation pass. |
| `rtk proxy npm --prefix ui exec -- tsc --project ui/tsconfig.json --noEmit --pretty false` | Standalone typecheck passes; final build also checks the subsequent modal fix. |
| `rtk proxy npm --prefix ui run lint` | Zero errors; three existing non-Insights warnings. Focused lint also passes after the final modal fix. |
| `rtk proxy go test -race ./internal/insights ./internal/api ./internal/api/auth ./cmd/paprika-insights` | Passes (cached); the service CLI compiles and has no test files. |
| Impeccable detector | No findings across changed widget/editor/Gamma code; final modal/CSS correction check also has no findings. No suppressions. |
| Premium strict audit | Seven reviewed false positives; raw exit code 1 retained. Zero unresolved product findings in the scoped review. |
| Design and skill validation | `designmd lint DESIGN.md` and the installed skill's `quick_validate.py` pass. |
| `rtk proxy git diff --check` | Passes for tracked changes. |

All six suites total **242 passed browser checks**, plus four explicit N/A cases. The final contrast-only correction was verified by rerunning the complete widget audit on the rebuilt export. Seven touched E2E files also pass scoped ESLint and syntax checks.

The visual confirmation inspected `widget-audit/normal-1512.png`, `normal-390.png`, `long-390.png`, `editor-timeseries-390.png`, `data-timeseries-390.png`, `detail-heatmap-390-touch.png` and `confirmation-390.png`. The repaired stat caption and trace lines remain visible; long data is available through internal scrolling and exact-details controls. This confirmation identified the chart engine's independent opacity reduction: the browser measured 2.80:1 effective tick contrast on white. After the narrow correction, refreshed desktop/mobile screenshots and browser measurements confirm **5.33:1 at 1512/768/390px**, with opacity 1; the audited saved custom style has 11.00:1 ticks and axis titles. Geometry is unchanged.

Static review uses `docs/design/insights/premium-ui.json`. Premium's raw auditor includes test fixtures and does not resolve CSS modules: six remaining flags concern intentional focus/form-submission fixtures, and the shared textarea flag requires checking its `resize: none` CSS. These are reviewed false positives, not rewritten tests or hidden raw results. `premium-audit.json` retains the raw result.

`premium-audit-triage.json` records each reviewed false positive and preserves the strict auditor's exit code of 1. No ignore rule or file suppression was added. Root `DESIGN.md` lint and the updated `paprika-widgets` skill validator both pass.

Local browser evidence is Chromium desktop and mobile emulation. Physical devices, Safari/Firefox, assistive-technology testing and production-scale performance measurements remain unverified. Explicit low-contrast user colors are warned about rather than overwritten. The trace explorer remains a list; alerting, logs and full Grafana parity are outside this widget review.

## Gallery refinement and bounded-provider checks — 2026-10-29

This is a scoped continuation, not proof of pixel-perfect coverage across the
entire gallery. The design direction remains the existing Gamma **Operate**
workspace. This historical pass applied only general legibility and state
guidance; its dashboard-exclusion rationale was incorrect and is superseded
by the full app-screen review process recorded below. Impeccable's scoped detector returned no findings for the changed UI.

| Area | Status | Evidence |
| --- | --- | --- |
| Compact viewing and responsive projection | Pass for covered layouts | Real-provider Chromium E2E at 1512, 1000 and 390px in both themes verifies unchanged saved documents/ETags, all ten destination rows, six status lanes and a selectable final day in a six-week calendar. This is a view preference; editing retains saved geometry. |
| Table status, threshold gauge cells | Pass for covered states | Explicit status-to-color mappings and value-colored gauges were saved and rendered from PostgreSQL in desktop/mobile light/dark; unmapped and missing values stay neutral. |
| Historical chart drilldowns | Pass for covered time-series | Pinned observation supplies its exact sampled value and labels; hover alone does not commit. Fixture and real Prometheus browser E2E verify navigation, target query, carried range, reload and unchanged ETags. |
| High-cardinality query feedback | Pass for synthetic provider bounds | Query Stress Lab exercises 240 metric series, 1,320 PostgreSQL records per cluster and >100 Tempo traces per service; browser checks preserve null/zero distinction and show provider-limit notices. Observe bundles expose provider and compact-preview truncation separately. |
| Tempo search limit | Pass for covered provider behavior | Local Tempo integration and unit tests cover under-limit, exact-limit, over-limit and a conservative fallback when a backend rejects an extra-result probe. A backend that silently caps the successful probe cannot be distinguished from an exact-limit result. |
| Full gallery visual parity | Incomplete | References still require comparison across all boards and their authoring surfaces. The last review found density, map and incident-detail differences; mobile table overflow remains an area to assess. No claim of pixel-perfect parity, production-scale performance or physical-device coverage is made. |

The local stack is synthetic and isolated. The 1,975 UI tests, Go build/vet,
controller/Insights/observability suites, 124 saved-query checks and the MCP
bundle checks use the commands in `demo/insights-gallery/README.md`. They are
functional evidence, not a throughput benchmark. During overlapping browser
and MCP runs, the local gateway returned transient capacity rejections that
were retried; avoid treating those runs as uncontended performance data.

## Gallery context, feedback and data fidelity — 2026-10-29

This continuation addresses specific reference gaps without claiming the whole
gallery is pixel-perfect. The existing Gamma Operate direction remains the
visual authority; user-requested landing-page styling is not imposed on dense
operational charts.

| Area | Status | Evidence |
| --- | --- | --- |
| Series identity and colors | Pass for covered charts | Exact metric label/value color rules survive editor, JSON, YAML, OpenUI and service save/reload; lines, legend, tooltip and previous-period overlay retain identity under series reorder. A real Prometheus browser test exercises both themes and widths. |
| Bar categories | Pass for covered source chart | Collision-safe axes can omit tick labels while a compact accessible key lists every plotted category, latest value and exact underlying identity. Real provider checks cover five categories at 1512 and 390px in both themes. |
| Explore result feedback | Pass for covered states | Real PostgreSQL browser tests exercise a capped result, incomplete mapping and SQL failure in both themes at desktop/mobile; the summary retains missing counts and discloses a prior successful result. Cancellation has a focused regression. |
| Synthetic incident alignment | Pass for covered services | `check-reliability.mjs` queries real local Prometheus and PostgreSQL for checkout and payments, and checks that recorded incident intervals overlap error-rate spikes and distinct 1h/6h burn rates. Availability probes and request-error burn remain distinct signals. |
| Geographic sample honesty | Pass for covered data | `check-geography.mjs` checks 288 uniquely labelled observations per cluster, coordinate bounds and a Melbourne city sample near its documented coordinate. Wider region samples are synthetic and may be offshore. |
| Capacity behavior | Measured locally, no change | A three-pass rapid-scroll comparison did not establish a reliable advantage for three scheduler slots over four. Observed rejections were on rapidly canceled offscreen queries; visible widgets completed. `rapid-scroll.mjs` reproduces local measurement without imposing a timing gate. The gateway's bounded admission remains unchanged. |
| Full gallery parity | Incomplete | The refreshed desktop dark review confirmed the targeted fixes. A complete light/mobile visual matrix, stronger geographic realism and exact reference equivalence remain unverified. Chromium emulation and synthetic providers are not production or physical-device validation. |

## Gallery accessibility and sample fidelity — 2026-10-29

This local iteration improves the dense gallery examples; it does not establish
pixel-perfect equivalence for every reference or authoring view.

| Area | Status | Evidence |
| --- | --- | --- |
| Geographic observations | Pass for covered samples | The regenerated PostgreSQL seed has 288 distinct synthetic observations for each cluster, with land-checked city and regional coordinates. The map has a searchable, paginated keyboard-accessible location explorer; selection preserves exact coordinates. `check-geography.mjs` and the real-provider map accessibility E2E cover both clusters and desktop/mobile light/dark. |
| Geographic authoring | Pass for covered workflow | The builder exposes geo-heatmap selection, and a real-provider browser test authors, saves with ETags, reloads and selects an observation in both themes and widths. |
| Dense charts and tables | Pass for covered workflows | Stacked-chart marks are hidden from the accessibility tree while keyboard inspection remains available. Overflowing tables provide an associated horizontal-scroll cue and support keyboard scrolling. Browser tests cover both themes and widths. |
| Chart axes and overlays | Pass for covered charts | Tick labels reserve space based on their formatted values, with longer units shown above the plot. Live-provider tests check the Signal Kit axis and Reliability Room's incident footer, legend, tooltip and zoom at desktop/mobile widths in both themes. |
| Signal Kit | Pass for covered states | The board uses live local Prometheus data for its charts and intentionally labeled empty and invalid-query examples. MCP bundles preserve the partial state; the example data is synthetic. |
| Provider-backed examples | Pass for covered examples | All 65 saved queries were exercised with default and alternate values, including the two intentional empty/error examples. Sixteen MCP bundles passed, including partial and truncated states. Eight gallery boards and shared-selection flows passed browser checks in both themes. |
| Validation limits | Incomplete | A complete pixel-level comparison of every gallery and builder surface has not been made. At this review, visual inspection found small mobile treemap labels and a clipped topology layout; see the follow-up below. Physical devices, other browsers and production-scale throughput remain unverified. Some overlapping local browser requests received 429s and recovered; this is not an uncontended load test. |

## Gallery mobile and machine feedback — 2026-10-29

| Area | Status | Evidence |
| --- | --- | --- |
| Market Lens treemap | Pass for covered layouts | The renderer measures its available panel instead of scaling a fixed viewBox. Real PostgreSQL browser tests verify physical label size, bounded tiles, resizing, and keyboard selection of a linked company at 1512/390px in both themes. |
| Collection Control topology | Pass for covered layouts | Stages have more room, with connection observations in an accessible disclosure and keyboard-accessible overflow when needed. Real PostgreSQL browser tests exercise the final stage, connection and stage tooltips, and horizontal and vertical scrolling in both themes at 1512/390px. |
| Signal Kit shared cluster | Pass for covered queries | Both service and cluster now bind the rate, latency, component state, distribution and incident queries; the memory gauge shares cluster. Live-provider and MCP checks verify selected series and incident scopes, including alternate values. |
| Observe text feedback | Pass for covered errors | The compact MCP text includes bounded, quoted widget and annotation binding errors and provider error details. A local real-service check validates a missing saved query and invalid PromQL against both compact text and structured output; it removes its fixture with the exact ETag. |
| Complete visual parity | Incomplete | These targeted repairs do not prove pixel-perfect coverage of every artboard, tooltip, management and configuration surface. Chromium emulation and synthetic providers do not establish physical-device or production performance. |

## Gallery signal and authoring refinement — 2026-10-29

| Area | Status | Evidence |
| --- | --- | --- |
| Service Pulse | Pass for covered signals | The chart compares three independently plotted provider series, and a separate one-hour burn-rate query describes request errors as a multiple of a 99.9% objective. Saved-query checks, both-theme browser checks and MCP bundles verify the selected service and data. |
| Market Lens | Pass for covered composition | A grouped treemap displays the four largest synthetic companies per sector; recorded hourly sector trends and selected-company history come from PostgreSQL. Real-provider browser checks include cross-sector selection and both themes at desktop/mobile widths. |
| Returned-sample freshness | Pass for covered Single value workflows | The optional threshold compares the primary series' last valid returned sample against the selected range end. A synthetic Signal Kit query demonstrates old returned samples. Real-provider tests cover live editing, ETag save/reload, sparkline and MCP reporting; empty or failed data has unknown freshness. This is not a scrape-health claim. |
| Recovery and builder feedback | Pass for covered failures | Widget Retry recovers from an injected temporary failure using the original real Prometheus query without changing the saved dashboard. Explore identifies first-run errors and previous results from different inputs; real PostgreSQL tests cover both themes and widths. |
| Remaining reference coverage | Incomplete | At this review Collection Control still differed from its reference in freshness bars and job execution history. Full pixel-level parity, all builder surfaces, other browsers and production-scale behavior remain unverified. The original synthetic stale example used a fixed cutoff; the follow-up uses a range-relative gap. |

## Collection Control and record authoring — 2026-10-30

| Area | Status | Evidence |
| --- | --- | --- |
| Freshness and job history | Pass for covered views | Collection Control shows five horizontal gauges with threshold labels and six sampled job-state lanes. A separate synthetic Prometheus metric supplies completed, running and failed samples; missing observations remain unknown. Real-provider browser tests cover both themes and widths, keyboard details and the shared cluster filter. The PostgreSQL job rows are a separate sample dataset. |
| Record configuration | Pass for covered workflows | Treemap configuration and selection bindings suggest bounded loaded column names and types without fetching additional data. Numeric controls identify incompatible columns, and manual names remain available. PostgreSQL browser tests exercise editing, selection, ETag save/reload and geo-selection regression at desktop/mobile in both themes. |
| MCP authoring discovery | Pass for covered schemas | Discovery describes status badges, threshold-colored cells, grouped treemaps, returned-sample freshness and horizontal gauge statuses. Observe E2E validates schema discovery, create, targeted patch, stale ETag rejection and UI synchronization; example query expressions in that fixture are illustrative. |
| Rolling old-sample demo | Pass for covered windows | `check-sample-age.mjs` verifies a synthetic returned-sample gap for both clusters in current and historical windows against Prometheus. The provider continues to scrape normally; this does not assert ingestion health. |
| Full reference parity | Incomplete | This targeted pass does not establish pixel-perfect equivalence of all gallery screens, management surfaces and drilldowns. Physical-device, non-Chromium and production-scale validation remain outstanding. |

## Collection interactions and AI context — 2026-10-30

| Area | Status | Evidence |
| --- | --- | --- |
| Ingestion throughput | Pass for covered provider queries | The chart overlays independent metrics, traces and logs series. Synthetic counters yield distinct rates, with the metrics-only statistic and rejection percentage checked against Prometheus for both clusters. Real-provider E2E verifies the legend, exact tooltip value and cluster change in both themes and widths. |
| Freshness gauge interaction | Pass for covered layouts | Horizontal rows fill the available card; intrinsic row sizing keeps the overflow hint stable in a short card. Real-provider E2E verifies hover, focus/Escape, touch pin/dismiss, overflow scrolling and expansion in both themes. |
| Narrow chart legends | Pass for covered layouts | Full current values and units remain visible in the throughput legend at 320/390/1512px in both themes. Table legends receive enough projected height for plot and rows on narrow screens; the saved layout is unchanged. |
| Recent job records | Pass for covered states | PostgreSQL returns only recorded failed or retrying jobs with their start, pipeline and duration. Both statuses have explicit badge mappings; browser checks exercise both clusters in light/dark desktop and mobile. This record set is independent of the sampled job-state metrics. |
| AI authoring context | Pass for covered configurations | Generated context includes registered plugin controls and defaults, supported time ranges and provider-specific query guidance. UI tests and a real-harness browser test cover gauge-bank, grouped-treemap and status-history controls in both themes and widths. |
| Demo startup rate | Addressed in follow-up | At this review the Prometheus import left a sampling gap; a disjoint continuation-block experiment did not remove it. The subsequent catch-up check below verifies a different approach. |
| Full reference parity | Incomplete | This is a targeted gallery improvement, not a pixel-level verification of every dashboard and authoring surface. Physical devices, other browsers and production-scale workloads remain unverified. |

## Fleet observations, tooltip navigation and data continuity — 2026-10-30

| Area | Status | Evidence |
| --- | --- | --- |
| Fleet Atlas conditions | Pass for covered synthetic data | The ready-node card and condition history now use dedicated sampled node states, not CPU thresholds. Both clusters have Ready, Pressure and Unavailable observations and an explicit missing interval. Real-provider checks compare ready counts to observed states; browser and MCP checks exercise the shared cluster filter. |
| Fleet small-multiple labels | Pass for covered series | Concise collision-safe labels replace raw provider label strings; full identity remains in the title, accessible chart name and exact details. Real-provider browser checks cover both themes at desktop/mobile widths. |
| History-to-live join | Pass for covered local stack | The isolated exporter catches up missing synthetic minutes before resuming ordinary one-minute scrapes. `check-bootstrap.py` verifies ordered samples, a maximum 60-second gap, monotonic counters, rate continuity and retained series. An interruption test checks cleanup is limited to the owned containers and network. |
| Tooltip navigation | Pass for covered service flow | A pinned time-series tooltip can open a configured dashboard link with the selected observation context. The Service Pulse example uses a saved-query detail and opens service traces with the carried time range. Provider-backed browser tests cover service selection and unchanged saved ETags. |
| Full reference parity | Incomplete | These focused changes do not prove pixel-perfect parity of every gallery, tooltip, drilldown and management view. Physical devices, other browser engines and production-scale operation remain unverified. |

## Edge selection and machine-readable feedback — 2026-10-30

| Area | Status | Evidence |
| --- | --- | --- |
| Edge geography | Pass for covered synthetic observations | The map combines 288 named-city samples with 144 globally distributed land-checked samples per cluster; the honeycomb retains its original 288 records. Both named and global selections reach the exact PostgreSQL detail query. Browser tests cover pointer, touch and keyboard in both themes and verify that saved dashboard ETags remain unchanged. |
| Link authoring | Pass for covered bindings | The link editor suggests loaded metric-label keys and record fields, identifies labels present in only some loaded series, and permits manual input. Real-provider tests save, reload and follow a selected node with ETag protection in both themes and widths. |
| Compact MCP signal text | Pass for covered signals | Latest valid samples retain their timestamps and disclose a missing final observation. Provider and preview limits are reported for metrics and traces; schema descriptions specify timestamp units. Unit tests and real local MCP bundle checks include source-limit cases. Structured responses and ETags are unchanged. |
| Full reference parity | Incomplete | These changes cover a subset of the gallery and authoring workflows; they do not establish pixel-level equivalence or production-scale, physical-device or non-Chromium validation. Map points are synthetic and do not represent real clients or population density. |

## Reliability severity and authoring feedback — 2026-10-30

| Area | Status | Evidence |
| --- | --- | --- |
| Incident calendar | Pass for covered records | Optional threshold coloring displays the maximum recorded severity for each UTC day. Missing days remain unobserved and unknown severity is neutral. Real PostgreSQL browser tests compare daily values, tooltips and service changes in light/dark at desktop/mobile, with unchanged dashboard ETags. Existing intensity mode remains the default. |
| Invalid widget drafts | Pass for covered workflow | A visible status associated with the disabled dashboard Save button explains that widget settings need correction. Real-provider E2E verifies invalid, corrected and closed drafts in both themes and widths without modifying the saved dashboard. |
| MCP widget identity | Pass for covered bundles | Structured results include plugin visualization ID and input kind for every plugin widget, including when signals are deduplicated. Compact text identifies the first view and reports shared widgets. Real MCP checks cover 16 bundles, annotation interval end columns and unchanged ETags. |
| Full reference parity | Incomplete | These focused checks do not prove pixel-perfect equivalence for all references or all authoring and tooltip workflows. Browser evidence is Chromium emulation with synthetic local providers, not physical-device or production-scale validation. |

## Missing and incomplete data — 2026-10-30

| Area | Status | Evidence |
| --- | --- | --- |
| Unknown incident severity | Pass for covered fixture | A separately seeded unclassified record renders as a neutral hatched observed day; days without records remain dashed and unobserved. Real PostgreSQL tests check the day, tooltip, service switching and unchanged ETags in both themes at desktop/mobile. The seed omits the extra example if all elapsed UTC days are occupied; the E2E reports that boundary as N/A. |
| Missing latest stat observation | Pass for covered data | Single value keeps the last valid value, explicitly labels a missing latest observation, and preserves zero. Browser tests use real Prometheus NaN samples normalized to null in both themes at desktop/mobile. |
| Incomplete empty MCP result | Pass for covered sources | A source-truncated response with no usable observations reports partial rather than empty. A loopback simulated Prometheus warning E2E covers complete empty, incomplete empty, observed zero, aggregate ordering and unchanged ETags; focused Go tests cover metrics, records and traces. |
| Full reference parity | Incomplete | These data-state corrections do not prove pixel-perfect parity for all gallery and authoring surfaces. Physical devices, other browser engines and production workloads remain unverified. |

## Record windows and result clarity — 2026-10-30

| Area | Status | Evidence |
| --- | --- | --- |
| Record chart time windows | Pass for covered PostgreSQL charts | Timestamp-backed line and bar charts compare and zoom the samples already returned by the query. This local view neither reruns SQL nor changes the saved dashboard. Browser tests check sample values, reset and unchanged document ETags in both themes at desktop/mobile widths. |
| Saved-query selection | Pass for covered result kinds | Dropdowns describe the saved result kind and parameter count without guessing a provider language. A PostgreSQL browser test covers authoring and discarding a uniquely named query. |
| Incomplete empty UI | Pass for covered sources | Built-in and plugin widgets distinguish incomplete empty responses from complete empty results, while preserving observed zero. An isolated simulated Prometheus warning fixture checks both themes and desktop/mobile widths through the UI and MCP. |
| Compact multi-series text | Pass for covered bundles | MCP text provides bounded series identities, last values and timestamps, including missing observations and an omitted count; structured results remain authoritative. Local provider bundle checks exercise the service filter and document ETags. |
| Full reference parity | Incomplete | These improvements do not establish pixel-perfect equivalence across the gallery, configuration and drilldown surfaces. Browser evidence is Chromium emulation with synthetic local providers, not physical-device or production-scale validation. |

## Edge tables, selection and snapshot context — 2026-10-30

| Area | Status | Evidence |
| --- | --- | --- |
| Edge Watch tables | Pass for covered views | Optional row numbers follow the loaded rows' displayed sort, filter and pagination order; they are not source-wide ranks. Destination and risk tables use them, and blocked request status uses a badge. PostgreSQL browser checks exercise sorting in both themes at desktop/mobile widths and preserve dashboard ETags. |
| Selection binding feedback | Pass for covered authoring | Metric label suggestions and partial-coverage feedback use loaded series, while incomplete snapshots avoid definite missing-field claims. Browser checks use Prometheus data in both themes at desktop/mobile widths and preserve the saved dashboard ETag. |
| Pinned chart observation | Pass for covered flow | A pinned point keeps its exact series and timestamp as the pointer moves across the chart. Local provider browser tests exercise the saved-query tooltip and trace drilldown, with unchanged dashboard ETags. |
| MCP snapshot context | Pass for covered bundles | Compact text includes the resolved time range, step, observation time, dashboard ETag and bounded effective variables. Bundle checks cover default and alternate selections against local synthetic providers. |
| Full reference parity | Incomplete | This is a focused improvement, not a pixel-level verification of every gallery, configuration and drilldown view. Evidence uses Chromium emulation and synthetic local providers; physical devices, other browsers and production-scale operation remain unverified. |

## Historical ranges and Edge table fit — 2026-10-30

| Area | Status | Evidence |
| --- | --- | --- |
| PostgreSQL time ranges | Pass for covered queries | Explicit range parameters bind UTC timestamps through the SQL driver. Reliability attention, incident lists, annotations and incident severity use the selected range; incident intervals include touching boundaries and status/duration are evaluated at its end. Real local PostgreSQL tests cover historical and current windows, boundaries, both clusters and unchanged dashboard ETags. Other SQL queries only honor a range when their author includes the parameters and predicates. |
| Query preview context | Pass for covered filter changes | Changing a dashboard service invalidates the previous query preview and aborts pending work. Prometheus browser tests cover rerun and unchanged dashboard ETag in both themes at desktop/mobile widths. |
| Fractional comparison boundaries | Pass for covered data | Prior-period comparison includes valid timestamps immediately before the boundary, matching the plotted previous period, while excluding the boundary itself. Focused tests cover fractional milliseconds and the calculated difference. |
| Edge table fit | Pass for covered layout | Compact cell spacing lets all six risk columns fit the desktop reference panel without clipping. At 390px the table retains keyboard-accessible horizontal scrolling and a visible hint. PostgreSQL browser tests cover both themes, sorting and unchanged ETags. |
| Risk trend colors | Pass for covered data | Record-table sparklines can use a numeric field from the same row with the widget thresholds. Edge Watch uses the risk field; missing values and unconfigured thresholds stay neutral. PostgreSQL browser checks cover both themes and widths, and the authoring schema describes the option. |
| Full reference parity | Incomplete | Excess card height remained a visual difference at review. Full pixel-level coverage, physical-device and non-Chromium checks and production-scale behavior remain unverified. |

## Market history and record inspection — 2026-10-30

| Area | Status | Evidence |
| --- | --- | --- |
| Market historical data | Pass for covered queries | Sector and selected-company charts, plus company table sparklines, use bound selected-range timestamps. PostgreSQL browser tests verify exact inclusive boundaries and an empty historical window in both themes and widths. Company rankings and composition are seed-time snapshots, identified in the dashboard description. |
| Record chart tooltips | Pass for covered interactions | Line and bar plots expose exact recorded observations to pointer and keyboard inspection and use explicit pinning; hover does not change dashboard selection. Local PostgreSQL E2E covers touch, keyboard, tooltip movement and unchanged document ETags. |
| Edge layout | Improved, not pixel-perfect | Major rows are one grid unit shorter, while retaining plotted content and all visible table rows. Provider-backed browser tests cover desktop/mobile, both themes and ETags. The risk card retains some whitespace and mobile tables need horizontal scrolling. |
| MCP authoring | Pass for covered discovery | Schema discovery describes PostgreSQL range parameters and record-table row numbering. A read-only MCP-to-PostgreSQL check verifies the range-aware example with current and historical data. |
| Synthetic history continuity | Pass for newly created local stacks | A worker in the owned disposable PostgreSQL container appends synthetic probe, company, node and edge observations. Isolated tests verify interruption rollback, serialized retries, unchanged old samples and bounded catch-up. Histories are not pruned and storage grows until the local stack is stopped. |
| Growing table histories | Pass for covered queries | Market, node and edge sparklines return the latest 240 recorded observations within the selected range; seed-time snapshot fields are identified separately. PostgreSQL checks verify timestamp boundaries and empty historical ranges. Narrow table views reserve room for sparkline rows and scroll guidance. |
| Full reference parity | Incomplete | These checks cover selected gallery and authoring workflows. Full pixel-level comparison, physical-device and non-Chromium checks, and production-scale behavior remain unverified. |

## Event windows and observation context — 2026-10-30

| Area | Status | Evidence |
| --- | --- | --- |
| Edge and Collection events | Pass for covered records | Blocked requests, gateway annotations and failed job starts use explicit selected-range SQL parameters. Local PostgreSQL browser checks cover two clusters, observed and empty historical windows, both themes and widths, and unchanged dashboard revisions. |
| Single value MCP bands | Pass for covered signals | Widget-specific output identifies the matched configured visual band using the same primary last-valid sample as the UI; it is not a service-health verdict. Go tests cover missing and limited responses, zero, boundary values and shared signals; local Observe bundles exercise provider data. |
| Record tooltip placement | Improved, with fallback | Inspectors remain inside the visible dashboard canvas and seek a clear position outside neighboring widgets. Local PostgreSQL browser checks cover pointer, touch, keyboard and unchanged revisions. A pinned inspector can still overlap another card where no clear area is available. |
| Status-history selection | Pass for covered flow | Explicitly selecting a recorded node state provides its label and sample timestamp as selection context; Fleet binds the node label to its shared variable. The first and last time-axis marks retain reachable hit areas. Local Prometheus browser tests check that hover and focus are inert, selection updates node detail, and dashboard revisions remain unchanged in both themes and widths. |
| Full reference parity | Incomplete | These checks cover only selected gallery interactions and do not establish pixel-level equivalence or physical-device, non-Chromium and production-scale validation. |

## Pie inspection and authoring continuity — 2026-10-30

| Area | Status | Evidence |
| --- | --- | --- |
| Metric pie | Pass for covered interactions | The tooltip shows the selected series' actual latest observation, timestamp and share of positive observations. Explicit selection carries the timestamp; a data refresh invalidates a stale pin. Signal Kit includes a saved-query-backed synthetic node-ratio example with the shared cluster filter. Prometheus browser tests cover pointer, touch, keyboard and both themes at desktop/mobile widths. Legends use collision-safe concise labels while retaining full identities and expose a labeled scroll region for overflow. |
| Visualization switching | Pass for covered workflows | Selection bindings and tooltip widgets remain available as inactive drafts when the new visualization cannot use them. The editor explains the state and offers explicit removal. Browser tests check switching back, discarding drafts, saving removal and ETags in both themes and widths. |
| MCP provenance | Pass for covered bundles | Widget saved-query and annotation IDs and authorized signal provider IDs are associated with their results; deduplicated queries retain each widget's source identity. Tests cover missing references, denied providers and document revisions. |
| Tooltip control avoidance | Improved, with fallback | Dashboard controls are prioritized as obstacles for external chart inspectors. Browser tests cover the pie and record tooltips in both themes and widths; if no clear area exists a pinned inspector can still overlap a neighboring card. |
| Full reference parity | Incomplete | These changes cover selected chart, authoring and MCP workflows only. Pixel-level comparison of the full gallery and physical-device, non-Chromium and production-scale checks remain outstanding. |

## Skewed distributions and compact trace context — 2026-10-30

| Area | Status | Evidence |
| --- | --- | --- |
| Pie numeric range | Pass for covered finite observations | Pie weights are normalized before summing, so large finite samples do not collapse their sectors when their direct sum overflows. Focused tests cover large and subnormal values while preserving the original displayed observations. |
| Distribution color | Pass for covered configuration | An optional logarithmic scale spreads positive densities using the range in shown buckets before time sampling, while keeping recorded zero and missing observations distinct. Linear remains the default, and the legend describes the domain. Local Prometheus checks exercise the Signal Kit example. |
| Mobile pinned inspector | Improved, with fallback | When a narrow viewport forces overlap, users can minimize and restore the pinned inspector without losing its exact observation or rerunning its child query. Browser tests cover focus, dismissal and ETags in both themes; the compact control can still cover a small part of a neighboring card. |
| MCP trace synopsis | Pass for covered bundles | Compact text includes bounded sampled trace IDs, statuses and timing with omission and invalid-field indicators; structured content remains authoritative. Local Tempo bundle checks compare the synopsis to returned examples. |
| Full reference parity | Incomplete | This is a targeted improvement, not proof of pixel-level parity or complete physical-device, non-Chromium and production-scale coverage. |

## Tiny densities and safe visualization changes — 2026-10-30

| Area | Status | Evidence |
| --- | --- | --- |
| Histogram fidelity | Pass for covered data | A materially decreasing cumulative bucket stays unknown even at tiny magnitudes; true zero remains zero. Small nonzero legend values use an approximate scientific label when fixed decimals would display zero, and notices wrap inside narrow cards. Prometheus E2E covers both themes and desktop/mobile widths. |
| Record chart scales | Pass for covered data | Signed coordinate and value ranges use overflow-safe positioning and tick interpolation. Unit tests exercise extreme finite inputs; PostgreSQL E2E uses large values inside its documented record precision limit and confirms larger values are rejected. |
| Visualization conversion | Pass for covered workflow | A switch that would remove an event query or replace an incompatible main query requires an explicit choice. Provider-backed browser tests cover cancel, discard, explicit conversion and saved ETags in both themes and widths. |
| MCP sample mean | Pass for covered signals | The machine summary reports an unweighted mean of finite returned observations with valid timestamps before history downsampling. It is not a time-weighted or source-wide average. Local Prometheus/MCP checks compare the summary against full provider samples. |
| Full reference parity | Incomplete | These focused checks do not prove pixel-level parity across all galleries or physical-device, non-Chromium and production-scale behavior. |

## Gauge bounds, drilldowns and trace filtering — 2026-10-30

| Area | Status | Evidence |
| --- | --- | --- |
| Gauge numeric range | Pass for covered finite observations | Linear, segmented and radial gauges use overflow-safe positioning and threshold colors across extreme signed ranges. Inferred bounds stay distinct, or display an actionable error if no finite bound is possible. Unit tests and local Prometheus browser checks cover both themes and desktop/mobile widths. |
| Drilldown destination changes | Pass for covered workflow | Changing to a destination without bound variables asks before removing incompatible bindings; cancel retains the draft and compatible bindings survive confirmation. Local Prometheus browser checks verify focus, both themes and widths, and that the dashboard ETag changes only on save. |
| MCP sample mean cancellation | Pass for covered signals | The unweighted mean accumulates finite observations before rounding, including small values between cancelling large positive and negative values. Local Prometheus-to-Observe checks cover cancellation, subnormal values, truncated history, compact text and an unchanged dashboard ETag. This remains a mean of returned valid samples, not a source-wide or time-weighted average. |
| Multi-cluster synthetic traces | Pass for covered workflows | Signal Kit's Tempo saved query binds both service and cluster. Local browser tests cover four filter combinations, failed spans, waterfalls, a keyboard-accessible overflow cue and Tempo IDs with omitted leading zeroes in both themes and viewport sizes; MCP bundles are checked against direct Tempo searches for the selected and opposite clusters. Search results report unknown trace-wide status when Tempo does not supply it. The continuously generated trace failures and request metrics are independent synthetic data. |
| Full reference parity | Incomplete | These focused fixes do not establish pixel-level parity across the gallery or physical-device, non-Chromium and production-scale behavior. |

## Compact layout and numeric extremes — 2026-10-30

| Area | Status | Evidence |
| --- | --- | --- |
| Compact canvas | Improved for covered layouts | A finer viewing-only grid preserves readable statistics and reduces excess height in some plots without changing saved or edit layouts. At 1332×826 with the sidebar collapsed, Edge Watch's second row began about 29px higher; its blocked-requests table still remained below the viewport. Local-provider browser tests cover light and dark at 1512, 1332, 1000 and 390px, checking chart room, ten destination rows, six history lanes, a six-week calendar, overlap and unchanged ETags. |
| Chart axes and stack overflow | Pass for covered finite observations | Stacked and directional plots position opposite-signed finite values up to ±1e308 without an overflowing axis span. If a stacked total cannot be represented, its entire affected time column becomes a gap with an explanation, rather than a partial total; the original observations remain inspectable. Local Prometheus browser tests cover both themes and desktop/mobile widths. |
| Legend sample mean | Pass for covered signals | The table legend accumulates finite returned observations without losing small values during large positive/negative cancellation. A local Prometheus-to-browser-and-MCP test compares its arithmetic mean with the machine summary in both themes and viewport sizes; this is not a time-weighted or source-wide mean. |
| MCP series coverage | Pass for covered bundles | Successful metric signals report the number of series in the bounded provider response and the number omitted from the compact summary, including zero for an empty response. These counts do not describe source-wide cardinality; provider truncation is separate. Local Prometheus and Observe checks cover an eight-series response with one summary and an empty metric, as well as the gallery bundle sweep. |
| Full reference parity | Incomplete | The compact adjustment improves density but does not reproduce the reference viewport; complete pixel-level comparison across charts, authoring and drilldowns remains outstanding. Chromium emulation and synthetic local providers do not establish physical-device, non-Chromium or production-scale behavior. |

## Waterfall, chart inspection and data quality — 2026-10-30

| Area | Status | Evidence and limits |
| --- | --- | --- |
| Trace waterfall | Pass for covered workflows | Trace details open in a larger dialog. Span bars share an axis from the first recorded start to the last recorded end; relative starts, durations and parent guides use the returned spans. Missing parents, unresolved relationships, invalid timing and partial responses remain explicit. Real Tempo browser checks verify bar geometry, connected guides, focus restoration and narrow timeline scrolling in both themes and viewport sizes. Timestamps retain the provider's existing floating-point millisecond precision. |
| Tooltip placement | Pass for covered workflows | A transient mouse or pen hover follows the pointer with a 16px gap, flipping and clamping at viewport edges; pointer transparency keeps charts reachable. Keyboard focus, touch and pinned details retain interactive anchor-based positioning. A combined-build provider-backed matrix exercises 15 custom-tooltip paths in both themes and desktop/mobile widths, supplemented by line, traffic, distribution, stat, table, heatmap, map and geo checks. At that review record-table and treemap still used browser-controlled titles; the follow-up below replaces those paths. Record-list and record-matrix do not have a custom hover tooltip. |
| Overlapping map markers | Pass for covered workflows | Clicking multiple actual marker hitboxes opens a chooser of the recorded locations beneath that point without shifting their coordinates or changing selection context. Combined-build PostgreSQL browser checks cover covered-marker selection, linked detail, focus, Escape and touch alongside the searchable 432-marker explorer in both themes. |
| Unrelated variable changes | Pass for covered workflows | Query lifecycle identity follows the resolved request and scheduler rather than an unrelated dashboard variable change. An unchanged widget retains its data and interaction focus; a changed resolved request clears stale data and cancels obsolete work. Lifecycle tests and real-service geographic and service-filter browser checks cover both unchanged and changed bindings, including late responses. |
| Same-time comparisons | Pass for covered workflow | The rich chart inspector shows each plotted series' value at the selected timestamp, explicitly marking absent observations instead of substituting nearby samples. A local Prometheus browser check verifies exact returned samples, pin and dismiss in both themes at desktop/mobile widths; the selected series remains the drilldown context. |
| Synthetic traffic and traces | Pass for covered provider data | Fresh local Prometheus data supplies bounded, independent minute-scale ingress/egress variation for both clusters. Fresh Tempo data includes six deterministic four-span timing shapes, a stable 200 ms fixture and failed spans. Provider checks validate both clusters and parent-relative timing. The synthetic trace failures and request metrics are independent and should not be read as correlated requests. |
| MCP duplicate observations | Pass for covered summaries | `duplicateObservations` counts additional samples at valid repeated timestamps, including missing-valued samples. Compact text explains that some charts require query aggregation; raw statistics still include valid returned samples. An authenticated synthetic Prometheus-compatible provider → Insights → Observe MCP test covers duplicate and missing samples, raw mean and unchanged ETag. |
| Full reference parity | Incomplete | These changes address the reported trace and tooltip problems but do not establish pixel-level equivalence across all gallery, authoring and drilldown surfaces. Browser checks use local synthetic providers and Chromium emulation, not physical devices, other browsers or production-scale workloads. |

## Record inspection and centered traffic — 2026-10-30

| Area | Status | Evidence and limits |
| --- | --- | --- |
| Record-table cell inspection | Pass for covered workflows | A compact shared inspector supports pointer-following previews and keyboard or touch pinning; table sorting, selection and time controls remain separate. Styled gauges and sparkline histories report recorded value and available context. Tooltip-disabled and embedded views do not expose the inspector. Real PostgreSQL browser checks cover the combined build, tooltip width, both themes and desktop/mobile widths, including sorting and unchanged ETags. |
| Treemap inspection | Pass for covered workflows | Pointer, keyboard and touch can inspect the recorded area, group and optional independent color observation. The area uses an explicit column unit or falls back to the widget unit; the color field retains its own unit. Narrow labels use an ellipsis when necessary and retain the full recorded value in accessible text and the inspector. The inspector invalidates when its data or formatting configuration changes. PostgreSQL browser checks cover the combined build, selection and unchanged ETags in both themes and viewport sizes. |
| Directional axis | Pass for covered workflows | The optional `symmetricAxis` control centers zero with equal positive and negative bounds. It does not alter recorded ingress or egress values, and its default preserves existing charts. Edge Watch enables it. Unit coverage includes zero and extreme finite values; real-provider checks cover chart geometry, authoring, ETag-protected save/reload and AI context in both themes and viewport sizes. |
| Edge sample continuity | Pass for covered provider data | The isolated PostgreSQL worker appends independent synthetic blocked requests every two minutes and gateway annotations every fifteen minutes for each cluster. A live saved-query check observed a later worker tick in the selected range; controlled tests cover bounded catch-up, idempotence and preserved history. These records are illustrative and do not represent real client traffic. |
| Full reference parity | Incomplete | These targeted improvements do not establish pixel-level parity across all gallery, authoring and drilldown surfaces. Physical-device, non-Chromium and production-scale behavior remains unverified. |


## Telemetry-first review loop — 2026-10-30

The reproducible multi-stage process is [review-loop.md](review-loop.md). It
supersedes the historical dashboard exclusion for DesignTaste. Review the whole
scan → pin → edit → save → reload journey, not disconnected widgets. Keep
composition approval distinct from functional test results and deployment.

This bounded candidate balances contiguous statistics at measured canvas widths
of 840px and above, uses intrinsic-height plain statistics in narrow **view mode**,
consolidates secondary mobile actions in the maintained Gamma menu, and keeps all
five widget-editor tabs on one accessible row. Saved positions and edit mode are
unchanged. Intrinsic cards grow for additional series and freshness notices;
sparkline, bar, described, linked and custom-height cards retain authored space.

Local sample review measured the traffic panel 148px earlier on the 1180px desktop
and 166px earlier in the 390px responsive iframe. The latter now includes the
chart header and beginning of its traces in the first viewport. At 320px the
five tabs measured 44px high and approximately 50px wide, with no page overflow.
These are observed sample-view results, not production-provider benchmarks or
physical-device certification.

Candidate validation: 2,140 UI tests across 204 files, TypeScript, production
static export and scoped ESLint passed. Regression coverage includes counts 1–8,
839/840/841px, mixed plugin/stat groups, view/edit document immutability, secondary
series, mobile menu keyboard focus/escape and local save behavior. Actual browser
checks covered both themes, desktop observation pinning, 320/390px editor and
menu interaction, and browser-local title save/reload/restore. Screenshot evidence
and candidate hashes are retained in the task review receipt; they are not a
substitute for authenticated provider or deployed-source verification.

Not established by this pass: Omega backend integration, missing original Grafana
artboard parity, browser detector certification, exhaustive loading/error visual
states, physical touch hardware, or a production release. Do not report any of
those as passed. Tests for loading/error/empty data remain separate from visual
state review.

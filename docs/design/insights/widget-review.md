# Insights widget review

Review scope: all six built-in renderers and the bundled Threshold gauge, their editor controls, provider/query connections, drilldowns, and shared Gamma interactions. The default example alone is insufficient: the audit fixture adds the metrics table and gauge. The results below distinguish widget fixtures, real-service integration and visual confirmation.

## Review authorities

- `paprika-widgets`: shared/per-type checklist and host/plugin/document boundaries.
- Impeccable: **Operate** mode, technical audit, craft checks, one initial visual batch and one confirmation batch. Its context command permitted scoped fixes to existing UI. The earlier spring/overshoot finding remains fixed through Gamma's emphasized easing alias.
- Frontend Design Premium and its upstream frontend-design: canonical component resolution, production states, focus, responsive behavior and static verification.
- Explicit local frontend-design: hierarchy, typography, visual restraint and existing product context.
- Design Taste: its dashboard exclusion applies. Compatible preservation, clarity and dependency guidance were used; landing-page defaults were not applied. The operating workspace retains low visual variance and motion, with deliberate information density.
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

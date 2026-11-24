# Tooltip query and widget review — 24 October 2026

Scope: extend heatmap tooltip sub-widgets to all built-in visualizations and trusted installed plugins, with provider queries bound to hovered labels, Gamma authoring controls, and desktop/mobile verification. The normal canvas remains free of connection metadata.

## Result and ownership

The builder now selects time series, bars, single values, metric tables, traces, heatmaps and registered plugins such as the threshold gauge. It supports existing cell data or an explicit provider query, compatible provider selection, label mappings, title, unit, color inheritance/reset, precision, supported plot options and four bounded heights. Trace views require trace queries. Query drafts survive switching between metric/trace types and source modes; invalid plugin JSON survives editor tab changes.

The shared contract lives in `schema.ts`, generated JSON Schema and independent Go validation. JSON, YAML and OpenUI round-trip nested definitions. AI review validates provider compatibility, template mappings and registered plugin settings. Library export/import discovers nested providers and remaps them by capability; retry identity calculation ignores remapped provider IDs so a corrected import does not duplicate dashboards or break links.

`tooltip-query.tsx` owns label binding and request lifecycle. The host supplies the shared scheduler and current range/step. Queries start only when a tooltip opens and abort on dismissal or identity change. A result from an old query cannot flash during a switch. Missing labels, unmapped variables and incompatible providers cause local errors without a request. Request failures offer a Gamma retry action while retaining exact parent-cell details.

A critical integration fix separates dashboard-template interpolation from the shared scheduler. Tooltip labels are quoted once before enqueueing; a label containing literal `{{text}}`, quotes, backslashes or newlines remains data and is never interpreted as another dashboard variable. No implicit dashboard-variable merge occurs.

`tooltip-widgets.tsx` bounds copied, frozen results to 12 metric series, 240 points per series and 100 traces. Sampling preserves the last valid observation before a null tail, as well as the null latest observation: bar/stat/table latest-valid semantics cannot change into heatmap/gauge latest-null semantics. Shared widget renderers run through an embedded presentation context with nested tooltips, inspectors and drilldown actions disabled. Queried time/bar SVGs have associated exact textual summaries for screen readers, including labels, units, timestamps and missing data.

## Review process and visual evidence

The installed `paprika-widgets` skill and checklist now document explicit queried tooltip sources, safe interpolation, isolated variables, shared scheduling/cancellation, immutable bounds, plugin validation and the new real-service suite. The earlier coordinated audit/critique/Gamma workflow remains in force: inspect production-rendered controls and native viewport captures, not component imports or successful clicks alone.

Gamma select, input, textarea, button and switch adapters are reused. Independent review of desktop 1512px, mobile 390px and narrow 320px captures found no actionable editor styling defect. Provider/query/mapping controls remain within the page; mobile provider, mapping and remove controls measure 44px high. Query textareas measure about 119px high with a 12px code font. Open provider/visualization menus retain focus, selection and readable labels without page overflow. Coordinates in the report may be outside the viewport after scrolling to another field; targeted native captures establish the individual fields' visible state.

Native review caught an inherited wrapping rule splitting a short trace status inside the narrow tooltip. The canonical `.status` style in `charts.module.css` now uses `white-space: nowrap`; the regression checks both computed style and a single rendered text line at desktop and phone widths. Relevant chart/tooltip unit tests pass 63/63 after this CSS fix.

Evidence lives in `artifacts/insights/tooltip-query/`: native editor, query-field and open-menu captures, per-widget tooltip captures, scrolled output captures, runtime state captures and `report.json`. The 320px scenario checks both horizontal containment and reaching the tooltip footer by keyboard scrolling. Chromium mobile emulation is used; no physical-device or cross-browser certification is claimed.

Impeccable's final scoped detector reports **zero findings**. Frontend Design Premium reports seven raw findings: six deliberate test-fixture cases and one CSS-module resize-rule detection limitation. They are individually explained in `static-audit-triage.json`; none is a verified production defect. No suppression was added. The earlier bounce easing finding remains fixed by the shared exponential ease-out token.

## Validation

- Full UI unit suite: **404 tests across 54 files pass**.
- Focused tooltip/query/chart/registry coverage: **81 tests pass**, included in the full suite.
- Production `npm run build`: passes, including TypeScript and all static routes.
- Scoped Insights/route/connection/E2E ESLint: passes; runtime and harness final changes also pass focused lint.
- `go test -race ./internal/insights`: passes. Tests cover strict nested fields and bounds, all widget/data kinds, portable persistence/restart and provider capability rejection before an upstream request.
- Complete browser runner: **all eight suites pass**, with **61 scenarios plus 206 widget checks** and four explicit N/A cases. After that run, the final one-line status wrapping correction was rebuilt and the affected **12/12 real-service tooltip scenarios passed again**, with zero page errors. Computed `nowrap` and a single rendered text line are asserted at 1512/390px; fresh native trace captures independently confirm the fix. The complete-run baseline is retained as `full-eight-suite-report.json`, and `report.json` records the final targeted run.
- `git diff --check`: passes.

The new browser suite runs the actual Go component and HTTP adapters against deterministic Prometheus/Tempo fixtures through a test-owned same-origin gateway. The gateway propagates client disconnects so cancellation is observed at the upstream fixture, rather than inferred from a mocked fetch. It verifies exact query text, no requests during editing, all seven visualization outputs on desktop/mobile, persisted settings after reload, provider errors, retry/empty states, stale-result prevention, dashboard range/refresh, and nested-provider library remapping. Existing suites cover JSON/YAML/OpenUI and the history-only defaults; contract tests round-trip every new type through all three formats.

The first new-suite attempt stopped on a test locator that matched both Latest and Max table cells with the same value. The assertion was narrowed to the intended visible cell; actual renderer checks were retained and expanded. The failure screenshot and `harness-corrections.json` document the correction. One initial build failed in generated Next.js font processing; preserving the old generated output and rebuilding cleanly resolved it without changing application code or fonts. The final normal Turbopack production build passes.

No deployment was performed. Deterministic fixtures verify integration and adapter behavior; they do not establish compatibility with every provider version, real production query cost, load performance or Grafana feature parity. Plugins remain trusted application modules, and tooltips are bounded leaf views rather than recursively interactive dashboards.

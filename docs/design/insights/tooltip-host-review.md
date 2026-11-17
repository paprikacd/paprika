# Tooltip hosts and authoring review — 24 October 2026

This follow-up extends the existing tooltip sub-widget framework to time-series points, bars and metrics-table rows, and makes configuration discoverable for every supported host, including heatmaps. The existing seven embedded visualizations and trusted plugin boundary remain unchanged.

## Behavior and design decisions

- **Findability:** Edit dashboard → widget settings → **Tooltips** → **Add tooltip widget**. The Style tab also provides a **Configure tooltips** shortcut. The dedicated tab keeps enable/disable, Add/Remove, visualization, query and mappings together. Reset appearance preserves this separate configuration.
- **Context:** Time series supply the exact plotted historical datum; bars and table rows supply their represented latest-valid sample. Heatmaps retain their latest sample, even when missing. Explicit query mappings support labels, series name, value and timestamp. Timestamps become Unix seconds with fractional precision; normalized chart data remains milliseconds.
- **Query correctness:** String values are quoted once and numeric values remain numbers. Missing context fails locally. Dashboard variables are not implicitly inherited. The shared scheduler, current range, cancellation, retry, identity masking and bounded leaf renderers remain in use.
- **Interaction:** TanStack's installed public hit-testing, focus/select callbacks and tooltip-extension API feed the same viewport-aware observation portal. Arrow keys visit individual series at each timestamp; pointer transfer, pinning, Escape and touch retain their existing behavior. Table previews also respond over numeric cells. A result refresh invalidates the old selection until another user interaction. Parent drilldown context is unchanged.
- **Consistency:** Gamma tabs, switches, buttons, selects, fields and existing scoped tokens are reused. Label mappings remain backward compatible, and switching mapping type preserves a label draft. Unnamed series use the same fallback name in the chart, tooltip and query.

## Review process

The Paprika widget checklist and Gamma discovery guide were applied, with the existing audit/critique, Impeccable and Frontend Design Premium workflow. The checklist now requires first-time configuration discovery and exact historical/row query evidence, in addition to native-size visual inspection. Component imports and successful clicks alone do not establish design quality.

Static reports are in `artifacts/insights/tooltip-query/impeccable-hosts-static.json` and `premium-hosts-strict.json`. Impeccable reported no findings. Premium reported the same seven previously reviewed test-fixture/CSS-module detector limitations; no new production defect or suppression was introduced. Native review and final test results are recorded below.

## Validation

| Check | Result |
| --- | --- |
| Full UI unit suite | **432 tests across 56 files pass** after the pinned-keyboard fix. |
| Production build / TypeScript | Pass; static preview rebuilt after runtime review. |
| Scoped ESLint / diff whitespace | Pass. |
| Go service race suite | `go test -race ./internal/insights` passes, with strict binding-union validation and persisted round trips for all four hosts. |
| First-time authoring | 3/3 isolated real-service scenarios pass at 1512/390/320px: Add flow, typed mappings, JSON/YAML/OpenUI and stored documents across all four hosts. |
| Complete eight-suite browser runner | **73 scenarios plus 206 widget checks pass**, with four explicit N/A cases; runner exits 0. Includes new point/bar/table hosts, typed mappings and pinned-arrow fix. |
| Final affected browser suites | After the parent-metadata ordering adjustment and final rebuild, **24/24 queried-tooltip and 13/13 builder scenarios pass**, zero queried-tooltip page errors. Parent-first DOM order is asserted for all seven heatmap child types and table/bar hosts on desktop/mobile. |

Independent native review confirms the five tabs fit at 320px (smallest 46.47 × 44px), the 44px phone fields and menu rows remain contained, the switch thumb stays inside its track, and the first-time Add action is visible. No editor visual change was needed after these captures.

Review found and fixed stale selection reopening after refresh, mismatched fallback names for unnamed series, and pinned keyboard focus moving ahead of its tooltip query. Regression tests cover these cases, exact fractional timestamps, negative/zero observations and duplicate-time observations.

Native root review then identified a parent/child hierarchy issue: table and existing heatmap sub-widgets interrupted the parent labels/timestamp. Both hosts now keep complete parent context above the child, matching time series and bars; unit and browser order assertions guard that association. Independent final native captures at 1512/390px confirm the corrected order, contained popups and reachable child content; 320px authoring and scroll checks also pass. The final production build and TypeScript pass. The first six browser suites never configure `tooltipView`, so the final presentation-only adjustment was rechecked through the two affected suites instead of repeating unchanged coverage.

The initial expanded browser run stopped because an unscoped test locator matched both the truthful parent no-data message and the child error. The test now targets the child alert while retaining no-query assertions. `hosts-initial-failure-report.json` preserves that initial evidence; this was a harness ambiguity, not a hidden product failure. A subsequent geometry assertion sampled the popup before its ResizeObserver placement settled; the failure capture already showed the correct final placement. The harness now waits for consecutive settled frames while retaining the same exact bounds and trigger assertions. Initial reports and correction evidence are preserved in `hosts-harness-corrections.json`.

This work is local. Deterministic Prometheus/Tempo fixtures exercise the real Go service path; mobile coverage uses Chromium touch emulation and does not establish physical-device or production-load performance.


## Evidence and scope

- `artifacts/insights/tooltip-query/hosts-full-eight-run.json` records the successful combined runner and its build boundary; `hosts-full-eight-tooltip-report.json` preserves its queried-tooltip results.
- `artifacts/insights/tooltip-query/report.json` and `hosts-final-hierarchy-report.json` contain the final 24-scenario real-service report and 76 native captures. The final builder results are in `artifacts/insights/builder/final-report.json`.
- `artifacts/insights/tooltip-query/host-authoring-review.json` records independent native-size review, Gamma discovery, control measurements and the resolved hierarchy finding.
- No lint/design suppressions were added. The seven Premium detector limitations remain explicitly triaged, not accepted production defects. No known production finding remains from this scoped review.

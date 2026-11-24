# Saved-query tooltip and Single value review

Scope: the Tooltips authoring path, saved-query library selection and optional Single value history. This continues the existing Gamma Insights component; it does not redesign the application or change data-source ownership.

## Baseline and findings

An isolated example workspace reproduced the existing path: Edit dashboard → Service health settings → Tooltips → Add tooltip widget → Saved query → Single value. A query created in Explore could be selected, applied, saved and reloaded; its persisted `source.ref.id` remained intact and the tooltip rendered its result. This established a discoverability problem, not a reproduced failure of saved references. The original user tab was not changed.

| Finding | Resolution and verification |
| --- | --- |
| The saved library was hidden behind Add and a generic source selector. | A direct **Use saved query** action opens saved mode. The visible selector label is **Data for this tooltip**. **Show tooltips** must be enabled first; a previously disabled setting remains deliberate. |
| An empty library offered no action to create the missing query. | **Create saved query** opens Explore, then returning to Dashboards resumes the same widget draft. Existing entries use **Manage saved queries**. ID search complements names. |
| Loading/error states could be mistaken for an empty compatible library. | Distinct messages and explicit Refresh. Local refresh errors clear when opening Explore or receiving a newer successful library snapshot, including when returning via sidebar navigation. |
| Reselecting the same saved query could discard parameter bindings. | Same-ID selection retains the existing reference/bindings. A different query starts with its own parameter requirements. |
| Single value had no optional trend. | `showSparkline` is opt-in for main and tooltip stat views; it reuses the same series' history without an additional request. Plain values remain the default. |
| The first compact trend layout split `1,234.5678ms` across lines. | The real-service browser assertion reproduced this on build `TJPFacHucY_Aa8LDSrrQd`: a 142.78px value column at 32.34px type produced two numeric lines beside a 119.11px plot. Baseline retained in `artifacts/insights/explorer/sparkline-number-wrap-report.json`. Build `qDGcsaVsRR0N-1LTr-vqA` gives the value its natural width and lets the trend move below when needed. Native 1512px, 390px and 320px captures and one-line/no-overlap geometry checks confirm the correction in the 120px view. |

## Coordinated review

Paprika's widget skill, local frontend-design, Premium and the established Impeccable **Operate** context guide this scoped review. The Impeccable context loader had already run in this session; the finished-source detector was rerun. The coordinator retrieved current Gamma switch/search-combobox briefs and checklist; the existing Gamma select, button and switch adapters remain canonical. No new control or token owner was introduced. Design-taste's dashboard/dense-data scope exclusion applies; no landing-page direction was imported.

- **Impeccable:** zero mechanical findings in `tooltip-saved-impeccable.json`.
- **Premium strict:** seven existing detections, all reviewed, with no suppression. The actionless-button detections are intentional outside-focus targets in `gamma/select.test.tsx:124` and `use-builder-panel-focus.test.tsx:38`, `:39`, `:50`. The two form detections refer to the isolated Gamma select FormData fixture, not an application-owned submission form. The textarea detection cannot follow the shared CSS module: `GammaTextarea` applies `styles.textarea`, whose canonical `.input.textarea.textarea` rule has `resize: none`, adequate minimum sizing and content sizing. No production action is required for these detections.
- **Source review:** optional defaults preserve existing documents; stat history and value use the same selected series; null gaps and bounded points are retained; shared query scheduling remains the host's responsibility. Single-value history is not a derived comparison and has no nested interaction.
- **Native review — pass:** final 1512px/390px/320px saved-query setup, ID-search menus and compact tooltip captures show readable field groups, a direct first-time action and contained Gamma menus. The long number stays on one line; at 320px its trend moves below while remaining within the compact view. Saved-query stat children on time series, bars and table rows also preserve the complete parent observation block before the child at desktop and phone sizes. Refreshed unobstructed main-stat and fully scrolled child captures show the complete value, unit, caption and null-gapped trend. No unresolved visual finding remains in this scope.

## Final verification

The final build is **`qDGcsaVsRR0N-1LTr-vqA`**. The Explorer suite passed **16/16 real-service scenarios**, with zero page errors; `sparkline-final-sixteen-report.json` preserves that full result. A separate **4/4** capture confirmation refreshed unobstructed/scrolled screenshots without production changes (`sparkline-final-captures-report.json`). The coordinator also completed 640 UI tests in 67 files, lint, typecheck, production build, 24 tooltip service scenarios and the focused Go race checks; aggregate scope is recorded in [validation](validation.md).

At 320px, the compact stat's content area measures 260 × 120px; scroll height remains 120px. `1,234.5678ms` has one numeric text rectangle at 28.6px type, with the trend below it and no overlap. At 390px the Show sparkline label target is 44px high. The service tests retain negative and zero samples, a null gap and a missing latest observation, verify no extra requests for main/reused-result sparklines, and preserve enabled/disabled settings through persistence.

Inspected native evidence under `artifacts/insights/explorer/`:

- `sparkline-direct-shortcut-390.png`, `sparkline-first-saved-query-1512.png`, `sparkline-tooltip-control-390.png`.
- `sparkline-saved-query-id-menu-{1512,390,320}.png`.
- `sparkline-saved-tooltip-{1512,390,320}.png` and `sparkline-saved-{timeseries,bar,table}-{1512,390}.png`.
- `sparkline-main-stat-390.png` and `sparkline-reused-tooltip-390.png`.

## Evidence and limits

Baseline reproduction: `output/playwright/tooltip-saved-baseline-editor.png` and `tooltip-saved-baseline-runtime.png`. These use an isolated example workspace and establish only selection/persistence/discoverability behavior. The current real-service verification is in `ui/e2e/insights-explorer.e2e.mjs`, with actual Go persistence and deterministic Prometheus/Tempo providers. Final screenshots and measurements belong in `artifacts/insights/explorer/`.

The review covers first-time setup, Create/return, saved ID search, Apply/save/reload, binding retention, library loading/error/refresh, and stat history without another request. Native acceptance includes a 120px tooltip with `1,234.5678ms` at 320px, one readable numeric line, separate unit/trend and viewport containment; renderer tests additionally cover constant and singleton histories. Chromium mobile emulation is not physical-device validation or a performance benchmark.

See [tooltip authoring](tooltip-widgets.md) for the actual workflow and [validation](validation.md) for coordinated repository test/build results.

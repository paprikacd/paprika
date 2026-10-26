# Insights widget behavior contract

Scope: the Insights microfrontend and its widget authoring workflow. This records existing ownership and the user's clean-canvas/Gamma requirements; it does not change main-app behavior or backend permissions.

## Canonical UI Map

Paths are relative to `ui/src/features/insights/` unless stated otherwise.

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| Table Selection | `chart-renderers.tsx` with `widget-context.ts` | Normalized result and selected observation | One metric row or trace for drilldown; no bulk selection | Chart/context unit tests and widget audit E2E |
| Select/Listbox | `gamma/select.tsx`, `gamma/search-combobox.tsx` | Gamma adapters and scoped theme | Single value, searchable value, query autocomplete | Gamma tests, popup keyboard/mobile E2E |
| Date | `time-range.tsx` and `schema.ts` | ISO fixed bounds; Unix seconds on requests | Authored relative-range select; platform-native datetime inputs with explicit local timezone | Workspace tools and live range E2E |
| Form | Gamma fields plus owning schema validation | `schema.ts`, plugin `parseConfig` | Live widget preview; document review/apply; provider form | Editor/schema tests and failure-path E2E |
| Scrollbar | `gamma/gamma-theme.module.css` | Scoped semantic scrollbar tokens | Internal table/legend geometry; no hidden scrollbars | Browser computed-style and narrow widget checks |
| Toast | Owning panel status/error region | Persistent inline feedback in `insights-app.tsx` and feature panels | `role=status` success/pending; `role=alert` actionable errors | Application and live E2E tests |
| CRUD | `insights-app.tsx`, `history.ts`, `client.ts` | Go service conditional writes and validated dashboard document | Widget edits in dashboard draft; explicit save; example-local persistence | Authoring, advanced, live and drilldown E2E |
| Tooltip sub-widget | `tooltip-editor.tsx`, `tooltip-query.tsx`, `tooltip-widgets.tsx`; mounted by `chart-renderers.tsx` | `options.tooltipView`, exact hovered point/row context and normalized results | Details-only default; current-series or host-queried builtin/trusted-plugin view | Tooltip contract/runtime/editor tests and desktop/mobile real-service E2E |

## Observable behavior

- The canvas shows title, telemetry and meaningful actions. Data-source selection, endpoint and query configuration live in the editor. A connection failure may identify the configuration that needs correction.
- Valid widget adjustments immediately update the unsaved dashboard, including guided query changes. Query edits coalesce for 350 ms and cancel obsolete requests; presentation changes do not fetch again. Save dashboard is the persistence boundary. Invalid input retains the last valid preview and blocks Save while the editor is open. Undo/redo operate on dashboard documents. Responsive projection and drilldown view parameters are not document edits.
- Keep existing pending, empty, missing-plugin, query failure, null and truncated-result states distinguishable. A renderer failure is isolated to its widget. Do not silently reuse results for a different query.
- Every exposed style control affects its selected renderer. Plugin configuration is validated by that registered plugin, inside the shared bounded JSON envelope. Imported documents cannot execute code.
- Table and trace selection is a single observation used for navigation. Full identifiers and values remain accessible despite compact presentation. Tables use bounded internal scrolling, not an unbounded page or invented pagination.
- Tooltips need keyboard and touch access, dismissal, viewport collision handling and a path to long content. Selection has visible state and a named action.
- Tooltip views use the hovered signal by default. An explicit query source selects a compatible provider and maps variables to explicit labels, series name, exact value or timestamp. Historical time-series points retain their own value/time; bar and table context matches the represented latest-valid sample, and heatmaps retain missing latest samples. The Tooltips tab exposes Add/Remove and mappings without requiring a hidden Style dropdown. The host resolves complete quoted string or numeric literals once, shares the dashboard scheduler and range, cancels on dismissal/switch, and masks stale responses. Missing labels or unavailable providers produce a local error without a request. Embedded renderers have bounded readonly data and no nested tooltips, inspectors or drilldown actions. The persisted type allowlist and trusted registries remain separate contracts; documents never load executable code.
- Query/provider selection uses the maintained Gamma controls. Platform date/time popups are currently an explicit native variant; the surrounding fields and range validation belong to Insights. This is not a claim of an authored calendar or cross-platform popup visual parity.
- Carried time ranges and variables identify a view in the URL. Save preserves destination defaults. Query variables are encoded by the interpolation helper; never concatenate raw values into query syntax.
- The service enforces write conflicts; the UI retains the user's draft on failure. Dashboard/import navigation must not discard intervening edits or create duplicate identities after ambiguous saves.

## Evidence and policy sources

| Area | Source |
| --- | --- |
| User intent and design | Current widget review request; prior Gamma/clean-canvas requirements; root `DESIGN.md`; `.impeccable.md` for main-app audience |
| Data validation and lifecycle | `schema.ts`, `internal/insights/`, conditional writes in `client.ts` |
| Provider access and permissions | `internal/api/insights_proxy.go`, `internal/api/auth/`, service provider configuration |
| Navigation/transfer | `drilldown.ts`, `workspace-transfer.ts`, `docs/design/insights/drilldowns.md` |
| Production limits | `docs/design/insights/README.md` and the widget review report; no alert/log/remote-plugin/Grafana-parity claim |

English is currently the authored language. Numeric and timestamp formatting follows the renderer's explicit formatters, with the local timezone shown for custom time input. No additional locale or production browser-support promise is made by this local Chromium review. The scope contains no billing or legal-copy change.

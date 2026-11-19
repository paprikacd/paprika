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
| Recorded chart events | `chart-events.tsx` | Already loaded, bounded events and dashboard timezone | Native disclosure in the footer; scrollable details do not resize the plot; Escape restores summary focus | Event component tests and `insights-chart-footer-live.e2e.mjs` |
| Geographic plane | `geographic-plot.tsx` and Gamma map tokens | Supplied WGS84 coordinates and shared 2:1 projection | Connection markers and geographic hex bins; full-map fitting at all widths | `insights-chart-system.e2e.mjs`, geographic interaction suites |
| Chart table anatomy | `chart-table.tsx` | Shared type, padding, headings, separators and focus | Metric, trace, record and matrix tables; renderer owns sorting/selection | Table unit tests and chart-system browser checks |
| Density colour | `density-palette.ts` and Gamma density tokens | Ordered magnitude scale, separate from categorical/status colour | Distribution, hex map and record honeycomb; canonical missing hatch | Theme contrast tests and chart-system screenshots |
| Chart mark control | `GammaButton` with `size="mark"`, via `ObservationDetails` | Plotted geometry and accessible observation label | Hexes and map markers; ordinary actions keep touch minimums | Mobile chart-system bounds and pin/dismiss checks |
| Hex interaction contour | `plugins/geo-heatmap.tsx`, its scoped styles and Gamma mark buttons | One set of six vertices for fill, border and paint clipping; transparent button states | Hover, pin and keyboard focus preserve data colour; non-scaling strokes stay inside the selected hex and cannot paint on neighbours | `insights-geo-heatmap.e2e.mjs`, `insights-hex-contour.e2e.mjs` pixel containment at 1×/2×, dense chart-system and drag performance checks |
| Compact reading height | `WidgetDefinition.sizing` → `responsive-layout.ts` | Trusted renderer metadata | Compact/narrow projections only; saved geometry and wide editing preserved | Layout projection unit tests and view/edit browser matrix |
| Editing performance | `canvas.tsx`, `gamma/inherit-theme.ts`, pinned grid selection patch | Warmed results, stable editing DOM order, native handle selection, one gesture surface | Drag/resize preserve focus and avoid page-wide style or subtree reattachment work; reduced motion creates no transitions | `insights-edit-performance.e2e.mjs` (12 panels, 500-record maps, 128,000 raw metric samples, resize/save/reload) |
| Observation panel anatomy | `tooltip-content.tsx`, `chart-styles.module.css`, `observation-tooltip.tsx` | One 14px gutter, title/reading/fact hierarchy, bounded history and metadata | Long identifiers wrap, actions align, pinned mobile panels minimize/dismiss; hidden labels never create overflow | `insights-tooltip-structure.e2e.mjs` (six families, light/dark, 1512/768/390px) |
| Observation owner | `observation-owner.ts` over `tooltip-dismiss.ts` | Which observation's panel is open, its pin, and the hover and focus engagement | One bounded 180 ms grace from the last engagement to the hide; engagement belongs to an element (a pointer leave ends only the hover, a blur only the focus); the panel holds while the pointer is in it; a hover never replaces a pin, and selecting the pinned observation again releases it; touch previews are suppressed and a tap pins; retention is by stable key (an open panel follows its key and closes when the key leaves) or by result revision; disabling closes any panel; outside, blur and Escape dismissal go through `attachTooltipDismissal` | Adopted by the status grid, small multiples, the heatmap, the pie, the uptime views, the record cell matrix, the record treemap, the record charts, the status history, the stat sparkline and the observation details trigger. The plot tooltip and rich metrics stay on `useTooltipDismiss`. A lint rule keeps `setTimeout` out of plugin hosts and `*-renderers.tsx` |
| Tooltip motion and map selection | `observation-tooltip.tsx`, `tooltip-pointer.ts`, `tooltip-position.ts`, map mark styles | Pointer capture before entry, a fixed pointer-facing corner, available-space placement | The first visible frame is beside the pointer; loading and pinning preserve its corner; a pin stops following the mouse but follows its mark on scroll; active map rings remain above neighbouring marks | `insights-tooltip-motion.e2e.mjs` records loading, loaded and hover-to-pin frames in map/grid views, light/dark, ordinary/tall viewports; tests pointer departure, keyboard scrolling and pinned map contours |
| Tabs | `gamma/tabs.tsx` | Shared single-row tab strip | Native horizontal scrolling with edge fades; arrow/Home/End navigation reveals the selected tab; canonical underline variant for focused workspaces | Gamma tests and local polish browser checks |
| Toast | Owning panel status/error region | Persistent inline feedback in `insights-app.tsx` and feature panels | `role=status` success/pending; `role=alert` actionable errors | Application and live E2E tests |
| CRUD | `insights-app.tsx`, `history.ts`, `client.ts` | Go service conditional writes and validated dashboard document | Focused widget draft with Apply/Discard; explicit dashboard save; example-local persistence | Authoring, advanced, live and drilldown E2E |
| Tooltip sub-widget | `tooltip-editor.tsx`, `tooltip-query.tsx`, `tooltip-widgets.tsx`; mounted by `chart-renderers.tsx` | `options.tooltipView`, exact hovered point/row context and normalized results | Details-only default; current-series or host-queried builtin/trusted-plugin view | Tooltip contract/runtime/editor tests and desktop/mobile real-service E2E |
| Query diagnostics | `query.ts`, `query-diagnostics.ts`, `query-inspector.tsx` | Canonical scheduler and optional service execution receipt | Passive, bounded session timeline; selected phase ledger and redacted resolved-query shape | Scheduler/client/inspector tests and query-inspector desktop/mobile E2E |

## Observable behavior

- The canvas shows title, telemetry and meaningful actions. Data-source selection, endpoint and query configuration live in the editor. A connection failure may identify the configuration that needs correction.
- Opening a widget enters a focused workbench: one canonical canvas tile, query/source workspace and chart settings, with the app navigation and other tiles removed. Valid adjustments update a staged preview. Apply commits one dashboard history entry and returns; Discard drops the staged settings and placement. Back/Escape guard unapplied work, nested menus/inspectors own their first Escape, and closing restores the chart edit button. Query creation may temporarily open Explore without unmounting the chart draft. Query edits coalesce for 350 ms and cancel obsolete requests; presentation changes reuse retained data. The selected chart stays engaged while the author scrolls to its query, and suspends when leaving for Explore. Mobile section navigation reveals Preview, Settings or Query below the persistent action bar. Invalid input retains the last valid preview and disables Apply. Local undo/redo includes settings and layout moves. Save dashboard remains the durable persistence boundary. Responsive projection, the toolbar time range and refresh, variable values, selections, brushes and drilldown view parameters are not document edits: none of them sets the dashboard dirty or enters edit mode. In edit mode, **Set as dashboard default** copies the current view's time range and refresh into the document; it is the only view control that writes the document. `insights-editor-focus.e2e.mjs` covers the focused workflow in both themes at 1512, 768 and 390px with metric, map, honeycomb and table previews.
- Keep existing pending, empty, missing-plugin, query failure, null and truncated-result states distinguishable. A row-capped result (`truncation.reason` `row_limit`) shows the first N by design and is a neutral fact, not a warning. Amber is reserved for partial or warned provider responses, errors, stale data and breaches. A renderer failure is isolated to its widget. Do not silently reuse results for a different query.
- Query inspection never starts or replays a request. Queue and browser-request intervals share the browser monotonic clock; service phases use their own clock and are nested within that request. Unavailable provider timing stays unknown. Shared consumers are attributed to one execution; cache deliveries link to the original execution and claim no new network work. Receipts remain bounded in session memory and are not saved with dashboards. Requested bounds remain distinct from dispatched bounds, and result counts describe returned observations rather than provider cost. See [query execution receipts](query-diagnostics.md).
- Hatched fill means no observation, warning hatch means invalid source data, and a flat empty fill means an observed zero; plot hatching comes from `plot-hatch.tsx`.
- Every exposed style control affects its selected renderer. Plugin configuration is validated by that registered plugin, inside the shared bounded JSON envelope. Imported documents cannot execute code.
- Table and trace selection is a single observation used for navigation. Full identifiers and values remain accessible despite compact presentation. Tables use bounded internal scrolling, not an unbounded page or invented pagination.
- Tooltips need keyboard and touch access, dismissal, viewport collision handling and a path to long content. Selection has visible state and a named action.
- Stat comparisons. A stat may declare `options.compare` (window `previous`, `1d` or `7d`, and optional `good` `up`/`down`). Its chip shows the change from the latest valid sample of the same series in that earlier window, labelled `vs 1 h earlier` (or `vs 1 d earlier` / `vs 7 d earlier`). The headline is the relative change (pp for percentage units, absolute when the earlier value is zero). The change is neutral ink with a word, `better`, `worse` or `unchanged`, only when `good` is set; it never takes a status colour and never raises an attention state. Unavailable, failed, not-run and partial states say so in words, and not-run is never read as no change. The number follows the widget's decimals, and float noise in Auto reads as `≈0` with no arrow. The chip's spoken text carries the whole change and window; the visible glyph and value are hidden from assistive tech. A narrow card keeps the value and collapses the label; below the narrowest card width the chip is hidden. A change that does not fit its card is not drawn, and its words move to the reading's title. While a stat reloads (a refresh or a new range), its last change stays with the reading still on screen; the loading slot shows only between a settled reading and its earlier window. Embedded stats and off-screen tiles fetch no earlier window; a comparison is not a status and the value is never clipped.
- Tooltip views use the hovered signal by default. An explicit query source selects a compatible provider and maps variables to explicit labels, series name, exact value or timestamp. Historical time-series points retain their own value/time; bar and table context matches the represented latest-valid sample, and heatmaps retain missing latest samples. The Tooltips tab exposes Add/Remove and mappings without requiring a hidden Style dropdown. The host resolves complete quoted string or numeric literals once, shares the dashboard scheduler and range, cancels on dismissal/switch, and masks stale responses. Missing labels or unavailable providers produce a local error without a request. Embedded renderers have bounded readonly data and no nested tooltips, inspectors or drilldown actions. The persisted type allowlist and trusted registries remain separate contracts; documents never load executable code.
- Query/provider selection uses the maintained Gamma controls. Platform date/time popups are currently an explicit native variant; the surrounding fields and range validation belong to Insights. This is not a claim of an authored calendar or cross-platform popup visual parity.
- The URL identifies the view: variables, a relative preset (`range`) or fixed window (`from`/`to`), and auto refresh (`refresh`). Save preserves the saved defaults. A fixed window pauses auto refresh; relative windows keep refreshing. Link variables the dashboard no longer declares, malformed link variables, and malformed range or refresh values are dropped with a dismissible notice that opens the linked dashboard, and the address is corrected without adding a history step. Structural link errors stay visible as errors. Query variables are encoded by the interpolation helper; never concatenate raw values into query syntax.
- The service enforces write conflicts; the UI retains the user's draft on failure. Dashboard/import navigation must not discard intervening edits or create duplicate identities after ambiguous saves.

## Review contracts for status, breach and attention

These contracts record the Next-phase review decisions. Each one names the code that owns it.

- **Status second cue.** Every status mark carries a glyph and a word (`status-chip.tsx`). Warning and critical status cells draw an inset frame of 1px and 2px. A cell too small for its frame keeps its whole fill: a warning frame needs at least 6px and a critical frame 8px. The chip and accessible name carry the level then.
- **Hatching.** Hatching marks missing data. Invalid source data uses a second, warning-toned hatch, as in the observable behaviour above. Status colour never uses hatching, and a hex-only band has no level.
- **Breach shading.** A time series shades a stretch only where an author-set `warning` or `critical` status band applies (`breaches.ts`). A colour-only threshold never shades or counts as a breach, and no separate shade option exists. A breaching series draws a heavier line over the breach span, and a reference line marks an objective without shading it.
- **Attention strip counting.** Counts come from author-declared statuses, failed queries and stale data, with each widget counted once under its most severe reason (`widget-attention.ts`, `attention-strip.tsx`). A tile with no loaded result is "not loaded" and counts as unchecked, never as failed or empty. A chip scrolls to its tile and outlines it briefly. The strip reports declared statuses and never infers health.
- **View controls never edit the document.** Range, refresh, variables, selections, brushes and drilldown parameters live in the URL (`dashboard-view.ts`). They never mark the dashboard dirty or enter edit mode. In edit mode, only **Set as dashboard default** writes the document.

## Evidence and policy sources

| Area | Source |
| --- | --- |
| User intent and design | Current widget review request; prior Gamma/clean-canvas requirements; root `DESIGN.md`; `.impeccable.md` for main-app audience |
| Data validation and lifecycle | `schema.ts`, `internal/insights/`, conditional writes in `client.ts` |
| Provider access and permissions | `internal/api/insights_proxy.go`, `internal/api/auth/`, service provider configuration |
| Navigation/transfer | `drilldown.ts`, `workspace-transfer.ts`, `docs/design/insights/drilldowns.md` |
| Production limits | `docs/design/insights/README.md` and the widget review report; no alert/log/remote-plugin/Grafana-parity claim |

English is currently the authored language. Numeric and timestamp formatting follows the renderer's explicit formatters, with the local timezone shown for custom time input. No additional locale or production browser-support promise is made by this local Chromium review. The scope contains no billing or legal-copy change.

## Number display

- Every number a widget shows honours its decimal places: `options.decimals` (0 to 8, or unset for Auto), set in the
  editor's Style section as "Decimal places". Each numeric widget type exposes that control.
- Auto (unset) shows the reading precision: three significant figures, with unit scaling (`812 ms`, `1.07K req/s`).
  Auto never prints floating-point noise such as `5.878749999999975`.
- With `decimals` set, the unit is still chosen first, as in Auto, and the decimal places then apply to the scaled number:
  `296303060975000` bytes reads `269.49 TiB` at two places, not `296,303,060,975,000.00 bytes`. A record table, treemap,
  list or record chart cell with a scalable unit scales each value on its own, so the cell reads in the unit step its value
  reads in (`269.49 TiB` beside `1.00 KiB`, not `296,303,060,975,000 bytes` or `0.000 TiB`). A bar cell's scale bounds and a
  matrix legend share one scale for their bounds.
- Whole numbers are never padded. A whole number with no unit is a count or an id: it reads as an integer at any setting,
  and a count is grouped (`18,432`) in stats, bounds, legends, matrix labels, record cells and record charts. A measure with a
  unit keeps the widget's decimals (`78.000%`, `84.000 ms`). Non-integers follow the widget's decimals.
- Identifier columns are shown as stored. A column with no unit whose last word is `id` (`order_id`, `orderId`, `Order ID`),
  `year` or `day` (a whole word, not `days` or `start_date`) drops digit grouping and padding (`10021`). A column with a unit is
  never an identifier: `retention_day` in ms reads `86,400 s` at zero places. A word before the last does not count, so
  `cost_per_year` is a money column. Matrix labels use the shortest form of the same number, so `0.1 + 0.2` labels as `0.3`.
- A set of values that compares (gauge scale, small-multiple extremes, a bar's scale bounds, a matrix legend) takes one unit,
  chosen from its largest value, and the decimals then apply to each scaled value: `1.03 s` and `0.64 s`, not `1.03 s` beside
  `640.00 ms`. A record cell is the exception: it scales on its own (see above).
- Axis ticks take their tick step's precision, not the widget's decimals: a `0`–`500` axis reads `0 250 500` at any
  setting, and a 0.25 step reads `0.25`. An authored decimal count is the smallest tick step, so ticks never collide. Readings,
  tooltips, cells and legends follow the decimals setting.
- Exact values appear only where the UI says "exact": Source details, the observation and point tables, and the
  "Exact" labels, and a record cell's "Recorded value". They keep up to 12 significant digits and group digits (`296,303,060,975,000`). Integers that are safe
  to represent keep every digit.
- Bucket and threshold bounds keep their own value. A bound whose exact form has at most five places shows it when the
  authored places would not (`0.5 s` at 0 decimals reads `0.5 s`, not `1 s`; `1.2 s` reads `1.2 s`). Otherwise the authored
  places apply (`272.84841053 TiB` reads `273` at 0 decimals), and a bound takes up to five places only when rounding would
  make it read as its neighbour or as zero. Auto puts every bound of one axis on a single shared scale, so neighbouring rows
  never mix `100 ms` with `1 s`.
- Latitude and longitude are coordinates, not metrics, and keep fixed precision.
- Agent text (MCP synopses) follows the same rule. A value with a scalable unit takes one step from its own magnitude, then
  the decimals: `296303060975000` bytes reads `269.486 TiB` at three places and `269 TiB` in Auto, never 15 raw digits. Auto
  keeps three significant figures for a value with a unit, and six for a unit-less value. A unit-less whole number stays
  whole and ungrouped (`84`, not `84.000`) at any setting, and each record cell scales on its own, as in the UI. Structured content keeps
  the exact number.

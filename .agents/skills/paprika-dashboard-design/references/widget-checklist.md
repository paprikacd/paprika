# Widget quality checklist

Use the rows that a change touches. Record each as **pass**, **fail**, **unverified** or **not applicable with
reason**, with the test, screenshot or observation behind it. Not applicable means the capability does not
exist for that widget (a stat has no axes); it never stands in for an untested control.

The behaviour these rows check is specified in
[UX-CONTRACT.md](../../../../docs/design/insights/UX-CONTRACT.md), [tooltip widgets](../../../../docs/design/insights/tooltip-widgets.md),
[drilldowns](../../../../docs/design/insights/drilldowns.md), [the explorer](../../../../docs/design/insights/explorer.md)
and [portable bundles](../../../../docs/design/insights/portable-bundles.md). This file lists what to check, not the rules.

## Product boundaries

- No connection metadata on the widget canvas: no provider or source names, IDs, endpoints, query text or
  connection badges in headers, footers or tooltips. An actionable connection error may name what to fix.
- Reuse the Gamma adapters (`ui/src/features/insights/gamma/README.md`). For a missing control, follow
  [Gamma discovery](../../../../docs/design/insights/gamma-discovery.md); do not call a look-alike "Gamma".
- Renderers consume normalized `QueryResult` data. The host owns provider access, scheduling and persistence.
  Extensions register through `registerWidgetPlugin` with a stable ID, a data kind and `parseConfig`. A
  document may name a registered plugin; it never contains or loads code.
- `schema.ts` is the contract. A persisted-contract change needs matching editor and renderer behaviour, Go
  validation, the JSON Schema artifacts and JSON/YAML/OpenUI round trips. Plugin-specific keys stay inside
  the `config` envelope and are validated by that plugin's `parseConfig`.
- Responsive placement is a projection of the saved layout. View-only drilldown variables and carried time
  ranges never become saved defaults.

## Shared checks

| Check | Evidence to seek |
| --- | --- |
| Intent and query | The title names the signal; a real query and a compatible provider supply it. Sample data stays labelled. |
| Value semantics | Aggregation and latest-sample behaviour are explicit. Zero, negative, null and non-finite values are preserved. `unit` is a suffix, never a conversion. Requests use Unix seconds; results use milliseconds. |
| Numbers | Every displayed number honours `decimals`; Auto never prints float noise ([Number display](../../../../docs/design/insights/UX-CONTRACT.md#number-display)). |
| Clean canvas | Data and meaningful actions dominate. Titles and descriptions fit compact cards. |
| Styling | Scoped Gamma controls and tokens; status colours from the status tokens, series colours from the palette and roles. Colour is never the only cue. |
| Honest states | Loading, empty, failure, missing plugin, null observation and truncation are distinct. Old results never show for a changed query. One renderer failure stays in its widget. |
| Accessibility | Named marks, cells and rows; labelled fields; visible focus; keyboard actions; focus return. Tooltips open on focus and touch, Escape dismisses, long details stay reachable. Reduced motion is honoured. |
| Responsive | Real canvas widths with the sidebar and inspector open: 1512, 1024, 768 and 390 px, light and dark, and narrow tiles (w=2 to 4 at 1512). No page overflow, no wrapped fixed rows, no clipped values. Saved positions survive resizing. |
| Performance | Bounded series, points and rows with spikes and gaps kept when sampling. Shared scheduler, cancellation and offscreen deferral. Layout, title and style edits do not refetch. |
| Controls and state | Each exposed option changes the output and round-trips. Defaults preserve old documents. Typing a variable does not issue a query per keystroke. |

## Built-in widgets

| Widget | Specific checks |
| --- | --- |
| Time series | Line/area, interpolation, legend, grid, tooltips and axis labels where exposed. Domains handle zero, negative, constant and outlier series. Null samples stay gaps. Tooltip values are exact where labelled exact; ticks take their step's precision. A pinned point's links use that point's own sample. |
| Bar | Categories keep their values, colours and selection. Long names stay understandable; negative and zero bars have a true baseline. A latest observation is not presented as a time aggregation. |
| Stat | The intended latest or aggregate value and unit, including zero, at the smallest card. `showSparkline` (default off) draws the same series as the value. A change (`options.compare`) comes from a declared window, never sample math. |
| Table | Values and labels stay aligned; full content is inspectable; scrolling stays inside the card; a row cap is a neutral fact. Row selection has visible, keyboard-reachable state and passes that row's context. |
| Traces | Trace ID, service, operation, duration, status and time come from the source. Empty and failed searches differ. A list never implies a waterfall. |
| Status heatmap | One tile per series from its latest sample, not a time histogram. A missing latest sample shows no data. Test values below, on and above thresholds; labels and values hide independently. Tooltip shows exact value, status range, labels and sample time, stays in the viewport, and pins, dismisses and scrolls by keyboard and touch. |

## Plugins

The built-in plugin IDs are listed in [widget-plugins.json](../../../../docs/design/insights/widget-plugins.json)
(generated from the registry by `widget-plugin-list.test.ts`). Apply the shared rows and this one to each,
plus the plugin's own contract where it has one ([Kubernetes widgets](../../../../docs/design/insights/kubernetes-widgets.md),
SLO cards in UX-CONTRACT.md).

| Check | Evidence to seek |
| --- | --- |
| Registration | Library, editor and AI context update without duplicate IDs. `dataKind`, `parseConfig`, the 16 KiB and eight-level config bounds, and missing-plugin isolation hold. |
| Context | A selectable plugin emits `onContextChange` with a deliberate observation. The host never replaces a derived or null value with a raw series; refresh or a config change invalidates it. Exercise the real host-to-drilldown path with a derived value and a missing latest sample. |
| Editor | Only the plugin's supported controls appear; a new plugin does not inherit another widget's switches. Reset returns its registered defaults. |

## Tooltip widgets

Details-only is the default. For a configured tooltip view, check: the historical point's own sample (including
fractional seconds), bars and tables using the represented latest-valid sample, heatmaps keeping a missing
latest sample; literal interpolation once, with quotes, backslashes, newlines and literal `{{text}}` in label
values unable to change query structure; no request while authoring; abort on dismissal or switch; no stale
result; bounded readonly data with no nested tooltips, inspectors or selection. Test the first-time journey:
settings, Tooltips, Add tooltip widget, mapping, removal.

## Authoring and management

| Area | Verify |
| --- | --- |
| Create and edit | Library discovery and provider capability. Query, title, style and layout survive Apply. A stale preview cannot replace a newer one. |
| Integrated controls | Production-rendered buttons, switches, fields, menus and provider forms at native size: padding, icon gaps, switch thumbs, editor height, contrast, focus and phone hit areas. A correct import is not visual evidence. |
| Layout and history | Pointer drag and resize succeed in the wide layout; the tile menu and Layout tab work below it. Undo and redo restore document changes without corrupting view state. |
| Persistence | Save, reload, check the result. Duplicate gets a new identity. Conditional-write conflicts are visible and keep the draft. |
| Documents and AI | JSON and YAML keep every field. Invalid input leaves the document unchanged. OpenUI review produces the same validated document. |
| Library transfer | Provider remapping respects capability; new dashboard IDs rewrite internal drilldown targets; partial retries keep earlier identities. Replace is never a default. |
| Links and variables | Bindings target declared variables only. Unset differs from empty. Values go through the interpolation helpers, never string concatenation. Back/Forward and reload keep the view; saving keeps the destination's defaults. |
| Saved queries | Running is explicit; drafts survive navigation; a missing reference is a local error, never a fallback to a dormant custom query. |

## Where the tests are

The browser suites, their tags and how to run them are in
[the Insights dev loop](../../../../docs/guides/insights-dev-loop.md). Unit tests sit beside their owners under
`ui/src/features/insights/` (for example `charts.test.tsx`, `tooltip-widgets.test.tsx`, `widget-registry.test.tsx`,
`schema-artifacts.test.ts`, `openui.test.ts`). Service changes need the matching `internal/insights` tests.
Deterministic provider fixtures prove the real service path, not compatibility with a given production install.

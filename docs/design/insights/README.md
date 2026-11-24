# Paprika Insights

Insights is an observability dashboard workspace inside Paprika. Its UI lives behind a small `InsightsApp` entry point and `InsightsClient` interface in `ui/src/features/insights`. Provider requests and dashboard persistence run in the separate `paprika-insights` Go component. The route is `/dashboard/insights/`.

The design context is the root [DESIGN.md](../../../DESIGN.md). The October 2026 wireframes that set the first visual direction are kept as evidence in [receipts/prompts.md](./receipts/prompts.md); they contain illustrative data, not implemented behaviour.

## How these docs are organised

This directory holds three kinds of document. Only the first is the current contract.

**Current contract.** Each topic is described once, in the file named here.

| Topic | Document |
| --- | --- |
| Document fields, OpenUI, provider and persistence boundary | This README |
| Machine contracts: [dashboard.schema.json](dashboard.schema.json), [saved-query.schema.json](saved-query.schema.json), [widget-plugins.json](widget-plugins.json) | Generated and drift-checked; embedded by the Go package in [schemas.go](schemas.go), so they must not move |
| Shared Go and TypeScript fixtures | [conformance/](conformance/) |
| UI behaviour owners, status, breach and attention rules, number display, stat comparisons, baseline bands, SLO cards | [UX-CONTRACT.md](UX-CONTRACT.md) |
| Variables (several values, All, sources), click-to-filter and links | [drilldowns.md](drilldowns.md) |
| `query_dashboard`, the variable options endpoint, admission | [dashboard-query.md](dashboard-query.md) |
| Schema discovery, `patch_dashboard` and `widget_edits`, revision history, the shared patch merge | [targeted-authoring.md](targeted-authoring.md) |
| `covers`, the application lookup and embed mode | [coverage.md](coverage.md) |
| Kubernetes widgets | [kubernetes-widgets.md](kubernetes-widgets.md) |
| Tooltip widgets | [tooltip-widgets.md](tooltip-widgets.md) |
| Explore and saved queries | [explorer.md](explorer.md) |
| Portable bundles and import review | [portable-bundles.md](portable-bundles.md) |
| Execution receipts, failure codes, result cache deliveries, gateway limit scope | [query-diagnostics.md](query-diagnostics.md) |
| Rich chart input contracts | [artboard-implementation.md](artboard-implementation.md) |
| Service API, permissions, result cache, lint rules | [internal/insights/README.md](../../../internal/insights/README.md) |
| Design context, status and series vocabulary | [DESIGN.md](../../../DESIGN.md) |
| Status token mirror | [status-tokens.json](status-tokens.json) |

**Guides and plans.**

- [Insights dev loop](../../guides/insights-dev-loop.md): playground, unit tests, lint, browser suites, visual matrix.
- [Local dashboard loop](../../guides/local-dashboard-polish.md), [widget lab](../../guides/widget-lab.md) and [dashboard data coverage](../../guides/dashboard-data-coverage.md).
- [Gamma discovery](gamma-discovery.md), [live Omega acceptance](omega-validation.md) and the [react-grid-layout exit plan](grid-library-exit.md).
- Provenance: [world land outline](world-land-source.md), [gamma-source-catalogue.json](gamma-source-catalogue.json); verification gates: [premium-ui.json](premium-ui.json).
- The review protocol is in the [design skill's validation reference](../../../.agents/skills/paprika-dashboard-design/references/validation.md).

**Dated evidence** lives in [receipts/](receipts/). Each file records what was built or checked on one day. Never cite one as current behaviour.

| Receipt | Date |
| --- | --- |
| [Validation history](receipts/validation-history.md), [builder](receipts/builder-review.md), [Explorer](receipts/explorer-review.md), [import](receipts/import-review.md), [portable bundles](receipts/portable-bundles-review.md), [tooltip host](receipts/tooltip-host-review.md), [tooltip query](receipts/tooltip-query-review.md) and [saved-query tooltip](receipts/tooltip-saved-review.md) reviews | 24 October 2026 |
| [Visual direction wireframes](receipts/prompts.md) | 23 October 2026 |
| [Observability integration](receipts/observability-integration-validation.md), [Observe authoring](receipts/observe-authoring-validation.md), [Observe as a data source](receipts/observe-data-source-validation.md), [service overview](receipts/service-overview-validation.md), [query_dashboard acceptance](receipts/dashboard-query-acceptance-2026-10.md) | 26 and 27 October 2026 |
| [Rich chart verification](receipts/artboard-verification-2026-10-29.md), [reference dashboard acceptance](receipts/reference-dashboard-acceptance.md) | 29 October 2026 |
| [Widget review](receipts/widget-review.md), [five-lens review protocol](receipts/review-loop.md) (superseded) | 29 and 30 October 2026 |
| [Omega control room](receipts/omega-control-room-2026-11-06.md), [local dashboard polish](receipts/local-dashboard-polish-2026-11-07.md), [local polish brief](receipts/local-polish-brief.md) | 6 to 9 November 2026 |

## One document across every authoring mode

The visual canvas, JSON/YAML editor, and OpenUI importer all produce the same versioned dashboard document. `schema.ts` is the frontend's canonical runtime contract. The service independently validates persisted documents. Chart components receive normalized provider results; charts do not execute source text.

Machine-readable authoring artifacts:

- [Dashboard JSON Schema](./dashboard.schema.json), generated from the canonical Zod schema and checked for drift by a unit test.
- [Plugin configuration JSON Schema](./widget-plugin-configs.schema.json), one schema per built-in plugin, checked on save.
- [Contract reference](./contract-reference.md), the generated tables of widget options and plugin configuration. Both schema files and the reference are written by `npm run schema:generate` in `ui/`.
- [Importable YAML example](./example-dashboard.yaml), with Prometheus health and Tempo trace widgets.

JSON Schema captures field types, required properties, ranges, and strict object shapes. Runtime validation additionally checks unique widget IDs, `x + w <= 12`, the UTF-8 document byte limit, and provider capabilities. Give AI assistants both the schema and the documented semantic constraints.

```yaml
schemaVersion: 1
id: production
title: Production overview
description: API availability
timeRange: 1h
refreshInterval: 30
widgets:
  - id: availability
    title: Target availability
    type: timeseries
    providerId: prometheus
    query: up
    unit: ""
    layout:
      x: 0
      y: 0
      w: 6
      h: 4
```

`providerId` must refer to an administrator-configured source. The `prometheus` identifier above is an example; it is not an automatic connection. Metric names and query validity depend on that provider.

| Field | Contract |
| --- | --- |
| `schemaVersion` | Currently `1`; unsupported versions are rejected. |
| `id`, widget `id`, `providerId` | 1–80 ASCII letters, digits, `_` or `-`; start with a letter or digit. |
| `title` | Nonempty, at most 120 characters. |
| `description` | Optional, at most 500 characters. |
| `timeRange` | `15m`, `30m`, `1h`, `6h`, `24h`, `7d` or `30d`. |
| `refreshInterval` | `0`, `15`, `30`, or `60` seconds. `0` disables automatic refresh. |
| `widgets` | At most 48, with unique identifiers. |
| `folder` | Optional slash-separated path up to 160 characters, e.g. `Production/Payments`. |
| `customTimeRange` | Optional `{from,to}` ISO dates with timezones; increasing, at most 31 days; overrides the preset. |
| `timeZone` | Optional IANA zone for the calendar axis, observation inspector and window labels; omitted, the viewer's zone applies. |
| `variables` | Optional, at most 20. See [drilldowns](drilldowns.md). |
| `annotationSource` | Optional recorded events from a saved records query, inherited by every time-based widget without its own. See [recorded chart events](../../guides/insights-chart-events.md). |
| `covers` | Optional `{applications,variables?,summaryWidget?}`: which applications the dashboard is for. See [coverage](coverage.md). |
| widget `type` | `timeseries`, `bar`, `stat`, `table`, `traces`, `heatmap`, or `plugin`. |
| widget `query` | Nonempty query in the provider's native language (PromQL, TraceQL, SQL, or a records operation in JSON), at most 8,192 characters. |
| widget `unit` | Display suffix, at most 24 characters. Values are not converted implicitly. |
| widget `color` | Optional six-digit hex color. |
| widget `options` | Presentation options per widget type. See [the widget option catalogue](#widget-option-catalogue). |
| widget `pluginId`, `dataKind`, `config` | For plugin widgets only: registered ID, `metrics`, `traces` or `records`, and optional JSON settings bounded to 16 KiB and eight nesting levels. |
| widget `layout` | 12 columns; `x` 0–11, `y` 0–1000, `w` 1–12, `h` 1–12 for stat widgets and 2–12 for other widgets, and `x + w <= 12`. |

### Widget option catalogue

This section is a placeholder. The catalogue of widget options will be generated from the schema in a later
change (review item R69) and will replace it; do not hand-write option tables here or elsewhere. Until then,
read the option definitions in [dashboard.schema.json](dashboard.schema.json) (or `get_insights_schema` over
MCP), and the behaviour of each option in [UX-CONTRACT.md](UX-CONTRACT.md).

Source documents are limited to 256 KiB of UTF-8. Unknown properties, duplicate widget IDs, duplicate YAML mapping keys, YAML aliases and merge properties are rejected. YAML is decoded only as data; there is no executable tag loader. JSON/YAML export remains suitable for version control. Importing a plain dashboard document edits the active dashboard while retaining its persistence identity. Portable bundles open a separate import review and create new dashboards with their saved-query dependencies; see [portable bundles](portable-bundles.md).

## OpenUI authoring contract

OpenUI is integrated through `@openuidev/lang-core` 1.0.1. The library defines the available components and generates model instructions from their schemas. Its parser turns model output into a structured tree; Paprika then validates and converts that tree into the canonical dashboard document. This follows OpenUI's component-library-to-prompt workflow without adding a second rendering or persistence model. [OpenUI core documentation](https://github.com/thesysdev/openui/tree/main/packages/lang-core)

Registered component names are `Dashboard`, `TimeSeries`, `BarChart`, `Stat`, `MetricsTable`, `Traces`, `Heatmap`, and `Plugin`:

```text
root = Dashboard("production", "Production overview", "1h", 30, [availability], "API availability")
availability = TimeSeries("availability", "Target availability", "prometheus", "up", "", {"x":0,"y":0,"w":6,"h":4}, null, null)
```

Widget arguments, in order, are `id`, `title`, `providerId`, `query`, `unit`, `layout`, then optional `description`, `color`, `options`, `pluginId`, `dataKind`, and `config`. Dashboard arguments are `id`, `title`, `timeRange`, `refreshInterval`, `widgets`, then optional `description`, `folder`, and `customTimeRange`. Existing shorter definitions remain supported. The AI context includes installed plugin metadata and validates provider capabilities and plugin configuration before applying.

Only complete, static component definitions are accepted. Runtime variables, tool calls, mutations, actions, expressions, unknown components, orphaned statements, and unresolved references are rejected. Paprika does not evaluate model-authored JavaScript, HTML, or arbitrary network requests.

The AI panel provides an explicit handoff:

1. Describe the intended dashboard and copy a prompt containing the current document, actual provider IDs, and registered widget definitions.
2. Paste that prompt into an AI assistant of your choice.
3. Bring back OpenUI, JSON, or YAML; review validation and the added/changed/removed widget summary.
4. Apply it to the draft, inspect the canvas, and save when ready.

The panel also has a collapsed **Use your agent with Paprika Observe** section. It copies
instructions for an agent that reads the dashboard through the Observe MCP endpoint. The agent
replies with one JSON object, `{"id", "widget_edits"}`, and does not save anything. Paste the reply
into the panel as JSON. Insights checks it against the current draft with the same merge the
repair applier uses, lists each changed field per widget, runs the save checks, and applies the
edits to the draft only when no check reports an error. A check that fails or times out does not
block Apply. A pasted whole dashboard still replaces the draft. The source editor shows the same
per-field change list before a replace. The prefilled Claude link is built in one place,
`buildAgentHandoff` in `agent-handoff.ts`, and can be dropped there without touching the rest.

No model is connected by default, and copying a prompt does not send it anywhere. Applying a reviewed definition requires the active dashboard to remain unchanged since review. Provider identifiers and capabilities are checked again at application time. Prompts explicitly instruct assistants not to invent metric names or embedded sample values.

## Technology decisions

**TanStack Charts 1.1.0** provides a typed chart grammar, granular imports, a React adapter, and accessible SVG output. Its stable compatibility contract starts at 1.0. Paprika pins the package and uses its installed API types because the public documentation follows unreleased main. This gives the visualization module a small composition surface that can expand to additional marks without changing dashboard persistence. [TanStack overview](https://tanstack.com/charts/latest/docs/overview), [compatibility policy](https://tanstack.com/charts/latest/docs/compatibility)

**React Grid Layout** supplies drag and resize behavior, container measurement, and compaction. Paprika keeps the layout in the document and commits gesture changes at drag/resize completion. The inspector also exposes sizing and movement controls. [React Grid Layout documentation](https://github.com/react-grid-layout/react-grid-layout)

**OpenUI core**, rather than the prebuilt chat UI, supplies the actual authoring protocol while preserving Paprika's own editor, typography, and rendering. OpenUI's React runtime supports streaming rendering when a connected model experience is needed later. [OpenUI React runtime documentation](https://github.com/thesysdev/openui/tree/main/packages/react-lang)

## Shared Observability MCP providers

Insights and `paprika-observe` use the same `ObservabilityProvider` registry and
credential resolution when the observability gateway is configured. Prometheus
and Tempo appear automatically in the query editor, saved-query selectors and
Data sources panel according to the signed-in user's namespace permissions.
Shared sources link to the existing Observability board for configuration; they
are not copied into Insights provider configuration.

The API proxy delegates the caller's subject and exact groups in a short-lived
Observe token. Insights opens a request-local MCP connection to the configured
gateway's `/observe/mcp`, discovers its read-only tools and invokes
`list_observability_providers`, `query_metrics`, `query_traces` and the metric,
label and trace-service discovery tools. There is no REST data fallback.
Backend Secrets stay in the gateway. Query tools receive the resolved native
expression, absolute range and metrics `step_seconds`; Insights normalizes
native samples into milliseconds and keeps missing samples and partial-result
markers. `list_metric_series` preserves bounded label/cardinality inspection.

Data sources shows **Paprika Observe MCP**, its actual connection status,
supported read tools and discovered providers. **Refresh connection** checks
both discovery and the caller's current provider access. Choose **Explore** on
a provider to open its query editor; the editor explains the tool's
provider, time-range and step bindings. Normal widget canvases stay focused on
data. The connection uses existing Paprika permissions, with no client token
or endpoint form. This is specifically the Paprika Observe integration, not a
general-purpose MCP tool runner.

Saved-query descriptions, tags, typed parameters and dashboard/tooltip bindings
continue to live in Insights. The existing scheduler resolves their templates
once before querying the shared provider; existing MCP authoring tools and the
UI continue to use the same document stores. Dashboards read metrics
(PromQL), traces (TraceQL) and typed records (SQL and application JSON, through
`query_records`); other gateway connector types remain available through MCP and
Observability.

Use `deploymentMode: split` and enable `insights.enabled` and
`observabilityGateway.enabled` in the chart, with
Insights' service token and the existing shared Paprika auth signing secret.
The chart supplies the gateway destination and matching public issuer. The
standalone Insights process accepts `PAPRIKA_OBSERVABILITY_GATEWAY_ADDR`; the
API process also needs that address and `PAPRIKA_MCP_PUBLIC_URL`. See the
[service contract](../../../internal/insights/README.md) for permissions and
identity mapping.

Run `npm run test:e2e:insights:observability` from `ui` after building the UI.
Its isolated Go fixture runs the actual API proxy, storage, authenticated
Observe HTTP and MCP surfaces, Kubernetes provider resolver and connectors
against deterministic telemetry backends. It does not access a live cluster.

## Provider and persistence boundary

Ordinary widget queries use only provider IDs. The Data sources panel lets Insights administrators add, edit, test, and remove managed Prometheus/Tempo connections; endpoint URLs and credential environment references are visible only to administrators. Resolved secrets stay server-side. Provisioned sources remain controlled by operator configuration. Managed configurations persist across service restarts with ETags. See the [service contract](../../../internal/insights/README.md) for RBAC, deployment, limits, and credential environment naming.

The guided query builder discovers metric names, label names, and values, then assembles filters, counter functions, aggregations, and grouping. It previews its expression and changes the raw query only when the author selects **Use generated query**. Full PromQL/TraceQL and **Run query** previews remain available. Metadata discovery is bounded and cached. Query bounds and step use Unix seconds; returned chart timestamps and trace start times use Unix milliseconds.

Dashboards are saved as JSON through the service with ETags. New documents use `If-None-Match: *`; edits and deletes carry the previously read `If-Match` tag. A conflict is shown to the operator instead of silently overwriting another edit. The file-backed store is intended for one Insights service replica with persistent storage.

Example mode is explicitly labeled, uses generated sample data, and stores its saved dashboards only in the current browser. It is useful for exploring authoring without pretending that live providers are configured.

## Dashboard organization and portability

The sidebar renders saved documents as a searchable, collapsible folder tree. Drag a dashboard onto a folder to move it; the **Manage** panel offers the same operation through a folder-path field, including creating nested paths. Folders are derived from dashboard metadata, so they travel with documents; empty folders are not separate records. Manage also provides rename, description, duplication, and conditional deletion.

**Code** edits/imports the active document and preserves its persistence ID. **Manage → Import** accepts a single document or a `PaprikaDashboardLibrary` bundle in JSON/YAML, reviews its contents, remaps provider IDs by capability, and creates new dashboard IDs. Libraries are limited to 4 MiB and 100 documents, with the same 256 KiB limit per dashboard. Multi-document imports use independent conditional creates; successful imports remain saved if another document fails, and only failed documents remain in review for retry. Export downloads saved documents, including folders, styles, plugin settings, and absolute ranges.

Custom dates use the browser's named timezone and serialize as explicit UTC ISO timestamps. Automatic refresh pauses for fixed ranges; manual refresh re-queries the same bounds. Relative presets remove the absolute override.

## Widget extension and Gamma controls

The normal widget canvas shows the signal, its title, and relevant interpretation controls. Provider/source labels are kept in the widget editor, avoiding a repeated source footer on every card. Actionable connection errors still explain what needs fixing.

The searchable widget library reads a typed registry. Built-ins cover time series, bars, statistics, tables, trace search, and a SignalFX-style **status heatmap**: one colored tile per series using its latest sample. The heatmap has configurable ascending thresholds, independent **Show labels** (`options.showLabels`) and **Show values** (`options.showValues`) controls, legend, and keyboard/pointer tooltips; a missing latest sample displays **No data**. It is not a time-bucket histogram. Both visibility options are optional booleans and default to visible when omitted, preserving existing dashboards. Set either or both to `false` for compact tiles; cells retain an accessible name with the series, value, and status. These options survive JSON, YAML, OpenUI, and service persistence.

Heatmap tooltips show the exact underlying value and unit, threshold status and range, complete series labels, and latest sample timestamp. They render outside the tile and fit the space above or below the selected cell. Hover or keyboard focus opens details; click/tap pins them, a second click/tap or Escape dismisses them, and Page Up/Down or Home/End scrolls long details while focus stays on the cell. Balanced columns avoid a mostly empty last row; labeled heatmaps receive more height in narrow layouts. Large query results remain scrollable and capped at 100 cells.

Time-series, bar, metrics-table and heatmap tooltips can embed any built-in visualization or trusted installed widget. Open the widget editor’s **Tooltips** tab and choose **Add tooltip widget**. Use the selected series history, or configure a compatible provider query with explicit mappings from labels, exact value, timestamp or series name. Historical time-series points use their own observation; bars and tables use the represented latest-valid sample, while heatmaps preserve a missing latest value. Queries run only while the tooltip is open, share the dashboard scheduler and time range, and cancel when dismissed or switched. Results stay bounded and cannot create nested tooltips or drilldown actions. See [tooltip widgets](tooltip-widgets.md) for builder controls, safe query templates, JSON/YAML/OpenUI support and the extension contract.

Trusted application code can register additional React renderers through the feature's public entry point:

```tsx
import { registerWidgetPlugin } from "@/features/insights"

const unregister = registerWidgetPlugin({
  id: "team-status",
  label: "Team status",
  description: "A team-specific metrics view",
  dataKind: "metrics",
  render: ({ result }) => <span>{result.series?.length ?? 0} series</span>,
  parseConfig: (config) => config,
})
```

Registration makes the widget available to the library, visualization picker, and AI context. A bundled **Threshold gauge** exercises this extension path with configuration validation, bounds, and threshold colors. Renderer failures are contained to the widget. Imported documents can reference installed plugin IDs but cannot download or execute JavaScript. Plugin schemas should validate their own settings; the shared contract always applies JSON size/depth limits.

The editor now uses Gamma source adaptations for searchable selects, query comboboxes, buttons, input fields, textareas, tabs, switches and action menus. Source and token provenance is recorded in [the Gamma adapter README](../../../ui/src/features/insights/gamma/README.md). Paprika scopes their CSS and tokens locally, caps rendered search results, positions menus in viewport-aware portals, and retains keyboard and reduced-motion behavior. The installed `explore-gamma` skill and registered local MCP provide maintained component discovery; see [Gamma setup and retrieval](gamma-discovery.md). The production frontend has no runtime dependency on the Gamma explorer app.

Widgets can link to another dashboard through their **Links** tab. Links carry a fixed time range and selected labels, series names, observations or constants into declared destination variables. The URL preserves that view through reload and browser history without changing saved defaults. [Dashboard variables and drilldowns](drilldowns.md) documents the visual workflow, JSON/YAML contract, safe query interpolation, plugin context and library link remapping.

The canvas commits layout changes at the end of pointer gestures. Queries deduplicate through a four-request scheduler, cache briefly, cancel on changes, and defer offscreen widgets. Chart rendering caps series/points/rows and preserves gaps and spikes while downsampling. These are implementation bounds, not a measured production performance guarantee.

Responsive layouts follow the **measured canvas width**, including space occupied by the editor. A canvas enters the saved twelve-column arrangement at 960px and keeps it down to 880px, so a panel or scrollbar at the edge does not flip the layout back and forth; a canvas that starts narrower than 960px stays compact until it reaches 960px. At 600–959px small metrics share two columns, short plugin cards (saved width 4 or less) pair with the next stat or short plugin card in reading order and otherwise take a full row, and charts use a full row; below 600px widgets stack in visual reading order. Resizing never changes the saved layout, and widening restores it. Builder panels sit beside the canvas without reflowing it: the sidebar yields to a panel only while the wide arrangement needs the room, returns when the panel closes, and stays hidden or shown as the user last chose. This presentation state is device-local and never enters the URL or the document. Direct dragging is available in the wide layout, and resizing works from any edge or corner there. Below wide, a tile's ⋯ menu moves it up or down in reading order, makes it taller or shorter, duplicates it or removes it; the widget editor's Layout tab also remains available at every size, and its positions refer to the wide grid. The editor moves above the canvas on tablet and phone screens.

## Verification and current scope

How to run the unit, lint and browser checks is in [the Insights dev loop](../../guides/insights-dev-loop.md).
Review evidence is in [receipts/](receipts/), indexed above, and the review protocol and widget checklist
are in the [design skill](../../../.agents/skills/paprika-dashboard-design/SKILL.md). Browser suites write
screenshots and reports under `artifacts/insights/`.

This implementation is the dashboard-building foundation for replacing Grafana in Paprika. It does not claim Grafana feature parity: alert rule management, log providers, user-specific dashboard permissions, and a connected model/chat backend remain separate extensions. Widget plugins are trusted application modules, not a marketplace or remote-code loader. The trace explorer's on-demand span waterfall is described in [the trace waterfall guide](../../guides/insights-trace-waterfall.md).

## Data source explorer and saved queries

Open **Explore** in the Insights navigation to run a query against a chosen provider, then save it in that provider’s library. Saved queries declare string or numeric parameters, defaults and separate test values. **Use in dashboard** adds a linked widget and maps parameters to dashboard variables. Existing widget editors also offer **Saved query**. Definitions are live: saving an edit updates linked widgets; deleting an in-use query is blocked. See [the explorer contract](explorer.md) for authoring, query bindings, persistence and portability.

JSON/YAML exports include deduplicated saved-query dependencies for both widgets and tooltip sub-widgets. **Manage → Import** and the **Code** panel share provider mapping and conflict review. Identical definitions can be reused; conflicts import as copies without overwriting the destination library. See [portable dashboard bundles](portable-bundles.md) and [the portability review](receipts/portable-bundles-review.md).

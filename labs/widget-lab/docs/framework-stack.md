# Framework and rendering stack

> **WP-B1a note:** `src/vendor/paprika/` no longer exists. Production files are imported through `@insights/*`, and the lab's holding copies live in `src/renderer-extensions/` (see [its README](../src/renderer-extensions/README.md)). Paths in this document name the pre-WP-B1a copy.

This inventory describes the running Paprika Widget Lab. The lab preserves Paprika's copied widget host, registry, query-result adapters, theme and cursor owners; local changes are recorded in the provenance patch. It does not establish that these changes are integrated into the production Paprika repository.

## Installed foundations

| Layer | Installed version | Responsibility |
| --- | --- | --- |
| React and React DOM | 19.2.4 | Components, local state, shared inspection state and portal-based inspectors. |
| TypeScript | 5.9.3 | Typed widget configuration, normalized query results and interaction contracts. |
| Vite | 7.3.7 | Local development and production bundling. |
| TanStack Charts | **1.1.0, pinned** | Canonical time-series rendering, keyed scene updates, nearest-observation focus and keyboard observation navigation. |
| D3 Scale | 4.0.2 | Calendar-time and quantitative scales, timestamp inversion and responsive plot geometry. |
| D3 Shape | 3.2.0 | Lines, areas and miniature histories. |
| D3 Hierarchy | 3.1.2 | The copied record/treemap plugin dependency closure and the local `allocation-treemap` renderer's sector/holding layout. |
| Zod | 4.6.7 | Runtime widget and configuration validation. |
| Lucide React | 1.64.0 | Interface icons. The manifest declares a compatible range. |
| Vitest | 4.1.12 | Semantic, numerical, adapter and interaction-state tests. |

Versions are resolved from this checkout and its lockfile, rather than inferred from current online documentation. TanStack's current documentation describes its unreleased main branch as well as the published release; check the installed 1.1.0 exports before selecting an interaction API.

## Rendering ownership

| Surface | Rendering and interaction owner |
| --- | --- |
| Core time series | TanStack Charts inside `src/vendor/paprika/ui/src/features/insights/chart-renderers.tsx`, with D3 calendar scales and the existing cursor/tooltip host. |
| Directional traffic, stacked outcomes and distribution | Custom React SVG in the trusted `rich-metrics` plugin, using normalized canonical data and a shared observation inspector. |
| Literal Edge Watch and Reliability Room plots | Custom React SVG and D3 in `src/reference/ReferenceCharts.tsx`. The original full-range geometry follows the supplied concept artwork; selected windows use actual timestamp geometry. |
| Geographic maps | Shared React SVG map in `src/charts/geo/GeoMap.tsx` with bounded projection/camera math in `geo-viewport.ts`. Natural Earth geometry and synthetic location fixtures are locally available. |
| Financial allocation | `src/lenses/FinanceLens.tsx` registers `allocation-treemap` through the existing widget registry. D3 Hierarchy computes container-derived sector/holding rectangles; React SVG owns labels, drilldown, exact inspection and keyboard selection. `finance-data.ts` owns valuation and return calculations. |
| Website and infrastructure lenses | `src/lenses/OperationsLenses.tsx` composes existing stat, time-series, stacked, directional, table and connection-map owners through `WidgetVisualization`; `operations-data.ts` owns deterministic fixtures and population selection. |
| Chart editor | `src/editor/WidgetEditor.tsx` renders the same `WidgetVisualization` and `QueryResult`; `editor-model.ts` owns draft/history, schema and plugin validation, and compatible visualization choices. The lens/catalogue host applies local session overrides. |
| Appearance | Paprika Gamma theme variables, CSS Modules, the reference visual grammar and responsive CSS. |
| Motion | CSS transitions plus the existing reduced-motion/replay owner. Continuous map input is batched through `requestAnimationFrame`; exact values update immediately. |
| Time-window gestures | One reusable React pointer owner shared by the core and reference time-series charts, with separate pure interval math and accessible controls. |

## Complex concept lenses — iteration 07

The four new lenses extend this same stack. **No new dependency is required for their 11 registered families.** `src/charts/register-concept-charts.ts` composes the four new bundles and the existing lab bundle; `WidgetVisualization` remains the common lifecycle, validation and renderer boundary. Final runtime evidence is tracked separately in [iteration 07](iteration-07-complex-lenses.md).

| Lens / new owner | Framework responsibilities | Reused capability |
| --- | --- | --- |
| Market Risk — `src/charts/market-risk/` | React SVG owns signed waterfall geometry, correlation cells and liquidity stacks; pure TypeScript adapters validate populations, missingness, domains and identity. Zod owns configurable mappings and controls. | D3 Hierarchy `allocation-treemap`; canonical TanStack time series for performance/drawdown; exact record table. |
| Inference Fleet — `src/charts/inference/` | React SVG owns the rack matrix, three-stage request-flow layout and logarithmic paired scatter; pure adapters conserve flows and retain stable entity identity. No D3 Sankey package is installed. | Existing distribution-heatmap differences compatible cumulative histograms; canonical queue plot; exact workload table. |
| Incident Room — `src/charts/incident/` | React SVG and D3 line/area primitives compose aligned separate-unit lanes, typed time annotations, a parent-aware trace waterfall and a directed dependency graph. | Existing `useChartTimeWindow`, `useTimeWindowBrush`, exact window controls, Gamma/Panel primitives and `GeoMap`. |
| Grid Operations — `src/charts/grid/` | React SVG and D3 Shape draw forecast intervals and timestamp-positioned histories. A regional geographic layer projects existing Natural Earth land and supplied locations consistently. | Shared `geo-viewport` functions for bounded camera and gesture ownership; canonical signed stacks, status history, table and compact metric components. |

Each new family is a trusted plugin referenced by an ID and normalized data. It does not execute code from a dashboard document or fetch data from a private renderer path. The full owner/ID/semantic inventory is in [chart capabilities](chart-capabilities.md).

### Interaction scope in the new lenses

| Control | Owner and affected population |
| --- | --- |
| Market Risk 14/30/90-day window | Recomputes historical performance, drawdown, contribution and paired correlation evidence. Closing allocation/liquidity/ledger retain the same current valuation snapshot. A brush in one canonical plot remains local to that plot. |
| Inference region/model | Rebuilds the selected device, routing, workload and historical populations. One/six-hour selection changes loaded histories; current snapshot rates retain the same selected scope. Scatter legend selection is local to that scatter. |
| Inference paired view | One parent owner accepts five-minute time windows from either histogram or queue. Both use UTC and 110px/12px plot insets; exact input, Undo and Reset retain the source population and snapshot summaries. |
| Incident service | Changes the compound telemetry panel's source population and summary. Its brush changes the compound panel's displayed time domain. The incident trace, dependency population and evidence remain explicitly separate. |
| Grid scenario/window | Scenario changes the deterministic dispatch/network/forecast inputs. Today/recent history selection changes loaded historical evidence; current snapshot and stored energy retain their declared time. The forecast brush remains local, and map zoom remains camera-only. |

New inspectors and camera feedback do not animate numerical values through invented intermediate observations. Inspector opacity uses a short optional transition, while cursor and geometry updates are immediate. Relevant local owners cancel scheduled animation frames on unmount. Their reduced-motion behavior and device interaction checks still require the independent runtime evidence recorded in the iteration report.

## Why retain this stack

Paprika's `WidgetVisualization` remains the shared chart host, and TanStack renders the canonical built-in time series. D3 supplies precise scale, shape and hierarchy primitives. Trusted React SVG plugins provide the new chart anatomy while retaining the same normalized data and authoring contracts. Shared time-window and geographic camera owners are reused; each new family owns its appropriate mark geometry and inspection targets.

The installed TanStack brush overlay intercepts the observation hit-testing needed by the rich inspector when kept continuously active. The lab therefore uses a small React pointer brush for the requested ordinary click-and-drag gesture, while retaining TanStack's chart geometry and focus behavior. Clicks still inspect; a deliberate horizontal drag previews and commits a bounded time interval.

No visx, Recharts, ECharts, MapLibre, Leaflet, D3 Zoom or Motion/Framer Motion dependency is installed. A GIS runtime would be a separate choice if future requirements include tiled basemaps, geographic feature queries or very large spatial datasets. The current bounded SVG map satisfies the supplied connection-geography visual and its zoom/pan controls.

## Scope of the new interactions

The **Chart window** narrows one chart's displayed time domain. It preserves the source observations for Reset and does not claim to refetch a provider or recalculate dashboard-wide KPIs. A later shared dashboard window should connect the same interval contract to the existing query owner and update every affected result together.

The Website lens's **Window** selector has a different scope: it selects one or three hours from the loaded synthetic population and rebuilds the three event summaries and all associated plots together. It still makes no provider request. Finance's period selector rebases the selected synthetic performance history; the closing valuation snapshot and treemap population remain fixed.

Map zoom changes only the camera. It does not change location values, classify additional risk or manufacture extra observations. Ordinary wheel input is consumed only when the map can zoom; Ctrl/Command remains browser zoom, and outward wheel input at a camera limit returns to the page.

The editor's **Apply changes** updates the current lab session. It does not save a dashboard to Paprika or execute the displayed query. Guided options and structured configuration use the existing runtime validators; invalid edits retain the last valid preview. No additional chart, animation or editor library was installed for iteration 06's three lenses, iteration 07's four complex lenses, or the editing workspace.

The production boundary is unchanged: new source lives in this independently hosted Widget Lab. Registering, editing and demonstrating a lab family does not establish upstream Paprika provider execution, durable authoring, supported alternate themes, complete Grafana import, or production performance. Keep those gates explicit during transfer.

## Sources

- Local `package.json`, `package-lock.json`, resolved installed package metadata and the source owners above.
- [TanStack Charts overview](https://tanstack.com/charts/latest/docs/overview), checked 31 October 2026 Australia/Melbourne, for release/documentation scope.
- [D3 Zoom documentation](https://d3js.org/d3-zoom), checked on the same date, for gesture and bounded camera design context. D3 Zoom itself is not installed.

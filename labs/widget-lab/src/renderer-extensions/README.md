# Holding copies of the Insights renderer

This folder holds the Widget Lab's copies of the production Insights files that
the lab patch changes. Everything else the lab renders is imported from
`ui/src/features/insights` through the `@insights/*` alias (see `vite.config.ts`
and `tsconfig.json`). Each copy is a base file from `bb52aed8` plus the lab
patch, with imports of unchanged production siblings rewritten to `@insights/…`.

Every copy here is deleted when its feature is upstreamed (WP-B1b), after which
the lab imports production for that file too.

The old vendored tree, its `PROVENANCE.json` and the saved patch are not in this
tree any more. They remain in git history at commit `af11b6c3` under
`labs/widget-lab/src/vendor/paprika/` and
`labs/widget-lab/docs/paprika-reference-renderer.patch`.

## Patched files (13): production file is the same path

| Holding copy | Production file | What the lab patch adds | Upstream target |
| --- | --- | --- | --- |
| `chart-renderers.tsx` | `chart-renderers.tsx` | gridX, calendar time axis, axis-unit captions, zero-anchored gradient fill, reference lines and zero line, plot insets, time-window brush and controls, observation-tooltip owner, focus ring | A2, A3, A4b |
| `charts.tsx` | `charts.tsx` | loading host slot (`WidgetLoadingProvider`), refresh notice, `WidgetTooltipProvider` mount | A3, A4a |
| `charts.module.css` | `charts.module.css` | loading frame and refresh notice | A4a |
| `chart-styles.module.css` | `chart-styles.module.css` | rich inspector and compact density rules | A4a, A4 |
| `plot-tooltip.tsx` | `plot-tooltip.tsx` | programmatic `pin()`, revision reset, rich inspector body, focus guard, footer copy | A3, A4b |
| `plugins/operational-records.tsx` | `plugins/operational-records.tsx` | zoomable connection map registration (imports the lab-owned `src/catalog/ConnectionMap.tsx`), binding text | Lab wrapper (D5) |
| `plugins/rich-metrics-data.ts` | `plugins/rich-metrics-data.ts` | exact `sourceCells` for display-sampled heatmap and stacked inspection | A4b |
| `plugins/rich-metrics.module.css` | `plugins/rich-metrics.module.css` | inspector CSS moved out of the production stylesheet | A4 |
| `plugins/rich-metrics.tsx` | `plugins/rich-metrics.tsx` | inspection state, calendar axis for heatmap and stacked charts, dismiss controller, focus restore | A3, A4b |
| `schema.ts` | `schema.ts` | lab options (`gridX`, `timeAxis`, `axisUnit`, `plotInsetLeft/Right`, `fillStyle`, `inspectorDensity`, `showZeroLine`, `referenceLines`, `tooltipPlacement/Offset/MaxWidth/MaxHeight`) and `tooltipView.height: 80` | A4a |
| `tooltip-widgets.module.css` | `tooltip-widgets.module.css` | compact density styles | A4 |
| `tooltip-widgets.tsx` | `tooltip-widgets.tsx` | 80px selected-series history, collapsible history range, density attribute | A4 |
| `widget-registry.tsx` | `widget-registry.tsx` | `validateInput`, `layout` (named `sizing` upstream, D7), field `binding` | A4a |

Production plugin modules import `./widget-registry`. The Vite plugin
`paprika-holding-overlay` resolves those imports to this copy, so one registry
holds every registration. Production and lab plugins register in the same store.

## Lab-only modules (10): production has no file at this path

| Holding copy | What it provides | Upstream target |
| --- | --- | --- |
| `chart-presentation.ts` | `calendarTick`, `horizontalPlotBounds`, `temporalPosition`, `timeAxisValue`, `signedAreaGradient` | A4 (same name) |
| `observation-inspector-data.ts` | exact observation lookup, bounded histories, inspector series | A4 |
| `observation-inspector.tsx` | `RichObservationInspector`: exact table, 40px history, UTC bounds | A4 |
| `time-window-controls.tsx` | in-plot brush, Time window popover, `useChartTimeWindow`, `useTimeWindowBrush` | A4 as `chart-window-controls.tsx` (D1, D7) |
| `time-window.module.css` | styles for the window controls | A4 (Gamma tokens) |
| `tooltip-dismiss.ts` | dismiss controller: 180 ms hide, revision reset, handoff hold | A3 |
| `tooltip-focus.ts` | `restoreTooltipFocus` and the passive-dismiss guard | A3 |
| `tooltip-interaction.tsx` | `WidgetTooltipProvider` store: pointer, owner precedence, Escape stack | A3 (D3) |
| `tooltip-position.ts` | `positionObservationTooltip`, `limitTooltipSize`, placement options | A3 |
| `widget-loading.tsx` | `WidgetLoadingProvider`: initial and refresh phases | A4 |

## Name collisions (2): production has a different file at the same path

| Holding copy | Production file | Difference | Upstream target |
| --- | --- | --- | --- |
| `observation-tooltip.tsx` | `observation-tooltip.tsx` (693 lines) | The lab's tooltip takes an optional `anchor` and `onDismiss(reason)`. Production requires `anchor`. The two APIs must merge. | A3 |
| `time-window.ts` | `time-window.ts` (dashboard observation model) | No export name collides. The lab's window model merges into production's module. | A4a |

## Sibling copy (1): identity and type

| Holding copy | Production file | Why it is held |
| --- | --- | --- |
| `appearance.ts` | `appearance.ts` (byte-identical) | `widgetTextColor` takes `WidgetOptions`. The lab's options type (`tooltipView.height: 80`) is not assignable to production's, so the patched renderer keeps this copy beside `schema.ts`. Delete with `schema.ts` (A4a). |

## Rules that keep the copies consistent

- Copies import each other by relative path. Unchanged production siblings are
  imported as `@insights/<path>`, never as copies of their own.
- Lab code imports a copy from this folder, and everything else through
  `@insights/`. `tests/` follows the same rule, including `vi.mock` paths.
- Registration order: `src/charts/register-lab-charts.ts` registers the lab's
  rich-metric and operational-record plugins before production's
  `registerDefaultWidgetPlugins()`. Production skips an id that is already
  registered, so the lab keeps its renderers, including the zoomable connection
  map. `tests/register-lab-charts.test.ts` pins this order and the shared registry.
- `src/catalog/ConnectionMap.tsx` is lab-owned. The holding operational-records
  copy imports it. Production never imports lab code.

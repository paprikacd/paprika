# Paprika source used by the widget evaluation lab

## Provenance and scope

- Renderer: production Insights in `ui/src/features/insights`, imported through the `@insights/*` alias. The lab does not carry a copy of the renderer.
- Holding copies: the files that the lab patch changes live in `src/renderer-extensions/`. They are copies of upstream base commit `bb52aed8ded8beb08534f6b190a3e7f37c1b19d8` (retrieved 2026-10-30) plus the lab patch. Each is deleted when its feature is upstreamed (WP-B1b). The per-file record is [`src/renderer-extensions/README.md`](../src/renderer-extensions/README.md).
- Attribution: the upstream `LICENSE`, `DESIGN.md`, Insights UX contract and Gamma source catalogue, as they were at `bb52aed8`, are kept in [`attribution/`](../attribution/). The production Gamma README is at `ui/src/features/insights/gamma/README.md`. Gamma's README keeps its separate component-provenance boundaries. This is the user's private evaluation harness, not a public redistribution claim for all original Gamma components.
- The renderer excludes the Next app shell, API clients, authentication, live provider configuration and backend code. The lab supplies no query environment or fetcher.
- The former vendored tree (`src/vendor/paprika/`), its `PROVENANCE.json` and its saved patch were retired in WP-B1a. They remain in git history at commit `af11b6c3`.

## How the lab resolves production

- `vite.config.ts` aliases `@insights/*` to `ui/src/features/insights`, sets `server.fs.allow` to the repository root, and `resolve.dedupe` for React, React DOM, TanStack Charts, the d3 packages used by the closure, `lucide-react`, `yaml` and `zod`. Production files therefore resolve every package from the lab's `node_modules`, and one React and one TanStack Charts serve both.
- `tsconfig.json` maps `@insights/*` and each bare package and TanStack Charts subpath to the lab's `node_modules`, so the typecheck does not depend on `ui/node_modules`. A clean-room check without `ui/node_modules` passed typecheck, build and tests.
- `holdingOverlay` (in `vite.config.ts`) resolves production's `./widget-registry` imports to the holding copy, so production plugins and the lab renderer share one registry.
- `src/charts/register-lab-charts.ts` registers the lab's rich-metric and operational-record renderers before production's `registerDefaultWidgetPlugins()`. `tests/register-lab-charts.test.ts` pins that order.

## Runtime dependencies

Versions match production's lock file wherever `ui` pins them: React and React DOM `19.2.4`, `@tanstack/charts` `1.1.0`, `d3-shape` `3.2.0`, `d3-hierarchy` `3.1.2`, `lucide-react` `1.17.0`, `zod` `4.6.7`, `yaml` `2.9.1`, and `@types/react` `19.2.17` and `@types/react-dom` `19.2.3` for type checking. `d3-scale` `4.0.2` is a direct dependency with `@types/d3-scale` `4.0.9`, because the calendar axis imports it. The lab's `package.json` and lock file record these versions.

## Local owner extensions

The options below are implemented by the holding copies and the strict schema they import. They are **not claims about the unchanged upstream commit** and are not runtime configuration that can be sent to an unpatched Paprika deployment. A production contribution would need a separate upstream review and its own tests.

| Local extension | Owner and behavior |
| --- | --- |
| `gridX: true` | `chart-renderers.tsx` enables vertical grid lines on the actual X scale when the grid is enabled. Y grid lines remain tied to the quantitative scale. |
| `timeAxis: 'calendar'` | The X scale uses `d3-scale`'s `scaleTime`. Both line and area accessors produce Date channels through `timeAxisValue`; original query points retain numeric epoch milliseconds for exact timestamps, shared cursor identity and inspection. `calendarTick` supplies browser-timezone clock/date labels. |
| `axisUnit: 'caption'` | The renderer displays the unit once in the plot caption and uses compact numeric Y ticks. |
| `fillStyle: 'gradient'` | `signedAreaGradient` generates unique, zero-anchored area definitions. Positive, negative and mixed-sign series fade toward their actual zero baseline. Existing solid fills remain available. |
| `showZeroLine: true` | A decorative `ruleY` mark draws an explicit zero reference using the quantitative scale. |
| `referenceLines` | Up to eight strict `{ value, label, color?, style? }` entries create scale-owned rules and corresponding legend labels. `style` is solid or dashed; custom color is a validated six-digit hex value. Reliability uses the labelled 1× budget-pace reference. |
| `inspectorDensity: 'compact'` | The tooltip owner opts into a compact surface, exact same-timestamp series values, selected-series history, useful tags, expandable metadata and explicit close/pin guidance. Comfortable presentation remains available. |
| `tooltipPlacement`, `tooltipOffset`, `tooltipMaxWidth`, `tooltipMaxHeight` | Strict common presentation options consumed by `ObservationTooltip`: pointer/keyboard anchoring, preferred side with collision fallback, bounded dimensions and internal scrolling. |
| `tooltipView.height: 80` | Schema, context type and mini-history owner all accept the compact history size. Detailed interval/reduction information remains reachable without repeating a large title block. |

The patch also refines common focus-ring and tick-label presentation. New presentation flags are opt-in, but byte-for-byte behavior equivalence of every unconfigured renderer detail is not asserted. `svgAnimation` remains disabled: data geometry updates directly.

Files the lab patch does not change come from production, so the lab also receives production's versions of the records, status-history, uptime, geo-heatmap, small-multiples and metric-distribution plugins, and production's gamma theme tokens. Measured across the 31-route preview at 1440px, the visible results were: the asset-by-time state panel draws production's status history (continuous segments with hatched unknown samples), and the records tables use production's column widths. Time series, bar and stacked charts, rich-metric plots, maps and the lab's shell matched the pre-switch screenshots within run-to-run noise.

## Canonical entry points

These are the production entry points. The lab imports each one as `@insights/…` unless the lab patch changes that file, in which case it imports the holding copy of the same name from `src/renderer-extensions/` (listed in [its README](../src/renderer-extensions/README.md)).

| Need | Export and file |
| --- | --- |
| Built-in or trusted-plugin rendering | `WidgetVisualization` from `charts.tsx` |
| Widget and result types; strict option validation | `Widget`, `QueryResult`, `widgetSchema` from `schema.ts` |
| Shared timestamp cursor | `ChartCursorProvider`, `useChartCursor` from `chart-cursor.tsx` |
| Theme scope | Default CSS Module export's `scope` from `gamma/gamma-theme.module.css` |
| Common floating inspector | `ObservationTooltip` from `observation-tooltip.tsx`; position/store helpers alongside it |
| Panel/dashboard menus | `GammaActionMenu` from `gamma/action-menu.tsx` |
| Standard buttons | `GammaButton` from `gamma/button.tsx` |
| Authored select/listbox | `GammaSelect` from `gamma/select.tsx` |
| Controlled tab/tabpanel set | `GammaTabs` from `gamma/tabs.tsx` |
| Labelled checkbox switch | `GammaSwitch` from `gamma/switch.tsx` |
| Native fields | `GammaInput`, `GammaTextarea` from `gamma/input.tsx` |
| Stacks, directional traffic, distribution heatmap | `registerRichMetricPlugins` from `plugins/rich-metrics.tsx` |
| Status history, pie | `registerMetricDistributionPlugins` from `plugins/metric-distributions.tsx` |
| Formatting and display reduction | `formatMetric`, `downsamplePoints`, `latestPoint` from `chart-data.ts` |

There is no separate canonical segmented-control component. Use `GammaTabs` for actual tab panels, or a labelled group of `GammaButton` controls with `aria-pressed` for a view option. Do not mislabel a display option as navigation.

## Minimal example

This complete example is relative to a file directly under `src/`. The hosting app must supply normal page layout and the dependencies above. `WidgetVisualization` and the rich-metric registration come from the holding copies because those files are patched; the theme, cursor and schema types come from production through `@insights/…` imports.

```tsx
import { WidgetVisualization } from './renderer-extensions/charts';
import { ChartCursorProvider } from '@insights/chart-cursor';
import gammaTheme from '@insights/gamma/gamma-theme.module.css';
import { registerRichMetricPlugins } from './renderer-extensions/plugins/rich-metrics';
import { registerMetricDistributionPlugins } from '@insights/plugins/metric-distributions';
import type { QueryResult, Widget } from './renderer-extensions/schema';

registerRichMetricPlugins();
registerMetricDistributionPlugins();

const widget: Widget = {
  id: 'latency-fixture',
  title: 'Checkout latency',
  type: 'timeseries',
  providerId: 'fixture',
  query: 'synthetic_fixture',
  unit: 'ms',
  layout: { x: 0, y: 0, w: 6, h: 4 },
  options: {
    display: 'line',
    curve: 'linear',
    showLegend: true,
    showGrid: true,
    showTooltip: true,
    decimals: 0,
    min: 0,
  },
};

const result: QueryResult = {
  series: [{
    name: 'Checkout p95',
    labels: { service: 'checkout' },
    points: [
      { timestamp: Date.parse('2026-10-30T03:00:00Z'), value: 180 },
      { timestamp: Date.parse('2026-10-30T03:01:00Z'), value: 240 },
      { timestamp: Date.parse('2026-10-30T03:02:00Z'), value: null },
      { timestamp: Date.parse('2026-10-30T03:03:00Z'), value: 210 },
    ],
  }],
};

export function Example() {
  return (
    <div className={gammaTheme.scope} data-insights-theme="light">
      <p>Deterministic synthetic evaluation data; latency values are milliseconds.</p>
      <ChartCursorProvider>
        <div style={{ height: 280, minWidth: 0 }}>
          <WidgetVisualization widget={widget} result={result} />
        </div>
      </ChartCursorProvider>
    </div>
  );
}
```

`WidgetVisualization` additionally accepts `loading`, `error` and `onContextChange`. A concrete height is required because the chart measures its container. Keep widget/result object identities stable between presentation-only renders so selection is not invalidated unnecessarily. The canonical result-replacement behavior clears stale observations, pins and cursors.

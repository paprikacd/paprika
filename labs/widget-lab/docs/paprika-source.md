# Paprika source used by the widget evaluation lab

## Provenance and scope

- Repository: https://github.com/paprikacd/paprika
- Upstream base commit: `bb52aed8ded8beb08534f6b190a3e7f37c1b19d8`
- Retrieved: 2026-10-30.
- Root copy: `src/vendor/paprika/`.
- The original import closure contained 43 TypeScript/TSX/CSS files. The reference pass locally modifies six of those copied owners and adds `chart-presentation.ts`; **the renderer copy is no longer byte-for-byte unchanged**. Original repository-relative paths remain preserved beneath the copy root. The production Paprika repository is not modified.
- `PROVENANCE.json` records each file's upstream SHA-256, current local SHA-256 and unchanged/modified/added status, plus the base commit, dependencies and exact patch hash. The original Apache-2.0 `LICENSE`, `DESIGN.md`, Insights UX contract, Gamma README and Gamma source catalogue remain unchanged.
- Gamma's README preserves its separate component-provenance boundaries. This is the user's private evaluation harness, not a public redistribution claim for all original Gamma components.
- The copy excludes the Next app shell, API clients, authentication, live provider configuration and backend code. React-local query-context modules are retained because the renderer imports their types/hooks; no query environment or fetcher is supplied by the lab.

## Runtime dependencies

The upstream manifest declares React/ReactDOM `19.2.4`, `@tanstack/charts` `1.1.0`, `d3-shape` `3.2.0`, `lucide-react` `^1.17.0`, `zod` `4.6.7` and `yaml` `2.9.1`. The local calendar-scale extension additionally imports **`d3-scale` `4.0.2` as a direct dependency**, with **`@types/d3-scale` `4.0.9`** for type checking. React and d3-shape declarations remain required. The rule extension uses `@tanstack/charts/rule` from the existing pinned TanStack package. All source imports use relative paths and CSS Modules; no Next import or path alias is required. `package.json` and the lockfile record the exact local dependency resolution.

## Local owner patch

The options below are implemented by this lab's copied renderer and strict schema. They are **not claims about the unchanged upstream commit** and are not runtime configuration that can be sent to an unpatched Paprika deployment. A production contribution would need a separate upstream review and its own tests.

| Local extension | Owner and behavior |
| --- | --- |
| `gridX: true` | `chart-renderers.tsx` enables vertical grid lines on the actual X scale when the grid is enabled. Y grid lines remain tied to the quantitative scale. |
| `timeAxis: 'calendar'` | The X scale uses `d3-scale`'s `scaleTime`. Both line and area accessors produce Date channels through `timeAxisValue`; original query points retain numeric epoch milliseconds for exact timestamps, shared cursor identity and inspection. `calendarTick` supplies browser-timezone clock/date labels. |
| `axisUnit: 'caption'` | The renderer displays the unit once in the plot caption and uses compact numeric Y ticks. |
| `fillStyle: 'gradient'` | `signedAreaGradient` generates unique, zero-anchored area definitions. Positive, negative and mixed-sign series fade toward their actual zero baseline. Existing solid fills remain available. |
| `showZeroLine: true` | A decorative `ruleY` mark draws an explicit zero reference using the quantitative scale. |
| `referenceLines` | Up to eight strict `{ value, label, color?, style? }` entries create scale-owned rules and corresponding legend labels. `style` is solid or dashed; custom color is a validated six-digit hex value. Reliability uses the labelled 1× budget-pace reference. |
| `inspectorDensity: 'compact'` | The tooltip owner opts into a compact surface, exact same-timestamp series values, selected-series history, useful tags, expandable metadata and explicit close/pin guidance. Comfortable presentation remains available. |
| `tooltipView.height: 80` | Schema, context type and mini-history owner all accept the compact history size. Detailed interval/reduction information remains reachable without repeating a large title block. |

The patch also refines common focus-ring and tick-label presentation. New presentation flags are opt-in, but byte-for-byte behavior equivalence of every unconfigured renderer detail is not asserted. `svgAnimation` remains disabled: data geometry updates directly. Compact inspector appearance consumes `--gamma-motion-duration` (150ms in the study shell), and reduced-motion preferences remove that effect.

The modified copied files are `chart-renderers.tsx`, `chart-styles.module.css`, `plot-tooltip.tsx`, `schema.ts`, `tooltip-widgets.tsx` and `tooltip-widgets.module.css`, all under `ui/src/features/insights/`. The new helper is `ui/src/features/insights/chart-presentation.ts`. Gamma controls, inheritance code, license and attribution are retained from the pinned source.

### Reproduce and verify the patch

[`paprika-reference-renderer.patch`](paprika-reference-renderer.patch) is a unified diff from exact Git blobs at the upstream base to the current copied owners. Its paths are rooted at `src/vendor/paprika/`, so it applies from the **lab project root** to a fresh copy of that upstream closure. Do not reapply it to an already patched copy.

Regenerate both the patch and per-file provenance after any final owner edit. The helper reads the upstream Git objects without changing that repository and writes only the lab's documentation/manifest:

```sh
python docs/regenerate-paprika-provenance.py --upstream /workspace/scratch/ffa6c3757aaa/paprika-source
python docs/regenerate-paprika-provenance.py --upstream /workspace/scratch/ffa6c3757aaa/paprika-source --check
git apply --check --reverse docs/paprika-reference-renderer.patch
```

For another checkout, replace the `--upstream` path with a local clone containing the recorded base commit. `--check` fails if the patch, manifest or copied-owner hashes are stale. The reverse apply check confirms the saved delta matches the patched working tree without changing files. These are provenance checks, not browser or visual validation.

## Canonical entry points

Paths below are relative to `src/vendor/paprika/ui/src/features/insights/`.

| Need | Export and file |
| --- | --- |
| Built-in or trusted-plugin rendering | `WidgetVisualization` from `charts.tsx` |
| Widget and result types; strict option validation | `Widget`, `QueryResult`, `widgetSchema` from `schema.ts` |
| Shared timestamp cursor | `ChartCursorProvider`, `useChartCursor` from `chart-cursor.tsx` |
| Theme scope | Default CSS Module export's `scope` from `gamma/gamma-theme.module.css` |
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

This complete example is relative to a file directly under `src/`. The hosting app must supply normal page layout and the dependencies above.

```tsx
import { WidgetVisualization } from './vendor/paprika/ui/src/features/insights/charts';
import { ChartCursorProvider } from './vendor/paprika/ui/src/features/insights/chart-cursor';
import gammaTheme from './vendor/paprika/ui/src/features/insights/gamma/gamma-theme.module.css';
import { registerRichMetricPlugins } from './vendor/paprika/ui/src/features/insights/plugins/rich-metrics';
import { registerMetricDistributionPlugins } from './vendor/paprika/ui/src/features/insights/plugins/metric-distributions';
import type { QueryResult, Widget } from './vendor/paprika/ui/src/features/insights/schema';

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

## Widget configurations

Every widget requires `id`, `title`, `type`, `providerId`, nonempty `query`, `unit`, and a valid `layout`. The provider/query fields in this harness identify synthetic fixtures and do not perform requests.

### Time series

Use `type: 'timeseries'` and the base options `display`, `curve`, `showLegend`, `showGrid`, `showTooltip`, `decimals`, `min`, `max`, `lineWidth` and `fillOpacity` as needed. A custom first-series color belongs to `widget.color`, not `options.color`. The explicit local extensions are listed above; they were added to the strict schema and renderer together. Baseline charts use the existing Gamma categorical palette. Built-in geometry uses `svgAnimation: false`; control-state CSS motion remains governed by Gamma tokens. Set nested `tooltipView.decimals` explicitly when mini-history precision must match the main inspector.

### Bar

Use `type: 'bar'`. Each series supplies one latest-valid category value. Use a zero-based domain for magnitude bars. If a point history has a missing final sample, explicitly explain that latest-valid and latest-sample semantics differ; do not present an older value as current without its time/freshness context.

### Distribution heatmap

Register rich metric plugins, then use `type: 'plugin'`, `pluginId: 'distribution-heatmap'`, `dataKind: 'metrics'`. Valid configuration keys are `bucketLabel`, `bucketUnit`, `densityUnit`, `group`, `aggregation`, `maxBuckets` and `maxColumns`.

The normalized input is cumulative bucket observations at each timestamp. Each series has an upper-bound label such as `{le: '100'}` or `{le: '+Inf'}`; remaining labels identify a histogram group. The renderer differences adjacent buckets. It does not compute counter rates over time. Use query-side rates or correctly labelled per-interval fixture counts. Multiple groups require an exact group selection or `aggregation: 'sum'`, and summation requires matching boundaries.

`bucketUnit` labels the numeric bucket boundaries. It does not convert them: convert second-valued bounds to milliseconds before using `bucketUnit: 'ms'`. Density units describe the differenced values independently. Invalid or incomplete buckets remain missing; zero density remains an observation.

### Status history

Register metric distribution plugins, then use `type: 'plugin'`, `pluginId: 'status-history'`, `dataKind: 'metrics'`, and `config: {maxSeries: 12, maxPoints: 60}` if needed. Supply sorted explicit `options.thresholds` with value, six-digit hex color and label. Null values represent unknown samples. Thresholds select the greatest boundary not exceeding the observed code; choose codes and labels consistently.

The current source renders equally spaced sample cells, and its context callback contains series/labels/value, without the selected timestamp. Use an explicitly uniform-cadence fixture with null placeholders for missing samples, and retain the source's "Earlier → latest" framing. This baseline is not a duration-proportional timeline or a timestamp-bearing drilldown. A richer interval timeline would need an explicit renderer change and tests.

## Evaluation boundaries

- Time-series tick labels use the browser's local timezone through the canonical formatter. Label the browser timezone explicitly rather than claiming UTC while reusing that formatter.
- The shared cursor carries numeric epoch timestamps, and time domains derive from actual returned observations. Edge and Reliability adapters supply actual observed/missing intervals only; do not fabricate boundary samples merely to stretch a plot, because those anchors can contaminate history counts and missingness. The original baseline adapter's domain conventions are documented separately in its historical data contract.
- Built-in series colors currently follow series position. Keep fixture order deterministic; semantic color stability across reorder is a separate improvement to evaluate.
- No live query provider is configured. Opening a normal details-only tooltip must not fetch.
- Default chart caps and notices still apply; use a bounded fixture rather than silently hiding additional data.
- Light/dark theme is selected with `data-insights-theme`. Portals inherit the scope's tokens and observe theme changes.
- The study shell changes effective motion duration tokens inline on that same scope. This lets the unchanged Gamma inheritance helper observe manual/OS preference updates and copy them into already-open portals. Demo replay is owned by the lab, advances real synthetic snapshots every 1.8 seconds, and stops on explicit pause, hidden-document state or study unmount. Its cadence is independent of reduced motion.
- Edge's ten-second observations are explicitly synthetic, conserve the original minute counts and bytes, preserve null gaps and retain overlapping identity. They do not imply a provider offers sub-minute measurements. Positive egress accounting is separate from the explicitly mirrored chart display.
- Browser behavior and numerical correctness must be verified by the harness checks. Source inspection alone does not prove that the widgets work in the evaluation environment.

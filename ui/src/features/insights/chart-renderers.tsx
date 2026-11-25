"use client";

// Load order. The renderers lived in this file, and these statements import the modules they use in the order the
// file did. Keep them first and in this order. Turbopack merges modules into one scope only when every chunk group
// reaches them in the same order, and it groups CSS by import order. Lazy plugin views and the first view reach the
// chart modules through this facade, so a different order splits the merged chart scope and the first-view CSS chunks
// (measured: +1.7 KB JS gzip, +1.1 KB CSS gzip). The bare imports are there only for that order.
// The moved renderers are bound below as this module's own exports, not re-exported: an importer of a re-export
// links to the renderer module itself, which exposes it and splits the scope too.
import "./benign-states";
import "./observation-owner";
import "./chart-table";
import "./trace-waterfall";
import "./trace-dialog";
export { MetricDetails } from "./metric-tooltip-content";
import "./tooltip-focus";
import "./dashboard-window";
import "./stat-comparison";
export {
  downsamplePoints,
  latestPoint,
  seriesName,
  formatMetric,
  exactMetric,
  formatTimeTick,
} from "./chart-data";
import "./heatmap-value-width";
import "./tooltip-widget-data";
import "./tooltip-widgets";
import "./stat-sparkline";
export { ObservationTooltip, ObservationDetails, heatmapTooltipSizeLimit, placeHeatmapTooltip, placePlotTooltip, placeOutsideWidgetTooltip, placeClearOutsideWidgetTooltip, outsideTooltipWidthLimit, tooltipOverlapsOtherWidget } from "./observation-tooltip";
import "./widget-context.module.css";
import "./selection-state";
export {
  thresholdForValue,
  resolveChartDomain,
  responsiveChartTicks,
  chartYAxisLayout,
} from "./chart-renderer-shared";
import "./widget-attention";
export { TimeSeriesChart, resolveTimeSeriesDomain } from "./time-series-chart";
export { BarChart } from "./bar-chart";
export { ChartDataInspector } from "./chart-data-inspector";
import { EmptyState as EmptyStateRenderer } from "./renderers/empty-state";
import { DEFAULT_HEATMAP_THRESHOLDS as HEATMAP_THRESHOLDS, balancedHeatmapColumns as heatmapColumns, Heatmap as HeatmapRenderer } from "./renderers/heatmap";
import { contrastText as builtinContrastText, BuiltinWidgetRenderer as BuiltinRenderer } from "./renderers/builtin";

export const EmptyState = EmptyStateRenderer;
export const DEFAULT_HEATMAP_THRESHOLDS = HEATMAP_THRESHOLDS;
export const balancedHeatmapColumns = heatmapColumns;
export const Heatmap = HeatmapRenderer;
export const contrastText = builtinContrastText;
export const BuiltinWidgetRenderer = BuiltinRenderer;

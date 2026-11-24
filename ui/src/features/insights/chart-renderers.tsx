"use client";

export { MetricDetails } from "./metric-tooltip-content";
export {
  downsamplePoints,
  latestPoint,
  seriesName,
  formatMetric,
  exactMetric,
  formatTimeTick,
} from "./chart-data";
export { ObservationTooltip, ObservationDetails, heatmapTooltipSizeLimit, placeHeatmapTooltip, placePlotTooltip, placeOutsideWidgetTooltip, placeClearOutsideWidgetTooltip, outsideTooltipWidthLimit, tooltipOverlapsOtherWidget } from "./observation-tooltip";
import type { DrilldownContext } from "./drilldown";
import { readableTextColor } from "./appearance";
import type { QueryResult, Widget } from "./schema";
import { TimeSeriesChart } from "./time-series-chart";
import { BarChart } from "./bar-chart";
import { EmptyState } from "./renderers/empty-state";
import { Stat } from "./renderers/stat";
import { MetricTable } from "./renderers/metric-table";
import { TraceList } from "./renderers/trace-list";
import { Heatmap } from "./renderers/heatmap";
export { TimeSeriesChart, resolveTimeSeriesDomain } from "./time-series-chart";
export { BarChart } from "./bar-chart";
export { ChartDataInspector } from "./chart-data-inspector";
export {
  thresholdForValue,
  resolveChartDomain,
  responsiveChartTicks,
  chartYAxisLayout,
} from "./chart-renderer-shared";


export { EmptyState } from "./renderers/empty-state";
export { DEFAULT_HEATMAP_THRESHOLDS, balancedHeatmapColumns, Heatmap } from "./renderers/heatmap";

export function contrastText(hex: string) {
  return readableTextColor(hex);
}

export function BuiltinWidgetRenderer({
  widget,
  result,
  onContextChange,
  onActivate,
}: {
  widget: Widget;
  result: QueryResult;
  onContextChange?: (context: DrilldownContext) => void;
  onActivate?: (context: DrilldownContext) => void;
}) {
  const series = result.series ?? [];
  switch (widget.type) {
    case "timeseries":
      return <TimeSeriesChart widget={widget} series={series} onContextChange={onContextChange} onActivate={onActivate} />;
    case "bar":
      return <BarChart widget={widget} series={series} onContextChange={onContextChange} onActivate={onActivate} />;
    case "stat":
      return (
        <Stat
          widget={widget}
          series={series}
          result={result}
          onContextChange={onContextChange}
        />
      );
    case "table":
      return (
        <MetricTable
          widget={widget}
          series={series}
          onContextChange={onContextChange}
          onActivate={onActivate}
        />
      );
    case "traces":
      return (
        <TraceList
          widget={widget}
          traces={result.traces ?? []}
          onContextChange={onContextChange}
          onActivate={onActivate}
        />
      );
    case "heatmap":
      return (
        <Heatmap
          widget={widget}
          series={series}
          onContextChange={onContextChange}
          onActivate={onActivate}
        />
      );
    default:
      return <EmptyState />;
  }
}

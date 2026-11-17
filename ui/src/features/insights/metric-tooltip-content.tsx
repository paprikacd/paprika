"use client";
import { useMemo, type ReactNode } from "react";
import { useDashboardTimeZone } from "./dashboard-time-zone";
import type { Widget } from "./schema";
import { seriesName, formatMetricDetails, exactMetric, fullDateTimeOptions, type Point, type Series } from "./chart-data";
import { validTimestamp } from "./widget-context";
import configStyles from "./chart-styles.module.css";

export function metricTooltipTitle(widget: Widget | undefined, series: Series, index: number) {
  return widget?.options?.tooltipTitle?.trim() || widget?.title || seriesName(series, index);
}

export function MetricDetails({
  widget,
  series,
  index,
  point,
  unit,
  decimals,
  description = "Latest valid sample",
  timestampFirst = false,
  compact = false,
  seriesLabel,
  children,
}: {
  widget?: Widget;
  series: Series;
  index: number;
  point?: Point;
  unit: string;
  decimals?: number;
  description?: string;
  timestampFirst?: boolean;
  compact?: boolean;
  seriesLabel?: string;
  children?: ReactNode;
}) {
  const timeZone = useDashboardTimeZone();
  const timestampFormat = useMemo(() => new Intl.DateTimeFormat("en", { ...fullDateTimeOptions, timeZone }), [timeZone]);
  const value =
    typeof point?.value === "number" && Number.isFinite(point.value)
      ? point.value
      : undefined;
  const timestamp = point && validTimestamp(point.timestamp) ? (
    <time dateTime={new Date(point.timestamp).toISOString()}>
      {timestampFormat.format(new Date(point.timestamp))}
    </time>
  ) : <span>No valid timestamp</span>;
  return (
    <>
      <div className={configStyles.tooltipHeader} data-tooltip-compact={compact || undefined}>
        <strong className={configStyles.tooltipTitle}>
          {metricTooltipTitle(widget, series, index)}
        </strong>
        {seriesLabel && <span className={configStyles.tooltipSeries}>{seriesLabel}</span>}
      </div>
      {timestampFirst && <div className={configStyles.plotTooltipTime}><span>{description}</span>{timestamp}</div>}
      <div className={configStyles.tooltipReading}>
        {widget?.options?.tooltipValueLabel && <span className={configStyles.tooltipEyebrow}>{widget.options.tooltipValueLabel}</span>}
        <strong
          data-metric-value={value === undefined ? undefined : String(value)}
        >
          {value === undefined ? "No data" : formatMetricDetails(value, widget?.options?.tooltipShowUnit === false ? "" : unit, widget?.options?.tooltipDecimals ?? decimals ?? widget?.options?.decimals)}
        </strong>
        {children}
      </div>
      {!timestampFirst && <div className={configStyles.tooltipFooter}>
        <span>{description}</span>
        {timestamp}
      </div>}
      <div className={`${configStyles.tooltipLabels}${compact ? ` ${configStyles.tooltipVisuallyHidden}` : ""}`}>
        {widget ? <details className={configStyles.tooltipSource}>
          <summary>Source details</summary>
          <div className={configStyles.tooltipSourceIdentity}>{seriesName(series, index)}</div>
          <dl>
            <div><dt>Exact value</dt><dd>{value === undefined ? "No data" : exactMetric(value, unit)}</dd></div>
            {Object.entries(series.labels).map(([key, label]) => <div key={key}><dt>{key}: </dt><dd>{label}</dd></div>)}
          </dl>
        </details> : <dl>{Object.entries(series.labels).map(([key, label]) => <div key={key}><dt>{key}:</dt><dd>{label}</dd></div>)}</dl>}
      </div>
    </>
  );
}

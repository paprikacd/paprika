"use client";

import { z } from "zod";
import {
  registerWidgetPlugin,
  getWidgetDefinition,
  type WidgetRendererProps,
} from "../widget-registry";
import {
  EmptyState,
  MetricDetails,
  ObservationDetails,
  exactMetric,
  formatMetric,
  seriesName,
  thresholdForValue,
} from "../chart-renderers";
import styles from "../chart-styles.module.css";
import { metricContext, validTimestamp } from "../widget-context";
import { widgetTextColor } from "../appearance";

const configSchema = z.strictObject({ label: z.string().max(100).optional() });
export function ThresholdGauge({
  widget,
  result,
  onContextChange,
}: WidgetRendererProps) {
  // A health gauge reports the latest observation of its first series. A missing
  // scrape must not silently become an older healthy value or another series.
  const series = result.series?.[0];
  if (!series) return <EmptyState />;
  const point = series.points.reduce<
    (typeof series.points)[number] | undefined
  >(
    (latest, current) =>
      validTimestamp(current.timestamp) &&
      (!latest || current.timestamp >= latest.timestamp)
        ? current
        : latest,
    undefined,
  );
  const value =
    typeof point?.value === "number" && Number.isFinite(point.value)
      ? point.value
      : undefined;
  const options = widget.options ?? {};
  const min = options.min ?? Math.min(0, (options.max ?? 100) - 1);
  const max = options.max ?? Math.max(100, min + 1);
  const progress =
    value === undefined
      ? 0
      : Math.max(0, Math.min(1, (value - min) / (max - min)));
  const threshold =
    value === undefined
      ? undefined
      : thresholdForValue(value, options.thresholds);
  const color = threshold?.color ?? widget.color ?? "#53876a";
  const config = configSchema.parse(widget.config ?? {});
  const name = seriesName(series, 0);
  const exact =
    value === undefined ? "No data" : exactMetric(value, widget.unit);
  return (
    <div className={styles.gauge}>
      <ObservationDetails
        label={`${onContextChange ? "Select signal" : "Inspect value"} for ${widget.title}: ${exact}`}
        enabled={options.showTooltip !== false}
        className={styles.gaugeSelection}
        revision={result}
        onSelect={
          onContextChange
            ? () => onContextChange(metricContext(series, 0, true))
            : undefined
        }
        details={
          <MetricDetails
            series={series}
            index={0}
            point={point}
            unit={widget.unit}
            decimals={options.decimals}
            description="Latest sample"
          >
            <span className={styles.tooltipStatus}>
              {value === undefined
                ? "Unknown"
                : (threshold?.label ?? "Observed value")}
            </span>
            <span className={styles.tooltipRange}>
              Scale: {min} to {max}
              {widget.unit ? ` ${widget.unit}` : ""}
            </span>
          </MetricDetails>
        }
      >
        <span
          className={styles.gaugeValue}
          style={{
            color:
              widgetTextColor(options) ??
              (value === undefined ? undefined : color),
          }}
        >
          <span>
            {value === undefined
              ? "No data"
              : formatMetric(value, "", false, options.decimals)}
          </span>
          {value !== undefined && <small>{widget.unit}</small>}
        </span>
        {(onContextChange || options.showTooltip !== false) && (
          <span className={styles.gaugeHint}>
            {onContextChange ? "Select signal" : "Inspect value"}
          </span>
        )}
      </ObservationDetails>
      <div
        className={styles.gaugeTrack}
        role={value === undefined ? undefined : "meter"}
        aria-label={value === undefined ? undefined : widget.title}
        aria-valuemin={value === undefined ? undefined : min}
        aria-valuemax={value === undefined ? undefined : max}
        aria-valuenow={
          value === undefined ? undefined : Math.min(max, Math.max(min, value))
        }
        aria-valuetext={
          value === undefined
            ? undefined
            : `${exact}${threshold?.label ? ` · ${threshold.label}` : ""}`
        }
      >
        <div
          className={styles.gaugeFill}
          style={{ width: `${progress * 100}%`, background: color }}
        />
      </div>
      {value === undefined && (
        <span role="status">Unknown · latest sample has no finite value</span>
      )}
      {options.showLegend !== false && (
        <div className={styles.gaugeBounds}>
          <span>{formatMetric(min, widget.unit, false, options.decimals)}</span>
          <span>{threshold?.label}</span>
          <span>{formatMetric(max, widget.unit, false, options.decimals)}</span>
        </div>
      )}
      <span className={styles.gaugeLabel}>{config.label ?? name}</span>
    </div>
  );
}

/** Example of a bundled, trusted extension. Hosts can register others in the same way. */
export function registerDefaultWidgetPlugins() {
  if (getWidgetDefinition("plugin", "threshold-gauge")) return;
  registerWidgetPlugin({
    id: "threshold-gauge",
    label: "Threshold gauge",
    description: "A value against healthy limits",
    dataKind: "metrics",
    render: ThresholdGauge,
    defaultOptions: {
      min: 0,
      max: 100,
      decimals: 1,
      thresholds: [
        { value: 0, color: "#53876a", label: "Healthy" },
        { value: 70, color: "#b29658", label: "Elevated" },
        { value: 90, color: "#b64a3a", label: "Critical" },
      ],
    },
    parseConfig: (config) => configSchema.parse(config ?? {}),
  });
}

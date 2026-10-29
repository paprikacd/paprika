"use client";

import type { CSSProperties } from "react";
import { z } from "zod";
import { registerRecordWidgetPlugins } from "./records";
import { registerMetricDistributionPlugins } from "./metric-distributions";
import { registerRecordChartPlugins } from "./record-charts";
import { registerRichMetricPlugins } from "./rich-metrics";
import { registerOperationalRecordPlugins } from "./operational-records";
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
import { useEmbeddedWidget } from "../widget-presentation";
import meterStyles from "./capacity-meter.module.css";

export const gaugeConfigSchema = z.strictObject({
  label: z.string().max(100).optional(),
  display: z.enum(["linear", "segmented", "radial"]).optional(),
  segments: z.number().int().min(8).max(60).optional(),
  showThresholds: z.boolean().optional(),
  seriesMode: z.enum(["first", "all"]).optional(),
  columns: z.number().int().min(1).max(4).optional(),
  maxSeries: z.number().int().min(1).max(12).optional(),
});
type GaugeConfig = z.infer<typeof gaugeConfigSchema>;
type GaugeSeries = NonNullable<WidgetRendererProps["result"]["series"]>[number];

export function ThresholdGauge(props: WidgetRendererProps) {
  const parentEmbedded = useEmbeddedWidget();
  const config = gaugeConfigSchema.parse(props.widget.config ?? {});
  const series = props.result.series ?? [];
  if (!series.length) return <EmptyState />;
  if (config.seriesMode !== "all") return <GaugeItem {...props} config={config} series={series[0]} index={0} />;
  const selected = series.slice(0, config.maxSeries ?? 6);
  const columns = config.columns ?? (config.display === "radial" ? 3 : 1);
  const omitted = series.length - selected.length;
  return <div className={meterStyles.bankContainer}>
    <div className={meterStyles.bank} role="region" aria-label={`${props.widget.title} gauges`} tabIndex={props.embedded || parentEmbedded ? undefined : 0}
      data-gauge-columns={columns} data-gauge-bank-display={config.display ?? "linear"} style={{ "--gauge-columns": columns } as CSSProperties}>
      {selected.map((entry, index) => <GaugeItem key={index} {...props} config={config} series={entry} index={index} bank />)}
    </div>
    {(omitted > 0 || props.result.truncated) && <p className={meterStyles.bankNotice} role="status">
      {omitted > 0 && <span>Showing {selected.length} of {series.length} series</span>}
      {props.result.truncated && <span>Partial source response</span>}
    </p>}
  </div>;
}

function GaugeItem({
  widget,
  result,
  onContextChange,
  embedded,
  series,
  index,
  config,
  bank = false,
}: WidgetRendererProps & { series: GaugeSeries; index: number; config: GaugeConfig; bank?: boolean }) {
  const parentEmbedded = useEmbeddedWidget();
  const interactive = !embedded && !parentEmbedded;
  // Every gauge reports its own latest scrape, including missing observations.
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
  const color = threshold?.color ?? widget.color ?? "var(--gamma-chart-2)";
  const display = config.display ?? "linear";
  const segments = config.segments ?? 24;
  const markers = config.showThresholds === false ? [] : (options.thresholds ?? []).filter(item => item.value > min && item.value < max);
  const name = seriesName(series, index);
  const title = bank ? `${widget.title}: ${name}` : widget.title;
  const exact =
    value === undefined ? "No data" : exactMetric(value, widget.unit);
  return (
    <div className={`${styles.gauge} ${bank ? meterStyles.bankGauge : ""}`} data-gauge-series={name} data-gauge-kind={display}>
      <div className={display === "radial" ? meterStyles.radialBody : meterStyles.body}>
      <ObservationDetails
        label={`${onContextChange ? "Select signal" : "Inspect value"} for ${title}: ${exact}`}
        enabled={interactive && options.showTooltip !== false}
        className={`${styles.gaugeSelection} ${display === "radial" ? meterStyles.radialReading : ""}`}
        revision={result}
        onSelect={
          interactive && onContextChange
            ? () => onContextChange(metricContext(series, index, true))
            : undefined
        }
        details={
          <MetricDetails
            series={series}
            index={index}
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
          className={`${styles.gaugeValue} ${display === "radial" ? meterStyles.radialValue : ""}`}
          style={{
            color:
              widgetTextColor(options) ??
              (bank ? "var(--gamma-ink)" : value === undefined ? undefined : color),
          }}
        >
          <span>
            {value === undefined
              ? "No data"
              : formatMetric(value, "", false, options.decimals)}
          </span>
          {value !== undefined && <small>{widget.unit}</small>}
        </span>
        {!bank && interactive && (onContextChange || options.showTooltip !== false) && (
          <span className={styles.gaugeHint}>
            {onContextChange ? "Select signal" : "Inspect value"}
          </span>
        )}
      </ObservationDetails>
      <div
        className={display === "linear" ? styles.gaugeTrack : display === "radial" ? meterStyles.radial : meterStyles.segmented}
        data-gauge-display={display}
        style={display === "segmented" ? { "--meter-segments": segments } as CSSProperties : undefined}
        role={value === undefined ? undefined : "meter"}
        aria-label={value === undefined ? undefined : title}
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
        {display === "linear" ? <div
          className={styles.gaugeFill}
          style={{ width: `${progress * 100}%`, background: color }}
        /> : display === "segmented" ? Array.from({ length: segments }, (_, index) => {
          const start = index / segments;
          const filled = value !== undefined && progress > start;
          const segmentValue = min + ((index + .5) / segments) * (max - min);
          const segmentColor = thresholdForValue(segmentValue, options.thresholds)?.color ?? widget.color ?? "var(--gamma-chart-2)";
          return <span key={index} className={meterStyles.segment} aria-hidden="true" data-filled={filled}
            style={{ "--meter-fill": segmentColor, "--meter-fraction": filled ? Math.min(1, (progress - start) * segments) : 0 } as CSSProperties} />;
        }) : <svg viewBox="0 0 200 114" aria-hidden="true" className={meterStyles.arc}>
          <path d="M16 98 A84 84 0 0 1 184 98" pathLength={100} className={meterStyles.arcTrack} />
          {value !== undefined && <path d="M16 98 A84 84 0 0 1 184 98" pathLength={100}
            className={meterStyles.arcFill} stroke={color} strokeDasharray={`${progress * 100} 100`} />}
          <text x="14" y="112" textAnchor="start">{formatMetric(min, "", false, options.decimals)}</text>
          <text x="186" y="112" textAnchor="end">{formatMetric(max, "", false, options.decimals)}</text>
        </svg>}
      </div>
      </div>
      {markers.length > 0 && options.showLegend !== false && <div className={meterStyles.thresholds} aria-label="Threshold limits">
        {markers.map(marker => <span key={marker.value}><i aria-hidden="true" style={{ background: marker.color }} />{marker.label ?? "Threshold"} {formatMetric(marker.value, widget.unit, false, options.decimals)}</span>)}
      </div>}
      {value === undefined && (
        <span role="status" className={bank ? meterStyles.bankUnknown : undefined}>Unknown · latest sample has no finite value</span>
      )}
      {options.showLegend !== false && (
        <div className={styles.gaugeBounds}>
          <span>{formatMetric(min, widget.unit, false, options.decimals)}</span>
          <span>{threshold?.label}</span>
          <span>{formatMetric(max, widget.unit, false, options.decimals)}</span>
        </div>
      )}
      <span className={`${styles.gaugeLabel} ${bank ? meterStyles.bankLabel : ""}`} title={bank ? name : undefined}>{bank ? config.label ? `${config.label} · ${name}` : name : config.label ?? name}</span>
    </div>
  );
}

/** Example of a bundled, trusted extension. Hosts can register others in the same way. */
export function registerDefaultWidgetPlugins() {
  registerRecordWidgetPlugins();
  registerMetricDistributionPlugins();
  registerRecordChartPlugins();
  registerRichMetricPlugins();
  registerOperationalRecordPlugins();
  if (getWidgetDefinition("plugin", "threshold-gauge")) return;
  registerWidgetPlugin({
    id: "threshold-gauge",
    label: "Threshold gauge",
    description: "One or more latest values against healthy limits",
    dataKind: "metrics",
    render: ThresholdGauge,
    styleControls: ["unit", "decimals", "color", "legend", "tooltips"],
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
    defaultConfig: { display: "linear", segments: 24, showThresholds: true, seriesMode: "first", maxSeries: 6 },
    configFields: [
      { key: "display", label: "Meter appearance", kind: "select", options: [{ value: "linear", label: "Continuous" }, { value: "segmented", label: "Segmented" }, { value: "radial", label: "Radial" }] },
      { key: "seriesMode", label: "Series display", kind: "select", options: [{ value: "first", label: "First series" }, { value: "all", label: "Gauge for each series" }] },
      { key: "columns", label: "Gauge columns", kind: "number", min: 1, max: 4, step: 1, help: "Maximum columns in a gauge bank. Narrow panels wrap automatically. Defaults to three for radial gauges and one for rows." },
      { key: "maxSeries", label: "Maximum gauges", kind: "number", min: 1, max: 12, step: 1, help: "Applies when displaying a gauge for each series. Additional series are disclosed below the bank." },
      { key: "segments", label: "Segments", kind: "number", min: 8, max: 60, help: "Number of segments in a segmented meter." },
      { key: "showThresholds", label: "Show threshold labels", kind: "boolean" },
      { key: "label", label: "Meter label", kind: "text", placeholder: "Series name" },
    ],
    parseConfig: (config) => gaugeConfigSchema.parse(config ?? {}),
  });
}

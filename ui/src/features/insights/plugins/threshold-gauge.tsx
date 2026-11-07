"use client";

import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { z } from "zod";
import { registerRecordWidgetPlugins } from "./records";
import { registerMetricDistributionPlugins } from "./metric-distributions";
import { registerRecordChartPlugins } from "./record-charts";
import { registerRichMetricPlugins } from "./rich-metrics";
import { registerOperationalRecordPlugins } from "./operational-records";
import { registerGeoHeatmapPlugin } from "./geo-heatmap";
import { registerStatusGridPlugin } from "./status-grid";
import { registerUptimeViews } from "./uptime-views";
import { registerSmallMultiplesPlugin } from "./small-multiples";
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
import { compactSeriesLabels } from "../series-display";
import meterStyles from "./capacity-meter.module.css";

export const gaugeConfigSchema = z.strictObject({
  label: z.string().max(100).optional(),
  display: z.enum(["linear", "segmented", "radial"]).optional(),
  orientation: z.enum(["horizontal", "vertical"]).optional(),
  segments: z.number().int().min(8).max(60).optional(),
  showThresholds: z.boolean().optional(),
  seriesMode: z.enum(["first", "all"]).optional(),
  columns: z.number().int().min(1).max(12).optional(),
  maxSeries: z.number().int().min(1).max(12).optional(),
  showStatus: z.boolean().optional(),
});
type GaugeConfig = z.infer<typeof gaugeConfigSchema>;
type GaugeSeries = NonNullable<WidgetRendererProps["result"]["series"]>[number];

function latestGaugePoint(series: GaugeSeries) {
  return series.points.reduce<(typeof series.points)[number] | undefined>((latest, point) =>
    validTimestamp(point.timestamp) && (!latest || point.timestamp >= latest.timestamp) ? point : latest, undefined);
}

function gaugeBounds(widget: WidgetRendererProps["widget"]) {
  // At large magnitudes adding or subtracting one can round back to the same
  // number. Choose a representable step before inferring the missing bound.
  const step = (value: number) => Math.max(1, Math.abs(value) * Number.EPSILON);
  const authoredMax = widget.options?.max ?? 100;
  const min = widget.options?.min ?? Math.min(0, authoredMax - step(authoredMax));
  return { min, max: widget.options?.max ?? Math.max(100, min + step(min)) };
}

/** Preserve finite positions when opposite-signed bounds overflow their span. */
function gaugeFraction(value: number, min: number, max: number) {
  if (value <= min) return 0;
  if (value >= max) return 1;
  const span = max - min;
  return Number.isFinite(span) ? (value - min) / span : (value / 2 - min / 2) / (max / 2 - min / 2);
}

/** Keep the configured cells honest: below four pixels use the continuous scale. */
export function gaugeTrackLayout(extent: number | undefined, segments: number) {
  return {
    continuous: extent !== undefined && extent < segments * 4,
    gap: extent === undefined ? 2 : Math.max(0, Math.min(3, (extent - segments * 4) / (segments - 1))),
  };
}

/** The label owns a separate row; an arc must fit the remaining frame in both axes. */
export function gaugeArcSize(width: number, height: number, maximumWidth: number) {
  const arcWidth = Math.max(0, Math.min(width, height * 200 / 114, maximumWidth));
  return { width: arcWidth, height: Math.max(0, Math.min(height, arcWidth * 114 / 200)) };
}

function RadialLayout({ reading, track, bank }: { reading: ReactNode; track: ReactNode; bank: boolean }) {
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number }>();
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const next = gaugeArcSize(bounds.width, bounds.height, bank ? 200 : 240);
      setSize(previous => previous?.width === next.width && previous.height === next.height ? previous : next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [bank]);
  return <div className={meterStyles.radialFrame} ref={frame} data-gauge-arc-frame>
    <div className={meterStyles.radialBody} data-gauge-arc-body style={size ? { width: size.width, height: size.height, "--gauge-arc-width": `${size.width}px`, "--gauge-arc-height": `${size.height}px` } as CSSProperties : undefined}>{reading}{track}</div>
  </div>;
}

function GaugeTrack({ widget, config, value, title }: {
  widget: WidgetRendererProps["widget"]; config: GaugeConfig; value: number | undefined; title: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [extent, setExtent] = useState<number>();
  const display = config.display ?? "linear", orientation = config.orientation ?? "horizontal", segments = config.segments ?? 24;
  useLayoutEffect(() => {
    if (display !== "segmented") return;
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      const next = Math.floor(orientation === "vertical" ? element.clientHeight || bounds.height : element.clientWidth || bounds.width);
      if (next > 0) setExtent(previous => previous === next ? previous : next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [display, orientation]);
  const { min, max } = gaugeBounds(widget);
  const progress = value === undefined ? 0 : gaugeFraction(value, min, max);
  const threshold = value === undefined ? undefined : thresholdForValue(value, widget.options?.thresholds);
  const baseColor = widget.color ?? "var(--gamma-chart-2)", color = threshold?.color ?? baseColor;
  const layout = gaugeTrackLayout(extent, segments);
  const continuous = display === "segmented" && layout.continuous;
  const boundaries = [min, ...(widget.options?.thresholds ?? []).filter(threshold => threshold.value > min && threshold.value < max).map(threshold => threshold.value), max];
  const gradient = boundaries.slice(0, -1).flatMap((start, index) => {
    const end = boundaries[index + 1], fill = thresholdForValue(start / 2 + end / 2, widget.options?.thresholds)?.color ?? baseColor;
    return [`${fill} ${gaugeFraction(start, min, max) * 100}%`, `${fill} ${gaugeFraction(end, min, max) * 100}%`];
  });
  return <div ref={ref}
    className={display === "radial" ? meterStyles.radial : `${meterStyles.track} ${display === "segmented" && !continuous ? meterStyles.segmented : meterStyles.solid}`}
    data-gauge-display={display} data-gauge-orientation={display === "radial" ? undefined : orientation}
    data-gauge-rendering={display === "radial" ? "radial" : display === "linear" || continuous ? "continuous" : "segmented"}
    data-gauge-progress={progress} data-gauge-unknown={value === undefined || undefined}
    style={display === "segmented" ? { "--meter-segments": segments, "--meter-gap": `${layout.gap}px` } as CSSProperties : undefined}
    role={value === undefined ? undefined : "meter"} aria-label={value === undefined ? undefined : title}
    aria-valuemin={value === undefined ? undefined : min} aria-valuemax={value === undefined ? undefined : max}
    aria-valuenow={value === undefined ? undefined : Math.min(max, Math.max(min, value))}
    aria-valuetext={value === undefined ? undefined : `${exactMetric(value, widget.unit)}${threshold?.label ? ` · ${threshold.label}` : ""}`}
    aria-description={continuous ? "Continuous threshold scale" : undefined}>
    {display === "radial" ? <><svg viewBox="0 0 200 114" aria-hidden="true" className={meterStyles.arc}>
      <path d="M16 98 A84 84 0 0 1 184 98" pathLength={100} className={meterStyles.arcTrack} />
      {value !== undefined && <path d="M16 98 A84 84 0 0 1 184 98" pathLength={100} className={meterStyles.arcFill} stroke={color} strokeDasharray={`${progress * 100} 100`} />}
    </svg><div className={meterStyles.radialBounds} data-gauge-radial-bounds aria-hidden="true">
      <span data-gauge-bound="min" title={exactMetric(min, widget.unit)}>{formatMetric(min, "", false, widget.options?.decimals)}</span>
      <span data-gauge-bound="max" title={exactMetric(max, widget.unit)}>{formatMetric(max, "", false, widget.options?.decimals)}</span>
    </div></> : display === "segmented" && !continuous ? Array.from({ length: segments }, (_, index) => {
      const start = index / segments, fraction = value === undefined ? 0 : Math.max(0, Math.min(1, (progress - start) * segments));
      const middle = (index + .5) / segments, segmentValue = min * (1 - middle) + max * middle;
      const segmentColor = thresholdForValue(segmentValue, widget.options?.thresholds)?.color ?? baseColor;
      return <span key={index} className={meterStyles.segment} aria-hidden="true" data-filled={fraction > 0}
        style={{ "--meter-fill": segmentColor, "--meter-fraction": fraction } as CSSProperties} />;
    }) : value !== undefined && <div aria-hidden="true" className={meterStyles.fill} data-gauge-solid-fill
      style={continuous ? {
        background: `linear-gradient(to ${orientation === "vertical" ? "top" : "right"}, ${gradient.join(", ")})`,
        clipPath: orientation === "vertical" ? `inset(${(1 - progress) * 100}% 0 0)` : `inset(0 ${(1 - progress) * 100}% 0 0)`,
      } : orientation === "vertical" ? { height: `${progress * 100}%`, background: color } : { width: `${progress * 100}%`, background: color }} />}
  </div>;
}

function GaugeLegend({ widget, config, compactRows = false }: Pick<WidgetRendererProps, "widget"> & { config: GaugeConfig; compactRows?: boolean }) {
  if (widget.options?.showLegend === false) return null;
  const { min, max } = gaugeBounds(widget);
  const markers = config.showThresholds === false ? [] : (widget.options?.thresholds ?? []).filter(item => item.value > min && item.value < max);
  return <div className={meterStyles.legend} data-gauge-legend data-gauge-legend-layout={compactRows ? "rows" : undefined}>
    <div className={meterStyles.bounds}>{compactRows ? <span>Scale {formatMetric(min, widget.unit, false, widget.options?.decimals)} – {formatMetric(max, widget.unit, false, widget.options?.decimals)}</span> : <><span>{formatMetric(min, widget.unit, false, widget.options?.decimals)}</span><span>{formatMetric(max, widget.unit, false, widget.options?.decimals)}</span></>}</div>
    {markers.length > 0 && <div className={meterStyles.thresholds} aria-label="Threshold limits">{markers.map(marker => <span key={marker.value}><i aria-hidden="true" style={{ background: marker.color }} />{marker.label ?? "Threshold"} {formatMetric(marker.value, widget.unit, false, widget.options?.decimals)}</span>)}</div>}
  </div>;
}

export function ThresholdGauge(props: WidgetRendererProps) {
  const config = gaugeConfigSchema.parse(props.widget.config ?? {}), series = props.result.series ?? [];
  const bounds = gaugeBounds(props.widget);
  if (!Number.isFinite(bounds.min) || !Number.isFinite(bounds.max) || bounds.min >= bounds.max)
    return <p className={meterStyles.bankNotice} role="alert">Choose finite gauge bounds with a maximum greater than the minimum.</p>;
  if (!series.length) return <EmptyState />;
  if (config.seriesMode !== "all") return <GaugeItem {...props} config={config} series={series[0]} index={0} />;
  return <GaugeBank {...props} config={config} series={series} />;
}

function GaugeBank(props: WidgetRendererProps & { config: GaugeConfig; series: GaugeSeries[] }) {
  const { config, series } = props;
  const parentEmbedded = useEmbeddedWidget(), bank = useRef<HTMLDivElement>(null), hintElement = useRef<HTMLParagraphElement>(null), hint = useId();
  const [overflow, setOverflow] = useState(false);
  const selected = series.slice(0, config.maxSeries ?? 6), omitted = series.length - selected.length;
  const displayLabels = compactSeriesLabels(selected);
  const orientation = config.orientation ?? "horizontal", columns = config.columns ?? (config.display === "radial" ? 3 : orientation === "vertical" ? 4 : 1);
  useLayoutEffect(() => {
    const element = bank.current;
    if (!element) return;
    let cancelled = false;
    const measure = () => {
      // The hint must not create the overflow that keeps itself visible after a resize.
      const availableHeight = element.clientHeight + (hintElement.current?.getBoundingClientRect().height ?? 0);
      if (!cancelled) setOverflow((element.clientHeight > 0 && element.scrollHeight > availableHeight + 1) || (element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1));
    };
    measure();
    // The dashboard grid may finish its initial responsive placement after the
    // first measurement without changing the bank's own observed box. Recheck
    // after layout settles so a temporary two-column state cannot leave a hint.
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(measure); });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    for (const child of element.children) observer?.observe(child);
    // The measured arc can shrink inside an unchanged grid cell after the
    // responsive width is known; that can clear horizontal overflow by itself.
    for (const arc of element.querySelectorAll("[data-gauge-arc-body]")) observer?.observe(arc);
    void document.fonts?.ready.then(measure);
    return () => { cancelled = true; cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [series, columns, config.display, config.maxSeries, orientation]);
  const readingWidth = Math.min(22, Math.max(7, ...selected.map(series => {
    const value = latestGaugePoint(series)?.value;
    return typeof value === "number" && Number.isFinite(value) ? formatMetric(value, props.widget.unit, false, props.widget.options?.decimals).length + 1 : 7;
  })));
  const compactRows = config.display !== "radial" && orientation === "horizontal";
  return <div className={meterStyles.bankContainer} data-gauge-bank-layout={compactRows ? "rows" : undefined}>
    <div ref={bank} className={meterStyles.bank} role="region" aria-label={`${props.widget.title} gauges`} tabIndex={props.embedded || parentEmbedded ? undefined : 0} aria-describedby={overflow ? hint : undefined}
      data-gauge-columns={columns} data-gauge-bank-display={config.display ?? "linear"} data-gauge-bank-orientation={config.display === "radial" ? undefined : orientation}
      style={{ "--gauge-columns": columns, "--gauge-reading-width": `${readingWidth}ch` } as CSSProperties}>
      {selected.map((entry, index) => <GaugeItem key={index} {...props} config={config} series={entry} index={index} displayLabel={displayLabels[index]} bank />)}
    </div>
    {overflow && <p ref={hintElement} className={meterStyles.bankHint} id={hint} data-gauge-overflow-hint>Scroll to see all gauges <span aria-hidden="true">↕</span></p>}
    <GaugeLegend widget={props.widget} config={config} compactRows={compactRows} />
    {(omitted > 0 || props.result.truncated) && <p className={meterStyles.bankNotice} role="status">
      {omitted > 0 && <span>Showing {selected.length} of {series.length} series</span>}
      {props.result.truncated && <span>Partial source response</span>}
    </p>}
  </div>;
}

function GaugeItem({ widget, result, onContextChange, embedded, series, index, config, displayLabel, bank = false }: WidgetRendererProps & { series: GaugeSeries; index: number; config: GaugeConfig; displayLabel?: string; bank?: boolean }) {
  const parentEmbedded = useEmbeddedWidget(), interactive = !embedded && !parentEmbedded;
  const point = latestGaugePoint(series), value = typeof point?.value === "number" && Number.isFinite(point.value) ? point.value : undefined;
  const options = widget.options ?? {}, { min, max } = gaugeBounds(widget);
  const threshold = value === undefined ? undefined : thresholdForValue(value, options.thresholds);
  const thresholdIndex = threshold ? options.thresholds?.indexOf(threshold) ?? -1 : -1;
  const nextThreshold = thresholdIndex >= 0 ? options.thresholds?.[thresholdIndex + 1] : undefined;
  const band = threshold && options.thresholds?.length === 1 ? "All values" :
    thresholdIndex === 0 && nextThreshold ? `Below ${exactMetric(nextThreshold.value, widget.unit)}` :
    threshold && thresholdIndex > 0 ? `≥ ${exactMetric(threshold.value, widget.unit)}${nextThreshold ? ` and < ${exactMetric(nextThreshold.value, widget.unit)}` : ""}` : undefined;
  const display = config.display ?? "linear", orientation = config.orientation ?? "horizontal";
  const name = seriesName(series, index), title = bank ? `${widget.title}: ${name}` : widget.title;
  const exact = value === undefined ? "No data" : exactMetric(value, widget.unit);
  const label = bank && config.label ? `${config.label} · ${name}` : config.label ?? name;
  const visualLabel = bank && config.label ? `${config.label} · ${displayLabel ?? name}` : config.label ?? displayLabel ?? name;
  const labelContent = visualLabel === label ? label : <><span aria-hidden="true">{visualLabel}</span><span className={meterStyles.srOnly}>{label}</span></>;
  const reading = <ObservationDetails
    label={`${onContextChange ? "Select signal" : "Inspect value"} for ${title}: ${exact}`}
    enabled={interactive && options.showTooltip !== false}
    avoidWidget
    className={`${styles.gaugeSelection} ${display === "radial" ? meterStyles.radialReading : meterStyles.reading}`}
    revision={result}
    onSelect={interactive && onContextChange ? () => onContextChange(metricContext(series, index, true)) : undefined}
    details={<MetricDetails widget={widget} series={series} index={index} point={point} unit={widget.unit} decimals={options.decimals} description="Latest sample">
      <span className={styles.tooltipStatus}>{threshold && <i data-gauge-threshold-swatch aria-hidden="true" style={{ background: threshold.color }} />}{value === undefined ? "Unknown" : threshold?.label ?? "Observed value"}</span>
      {band && <span className={styles.tooltipRange}>{band}</span>}
      <span className={styles.tooltipRange}>Scale: {min} to {max}{widget.unit ? ` ${widget.unit}` : ""}</span>
    </MetricDetails>}>
    <span className={`${styles.gaugeValue} ${display === "radial" ? meterStyles.radialValue : meterStyles.value} ${bank && threshold ? meterStyles.statusValue : ""}`}
      data-gauge-value={value === undefined ? "unknown" : value} title={interactive && options.showTooltip !== false ? undefined : exact}
      style={{ color: widgetTextColor(options) ?? (bank ? undefined : threshold?.color ?? widget.color), ...(bank && threshold ? { "--gauge-status-color": threshold.color } : {}) } as CSSProperties}>
      <span data-gauge-number>{value === undefined ? "No data" : formatMetric(value, "", false, options.decimals)}</span>{value !== undefined && widget.unit && <small data-gauge-unit>{widget.unit}</small>}
    </span>
  </ObservationDetails>;
  const track = <GaugeTrack widget={widget} config={config} value={value} title={title} />;
  const showStatus = bank && display !== "radial" && orientation === "horizontal" && config.showStatus;
  const statusLabel = value === undefined ? "Unknown" : threshold?.label ?? "Observed";
  return <div className={meterStyles.item} data-gauge-series={name} data-gauge-kind={display}
    data-gauge-orientation={display === "radial" ? undefined : orientation} data-gauge-bank-item={bank || undefined}>
    {display === "radial" ? <><RadialLayout reading={reading} track={track} bank={bank} /><span className={meterStyles.label} data-gauge-label title={label}>{labelContent}</span></> :
      <div className={meterStyles.body} data-gauge-show-status={showStatus || undefined}><span className={meterStyles.label} data-gauge-label title={label}>{labelContent}</span>{track}{reading}{showStatus && <span className={meterStyles.status} data-gauge-status title={statusLabel} style={{ "--gauge-status-color": threshold?.color ?? "var(--gamma-muted)" } as CSSProperties}><i aria-hidden="true" />{statusLabel}</span>}</div>}
    {value === undefined && <span role="status" className={meterStyles.srOnly}>Unknown · latest sample has no finite value</span>}
    {!bank && <GaugeLegend widget={widget} config={config} />}
  </div>;
}

/** Example of a bundled, trusted extension. Hosts can register others in the same way. */
export function registerDefaultWidgetPlugins() {
  registerSmallMultiplesPlugin();
  registerStatusGridPlugin();
  registerUptimeViews();
  registerRecordWidgetPlugins();
  registerMetricDistributionPlugins();
  registerRecordChartPlugins();
  registerRichMetricPlugins();
  registerOperationalRecordPlugins();
  registerGeoHeatmapPlugin();
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
    defaultConfig: { display: "linear", orientation: "horizontal", segments: 24, showThresholds: true, seriesMode: "first", maxSeries: 6 },
    configFields: [
      { key: "display", label: "Meter appearance", kind: "select", options: [{ value: "linear", label: "Continuous" }, { value: "segmented", label: "Segmented" }, { value: "radial", label: "Radial" }] },
      { key: "orientation", label: "Bar orientation", kind: "select", options: [{ value: "horizontal", label: "Horizontal rows" }, { value: "vertical", label: "Vertical columns" }], help: "Applies to continuous and segmented bars. Radial gauges keep their arc layout." },
      { key: "seriesMode", label: "Series display", kind: "select", options: [{ value: "first", label: "First series" }, { value: "all", label: "Gauge for each series" }] },
      { key: "columns", label: "Gauge columns", kind: "number", min: 1, max: 12, step: 1, help: "Maximum columns in a gauge bank. Narrow panels wrap automatically. Defaults to three for radial gauges, four for vertical bars and one for horizontal rows." },
      { key: "maxSeries", label: "Maximum gauges", kind: "number", min: 1, max: 12, step: 1, help: "Applies when displaying a gauge for each series. Additional series are disclosed below the bank." },
      { key: "segments", label: "Segments", kind: "number", min: 8, max: 60, help: "Requested segments. Narrow or short tracks use a continuous threshold scale when separated cells cannot fit." },
      { key: "showThresholds", label: "Show threshold labels", kind: "boolean" },
      { key: "showStatus", label: "Show status beside each horizontal gauge", kind: "boolean", help: "Shows the matching threshold label or Unknown for each gauge in a horizontal series bank." },
      { key: "label", label: "Meter label", kind: "text", placeholder: "Series name" },
    ],
    parseConfig: (config) => gaugeConfigSchema.parse(config ?? {}),
  });
}

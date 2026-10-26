"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { areaY } from "@tanstack/charts/area";
import { barY } from "@tanstack/charts/bar";
import { focusGroupX } from "@tanstack/charts/focus";
import { observationFocus, usePlotTooltip } from "./plot-tooltip";
import { lineY } from "@tanstack/charts/line";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { defineChart } from "@tanstack/charts/scene";
import { tooltip } from "@tanstack/charts/tooltip";
import { portal } from "@tanstack/charts/tooltip/portal";
import type { QueryResult, Widget, WidgetOptions, Threshold } from "./schema";
import styles from "./charts.module.css";
import configStyles from "./chart-styles.module.css";
import contextStyles from "./widget-context.module.css";
import type { DrilldownContext } from "./drilldown";
import { readableTextColor, widgetTextColor } from "./appearance";
import {
  downsamplePoints,
  latestPoint,
  seriesName,
  formatMetric,
  formatMetricDetails,
  exactMetric,
  formatTimeTick,
  timeFormat,
  dateTimeFormat,
  fullDateTimeFormat,
} from "./chart-data";
export {
  downsamplePoints,
  latestPoint,
  seriesName,
  formatMetric,
  exactMetric,
  formatTimeTick,
} from "./chart-data";
import { TooltipSubWidget } from "./tooltip-widgets";
import { StatSparkline } from "./stat-sparkline";
import sparklineStyles from "./stat-sparkline.module.css";
import {
  useWidgetPresentation,
  useEmbeddedWidget,
} from "./widget-presentation";

import { lockBodyScroll } from "./gamma/scroll-lock";
import { GammaButton } from "./gamma/button";
import { GammaSelect } from "./gamma/select";
import { inheritGammaTheme } from "./gamma/inherit-theme";
import {
  contextKey,
  metricContext,
  traceContext,
  validTimestamp,
} from "./widget-context";
import { d3Curve } from "@tanstack/charts/d3/shape";
import { curveMonotoneX, curveStepAfter } from "d3-shape";

type Series = NonNullable<QueryResult["series"]>[number];
type Point = Series["points"][number];
type Trace = NonNullable<QueryResult["traces"]>[number];

const PALETTE = [
  "var(--gamma-chart-1, #c46146)",
  "var(--gamma-chart-2, #6e947a)",
  "var(--gamma-chart-3, #6a8a9c)",
  "var(--gamma-chart-4, #b29658)",
  "var(--gamma-chart-5, #9c82a1)",
  "var(--gamma-chart-6, #7d9690)",
  "var(--gamma-chart-7, #ac805f)",
  "var(--gamma-chart-8, #969f5c)",
];
const MAX_SERIES = 12;
const MAX_ROWS = 100;
const themedPortal: typeof portal = {
  ...portal,
  id: "paprika-themed-portal",
  create(context, options) {
    const stopTheme = inheritGammaTheme(context.container, context.element);
    const instance = portal.create(context, options);
    return { ...instance, destroy() { stopTheme(); instance.destroy(); } };
  },
};

const chartTheme = {
  foreground: "var(--gamma-ink, #27332e)",
  muted: "var(--gamma-muted, #626e65)",
  grid: "var(--gamma-border, #dfe4db)",
  background: "transparent",
  palette: PALETTE,
};

const EMPTY_OPTIONS: WidgetOptions = Object.freeze({});
const CURVES = {
  linear: undefined,
  step: d3Curve(curveStepAfter),
  monotone: d3Curve(curveMonotoneX),
};
export const DEFAULT_HEATMAP_THRESHOLDS: Threshold[] = [
  { value: 0, color: "#b64a3a", label: "Unhealthy" },
  { value: 1, color: "#53876a", label: "Healthy" },
];

export function thresholdForValue(
  value: number,
  thresholds?: readonly Threshold[],
) {
  if (!Number.isFinite(value) || !thresholds?.length) return undefined;
  let match = thresholds[0];
  for (const threshold of thresholds) {
    if (threshold.value > value) break;
    match = threshold;
  }
  return match;
}

export function resolveChartDomain(
  series: Series[],
  options: WidgetOptions,
): [number, number] | undefined {
  if (options.min === undefined && options.max === undefined) return undefined;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const entry of series)
    for (const point of entry.points)
      if (
        validTimestamp(point.timestamp) &&
        typeof point.value === "number" &&
        Number.isFinite(point.value)
      ) {
        minimum = Math.min(minimum, point.value);
        maximum = Math.max(maximum, point.value);
      }
  let min = options.min ?? (Number.isFinite(minimum) ? minimum : 0);
  let max = options.max ?? (Number.isFinite(maximum) ? maximum : 1);
  if (min >= max) {
    if (options.min !== undefined) max = min + Math.max(1, Math.abs(min) * 0.1);
    else min = max - Math.max(1, Math.abs(max) * 0.1);
  }
  return [min, max];
}

function configuredTheme(options: WidgetOptions) {
  const textColor = widgetTextColor(options);
  return {
    ...chartTheme,
    ...(textColor ? { foreground: textColor, muted: textColor } : {}),
  };
}

function usePlotSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 500, height: 180 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const width = Math.round(bounds.width);
      const height = Math.max(48, Math.round(bounds.height));
      setSize((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(schedule);
    observer?.observe(element);
    window.addEventListener("resize", schedule);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, []);
  return { ref, ...size };
}

export function responsiveChartTicks(width: number, height: number) {
  return {
    x: Math.max(2, Math.min(6, Math.floor((width - 60) / 80))),
    y: height < 130 ? 2 : height < 190 ? 3 : 4,
  };
}

function TimeSeriesChart({
  widget,
  series,
}: {
  widget: Widget;
  series: Series[];
}) {
  const { ref, width, height } = usePlotSize();
  const { embedded, showAxis, descriptionId } = useWidgetPresentation();
  const associateDescription = useCallback(
    ({ svg }: { svg: SVGSVGElement }) => {
      if (descriptionId) svg.setAttribute("aria-describedby", descriptionId);
    },
    [descriptionId],
  );
  const ticks = responsiveChartTicks(width, height);
  const options = widget.options ?? EMPTY_OPTIONS;
  const tooltipEnabled =
    !embedded && options.showTooltip !== false && !!options.tooltipView;
  const plotTooltip = usePlotTooltip(widget, series, tooltipEnabled);
  const domain = useMemo(
    () => resolveChartDomain(series.slice(0, MAX_SERIES), options),
    [series, options],
  );
  const data = useMemo(
    () =>
      series.slice(0, MAX_SERIES).map((entry, index) => ({
        name: seriesName(entry, index),
        color:
          index === 0 && widget.color
            ? widget.color
            : PALETTE[index % PALETTE.length],
        points: downsamplePoints(entry.points).map((point) => ({
          ...point,
          series: seriesName(entry, index),
          seriesIndex: index,
        })),
      })),
    [series, widget.color],
  );
  const timeSpan = useMemo(() => {
    const bounds = data.flatMap((entry) =>
      entry.points.length
        ? [entry.points[0].timestamp, entry.points.at(-1)!.timestamp]
        : [],
    );
    return bounds.length ? Math.max(...bounds) - Math.min(...bounds) : 0;
  }, [data]);

  const definition = useMemo(
    () =>
      defineChart({
        marks: data.flatMap((entry, index) => [
          ...(options.display === "area"
            ? [
                areaY(entry.points, {
                  id: `area-${index}`,
                  x: "timestamp",
                  y: "value",
                  fill: entry.color,
                  fillOpacity: options.fillOpacity ?? 0.12,
                  curve: CURVES[options.curve ?? "linear"],
                }),
              ]
            : []),
          lineY(entry.points, {
            id: `line-${index}`,
            x: "timestamp",
            y: "value",
            stroke: entry.color,
            strokeWidth: options.lineWidth ?? 1.8,
            curve: CURVES[options.curve ?? "linear"],
            points: entry.points.some(
              (point, position, points) =>
                point.value !== null &&
                (position === 0 || points[position - 1].value === null) &&
                (position === points.length - 1 ||
                  points[position + 1].value === null),
            ),
          }),
        ]),
        scales: {
          x: {
            scale: scaleLinear,
            axis: !showAxis
              ? false
              : {
                  label: options.xAxisLabel
                    ? { text: options.xAxisLabel, opacity: 1 }
                    : undefined,
                  line: false,
                  ticks: {
                    count: ticks.x,
                    line: false,
                    padding: 10,
                    format: (value: number) => formatTimeTick(value, timeSpan),
                  },
                  tickLabels: {
                    opacity: 1,
                    fontSize: 10,
                    thin: { minGap: 12, priority: "ends" },
                  },
                },
          },
          y: {
            scale: domain ? scaleLinear().domain(domain) : scaleLinear,
            nice: !domain,
            grid:
              options.showGrid === false
                ? false
                : {
                    stroke: "var(--gamma-border, #dfe4db)",
                    strokeDasharray: "3 4",
                  },
            axis: !showAxis
              ? false
              : {
                  label: options.yAxisLabel
                    ? { text: options.yAxisLabel, opacity: 1 }
                    : undefined,
                  line: false,
                  ticks: {
                    count: ticks.y,
                    line: false,
                    format: (value: number) =>
                      formatMetric(value, widget.unit, true, options.decimals),
                  },
                  tickLabels: {
                    opacity: 1,
                    fontSize: 10,
                    thin: { minGap: 12, priority: "ends" },
                  },
                },
          },
        },
        margin: !showAxis
          ? { top: 8, right: 8, bottom: 8, left: 8 }
          : {
              top: height < 130 ? 4 : 10,
              right: 12,
              bottom: options.xAxisLabel ? 47 : 29,
              left: options.yAxisLabel ? 67 : 47,
            },
        clip: true,
        theme: configuredTheme(options),
        focus: embedded
          ? false
          : tooltipEnabled
            ? observationFocus
            : focusGroupX,
        svgAnimation: false,
        tooltip:
          options.showTooltip === false
            ? false
            : tooltipEnabled
              ? { use: plotTooltip.extension, sticky: true }
              : {
                  use: tooltip,
                  portal: themedPortal,
                  sticky: true,
                  className: styles.tooltip,
                  format: (point) =>
                    `${point.datum.series}\n${dateTimeFormat.format(new Date(point.datum.timestamp))}\n${typeof point.datum.value === "number" ? formatMetricDetails(point.datum.value, widget.unit, options.decimals) : "No data"}`,
                },
      }),
    [
      data,
      widget.unit,
      options,
      domain,
      ticks.x,
      ticks.y,
      height,
      timeSpan,
      showAxis,
      embedded,
      tooltipEnabled,
      plotTooltip.extension,
    ],
  );

  return (
    <div className={styles.chart}>
      <div
        className={styles.plot}
        ref={ref}
        onPointerMoveCapture={
          tooltipEnabled ? plotTooltip.onInteract : undefined
        }
        onPointerDownCapture={
          tooltipEnabled ? plotTooltip.onInteract : undefined
        }
        onKeyDownCapture={tooltipEnabled ? plotTooltip.onInteract : undefined}
        onFocusCapture={tooltipEnabled ? plotTooltip.onFocus : undefined}
        onBlurCapture={tooltipEnabled ? plotTooltip.onBlur : undefined}
      >
        <Chart
          definition={definition}
          height={height}
          width={width}
          style={{ width: "100%", maxWidth: "100%" }}
          ariaLabel={widget.title}
          tabIndex={embedded ? -1 : undefined}
          onRender={embedded ? associateDescription : plotTooltip.onRender}
          onFocusChange={tooltipEnabled ? plotTooltip.onFocusChange : undefined}
          onSelect={tooltipEnabled ? plotTooltip.onSelect : undefined}
          ariaDescription={`${data.length} time series.${embedded ? "" : " Use arrow keys to explore individual values."}`}
        />
      </div>
      {options.showLegend !== false && (
        <div className={styles.legend}>
          {data.map((entry, index) => (
            <span
              className={styles.legendItem}
              key={`${entry.name}-${index}`}
              title={options.showTooltip === false ? undefined : entry.name}
            >
              <span
                className={styles.swatch}
                style={{ background: entry.color }}
              />
              <span>{entry.name}</span>
            </span>
          ))}
        </div>
      )}
      {plotTooltip.panel}
      {!embedded && <ChartDataInspector widget={widget} series={series} />}
      {series.length > MAX_SERIES && (
        <span className={styles.notice} role="status">
          First {MAX_SERIES} of {series.length} series
        </span>
      )}
    </div>
  );
}

function BarChart({ widget, series }: { widget: Widget; series: Series[] }) {
  const { ref, width, height } = usePlotSize();
  const { embedded, showAxis, descriptionId } = useWidgetPresentation();
  const associateDescription = useCallback(
    ({ svg }: { svg: SVGSVGElement }) => {
      if (descriptionId) svg.setAttribute("aria-describedby", descriptionId);
    },
    [descriptionId],
  );
  const ticks = responsiveChartTicks(width, height);
  const options = widget.options ?? EMPTY_OPTIONS;
  const tooltipEnabled =
    !embedded && options.showTooltip !== false && !!options.tooltipView;
  const plotTooltip = usePlotTooltip(widget, series, tooltipEnabled);
  const rows = useMemo(
    () =>
      series.slice(0, MAX_SERIES).flatMap((entry, index) => {
        const point = latestPoint(entry);
        return point
          ? [
              {
                name: seriesName(entry, index),
                seriesIndex: index,
                label: String(index + 1),
                value: point.value,
                timestamp: point.timestamp,
                color:
                  thresholdForValue(point.value, options.thresholds)?.color ??
                  (index === 0 && widget.color
                    ? widget.color
                    : PALETTE[index % PALETTE.length]),
              },
            ]
          : [];
      }),
    [series, widget.color, options.thresholds],
  );
  const domain = useMemo(
    () =>
      resolveChartDomain(
        rows.map((row) => ({
          name: row.name,
          labels: {},
          points: [{ timestamp: row.timestamp, value: row.value }],
        })),
        options,
      ),
    [rows, options],
  );
  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          barY(rows, {
            x: "label",
            y: "value",
            fill: (row) => row.color,
            maxThickness: 42,
            radius: 3,
            inset: 3,
          }),
        ],
        scales: {
          x: {
            scale: scaleBand,
            axis: !showAxis
              ? false
              : {
                  label: options.xAxisLabel
                    ? { text: options.xAxisLabel, opacity: 1 }
                    : undefined,
                  line: false,
                  ticks: {
                    line: false,
                    format: (value: string) => {
                      const name =
                        rows.find((row) => row.label === value)?.name || value;
                      const characters = Math.max(
                        4,
                        Math.min(
                          16,
                          Math.floor(
                            (width - 70) / Math.max(1, rows.length) / 6,
                          ),
                        ),
                      );
                      return name.length > characters
                        ? `${name.slice(0, characters - 1)}…`
                        : name;
                    },
                  },
                  tickLabels: {
                    opacity: 1,
                    fontSize: 10,
                    thin: { minGap: 12, priority: "ends" },
                  },
                },
          },
          y: {
            scale: domain ? scaleLinear().domain(domain) : scaleLinear,
            nice: !domain,
            grid:
              options.showGrid === false
                ? false
                : {
                    stroke: "var(--gamma-border, #dfe4db)",
                    strokeDasharray: "3 4",
                  },
            axis: !showAxis
              ? false
              : {
                  label: options.yAxisLabel
                    ? { text: options.yAxisLabel, opacity: 1 }
                    : undefined,
                  line: false,
                  ticks: {
                    count: ticks.y,
                    line: false,
                    format: (value: number) =>
                      formatMetric(value, widget.unit, true, options.decimals),
                  },
                  tickLabels: {
                    opacity: 1,
                    fontSize: 10,
                    thin: { minGap: 12, priority: "ends" },
                  },
                },
          },
        },
        margin: !showAxis
          ? { top: 8, right: 8, bottom: 8, left: 8 }
          : {
              top: height < 130 ? 4 : 12,
              right: 10,
              bottom: options.xAxisLabel ? 47 : 28,
              left: options.yAxisLabel ? 67 : 47,
            },
        clip: true,
        theme: configuredTheme(options),
        svgAnimation: false,
        focus: embedded ? false : tooltipEnabled ? observationFocus : undefined,
        tooltip:
          options.showTooltip === false
            ? false
            : tooltipEnabled
              ? { use: plotTooltip.extension, sticky: true }
              : {
                  use: tooltip,
                  portal: themedPortal,
                  sticky: true,
                  className: styles.tooltip,
                  format: (point) =>
                    `${point.datum.name}\nLatest valid sample · ${dateTimeFormat.format(new Date(point.datum.timestamp))}\n${formatMetricDetails(point.datum.value, widget.unit, options.decimals)}`,
                },
      }),
    [
      rows,
      widget.unit,
      options,
      domain,
      ticks.y,
      width,
      height,
      showAxis,
      embedded,
      tooltipEnabled,
      plotTooltip.extension,
    ],
  );
  return (
    <div className={styles.chart}>
      <div
        className={styles.plot}
        ref={ref}
        onPointerMoveCapture={
          tooltipEnabled ? plotTooltip.onInteract : undefined
        }
        onPointerDownCapture={
          tooltipEnabled ? plotTooltip.onInteract : undefined
        }
        onKeyDownCapture={tooltipEnabled ? plotTooltip.onInteract : undefined}
        onFocusCapture={tooltipEnabled ? plotTooltip.onFocus : undefined}
        onBlurCapture={tooltipEnabled ? plotTooltip.onBlur : undefined}
      >
        <Chart
          definition={definition}
          height={height}
          width={width}
          style={{ width: "100%", maxWidth: "100%" }}
          ariaLabel={widget.title}
          tabIndex={embedded ? -1 : undefined}
          onRender={embedded ? associateDescription : plotTooltip.onRender}
          onFocusChange={tooltipEnabled ? plotTooltip.onFocusChange : undefined}
          onSelect={tooltipEnabled ? plotTooltip.onSelect : undefined}
          ariaDescription={
            embedded
              ? "Latest valid value for each series."
              : "Latest value for each series. Use arrow keys to explore values."
          }
        />
      </div>
      {options.showLegend !== false && (
        <div className={styles.legend}>
          <span>Latest valid sample per series</span>
        </div>
      )}
      {plotTooltip.panel}
      {!embedded && <ChartDataInspector widget={widget} series={series} />}
      {series.length > MAX_SERIES && (
        <span className={styles.notice} role="status">
          First {MAX_SERIES} of {series.length} series
        </span>
      )}
    </div>
  );
}

function Stat({
  widget,
  series,
  onContextChange,
}: {
  widget: Widget;
  series: Series[];
  onContextChange?: (context: DrilldownContext) => void;
}) {
  const entries = series
    .map((entry, index) => ({
      entry,
      index,
      name: seriesName(entry, index),
      point: latestPoint(entry),
    }))
    .filter((entry) => entry.point);
  const first = entries[0];
  if (!first?.point) return <EmptyState />;
  const color =
    widgetTextColor(widget.options) ??
    thresholdForValue(first.point.value, widget.options?.thresholds)?.color ??
    widget.color;
  return (
    <div className={styles.stat}>
      <div
        className={`${sparklineStyles.summary} ${widget.options?.showSparkline ? sparklineStyles.withSparkline : ""}`}
        data-stat-summary=""
      >
        <div className={sparklineStyles.value} data-stat-reading="">
          <ObservationDetails
            label={`Inspect value for ${widget.title}`}
            enabled={widget.options?.showTooltip !== false}
            revision={first.entry}
            onSelect={
              onContextChange
                ? () => onContextChange(metricContext(first.entry, first.index))
                : undefined
            }
            details={
              <MetricDetails
                series={first.entry}
                index={first.index}
                point={first.point}
                unit={widget.unit}
                decimals={widget.options?.decimals}
              />
            }
          >
            <span
              className={styles.statValue}
              data-metric-value={String(first.point.value)}
              style={{ color }}
            >
              {formatMetric(
                first.point.value,
                "",
                false,
                widget.options?.decimals,
              )}
              <span className={styles.statUnit}>{widget.unit}</span>
            </span>
          </ObservationDetails>
          <div className={styles.statMeta}>
            {entries.length > 1 ? `${first.name} · ` : ""}Latest valid sample ·{" "}
            {timeFormat.format(new Date(first.point.timestamp))}
          </div>
        </div>
        {widget.options?.showSparkline && (
          <StatSparkline
            series={first.entry}
            name={first.name}
            unit={widget.unit}
            color={color}
          />
        )}
      </div>
      {entries.slice(1, 4).map((entry) => (
        <div className={styles.statExtra} key={`${entry.name}-${entry.index}`}>
          <ObservationDetails
            label={`Inspect series ${entry.name}`}
            enabled={widget.options?.showTooltip !== false}
            revision={entry.entry}
            onSelect={
              onContextChange
                ? () => onContextChange(metricContext(entry.entry, entry.index))
                : undefined
            }
            details={
              <MetricDetails
                series={entry.entry}
                index={entry.index}
                point={entry.point}
                unit={widget.unit}
                decimals={widget.options?.decimals}
              />
            }
          >
            <span>{entry.name}</span>
          </ObservationDetails>
          <strong>
            {formatMetric(
              entry.point!.value,
              widget.unit,
              false,
              widget.options?.decimals,
            )}
          </strong>
        </div>
      ))}
      {entries.length > 4 && (
        <span className={styles.notice} role="status">
          +{entries.length - 4} more series. Switch to table to inspect.
        </span>
      )}
    </div>
  );
}

function MetricTable({
  widget,
  series,
  onContextChange,
}: {
  widget: Widget;
  series: Series[];
  onContextChange?: (context: DrilldownContext) => void;
}) {
  const [selected, setSelected] = useState<string>();
  const [hoveredRow, setHoveredRow] = useState<{
    index: number;
    entry: Series;
    anchor: HTMLTableRowElement;
  }>();
  const select = (entry: Series, index: number) => {
    const context = metricContext(entry, index);
    setSelected(contextKey(context));
    onContextChange?.(context);
  };
  return (
    <div
      className={styles.tableWrap}
      tabIndex={0}
      role="region"
      aria-label={`${widget.title} data table`}
    >
      <table className={styles.table} aria-label={widget.title}>
        <thead>
          <tr>
            <th scope="col">Series</th>
            <th scope="col" className={styles.numeric}>
              Latest valid
            </th>
            <th scope="col" className={styles.numeric}>
              Min
            </th>
            <th scope="col" className={styles.numeric}>
              Max
            </th>
          </tr>
        </thead>
        <tbody>
          {series.slice(0, MAX_ROWS).map((entry, index) => {
            const latest = latestPoint(entry);
            let min = Infinity;
            let max = -Infinity;
            for (const point of entry.points)
              if (
                typeof point.value === "number" &&
                Number.isFinite(point.value) &&
                validTimestamp(point.timestamp)
              ) {
                min = Math.min(min, point.value);
                max = Math.max(max, point.value);
              }
            const name = seriesName(entry, index);
            return (
              <tr
                key={`${name}-${index}`}
                onPointerEnter={(event) => {
                  if (
                    event.pointerType !== "touch" &&
                    widget.options?.tooltipView &&
                    widget.options.showTooltip !== false
                  )
                    setHoveredRow({
                      index,
                      entry,
                      anchor: event.currentTarget,
                    });
                }}
                onPointerLeave={() => setHoveredRow(undefined)}
                tabIndex={onContextChange ? 0 : undefined}
                aria-selected={
                  onContextChange
                    ? selected === contextKey(metricContext(entry, index))
                    : undefined
                }
                className={
                  onContextChange ? contextStyles.interactiveRow : undefined
                }
                onFocus={() => onContextChange && select(entry, index)}
                onClick={() => onContextChange && select(entry, index)}
                onKeyDown={(event) => {
                  if (
                    onContextChange &&
                    event.target === event.currentTarget &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    event.preventDefault();
                    select(entry, index);
                  }
                }}
              >
                <td>
                  <ObservationDetails
                    label={`Inspect series ${name}`}
                    enabled={widget.options?.showTooltip !== false}
                    revision={entry}
                    externalAnchor={
                      hoveredRow?.index === index && hoveredRow.entry === entry
                        ? hoveredRow.anchor
                        : undefined
                    }
                    details={
                      <>
                        <MetricDetails
                          series={entry}
                          index={index}
                          point={latest}
                          unit={widget.unit}
                          decimals={widget.options?.decimals}
                        >
                          <span className={configStyles.tooltipRange}>
                            Minimum:{" "}
                            {Number.isFinite(min)
                              ? formatMetricDetails(min, widget.unit, widget.options?.decimals)
                              : "No data"}{" "}
                            · Maximum:{" "}
                            {Number.isFinite(max)
                              ? formatMetricDetails(max, widget.unit, widget.options?.decimals)
                              : "No data"}
                          </span>
                        </MetricDetails>
                        {widget.options?.tooltipView && (
                          <TooltipSubWidget
                            view={widget.options.tooltipView}
                            series={entry}
                            seriesIndex={index}
                            point={latest}
                            unit={widget.unit}
                            color={widget.color}
                          />
                        )}
                      </>
                    }
                  >
                    <span>{name}</span>
                  </ObservationDetails>
                </td>
                <td className={styles.numeric}>
                  {formatMetric(
                    latest?.value ?? NaN,
                    widget.unit,
                    false,
                    widget.options?.decimals,
                  )}
                </td>
                <td className={styles.numeric}>
                  {formatMetric(
                    min,
                    widget.unit,
                    false,
                    widget.options?.decimals,
                  )}
                </td>
                <td className={styles.numeric}>
                  {formatMetric(
                    max,
                    widget.unit,
                    false,
                    widget.options?.decimals,
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {series.length > MAX_ROWS && (
        <p className={styles.notice}>
          Showing {MAX_ROWS} of {series.length} series. Narrow the query to see
          others.
        </p>
      )}
    </div>
  );
}

function TraceList({
  widget,
  traces,
  onContextChange,
}: {
  widget: Widget;
  traces: Trace[];
  onContextChange?: (context: DrilldownContext) => void;
}) {
  const [selected, setSelected] = useState<string>();
  const select = (trace: Trace) => {
    const context = traceContext(trace);
    setSelected(contextKey(context));
    onContextChange?.(context);
  };
  const maximum = Math.max(
    1,
    ...traces
      .slice(0, MAX_ROWS)
      .map((trace) =>
        Number.isFinite(trace.durationMs) ? Math.max(0, trace.durationMs) : 0,
      ),
  );
  return (
    <div
      className={styles.tableWrap}
      tabIndex={0}
      role="region"
      aria-label={`${widget.title} traces`}
    >
      <table className={styles.table} aria-label={widget.title}>
        <thead>
          <tr>
            <th scope="col">Service / operation</th>
            <th scope="col">Duration</th>
            <th scope="col">Status</th>
            <th scope="col" className={styles.numeric}>
              Started
            </th>
          </tr>
        </thead>
        <tbody>
          {traces.slice(0, MAX_ROWS).map((trace, index) => {
            const failed = /error|fail/i.test(trace.status);
            return (
              <tr
                key={`${trace.traceId}-${index}`}
                tabIndex={onContextChange ? 0 : undefined}
                aria-selected={
                  onContextChange
                    ? selected === contextKey(traceContext(trace))
                    : undefined
                }
                className={
                  onContextChange ? contextStyles.interactiveRow : undefined
                }
                onFocus={() => onContextChange && select(trace)}
                onClick={() => onContextChange && select(trace)}
                onKeyDown={(event) => {
                  if (
                    onContextChange &&
                    event.target === event.currentTarget &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    event.preventDefault();
                    select(trace);
                  }
                }}
              >
                <td>
                  <ObservationDetails
                    label={`Inspect trace ${trace.traceId}`}
                    enabled={widget.options?.showTooltip !== false}
                    revision={trace}
                    details={
                      <>
                        <div className={configStyles.tooltipHeader}>
                          <strong className={configStyles.tooltipTitle}>
                            {trace.service || "Unknown service"}
                          </strong>
                          <span>{trace.operation || trace.traceId}</span>
                        </div>
                        <div className={configStyles.tooltipReading}>
                          <strong
                            data-metric-value={
                              Number.isFinite(trace.durationMs) &&
                              trace.durationMs >= 0
                                ? String(trace.durationMs)
                                : undefined
                            }
                          >
                            {Number.isFinite(trace.durationMs) &&
                            trace.durationMs >= 0
                              ? formatMetricDetails(trace.durationMs, "ms", widget.options?.decimals)
                              : "No data"}
                          </strong>
                          <span className={configStyles.tooltipStatus}>
                            {trace.status || "Unknown"}
                          </span>
                        </div>
                        <div className={configStyles.tooltipLabels}>
                          <dl>
                            <div>
                              <dt>Trace ID</dt>
                              <dd>{trace.traceId}</dd>
                            </div>
                            <div>
                              <dt>Service</dt>
                              <dd>{trace.service || "Unknown"}</dd>
                            </div>
                            <div>
                              <dt>Operation</dt>
                              <dd>{trace.operation || "Unknown"}</dd>
                            </div>
                          </dl>
                        </div>
                        <div className={configStyles.tooltipFooter}>
                          <span>Started</span>
                          {validTimestamp(trace.startTime) ? (
                            <time
                              dateTime={new Date(trace.startTime).toISOString()}
                            >
                              {fullDateTimeFormat.format(
                                new Date(trace.startTime),
                              )}
                            </time>
                          ) : (
                            "No valid timestamp"
                          )}
                        </div>
                      </>
                    }
                  >
                    <span>
                      <span>{trace.service || "Unknown service"}</span>
                      <span className={styles.operation}>
                        {trace.operation || trace.traceId}
                      </span>
                    </span>
                  </ObservationDetails>
                </td>
                <td>
                  <div className={styles.traceTime}>
                    {formatMetric(
                      trace.durationMs >= 0 ? trace.durationMs : NaN,
                      "ms",
                      false,
                      widget.options?.decimals,
                    )}
                    <span
                      className={`${styles.traceBar} ${failed ? styles.traceError : ""}`}
                      style={{
                        width: `${Number.isFinite(trace.durationMs) ? Math.max(0, (trace.durationMs / maximum) * 100) : 0}%`,
                      }}
                    />
                  </div>
                </td>
                <td>
                  <span
                    className={`${styles.status} ${failed ? styles.statusError : ""}`}
                  >
                    {trace.status || "Unknown"}
                  </span>
                </td>
                <td className={styles.numeric}>
                  {validTimestamp(trace.startTime) ? (
                    <time
                      dateTime={new Date(trace.startTime).toISOString()}
                      title={fullDateTimeFormat.format(
                        new Date(trace.startTime),
                      )}
                    >
                      {timeFormat.format(new Date(trace.startTime))}
                    </time>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {traces.length > MAX_ROWS && (
        <p className={styles.notice}>
          Showing {MAX_ROWS} of {traces.length} traces. Narrow the query to see
          others.
        </p>
      )}
    </div>
  );
}

export function EmptyState() {
  return (
    <div className={styles.state}>
      <strong>No data in this time range</strong>
      <p>Try a wider time range or adjust this widget’s query.</p>
    </div>
  );
}

interface TooltipViewport {
  width: number;
  height: number;
  left?: number;
  top?: number;
}
export function heatmapTooltipSizeLimit(
  anchor: Pick<DOMRect, "top" | "bottom">,
  viewport: TooltipViewport,
) {
  const above = anchor.top - (viewport.top ?? 0) - 22;
  const below = (viewport.top ?? 0) + viewport.height - anchor.bottom - 22;
  return {
    width: Math.max(0, viewport.width - 24),
    height: Math.max(
      0,
      Math.min(560, viewport.height - 24, Math.max(64, above, below)),
    ),
  };
}
export function placeHeatmapTooltip(
  anchor: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  size: { width: number; height: number },
  viewport: TooltipViewport,
) {
  const margin = 12;
  const gap = 10;
  const leftEdge = (viewport.left ?? 0) + margin;
  const topEdge = (viewport.top ?? 0) + margin;
  const rightEdge = (viewport.left ?? 0) + viewport.width - margin;
  const bottomEdge = (viewport.top ?? 0) + viewport.height - margin;
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  const preferBelow = below + size.height <= bottomEdge || above < topEdge;
  return {
    left: Math.max(
      leftEdge,
      Math.min(
        (anchor.left + anchor.right - size.width) / 2,
        rightEdge - size.width,
      ),
    ),
    top: Math.max(
      topEdge,
      Math.min(preferBelow ? below : above, bottomEdge - size.height),
    ),
    placement: preferBelow ? "bottom" : "top",
  };
}

export function balancedHeatmapColumns(
  count: number,
  width: number,
  hasText = true,
) {
  const gap = width <= 340 ? 4 : 6;
  const minimum = hasText ? 120 : width <= 340 ? 48 : 64;
  const maximum = Math.max(1, Math.floor((width + gap) / (minimum + gap)));
  const cells = Math.max(1, Math.min(MAX_ROWS, count));
  return Math.ceil(cells / Math.ceil(cells / maximum));
}

function thresholdRange(
  thresholds: readonly Threshold[],
  index: number,
  unit: string,
) {
  if (thresholds.length === 1) return "All values";
  if (index === 0) return `Below ${exactMetric(thresholds[1].value, unit)}`;
  const next = thresholds[index + 1];
  return `≥ ${exactMetric(thresholds[index].value, unit)}${next ? ` and < ${exactMetric(next.value, unit)}` : ""}`;
}

export function ObservationTooltip({
  id,
  anchor,
  anchorRect,
  onDismiss,
  onEnter,
  onLeave,
  children,
}: {
  id: string;
  anchor: Element;
  anchorRect?: () => DOMRect;
  onDismiss: () => void;
  onEnter: () => void;
  onLeave: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ReturnType<
    typeof placeHeatmapTooltip
  > | null>(null);
  useLayoutEffect(() => {
    let frame = 0;
    const stopTheme = ref.current ? inheritGammaTheme(anchor, ref.current) : undefined;
    const update = () => {
      const element = ref.current;
      if (!element || !anchor.isConnected) return;
      const viewport = window.visualViewport;
      const visibleViewport = {
        width: viewport?.width ?? window.innerWidth,
        height: viewport?.height ?? window.innerHeight,
        left: viewport?.offsetLeft,
        top: viewport?.offsetTop,
      };
      const anchorBounds = anchorRect?.() ?? anchor.getBoundingClientRect();
      const limits = heatmapTooltipSizeLimit(anchorBounds, visibleViewport);
      // Keep the trigger exposed: a long panel must scroll instead of moving
      // over the cell and intercepting the click that pins or dismisses it.
      element.style.maxWidth = `${limits.width}px`;
      element.style.maxHeight = `${limits.height}px`;
      const bounds = element.getBoundingClientRect();
      const next = placeHeatmapTooltip(anchorBounds, bounds, visibleViewport);
      setPosition((previous) =>
        previous?.left === next.left &&
        previous?.top === next.top &&
        previous?.placement === next.placement
          ? previous
          : next,
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(schedule);
    if (ref.current) observer?.observe(ref.current);
    observer?.observe(anchor);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      stopTheme?.();
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [anchor, anchorRect]);
  useEffect(() => {
    const pointer = (event: PointerEvent) => {
      if (
        !anchor.contains(event.target as Node) &&
        !ref.current?.contains(event.target as Node)
      )
        onDismiss();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onDismiss();
        return;
      }
      const element = ref.current;
      if (
        element &&
        (event.target === anchor || element.contains(event.target as Node)) &&
        ["PageDown", "PageUp", "Home", "End"].includes(event.key)
      ) {
        // A tooltip does not take focus away from its trigger. Let keyboard
        // users inspect every label while keeping the chart's tab order intact.
        event.preventDefault();
        event.stopPropagation();
        const maximum = Math.max(
          0,
          element.scrollHeight - element.clientHeight,
        );
        const page = Math.max(48, Math.round(element.clientHeight * 0.8));
        element.scrollTop =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? maximum
              : Math.max(
                  0,
                  Math.min(
                    maximum,
                    element.scrollTop +
                      (event.key === "PageDown" ? page : -page),
                  ),
                );
      }
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("keydown", keyboard, true);
    };
  }, [anchor, onDismiss]);
  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className={configStyles.heatmapTooltip}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
      data-placement={position?.placement}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onFocusCapture={onEnter}
      onBlurCapture={(event) => {
        if (
          !event.currentTarget.contains(event.relatedTarget as Node | null) &&
          !anchor.contains(event.relatedTarget as Node | null)
        )
          onLeave();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Pointer preview and click/tap pinning share the same keyboard-readable panel. */
export function ObservationDetails({
  label,
  children,
  details,
  onSelect,
  enabled = true,
  className,
  revision,
  externalAnchor,
}: {
  label: string;
  children: ReactNode;
  details: ReactNode;
  onSelect?: () => void;
  enabled?: boolean;
  className?: string;
  revision?: unknown;
  externalAnchor?: Element;
}) {
  const id = useId();
  const [active, setActive] = useState<{
    anchor: Element;
    pinned: boolean;
    revision: unknown;
  } | null>(null);
  const interaction = useRef({ focused: false, hovered: false, panel: false });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearHide = useCallback(() => clearTimeout(timer.current), []);
  const dismiss = useCallback(() => {
    clearHide();
    interaction.current.panel = false;
    setActive(null);
  }, [clearHide]);
  const scheduleHide = useCallback(() => {
    clearHide();
    timer.current = setTimeout(() => {
      const state = interaction.current;
      setActive((current) =>
        current &&
        !current.pinned &&
        !state.focused &&
        !state.hovered &&
        !state.panel
          ? null
          : current,
      );
    }, 180);
  }, [clearHide]);
  useEffect(() => clearHide, [clearHide]);
  useEffect(() => {
    if (!externalAnchor || !enabled) return;
    let disposed = false;
    const interactionState = interaction.current;
    interactionState.hovered = true;
    clearHide();
    queueMicrotask(() => {
      if (!disposed)
        setActive((current) =>
          current?.pinned
            ? current
            : { anchor: externalAnchor, pinned: false, revision },
        );
    });
    return () => {
      disposed = true;
      interactionState.hovered = false;
      scheduleHide();
    };
  }, [externalAnchor, enabled, revision, clearHide, scheduleHide]);
  if (active && (active.revision !== revision || !enabled)) {
    setActive(null);
  }
  const show = (anchor: HTMLButtonElement, pinned = false) => {
    clearHide();
    if (!enabled) return;

    setActive({ anchor, pinned, revision });
  };
  if (!enabled && !onSelect)
    return <span className={className}>{children}</span>;
  return (
    <>
      <GammaButton
        variant="ghost"
        className={className ?? configStyles.observationTrigger}
        aria-label={label}
        aria-describedby={active ? id : undefined}
        aria-pressed={enabled ? (active?.pinned ?? false) : undefined}
        onPointerEnter={(event) => {
          if (event.pointerType === "touch") return;
          interaction.current.hovered = true;
          if (!active?.pinned) show(event.currentTarget);
        }}
        onPointerLeave={() => {
          interaction.current.hovered = false;
          scheduleHide();
        }}
        onFocus={(event) => {
          interaction.current.focused = true;
          onSelect?.();
          show(event.currentTarget);
        }}
        onBlur={() => {
          interaction.current.focused = false;
          setActive((current) =>
            current ? { ...current, pinned: false } : null,
          );
          scheduleHide();
        }}
        onClick={(event) => {
          onSelect?.();
          if (active?.pinned) dismiss();
          else show(event.currentTarget, true);
        }}
      >
        {children}
      </GammaButton>
      {active && enabled && (
        <ObservationTooltip
          id={id}
          anchor={active.anchor}
          onDismiss={dismiss}
          onEnter={() => {
            interaction.current.panel = true;
            clearHide();
          }}
          onLeave={() => {
            interaction.current.panel = false;
            scheduleHide();
          }}
        >
          {details}
          <div className={configStyles.tooltipFooter}>
            <small>Page Up/Down to scroll · Esc to close</small>
            <small>
              {active.pinned
                ? "Pinned · tap again to close"
                : "Click or tap to keep open"}
            </small>
          </div>
        </ObservationTooltip>
      )}
    </>
  );
}

export function MetricDetails({
  series,
  index,
  point,
  unit,
  decimals,
  description = "Latest valid sample",
  children,
}: {
  series: Series;
  index: number;
  point?: Point;
  unit: string;
  decimals?: number;
  description?: string;
  children?: ReactNode;
}) {
  const value =
    typeof point?.value === "number" && Number.isFinite(point.value)
      ? point.value
      : undefined;
  return (
    <>
      <div className={configStyles.tooltipHeader}>
        <strong className={configStyles.tooltipTitle}>
          {seriesName(series, index)}
        </strong>
      </div>
      <div className={configStyles.tooltipReading}>
        <strong
          data-metric-value={value === undefined ? undefined : String(value)}
        >
          {value === undefined ? "No data" : formatMetricDetails(value, unit, decimals)}
        </strong>
        {children}
      </div>
      {!!Object.keys(series.labels).length && (
        <div className={configStyles.tooltipLabels}>
          <dl>
            {Object.entries(series.labels).map(([key, value]) => (
              <div key={key}>
                <dt>{key}: </dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <div className={configStyles.tooltipFooter}>
        <span>{description}</span>
        {point && validTimestamp(point.timestamp) ? (
          <time dateTime={new Date(point.timestamp).toISOString()}>
            {fullDateTimeFormat.format(new Date(point.timestamp))}
          </time>
        ) : (
          <span>No valid timestamp</span>
        )}
      </div>
    </>
  );
}

function ChartDataInspector({
  widget,
  series,
}: {
  widget: Widget;
  series: Series[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={configStyles.chartDataAction}>
      <GammaButton
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Inspect chart data for ${widget.title}`}
      >
        Inspect data
      </GammaButton>
      {open && (
        <ChartDataDialog
          widget={widget}
          series={series}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function ChartDataDialog({
  widget,
  series,
  onClose,
}: {
  widget: Widget;
  series: Series[];
  onClose: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const choices = useMemo(
    () =>
      series.map((entry, index) => ({
        entry,
        value: contextKey(metricContext(entry, index)),
        label: seriesName(entry, index),
      })),
    [series],
  );
  const [selected, setSelected] = useState(() => choices[0]?.value ?? "");
  const [page, setPage] = useState(0);
  const chosen =
    choices.find((choice) => choice.value === selected) ?? choices[0];
  if (chosen && chosen.value !== selected) {
    setSelected(chosen.value);
    setPage(0);
  }
  const entry = chosen?.entry;
  const points = useMemo(() => {
    if (!entry) return [];
    if (widget.type === "bar") {
      const point = latestPoint(entry);
      return point ? [point] : [];
    }
    return entry.points
      .filter((point) => validTimestamp(point.timestamp))
      .toSorted((a, b) => a.timestamp - b.timestamp);
  }, [entry, widget.type]);
  const pages = Math.max(1, Math.ceil(points.length / 25));
  const currentPage = Math.min(page, pages - 1);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement;
    const unlock = lockBodyScroll();
    element.showModal();
    close.current?.focus();
    return () => {
      const restore =
        element.contains(document.activeElement) ||
        document.activeElement === document.body;
      element.close();
      unlock();
      if (restore && opener instanceof HTMLElement && opener.isConnected)
        opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={configStyles.dataDialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className={configStyles.inspectorToolbar}>
        <h2 id={`${id}-title`}>{widget.title} data</h2>
        <GammaButton ref={close} variant="ghost" onClick={onClose}>
          Close data
        </GammaButton>
      </div>
      <p id={`${id}-description`}>
        {widget.type === "bar"
          ? "Latest valid sample per series. Values are shown without rounding."
          : "Exact query observations before visual downsampling. Missing samples remain empty. This view does not change dashboard link selection."}
      </p>
      <div className={configStyles.inspectorToolbar}>
        <GammaSelect
          aria-label="Data series"
          value={selected}
          options={choices}
          searchable={series.length > 8}
          onValueChange={(value) => {
            setSelected(value);
            setPage(0);
          }}
        />
      </div>
      {entry && (
        <dl className={configStyles.inspectorLabels}>
          {Object.entries(entry.labels).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div
        className={styles.tableWrap}
        role="region"
        aria-label="Exact chart observations"
        tabIndex={0}
      >
        <table className={styles.table} aria-label={widget.title}>
          <thead>
            <tr>
              <th scope="col">Timestamp</th>
              <th scope="col">Value{widget.unit ? ` (${widget.unit})` : ""}</th>
            </tr>
          </thead>
          <tbody>
            {points
              .slice(currentPage * 25, (currentPage + 1) * 25)
              .map((point, index) => (
                <tr key={`${point.timestamp}-${index}`}>
                  <td>
                    <time dateTime={new Date(point.timestamp).toISOString()}>
                      {new Date(point.timestamp).toISOString()}
                    </time>
                  </td>
                  <td
                    data-metric-value={
                      typeof point.value === "number" &&
                      Number.isFinite(point.value)
                        ? String(point.value)
                        : undefined
                    }
                  >
                    {typeof point.value === "number" &&
                    Number.isFinite(point.value)
                      ? exactMetric(point.value, widget.unit)
                      : "No data"}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {!points.length && <p>No valid samples for this series.</p>}
      </div>
      <div className={configStyles.inspectorFooter}>
        <span role="status">
          {points.length} observations · Page {currentPage + 1} of {pages}
        </span>
        <GammaButton
          disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}
        >
          Previous observations
        </GammaButton>
        <GammaButton
          disabled={currentPage + 1 >= pages}
          onClick={() => setPage(currentPage + 1)}
        >
          Next observations
        </GammaButton>
      </div>
    </dialog>
  );
}

export function Heatmap({
  widget,
  series,
  onContextChange,
}: {
  widget: Widget;
  series: Series[];
  onContextChange?: (context: DrilldownContext) => void;
}) {
  const embedded = useEmbeddedWidget();
  const { ref: cellsRef, width: cellsWidth } = usePlotSize();
  const [active, setActive] = useState<{
    index: number;
    key: string;
    anchor: HTMLButtonElement;
    pinned: boolean;
  } | null>(null);
  const interaction = useRef<{
    focused: HTMLButtonElement | null;
    hovered: HTMLButtonElement | null;
    tooltipHovered: boolean;
  }>({ focused: null, hovered: null, tooltipHovered: false });
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const tooltipId = useId();
  const options = widget.options ?? EMPTY_OPTIONS;
  const thresholds = options.thresholds?.length
    ? options.thresholds
    : DEFAULT_HEATMAP_THRESHOLDS;
  const clearHide = useCallback(() => {
    clearTimeout(hideTimer.current);
    hideTimer.current = undefined;
  }, []);
  const dismiss = useCallback(() => {
    clearHide();

    interaction.current.tooltipHovered = false;
    setActive(null);
  }, [clearHide]);
  const scheduleHide = useCallback(() => {
    clearHide();
    hideTimer.current = setTimeout(() => {
      const state = interaction.current;
      setActive((current) =>
        current &&
        !current.pinned &&
        state.focused !== current.anchor &&
        state.hovered !== current.anchor &&
        !state.tooltipHovered
          ? null
          : current,
      );
    }, 180);
  }, [clearHide]);
  useEffect(() => clearHide, [clearHide]);
  const cells = useMemo(
    () =>
      series.slice(0, MAX_ROWS).map((entry, index) => {
        // A missing latest scrape is unknown, even if an older sample was healthy.
        const point = entry.points.reduce<Point | undefined>(
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
        return {
          name: seriesName(entry, index),
          key: contextKey(metricContext(entry, index, true)),
          source: entry,
          labels: entry.labels,
          point,
          value,
        };
      }),
    [series],
  );
  const selected =
    active && cells[active.index]?.key === active.key
      ? cells[active.index]
      : undefined;
  if (active && !selected) {
    setActive(null);
  }
  const selectedThreshold =
    selected?.value === undefined
      ? undefined
      : thresholdForValue(selected.value, thresholds);
  const timestamp =
    selected?.point && Math.abs(selected.point.timestamp) <= 8.64e15
      ? new Date(selected.point.timestamp).toISOString()
      : undefined;
  const hasText = options.showLabels !== false || options.showValues !== false;
  return (
    <div className={configStyles.heatmap}>
      <div
        ref={cellsRef}
        className={`${configStyles.cells} ${hasText ? "" : configStyles.colorOnlyCells}`}
        style={{
          gridTemplateColumns: `repeat(${balancedHeatmapColumns(cells.length, cellsWidth, hasText)}, minmax(0, 1fr))`,
        }}
        role="group"
        aria-label={`${widget.title} heatmap`}
      >
        {cells.map((cell, index) => {
          const threshold =
            cell.value === undefined
              ? undefined
              : thresholdForValue(cell.value, thresholds);
          if (embedded)
            return (
              <div
                key={`${cell.name}-${index}`}
                role="img"
                aria-label={`${cell.name}: ${cell.value === undefined ? "No data" : formatMetric(cell.value, widget.unit, false, options.decimals)}${threshold?.label ? ` · ${threshold.label}` : ""}`}
                className={`${configStyles.cell} ${hasText ? "" : configStyles.colorOnlyCell}`}
                style={{
                  background: threshold?.color ?? "#e6e9e0",
                  color:
                    options.textColor ??
                    (threshold ? contrastText(threshold.color) : "#69725f"),
                }}
              >
                {options.showLabels !== false && (
                  <span className={configStyles.cellName}>{cell.name}</span>
                )}
                {options.showValues !== false && (
                  <strong>
                    {cell.value === undefined
                      ? "No data"
                      : formatMetric(
                          cell.value,
                          widget.unit,
                          false,
                          options.decimals,
                        )}
                  </strong>
                )}
              </div>
            );
          return (
            <button
              key={`${cell.name}-${index}`}
              type="button"
              className={`${configStyles.cell} ${hasText ? "" : configStyles.colorOnlyCell}`}
              style={{
                background: threshold?.color ?? "#e6e9e0",
                color:
                  options.textColor ??
                  (threshold ? contrastText(threshold.color) : "#69725f"),
              }}
              aria-label={`${cell.name}: ${cell.value === undefined ? "No data" : formatMetric(cell.value, widget.unit, false, options.decimals)}${threshold?.label ? ` · ${threshold.label}` : ""}`}
              aria-describedby={
                active?.index === index && options.showTooltip !== false
                  ? tooltipId
                  : undefined
              }
              aria-pressed={
                options.showTooltip !== false
                  ? active?.index === index && active.pinned
                  : undefined
              }
              onPointerEnter={(event) => {
                if (event.pointerType === "touch") return;
                interaction.current.hovered = event.currentTarget;
                clearHide();
                if (!active?.pinned && options.showTooltip !== false)
                  setActive({
                    index,
                    key: cell.key,
                    anchor: event.currentTarget,
                    pinned: false,
                  });
              }}
              onPointerLeave={() => {
                interaction.current.hovered = null;
                scheduleHide();
              }}
              onFocus={(event) => {
                onContextChange?.({
                  series: cell.name,
                  labels: cell.labels,
                  value: cell.value ?? null,
                });
                interaction.current.focused = event.currentTarget;
                clearHide();
                if (options.showTooltip !== false) {
                  setActive({
                    index,
                    key: cell.key,
                    anchor: event.currentTarget,
                    pinned: false,
                  });
                }
              }}
              onBlur={() => {
                interaction.current.focused = null;

                setActive((current) =>
                  current?.pinned ? { ...current, pinned: false } : current,
                );
                scheduleHide();
              }}
              onClick={(event) => {
                onContextChange?.({
                  series: cell.name,
                  labels: cell.labels,
                  value: cell.value ?? null,
                });
                if (options.showTooltip === false) return;
                if (active?.index === index && active.pinned) dismiss();
                else {
                  clearHide();

                  setActive({
                    index,
                    key: cell.key,
                    anchor: event.currentTarget,
                    pinned: true,
                  });
                }
              }}
            >
              {options.showLabels !== false && (
                <span className={configStyles.cellName}>{cell.name}</span>
              )}
              {options.showValues !== false && (
                <strong>
                  {cell.value === undefined
                    ? "No data"
                    : formatMetric(
                        cell.value,
                        widget.unit,
                        false,
                        options.decimals,
                      )}
                </strong>
              )}
            </button>
          );
        })}
      </div>
      {!embedded && selected && active && options.showTooltip !== false && (
        <ObservationTooltip
          id={tooltipId}
          anchor={active.anchor}
          onDismiss={dismiss}
          onEnter={() => {
            interaction.current.tooltipHovered = true;
            clearHide();
          }}
          onLeave={() => {
            interaction.current.tooltipHovered = false;
            scheduleHide();
          }}
        >
          <div className={configStyles.tooltipHeader}>
            <strong className={configStyles.tooltipTitle}>
              {selected.name}
            </strong>
            <span className={configStyles.tooltipKeyHint}>
              Page Up/Down to scroll · Esc to close
            </span>
          </div>
          <div className={configStyles.tooltipReading}>
            <strong
              data-metric-value={
                selected.value === undefined
                  ? "missing"
                  : String(selected.value)
              }
            >
              {selected.value === undefined
                ? "No data"
                : formatMetricDetails(selected.value, widget.unit, options.decimals)}
            </strong>
            <span className={configStyles.tooltipStatus}>
              <i
                style={{ background: selectedThreshold?.color ?? "#a5ad9b" }}
              />
              {selectedThreshold?.label ??
                (selectedThreshold ? "Threshold matched" : "Unknown")}
            </span>
            <span className={configStyles.tooltipRange}>
              {selectedThreshold
                ? thresholdRange(
                    thresholds,
                    thresholds.indexOf(selectedThreshold),
                    widget.unit,
                  )
                : "The latest sample has no finite value"}
            </span>
          </div>
          {Object.keys(selected.labels).length > 0 && (
            <div className={configStyles.tooltipLabels}>
              <span className={configStyles.tooltipEyebrow}>Series labels</span>
              <dl>
                {Object.entries(selected.labels).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}: </dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          <div className={configStyles.tooltipFooter}>
            <span>Latest sample</span>
            {timestamp ? (
              <time dateTime={timestamp}>
                {fullDateTimeFormat.format(new Date(timestamp))}
              </time>
            ) : (
              <span>No timestamp</span>
            )}
          </div>
          {options.tooltipView && (
            <TooltipSubWidget
              view={options.tooltipView}
              series={selected.source}
              seriesIndex={active.index}
              point={selected.point}
              unit={widget.unit}
              color={widget.color}
            />
          )}
          <div className={configStyles.tooltipFooter}>
            <small>
              {active.pinned
                ? "Pinned · tap again or press Esc to close"
                : "Click or tap to keep open"}
            </small>
          </div>
        </ObservationTooltip>
      )}
      {options.showLegend !== false && (
        <div
          className={configStyles.thresholdLegend}
          aria-label="Heatmap thresholds"
        >
          {thresholds.map((threshold, index) => (
            <span key={threshold.value}>
              <i style={{ background: threshold.color }} />
              <span>
                {threshold.label ||
                  formatMetric(
                    threshold.value,
                    widget.unit,
                    false,
                    options.decimals,
                  )}
                <small>{thresholdRange(thresholds, index, widget.unit)}</small>
              </span>
            </span>
          ))}
        </div>
      )}
      {series.length > MAX_ROWS && (
        <span className={styles.notice}>
          First {MAX_ROWS} of {series.length} series. Narrow the query to see
          others.
        </span>
      )}
    </div>
  );
}

export function contrastText(hex: string) {
  return readableTextColor(hex);
}

export function BuiltinWidgetRenderer({
  widget,
  result,
  onContextChange,
}: {
  widget: Widget;
  result: QueryResult;
  onContextChange?: (context: DrilldownContext) => void;
}) {
  const series = result.series ?? [];
  switch (widget.type) {
    case "timeseries":
      return <TimeSeriesChart widget={widget} series={series} />;
    case "bar":
      return <BarChart widget={widget} series={series} />;
    case "stat":
      return (
        <Stat
          widget={widget}
          series={series}
          onContextChange={onContextChange}
        />
      );
    case "table":
      return (
        <MetricTable
          widget={widget}
          series={series}
          onContextChange={onContextChange}
        />
      );
    case "traces":
      return (
        <TraceList
          widget={widget}
          traces={result.traces ?? []}
          onContextChange={onContextChange}
        />
      );
    case "heatmap":
      return (
        <Heatmap
          widget={widget}
          series={series}
          onContextChange={onContextChange}
        />
      );
    default:
      return <EmptyState />;
  }
}

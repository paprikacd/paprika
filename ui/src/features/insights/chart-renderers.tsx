"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTraceFetcher } from "./trace-waterfall";
import { TraceDialog } from "./trace-dialog";
import { TooltipInstructions } from "./tooltip-instructions";
import { createPortal } from "react-dom";
import { areaY } from "@tanstack/charts/area";
import { barY } from "@tanstack/charts/bar";
import { focusGroupX, focusNearestX } from "@tanstack/charts/focus";
import { usePlotTooltip } from "./plot-tooltip";
import { useChartCursor } from "./chart-cursor";
import { useAnnotationEvents } from "./annotation-events";
import { TimeWindowLens } from "./time-window-lens";
import { useDashboardWindow } from "./dashboard-window";
import { alignPriorPeriod, seriesInWindow, type ObservationWindow } from "./time-window";
import { compactSeriesLabels } from "./series-display";
import { useTooltipWidgetData } from "./tooltip-widget-data";
import { resolveSeriesColor } from "./series-colors";
import { lineY } from "@tanstack/charts/line";
import { decorative } from "@tanstack/charts/mark/decorative";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { defineChart } from "@tanstack/charts/scene";
import { tooltip } from "@tanstack/charts/tooltip";
import { portal } from "@tanstack/charts/tooltip/portal";
import type { QueryResult, Widget, WidgetOptions, Threshold } from "./schema";
import styles from "./charts.module.css";
import configStyles from "./chart-styles.module.css";
import eventStyles from "./plugins/rich-metrics.module.css";
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
import { installTooltipPointerTracking, placePointerTooltip, pointerOverAnchor } from "./tooltip-pointer";
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
  muted: "var(--gamma-chart-axis, var(--gamma-muted, #626e65))",
  grid: "var(--gamma-chart-grid, var(--gamma-border, #dfe4db))",
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

/** Threshold guides participate in autoscaling, but explicit axis bounds win. */
export function resolveTimeSeriesDomain(series: Series[], options: WidgetOptions): [number, number] | undefined {
  const thresholds = options.thresholds?.filter(threshold => Number.isFinite(threshold.value)) ?? [];
  if (!thresholds.length) return resolveChartDomain(series, options);
  let observedMin = Infinity, observedMax = -Infinity;
  for (const threshold of thresholds) { observedMin = Math.min(observedMin, threshold.value); observedMax = Math.max(observedMax, threshold.value); }
  for (const entry of series) for (const point of entry.points) if (validTimestamp(point.timestamp) && typeof point.value === "number" && Number.isFinite(point.value)) { observedMin = Math.min(observedMin, point.value); observedMax = Math.max(observedMax, point.value); }
  const padding = Math.max((observedMax - observedMin) * .05, observedMin === observedMax ? Math.max(1, Math.abs(observedMin) * .1) : 0);
  let min = options.min ?? observedMin - padding, max = options.max ?? observedMax + padding;
  if (min >= max) {
    if (options.min !== undefined && options.max === undefined) max = min + Math.max(1, Math.abs(min) * .1);
    else if (options.max !== undefined && options.min === undefined) min = max - Math.max(1, Math.abs(max) * .1);
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
        : new ResizeObserver(measure);
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

/** Reserve enough space for formatted numeric ticks, including custom precision.
 * Keep longer units above the plot so they don't repeat on every tick. */
export function chartYAxisLayout(values: number[], unit: string, decimals?: number, axisLabel?: string) {
  const separateUnit = unit.length > 3;
  let min = 0, max = 0;
  for (const value of values) if (Number.isFinite(value)) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const labels = [min, max, min * 1.1, max * 1.1].map(value => formatMetric(value, separateUnit ? "" : unit, true, decimals));
  const width = Math.max(...labels.map(label => label.length)) * 7 + 12;
  return { separateUnit, left: Math.max(54, width) + (axisLabel ? 20 : 0) };
}

function TimeSeriesChart({
  widget,
  series,
  onContextChange,
}: {
  widget: Widget;
  series: Series[];
  onContextChange?: (context: DrilldownContext) => void;
}) {
  const { ref, width, height } = usePlotSize();
  const [selection, setSelection] = useState<{ source: Series[]; window: ObservationWindow; previous?: QueryResult }>();
  // Query/variable changes must never reuse a range selected from another result.
  const zoom = selection?.source === series ? selection.window : undefined;
  const visibleSeries = useMemo(() => zoom ? seriesInWindow(series, zoom) : series, [series, zoom]);
  const previousResult = selection?.previous;
  const prior = useMemo(() => zoom && previousResult ? alignPriorPeriod(series.slice(0, MAX_SERIES), previousResult.series ?? [], zoom) : [], [series, zoom, previousResult]);
  const emptyCurrent = !!zoom && !visibleSeries.slice(0, MAX_SERIES).some(entry => latestPoint(entry));
  const emptyZoom = emptyCurrent && !prior.length;
  const cursor = useChartCursor();
  const eventData = useAnnotationEvents();
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
    !embedded && options.showTooltip !== false;
  const plotTooltip = usePlotTooltip(widget, visibleSeries, tooltipEnabled, onContextChange);
  const domain = useMemo(
    () => resolveTimeSeriesDomain([...visibleSeries.slice(0, MAX_SERIES), ...prior.map(entry => entry.shifted)], options),
    [visibleSeries, prior, options],
  );
  const previousData = useMemo(() => prior.map(entry => ({ ...entry, color: resolveSeriesColor(entry.original.labels, options.seriesColors, entry.index === 0 && widget.color ? widget.color : PALETTE[entry.index % PALETTE.length]), points: downsamplePoints(entry.shifted.points) })), [prior, widget.color, options.seriesColors]);
  const displayLabels = useMemo(() => compactSeriesLabels(visibleSeries.slice(0, MAX_SERIES)), [visibleSeries]);
  const data = useMemo(
    () =>
      visibleSeries.slice(0, MAX_SERIES).map((entry, index) => ({
        name: seriesName(entry, index),
        latest: latestPoint(entry),
        color: resolveSeriesColor(entry.labels, options.seriesColors,
          index === 0 && widget.color ? widget.color : PALETTE[index % PALETTE.length]),
        points: downsamplePoints(entry.points).map((point) => ({
          ...point,
          series: seriesName(entry, index),
          seriesIndex: index,
        })),
      })),
    [visibleSeries, widget.color, options.seriesColors],
  );
  const timeSpan = useMemo(() => {
    const bounds = [...data, ...previousData].flatMap((entry) =>
      entry.points.length
        ? [entry.points[0].timestamp, entry.points.at(-1)!.timestamp]
        : [],
    );
    return bounds.length ? Math.max(...bounds) - Math.min(...bounds) : 0;
  }, [data, previousData]);
  const cursorBounds = data.flatMap(entry => entry.points.length ? [entry.points[0].timestamp, entry.points.at(-1)!.timestamp] : []);
  const cursorStart = Math.min(...cursorBounds), cursorEnd = Math.max(...cursorBounds);
  const { left: axisLeft, separateUnit } = chartYAxisLayout([...data, ...previousData].flatMap(entry => entry.points.map(point => point.value ?? 0)).concat(domain ?? []), widget.unit, options.decimals, options.yAxisLabel);
  const cursorLeft = !showAxis ? 8 : axisLeft;
  const cursorX = cursor && !embedded && cursor.timestamp >= cursorStart && cursor.timestamp <= cursorEnd && cursorEnd > cursorStart
    ? cursorLeft + (cursor.timestamp - cursorStart) / (cursorEnd - cursorStart) * Math.max(0, width - cursorLeft - 12)
    : undefined;
  // Match the rendered time domain, including aligned prior-period samples.
  // Event markers are decorative and never intercept chart pointer input.
  const eventBounds = [...data, ...previousData].flatMap(entry => entry.points.map(point => point.timestamp).filter(validTimestamp));
  const eventStart = Math.min(...eventBounds), eventEnd = Math.max(...eventBounds);
  const eventsInView = widget.annotationSource && !embedded && eventBounds.length ? eventData.events.filter(event => {
    const at = Date.parse(event.timestamp);
    return at <= eventEnd && Date.parse(event.endTimestamp ?? event.timestamp) >= eventStart;
  }) : [];
  const visibleEvents = eventsInView.slice(0, 20);
  const eventTop = !showAxis ? 8 : separateUnit ? 18 : height < 130 ? 4 : 10;
  const eventBottom = !showAxis ? 8 : options.xAxisLabel ? 47 : 29;

  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          ...previousData.map((entry, index) => decorative(lineY(entry.points, { id: `previous-${index}`, x: "timestamp", y: "value", stroke: entry.color, strokeWidth: options.lineWidth ?? 1.8, strokeDasharray: "5 4", strokeOpacity: .7, curve: CURVES[options.curve ?? "linear"] }))),
          ...data.flatMap((entry, index) => [
          ...(options.display === "area"
            ? [
                // Fills paint behind observations; only the line owns hit testing.
                decorative(
                  areaY(entry.points, {
                    id: `area-${index}`,
                    x: "timestamp",
                    y: "value",
                    fill: entry.color,
                    fillOpacity: options.fillOpacity ?? 0.06,
                    curve: CURVES[options.curve ?? "linear"],
                  }),
                ),
              ]
            : []),
          lineY(entry.points, {
            id: `line-${index}`,
            x: "timestamp",
            y: "value",
            // Shared timestamps still need distinct groups for nearest-line focus.
            z: "seriesIndex",
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
        ],
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
                    fontSize: 11,
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
                    stroke: "var(--gamma-chart-grid, var(--gamma-border, #dfe4db))",
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
                      formatMetric(value, separateUnit ? "" : widget.unit, true, options.decimals),
                  },
                  tickLabels: {
                    opacity: 1,
                    fontSize: 11,
                    thin: { minGap: 12, priority: "ends" },
                  },
                },
          },
        },
        margin: !showAxis
          ? { top: 8, right: 8, bottom: 8, left: 8 }
          : {
              top: separateUnit ? 18 : height < 130 ? 4 : 10,
              right: 12,
              bottom: options.xAxisLabel ? 47 : 29,
              left: axisLeft,
            },
        clip: true,
        theme: configuredTheme(options),
        // Built-in strategy identity preserves TanStack's segment hit testing.
        focus: embedded
          ? false
          : tooltipEnabled
            ? focusNearestX
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
      previousData,
      widget.unit,
      axisLeft,
      separateUnit,
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
    <div className={styles.chart} data-prior-overlay={previousData.length || undefined}>
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
        {showAxis && separateUnit && <span className={styles.axisUnit} title={widget.unit} data-chart-axis-unit>{widget.unit}</span>}
        {emptyZoom ? <div className={styles.state} role="status">No recorded observations in this window. Reset chart zoom to return to the full view.</div> : <Chart
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
        />}
        {cursorX !== undefined && <span aria-hidden="true" className={styles.sharedCursor}
          data-chart-cursor-time={cursor!.timestamp} data-chart-cursor-source={cursor!.source}
          style={{ left: cursorX, top: separateUnit ? 18 : height < 130 ? 4 : 10, bottom: !showAxis ? 8 : options.xAxisLabel ? 47 : 29 }} />}
        {!embedded && domain && domain[1] > domain[0] && !emptyZoom && (options.thresholds ?? []).filter(threshold => threshold.value >= domain[0] && threshold.value <= domain[1]).map((threshold, index) => <span key={`${threshold.value}-${index}`} role="img" aria-label={`${threshold.label ? `${threshold.label}: ` : "Threshold: "}${formatMetric(threshold.value, widget.unit, false, options.decimals)}`} className={styles.thresholdGuide} data-threshold-value={threshold.value} style={{ left: cursorLeft, right: !showAxis ? 8 : 12, top: eventTop + (domain[1] - threshold.value) / (domain[1] - domain[0]) * Math.max(0, height - eventTop - eventBottom), borderColor: threshold.color, color: threshold.color }}><span aria-hidden="true">{threshold.label || formatMetric(threshold.value, widget.unit, false, options.decimals)}</span></span>)}
        {eventEnd > eventStart && visibleEvents.map((event, index) => {
          const at = Date.parse(event.timestamp), finish = event.endTimestamp ? Date.parse(event.endTimestamp) : at;
          const position = (value: number) => cursorLeft + (value - eventStart) / (eventEnd - eventStart) * Math.max(0, width - cursorLeft - (!showAxis ? 8 : 12));
          return <span key={`${event.timestamp}-${index}`} aria-hidden="true" data-annotation-timestamp={event.timestamp} data-annotation-interval={finish > at ? "true" : undefined} data-severity={event.severity ?? "unclassified"} className={finish > at ? styles.eventRange : styles.eventLine}
            style={{ left: position(Math.max(at, eventStart)), width: finish > at ? Math.max(0, position(Math.min(finish, eventEnd)) - position(Math.max(at, eventStart))) : undefined, top: eventTop, bottom: eventBottom }} />;
        })}
      </div>
      {(options.showLegend !== false || !embedded) && <div className={styles.chartFooter} data-chart-footer>
      {emptyCurrent && previousData.length > 0 && <span role="status" className={styles.notice}>No current observations in this window; the dashed lines show the preceding period.</span>}
      {options.showLegend !== false && (
        <div className={styles.legend} role="list" aria-label="Latest values by series">
          {data.map((entry, index) => (
            <span
              className={styles.legendItem}
              role="listitem"
              key={`${entry.name}-${index}`}
              title={options.showTooltip === false ? undefined : entry.name}
            >
              <span
                className={styles.swatch}
                aria-hidden="true"
                style={{ background: entry.color }}
              />
              <span className={styles.legendName}>{displayLabels[index] === entry.name ? entry.name : <><span aria-hidden="true">{displayLabels[index]}</span><span className={styles.srOnly}>{entry.name}</span></>}</span>
              <span
                className={styles.legendValue}
                title={options.showTooltip === false ? undefined : entry.latest
                  ? `Latest valid sample · ${fullDateTimeFormat.format(new Date(entry.latest.timestamp))}`
                  : "No valid sample"}
                aria-label={entry.latest
                  ? `${entry.name}, latest valid sample: ${formatMetricDetails(entry.latest.value, widget.unit, options.decimals)} at ${new Date(entry.latest.timestamp).toISOString()}`
                  : `${entry.name}: no valid sample`}
                data-legend-value={entry.latest?.value}
                data-legend-timestamp={entry.latest?.timestamp}
              >
                {entry.latest
                  ? formatMetric(entry.latest.value, widget.unit, false, options.decimals)
                  : "—"}
              </span>
            </span>
          ))}
        </div>
      )}
      {previousData.length > 0 && zoom && <div className={styles.priorLegend} role="group" aria-label="Previous period overlay" tabIndex={0}>
        <span>Previous period · dashed · aligned to selected window</span>
        {previousData.map(entry => { const last = latestPoint(entry.original); const first = entry.original.points[0]; return <span key={entry.index} data-prior-series={entry.index} data-prior-original-first={first?.timestamp} data-prior-aligned-first={entry.points[0]?.timestamp} title={last ? `Previous sample: ${formatMetricDetails(last.value, widget.unit)} at ${new Date(last.timestamp).toISOString()}` : "No prior sample"}>
          <i aria-hidden="true" style={{ borderColor: entry.color }} />{seriesName(entry.original, entry.index)} · latest valid: {last ? <>{formatMetric(last.value, widget.unit, false, options.decimals)} <time dateTime={new Date(last.timestamp).toISOString()}>{new Date(last.timestamp).toLocaleString()}</time></> : "No data"}
        </span> })}
        {selection?.previous?.truncated && <span>Partial prior result</span>}
      </div>}
      {!embedded && <TimeWindowLens title={widget.title} series={series} unit={widget.unit} decimals={options.decimals} zoom={zoom} onZoom={window => setSelection({ source: series, window })} onOverlay={(window, previous) => setSelection({ source: series, window, previous })} onReset={() => setSelection(undefined)} />}
      {!embedded && previousData.length > 0 && <ChartDataInspector widget={{ ...widget, title: `${widget.title} · Previous period` }} series={previousData.map(entry => entry.original)} buttonText="Inspect prior data" />}
      {!embedded && <ChartDataInspector widget={widget} series={visibleSeries} />}
      </div>}
      {visibleEvents.length > 0 && <details className={eventStyles.annotationEvents} role="group" aria-label="Chart events"><summary>{visibleEvents.length} {visibleEvents.length === 1 ? "event" : "events"} in view</summary><ul>{visibleEvents.map((event, index) => <li key={`${event.timestamp}-${index}`}><span className={eventStyles.annotationBullet} data-severity={event.severity ?? "unclassified"} aria-hidden="true" /><strong>{event.label}</strong><time dateTime={event.timestamp} title={new Date(event.timestamp).toISOString()}>{new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(event.timestamp))}</time>{event.endTimestamp && <time dateTime={event.endTimestamp}>to {new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(event.endTimestamp))}</time>}<span>{event.severity ?? "unclassified"}</span></li>)}</ul></details>}
      {widget.annotationSource && !embedded && eventData.error && <p role="status">Events unavailable: {eventData.error}</p>}
      {widget.annotationSource && !embedded && !!eventData.omitted && <p>{eventData.omitted} invalid or excess event records omitted.</p>}
      {widget.annotationSource && !embedded && eventsInView.length > visibleEvents.length && <p>{eventsInView.length - visibleEvents.length} additional events in view omitted.</p>}
      {widget.annotationSource && !embedded && eventData.truncated && <p>Event source response is partial.</p>}
      {plotTooltip.panel}
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
    !embedded && options.showTooltip !== false;
  const plotTooltip = usePlotTooltip(widget, series, tooltipEnabled);
  const displayLabels = useMemo(() => compactSeriesLabels(series.slice(0, MAX_SERIES)), [series]);
  const rows = useMemo(
    () =>
      series.slice(0, MAX_SERIES).flatMap((entry, index) => {
        const point = latestPoint(entry);
        return point
          ? [
              {
                name: seriesName(entry, index),
                displayName: displayLabels[index],
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
    [series, widget.color, options.thresholds, displayLabels],
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
  const { left: axisLeft, separateUnit } = chartYAxisLayout(rows.map(row => row.value).concat(domain ?? []), widget.unit, options.decimals, options.yAxisLabel);
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
                        rows.find((row) => row.label === value)?.displayName || value;
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
                    fontSize: 11,
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
                    stroke: "var(--gamma-chart-grid, var(--gamma-border, #dfe4db))",
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
                      formatMetric(value, separateUnit ? "" : widget.unit, true, options.decimals),
                  },
                  tickLabels: {
                    opacity: 1,
                    fontSize: 11,
                    thin: { minGap: 12, priority: "ends" },
                  },
                },
          },
        },
        margin: !showAxis
          ? { top: 8, right: 8, bottom: 8, left: 8 }
          : {
              top: separateUnit ? 18 : height < 130 ? 4 : 12,
              right: 10,
              bottom: options.xAxisLabel ? 47 : 28,
              left: axisLeft,
            },
        clip: true,
        theme: configuredTheme(options),
        svgAnimation: false,
        focus: embedded ? false : tooltipEnabled ? focusNearestX : undefined,
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
      axisLeft,
      separateUnit,
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
        {showAxis && separateUnit && <span className={styles.axisUnit} title={widget.unit} data-chart-axis-unit>{widget.unit}</span>}
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
      {(options.showLegend !== false || !embedded) && <div className={styles.chartFooter} data-chart-footer>
      {options.showLegend !== false && (
        <div className={`${styles.legend} ${styles.barLegend}`} role="list" aria-label="Latest values by category" tabIndex={0}>
          {rows.map((row) => <span className={styles.legendItem} role="listitem" key={row.seriesIndex} title={row.name}>
            <span className={styles.swatch} aria-hidden="true" style={{ background: row.color }} />
            <span className={styles.legendName}>{row.displayName === row.name ? row.name : <><span aria-hidden="true">{row.displayName}</span><span className={styles.srOnly}>{row.name}</span></>}</span>
            <span className={styles.legendValue} aria-label={`${row.name}, latest valid sample: ${formatMetricDetails(row.value, widget.unit, options.decimals)} at ${new Date(row.timestamp).toISOString()}`} data-legend-value={row.value} data-legend-timestamp={row.timestamp}>{formatMetric(row.value, widget.unit, false, options.decimals)}</span>
          </span>)}
        </div>
      )}
      {!embedded && <ChartDataInspector widget={widget} series={series} />}
      </div>}
      {plotTooltip.panel}
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
  const embedded = useEmbeddedWidget();
  const { rangeEnd } = useDashboardWindow();
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
  // A Single value intentionally displays the last valid observation. A
  // newer missing observation must still be disclosed: otherwise an older
  // healthy value can be mistaken for a current reading. Match the dashboard
  // bundle's last-in-input rule for duplicate latest timestamps.
  let latestObservation: Point | undefined;
  for (const point of first.entry.points) {
    if (validTimestamp(point.timestamp) && (!latestObservation || point.timestamp >= latestObservation.timestamp)) latestObservation = point;
  }
  const latestMissing = latestObservation !== undefined && (typeof latestObservation.value !== "number" || !Number.isFinite(latestObservation.value));
  const ageSeconds = rangeEnd !== undefined && Number.isFinite(rangeEnd)
    ? Math.max(0, (rangeEnd - first.point.timestamp) / 1000)
    : undefined;
  const stale = ageSeconds !== undefined && widget.options?.staleAfterSeconds !== undefined && ageSeconds > widget.options.staleAfterSeconds;
  const color =
    widgetTextColor(widget.options) ??
    thresholdForValue(first.point.value, widget.options?.thresholds)?.color ??
    widget.color;
  const minimum = widget.options?.min, maximum = widget.options?.max;
  const showBar = widget.options?.showStatBar === true && minimum !== undefined && maximum !== undefined && Number.isFinite(minimum) && Number.isFinite(maximum) && minimum < maximum;
  const boundedValue = showBar ? Math.max(minimum, Math.min(maximum, first.point.value)) : 0;
  const span = showBar ? maximum - minimum : 1;
  const magnitude = showBar ? Math.max(Math.abs(minimum), Math.abs(maximum), 1) : 1;
  const fraction = showBar ? Math.max(0, Math.min(1, Number.isFinite(span) ? (boundedValue - minimum) / span : (boundedValue / magnitude - minimum / magnitude) / (maximum / magnitude - minimum / magnitude))) : 0;
  const barColor = thresholdForValue(first.point.value, widget.options?.thresholds)?.color ?? widget.color ?? "var(--gamma-chart-1)";
  return (
    <div className={`${styles.stat} ${embedded ? styles.embeddedStat : ""}`} data-stat-sparkline-enabled={widget.options?.showSparkline || undefined} data-stat-bar-enabled={showBar || undefined}>
      {latestMissing && <div className={styles.missingObservation} role="status" data-latest-missing="" title="The latest returned observation is missing; the displayed value is the last valid sample.">Last valid · latest missing</div>}
      {stale && <div className={styles.staleObservation} role="status" data-stale-observation="">
        Last valid sample: {Math.floor(ageSeconds / 60) >= 1 ? `${Math.floor(ageSeconds / 60)} min` : `${Math.floor(ageSeconds)} sec`} before range end.
      </div>}
      <div
        className={`${sparklineStyles.summary} ${widget.options?.showSparkline ? sparklineStyles.withSparkline : ""}`}
        data-stat-summary=""
        data-sparkline-placement={widget.options?.sparklinePlacement ?? "background"}
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
              style={{ color: showBar ? widgetTextColor(widget.options) : widget.options?.sparklinePlacement === "side" ? widgetTextColor(widget.options) ?? thresholdForValue(first.point.value, widget.options?.thresholds)?.color : color }}
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
            color={color ?? PALETTE[0]}
          />
        )}
      </div>
      {showBar && <div className={styles.statBar} role="meter" aria-label={`${widget.title} value on configured scale`}
        aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={boundedValue}
        aria-valuetext={`${formatMetricDetails(first.point.value, widget.unit, widget.options?.decimals)}${first.point.value !== boundedValue ? " (outside configured scale)" : ""}`}
        data-stat-bar="" data-stat-bar-value={first.point.value} data-stat-bar-fraction={fraction}>
        <span className={styles.statBarFill} style={{ width: `${fraction * 100}%`, backgroundColor: barColor }} />
      </div>}
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
  const [expandedTrace, setExpandedTrace] = useState<string>();
  const fetchTrace = useTraceFetcher();
  const list = useRef<HTMLDivElement>(null);
  const hintElement = useRef<HTMLParagraphElement>(null);
  const hintId = useId();
  const [overflow, setOverflow] = useState<"vertical" | "horizontal" | "both">();
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    let cancelled = false;
    const measure = () => {
      // Account for the hint's height so it cannot cause its own overflow.
      const availableHeight = element.clientHeight + (hintElement.current?.getBoundingClientRect().height ?? 0);
      const vertical = element.clientHeight > 0 && element.scrollHeight > availableHeight + 1;
      const horizontal = element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1;
      if (!cancelled) setOverflow(vertical && horizontal ? "both" : vertical ? "vertical" : horizontal ? "horizontal" : undefined);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    void document.fonts?.ready.then(measure);
    return () => { cancelled = true; observer?.disconnect(); };
  }, [traces, expandedTrace]);
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
    <div className={styles.traceListContainer}>
    <div
      ref={list}
      className={styles.tableWrap}
      tabIndex={0}
      role="region"
      aria-label={`${widget.title} traces`}
      aria-describedby={overflow ? hintId : undefined}
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
            const status = trace.status.trim().toLowerCase();
            const failed = /^(error|fail|failed|failure|status_code_error)$/.test(
              status,
            );
            const successful = /^(ok|success|succeeded|status_code_ok)$/.test(
              status,
            );
            const statusClass = failed
              ? styles.statusError
              : successful
                ? styles.statusSuccess
                : styles.statusNeutral;
            const barClass = failed
              ? styles.traceError
              : successful
                ? styles.traceSuccess
                : "";
            return (
              <Fragment key={`${trace.traceId}-${index}`}><tr
                tabIndex={onContextChange ? 0 : undefined}
                aria-selected={
                  onContextChange
                    ? selected === contextKey(traceContext(trace))
                    : undefined
                }
                className={
                  onContextChange ? contextStyles.interactiveRow : undefined
                }
                onFocus={(event) => {
                  if (onContextChange && !(event.target as HTMLElement).closest("[data-trace-waterfall-toggle]")) select(trace);
                }}
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
                  {fetchTrace && /^[a-fA-F0-9]{32}$/.test(trace.traceId) && <button type="button" data-trace-waterfall-toggle className={styles.traceExpand} aria-expanded={expandedTrace === trace.traceId} onClick={event => { event.stopPropagation(); setExpandedTrace(previous => previous === trace.traceId ? undefined : trace.traceId); }}>
                    {expandedTrace === trace.traceId ? "Close waterfall" : "View waterfall"}
                  </button>}
                  {expandedTrace === trace.traceId && <TraceDialog traceId={trace.traceId} onClose={() => setExpandedTrace(undefined)} />}
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
                      className={`${styles.traceBar} ${barClass}`}
                      style={{
                        width: `${Number.isFinite(trace.durationMs) ? Math.max(0, (trace.durationMs / maximum) * 100) : 0}%`,
                      }}
                    />
                  </div>
                </td>
                <td>
                  <span
                    className={`${styles.status} ${statusClass}`}
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
              </tr></Fragment>
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
    {overflow && <p ref={hintElement} id={hintId} className={styles.traceScrollHint}>
      {overflow === "both" ? "Scroll to see all traces and columns" : overflow === "vertical" ? "Scroll to see all traces" : "Scroll horizontally to see more columns"}
    </p>}
    </div>
  );
}

export function EmptyState({ partial = false }: { partial?: boolean }) {
  const source = useTooltipWidgetData();
  const contextualPartial = !!(source?.result.truncated || source?.result.records?.truncated);
  const incomplete = partial || contextualPartial;
  return (
    <div className={styles.state}>
      <strong>{incomplete ? "No observations returned" : "No data in this time range"}</strong>
      <p>{partial ? "The provider response may be incomplete. Narrow the query or check the data source." : contextualPartial ? "No observations were included in this incomplete response." : "Try a wider time range or adjust this widget’s query."}</p>
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

/** Leave the sample's vertical track exposed while inspecting adjacent lines. */
export function placePlotTooltip(
  anchor: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  size: { width: number; height: number },
  viewport: TooltipViewport,
) {
  const margin = 12;
  const gap = 16;
  const leftEdge = (viewport.left ?? 0) + margin;
  const rightEdge = (viewport.left ?? 0) + viewport.width - margin;
  const right = anchor.right + gap;
  const left = anchor.left - gap - size.width;
  const fitsRight = right >= leftEdge && right + size.width <= rightEdge;
  const fitsLeft = left >= leftEdge && left + size.width <= rightEdge;
  if (!fitsRight && !fitsLeft) return placeHeatmapTooltip(anchor, size, viewport);
  const topEdge = (viewport.top ?? 0) + margin;
  const bottomEdge = (viewport.top ?? 0) + viewport.height - margin;
  return {
    left: fitsRight ? right : left,
    top: Math.max(
      topEdge,
      Math.min(
        (anchor.top + anchor.bottom - size.height) / 2,
        bottomEdge - size.height,
      ),
    ),
    placement: fitsRight ? "right" : "left",
  };
}

/** Prefer a free area outside the widget, so inspecting never covers its plot. */
export function placeOutsideWidgetTooltip(
  widget: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  anchor: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  size: { width: number; height: number },
  viewport: TooltipViewport,
) {
  const margin = 12, gap = 10;
  const left = (viewport.left ?? 0) + margin, right = (viewport.left ?? 0) + viewport.width - margin;
  const top = (viewport.top ?? 0) + margin, bottom = (viewport.top ?? 0) + viewport.height - margin;
  const maxHeight = Math.max(0, Math.min(560, bottom - top));
  const clampedTop = Math.max(top, Math.min((anchor.top + anchor.bottom - size.height) / 2, bottom - Math.min(size.height, maxHeight)));
  const rightStart = Math.max(left, widget.right + gap), leftStart = Math.min(right - size.width, widget.left - gap - size.width);
  if (rightStart + size.width <= right)
    return { left: rightStart, top: clampedTop, placement: "right", maxHeight, overlapsWidget: false };
  if (leftStart >= left)
    return { left: leftStart, top: clampedTop, placement: "left", maxHeight, overlapsWidget: false };
  const aboveEnd = Math.min(bottom, widget.top - gap), belowStart = Math.max(top, widget.bottom + gap);
  const above = Math.max(0, aboveEnd - top), below = Math.max(0, bottom - belowStart);
  if (Math.max(above, below) >= 64) {
    const useBelow = below >= above, available = Math.min(maxHeight, useBelow ? below : above);
    return {
      left: Math.max(left, Math.min((anchor.left + anchor.right - size.width) / 2, right - size.width)),
      top: useBelow ? belowStart : aboveEnd - Math.min(size.height, available),
      placement: useBelow ? "bottom" : "top", maxHeight: available, overlapsWidget: false,
    };
  }
  // A full-viewport chart has no outside space. Hover previews pass pointer
  // events through in this case; pinning makes the same panel interactive.
  return { ...placePlotTooltip(anchor, size, viewport), maxHeight, overlapsWidget: true };
}

type TooltipRectangle = Pick<DOMRect, "left" | "right" | "top" | "bottom">;
type TooltipObstacle = TooltipRectangle & { weight?: number };

/** Prefer an unobstructed outside position when neighboring panels leave room.
 * When every outside position is occupied, keep the least-obscuring one and
 * retain the existing scrollable, pointer-transparent hover fallback. */
export function placeClearOutsideWidgetTooltip(
  widget: TooltipRectangle,
  anchor: TooltipRectangle,
  size: { width: number; height: number },
  viewport: TooltipViewport,
  obstacles: readonly TooltipObstacle[],
) {
  const baseline = placeOutsideWidgetTooltip(widget, anchor, size, viewport);
  if (!obstacles.length || baseline.overlapsWidget) return baseline;
  const left = (viewport.left ?? 0) + 12, right = (viewport.left ?? 0) + viewport.width - 12;
  const top = (viewport.top ?? 0) + 12, bottom = (viewport.top ?? 0) + viewport.height - 12;
  const gap = 10, maxHeight = Math.max(0, Math.min(560, bottom - top));
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
  const overlap = (a: TooltipRectangle, b: TooltipRectangle) =>
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const candidates = [baseline];
  const vertical = (placement: "top" | "bottom", boundary: number, available: number) => {
    const limit = Math.min(maxHeight, available);
    if (limit < 64 || right - left < size.width) return;
    const height = Math.min(size.height, limit);
    const y = placement === "top" ? boundary - height : boundary;
    const xs = [(anchor.left + anchor.right - size.width) / 2, left, right - size.width,
      ...obstacles.flatMap(rect => [rect.left - size.width - gap, rect.right + gap])];
    for (const value of xs) candidates.push({ left: clamp(value, left, right - size.width), top: y, placement, maxHeight: limit, overlapsWidget: false });
  };
  const horizontal = (placement: "left" | "right", x: number) => {
    if (x < left || x + size.width > right || maxHeight < 64) return;
    const height = Math.min(size.height, maxHeight);
    const ys = [(anchor.top + anchor.bottom - height) / 2, top, bottom - height,
      ...obstacles.flatMap(rect => [rect.top - height - gap, rect.bottom + gap])];
    for (const value of ys) candidates.push({ left: x, top: clamp(value, top, bottom - height), placement, maxHeight, overlapsWidget: false });
  };
  vertical("top", Math.min(bottom, widget.top - gap), Math.max(0, Math.min(bottom, widget.top - gap) - top));
  vertical("bottom", Math.max(top, widget.bottom + gap), Math.max(0, bottom - Math.max(top, widget.bottom + gap)));
  horizontal("left", widget.left - gap - size.width);
  horizontal("right", widget.right + gap);
  const score = (candidate: typeof baseline) => {
    const height = Math.min(size.height, candidate.maxHeight);
    const rect = { left: candidate.left, right: candidate.left + size.width, top: candidate.top, bottom: candidate.top + height };
    return {
      controls: obstacles.filter(obstacle => (obstacle.weight ?? 1) > 1).reduce((sum, obstacle) => sum + overlap(rect, obstacle), 0),
      other: obstacles.filter(obstacle => (obstacle.weight ?? 1) <= 1).reduce((sum, obstacle) => sum + overlap(rect, obstacle), 0) + (size.height - height) * size.width,
    };
  };
  return candidates.reduce((best, candidate) => {
    const a = score(candidate), b = score(best);
    return a.controls < b.controls || (a.controls === b.controls && a.other < b.other) ? candidate : best;
  }, baseline);
}

/** Use a narrower inspector when it makes room beside the chart. */
export function outsideTooltipWidthLimit(
  widget: Pick<DOMRect, "left" | "right">,
  viewport: TooltipViewport,
) {
  const left = (viewport.left ?? 0) + 12;
  const right = (viewport.left ?? 0) + viewport.width - 12;
  const available = Math.max(
    0,
    right - Math.max(left, widget.right + 10),
    Math.min(right, widget.left - 10) - left,
  );
  // Below 240px, retain the comfortable width and try above/below instead.
  return available >= 240 ? Math.min(330, available) : Math.max(0, right - left);
}

/** A transient overlay must not intercept pointer movement over another tile. */
export function tooltipOverlapsOtherWidget(
  panel: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  owner: Element,
) {
  return [...document.querySelectorAll("[data-widget-id]")].some(other => {
    if (other === owner || other.contains(owner) || owner.contains(other)) return false;
    const bounds = other.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && panel.left < bounds.right && panel.right > bounds.left && panel.top < bounds.bottom && panel.bottom > bounds.top;
  });
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
  preferSide = false,
  avoidWidget = false,
  pinned = false,
  panelRef,
  role = "tooltip",
  ariaLabel,
  className,
  tabIndex,
  onDismiss,
  onEnter,
  onLeave,
  children,
}: {
  id: string;
  anchor: Element;
  anchorRect?: () => DOMRect;
  preferSide?: boolean;
  avoidWidget?: boolean;
  pinned?: boolean;
  panelRef?: (element: HTMLDivElement | null) => void;
  role?: "tooltip" | "region";
  ariaLabel?: string;
  className?: string;
  tabIndex?: number;
  onDismiss: () => void;
  onEnter: () => void;
  onLeave: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [compactState, setCompactState] = useState({ anchor, pinned, minimized: false });
  if (compactState.anchor !== anchor || compactState.pinned !== pinned) {
    setCompactState({ anchor, pinned, minimized: false });
  }
  const minimized = narrow && pinned && compactState.anchor === anchor && compactState.pinned === pinned && compactState.minimized;
  const dismissRef = useRef(onDismiss);
  const pinnedRef = useRef(pinned);
  useLayoutEffect(() => {
    dismissRef.current = onDismiss;
    pinnedRef.current = pinned;
  }, [onDismiss, pinned]);
  useEffect(() => {
    // A stationary pointer can acquire a new hover target after scrolling
    // while another chart still has focus. Keep transient previews singular;
    // explicitly pinned observations remain under the user's control.
    const opened = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id && !pinnedRef.current) dismissRef.current();
    };
    document.addEventListener("paprika:observation-open", opened);
    document.dispatchEvent(new CustomEvent("paprika:observation-open", { detail: id }));
    return () => document.removeEventListener("paprika:observation-open", opened);
  }, [id]);
  const assignRef = useCallback((element: HTMLDivElement | null) => { ref.current = element; panelRef?.(element); }, [panelRef]);
  const [position, setPosition] = useState<ReturnType<
    typeof placeHeatmapTooltip
  > & { overlapsWidget?: boolean; overlapsOtherWidget?: boolean; overlapsControls?: boolean; pointer?: boolean } | null>(null);
  useLayoutEffect(() => {
    let frame = 0;
    const stopPointer = installTooltipPointerTracking();
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
      setNarrow(visibleViewport.width < 600);
      const anchorBounds = anchorRect?.() ?? anchor.getBoundingClientRect();
      const limits = heatmapTooltipSizeLimit(anchorBounds, visibleViewport);
      const pointer = !pinned ? pointerOverAnchor(anchor) : undefined;
      if (pointer) {
        element.style.maxWidth = `${Math.max(0, visibleViewport.width - 24)}px`;
        element.style.maxHeight = `${Math.max(0, Math.min(560, visibleViewport.height - 24))}px`;
        const next = placePointerTooltip(pointer, element.getBoundingClientRect(), visibleViewport);
        element.style.maxHeight = `${next.maxHeight}px`;
        setPosition(previous => previous?.pointer && previous.left === next.left && previous.top === next.top && previous.placement === next.placement ? previous : { ...next, pointer: true });
        return;
      }
      if (avoidWidget) {
        const widget = anchor.closest("[data-widget-id]") ?? anchor.parentElement ?? anchor;
        const widgetBounds = widget.getBoundingClientRect();
        // Keep inspectors inside the dashboard canvas rather than covering
        // navigation or the settings panel alongside it. Dialogs and charts
        // outside a dashboard retain the ordinary viewport bounds.
        const canvas = anchor.closest('[data-testid="dashboard-canvas"]');
        const canvasBounds = canvas?.getBoundingClientRect();
        const canvasLeft = Math.max(visibleViewport.left ?? 0, canvasBounds?.left ?? (visibleViewport.left ?? 0));
        const canvasRight = Math.min((visibleViewport.left ?? 0) + visibleViewport.width, canvasBounds?.right ?? ((visibleViewport.left ?? 0) + visibleViewport.width));
        const tooltipViewport = canvasBounds && canvasRight - canvasLeft >= 240
          ? { ...visibleViewport, left: canvasLeft, width: canvasRight - canvasLeft }
          : visibleViewport;
        const obstacles = [...document.querySelectorAll("[data-widget-id], [data-tooltip-obstacle]")].flatMap(other => {
          if (other === widget || other.contains(widget) || widget.contains(other)) return [];
          const bounds = other.getBoundingClientRect();
          const viewportLeft = tooltipViewport.left ?? 0, viewportTop = tooltipViewport.top ?? 0;
          return bounds.width > 0 && bounds.height > 0 && bounds.right > viewportLeft && bounds.left < viewportLeft + tooltipViewport.width && bounds.bottom > viewportTop && bounds.top < viewportTop + tooltipViewport.height
            ? [{ left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, weight: other.hasAttribute("data-tooltip-obstacle") ? 8 : 1 }]
            : [];
        });
        element.style.maxWidth = `${outsideTooltipWidthLimit(widgetBounds, tooltipViewport)}px`;
        // Clear a previous placement's height restriction before measuring.
        // Otherwise an expanding tooltip is scored as if its clipped height
        // were its full height, and the second placement can choose a smaller
        // space without applying that new space's height limit.
        element.style.maxHeight = `${Math.max(0, Math.min(560, tooltipViewport.height - 24))}px`;
        const next = placeClearOutsideWidgetTooltip(widgetBounds, anchorBounds, element.getBoundingClientRect(), tooltipViewport, obstacles);
        element.style.maxHeight = `${next.maxHeight}px`;
        const size = element.getBoundingClientRect();
        const overlapsOtherWidget = tooltipOverlapsOtherWidget({ left: next.left, right: next.left + size.width, top: next.top, bottom: next.top + size.height }, widget);
        const overlapsControls = obstacles.some(rect => rect.weight === 8 && next.left < rect.right && next.left + size.width > rect.left && next.top < rect.bottom && next.top + size.height > rect.top);
        setPosition(previous => !previous?.pointer && previous?.left === next.left && previous?.top === next.top && previous?.placement === next.placement && previous?.overlapsWidget === next.overlapsWidget && previous?.overlapsOtherWidget === overlapsOtherWidget && previous?.overlapsControls === overlapsControls ? previous : { ...next, overlapsOtherWidget, overlapsControls });
        return;
      }
      element.style.maxWidth = `${limits.width}px`;
      const candidate = preferSide
        ? placePlotTooltip(
            anchorBounds,
            element.getBoundingClientRect(),
            visibleViewport,
          )
        : null;
      const useSide =
        candidate?.placement === "left" || candidate?.placement === "right";
      // Side panels leave neighboring lines reachable; vertical panels must
      // scroll before they can overlap the trigger that pins or dismisses them.
      element.style.maxHeight = `${
        useSide
          ? Math.max(0, Math.min(560, visibleViewport.height - 24))
          : limits.height
      }px`;
      const bounds = element.getBoundingClientRect();
      const next = useSide
        ? placePlotTooltip(anchorBounds, bounds, visibleViewport)
        : placeHeatmapTooltip(anchorBounds, bounds, visibleViewport);
      setPosition((previous) =>
        !previous?.pointer && previous?.left === next.left &&
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
    const followPointer = (event: PointerEvent) => {
      if (!pinned && event.pointerType !== "touch" && event.target instanceof Node && anchor.contains(event.target)) schedule();
    };
    update();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(schedule);
    // A scroll-capped panel can gain content without its border box resizing.
    // Observe content changes as well, so async results and pinning can choose
    // a better position instead of retaining a stale small height limit.
    const contentObserver = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(schedule);
    if (ref.current) observer?.observe(ref.current);
    if (ref.current) contentObserver?.observe(ref.current, { subtree: true, childList: true, characterData: true });
    observer?.observe(anchor);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("pointermove", followPointer, true);
    document.addEventListener("keydown", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      stopTheme?.();
      stopPointer();
      cancelAnimationFrame(frame);
      observer?.disconnect();
      contentObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("pointermove", followPointer, true);
      document.removeEventListener("keydown", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [anchor, anchorRect, preferSide, avoidWidget, minimized, pinned]);
  useEffect(() => {
    const pointer = (event: PointerEvent) => {
      if (
        !anchor.contains(event.target as Node) &&
        !ref.current?.contains(event.target as Node)
      )
        onDismiss();
    };
    const focus = (event: FocusEvent) => {
      if (!pinned && !anchor.contains(event.target as Node) && !ref.current?.contains(event.target as Node)) {
        onDismiss();
      }
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // A focused Gamma menu/listbox owns the first Escape even though its
        // panel is portaled away from the widget and observation tooltip.
        if (event.target instanceof Element && event.target.closest("[data-gamma-portal]")) return;
        // A fading hover card must not swallow Escape from another chart.
        if (anchor.contains(event.target as Node) || ref.current?.contains(event.target as Node)) {
          event.preventDefault();
          event.stopPropagation();
        }
        onDismiss();
        return;
      }
      const element = ref.current;
      if (
        element &&
        (event.target === anchor || (role !== "region" && element.contains(event.target as Node))) &&
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
    document.addEventListener("focusin", focus, true);
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("keydown", keyboard, true);
    };
  }, [anchor, onDismiss, pinned, role]);
  return createPortal(
    <div
      ref={assignRef}
      id={id}
      role={role}
      aria-label={ariaLabel}
      tabIndex={tabIndex}
      className={`${configStyles.heatmapTooltip} ${className ?? ""}`}
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        width: minimized ? "max-content" : undefined,
        visibility: position ? "visible" : "hidden",
        pointerEvents: !pinned && (position?.pointer || (avoidWidget && (position?.overlapsWidget || position?.overlapsOtherWidget || position?.overlapsControls))) ? "none" : undefined,
      }}
      data-placement={position?.placement}
      data-tooltip-pointer={position?.pointer || undefined}
      data-tooltip-overlap={position?.overlapsWidget || undefined}
      data-tooltip-overlaps-other-widget={position?.overlapsOtherWidget || undefined}
      data-tooltip-overlaps-controls={position?.overlapsControls || undefined}
      data-inspector-minimized={minimized || undefined}
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
      {pinned && avoidWidget && narrow && (minimized || position?.overlapsWidget || position?.overlapsOtherWidget || position?.overlapsControls) && (
        <div className={configStyles.tooltipCompactControls}>
          <GammaButton variant="ghost" size="sm" aria-label={minimized ? "Show inspector details" : "Minimize inspector"} aria-expanded={!minimized} aria-controls={`${id}-details`} onClick={() => setCompactState({ anchor, pinned, minimized: !minimized })}>
            {minimized ? "Show details" : "Minimize"}
          </GammaButton>
          {minimized && <GammaButton variant="ghost" size="sm" aria-label="Close inspector" onClick={() => {
            const returnFocus = ref.current?.contains(document.activeElement);
            if (returnFocus && (anchor instanceof HTMLElement || anchor instanceof SVGElement)) anchor.focus({ preventScroll: true });
            onDismiss();
          }}>Close</GammaButton>}
        </div>
      )}
      <div id={`${id}-details`} hidden={minimized}>{children}</div>
    </div>,
    // Native dialogs occupy the browser top layer; a body portal would render
    // behind them even with a high z-index. Escape the chart within that layer.
    anchor.closest("dialog[open]") ?? document.body,
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
  avoidWidget = true,
  selectOnFocus = true,
  tabIndex,
}: {
  label: string;
  children: ReactNode;
  details: ReactNode;
  onSelect?: () => void;
  enabled?: boolean;
  className?: string;
  revision?: unknown;
  externalAnchor?: Element;
  avoidWidget?: boolean;
  /** Some contexts change dashboard variables only on explicit activation. */
  selectOnFocus?: boolean;
  /** A dense visual can expose individual observations through a separate keyboard-accessible explorer. */
  tabIndex?: number;
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
        tabIndex={tabIndex}
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
          if (selectOnFocus) onSelect?.();
          if (!active?.pinned) show(event.currentTarget);
        }}
        onBlur={() => {
          interaction.current.focused = false;
          // Focus can move into the portaled content. Pinned observations
          // remain open until explicitly dismissed.
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
          avoidWidget={avoidWidget}
          pinned={active.pinned}
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
            <small><TooltipInstructions /></small>
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
  timestampFirst = false,
  compact = false,
  children,
}: {
  series: Series;
  index: number;
  point?: Point;
  unit: string;
  decimals?: number;
  description?: string;
  timestampFirst?: boolean;
  compact?: boolean;
  children?: ReactNode;
}) {
  const value =
    typeof point?.value === "number" && Number.isFinite(point.value)
      ? point.value
      : undefined;
  const timestamp = point && validTimestamp(point.timestamp) ? (
    <time dateTime={new Date(point.timestamp).toISOString()}>
      {fullDateTimeFormat.format(new Date(point.timestamp))}
    </time>
  ) : <span>No valid timestamp</span>;
  return (
    <>
      <div className={configStyles.tooltipHeader} data-tooltip-compact={compact || undefined}>
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
        {timestampFirst && <span className={configStyles.tooltipKeyHint}>{description} · {timestamp}</span>}
        {children}
      </div>
      {!!Object.keys(series.labels).length && (
        <div className={`${configStyles.tooltipLabels}${compact ? ` ${configStyles.tooltipVisuallyHidden}` : ""}`}>
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
      {!timestampFirst && <div className={configStyles.tooltipFooter}>
        <span>{description}</span>
        {timestamp}
      </div>}
    </>
  );
}

export function ChartDataInspector({
  widget,
  series,
  buttonText = "Inspect data",
}: {
  widget: Widget;
  series: Series[];
  buttonText?: string;
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
        {buttonText}
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
          avoidWidget
          pinned={active.pinned}
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
              <TooltipInstructions />
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
      return <TimeSeriesChart widget={widget} series={series} onContextChange={onContextChange} />;
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

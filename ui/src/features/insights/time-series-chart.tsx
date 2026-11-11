"use client";

// The time-series renderer. chart-renderers.tsx re-exports it, so existing importers are unchanged.
import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { areaY } from "@tanstack/charts/area";
import { crosshair } from "@tanstack/charts/crosshair";
import { d3Curve } from "@tanstack/charts/d3/shape";
import { focusGroupX, focusNearestX } from "@tanstack/charts/focus";
import { lineY } from "@tanstack/charts/line";
import { decorative } from "@tanstack/charts/mark/decorative";
import { Chart } from "@tanstack/charts/react";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { defineChart } from "@tanstack/charts/scene";
import { tooltip } from "@tanstack/charts/tooltip";
import type { ChartLinearGradient } from "@tanstack/charts";
import { curveMonotoneX, curveStepAfter } from "d3-shape";
import { useAnnotationEvents } from "./annotation-events";
import { ChartEvents } from "./chart-events";
import { useChartCursor } from "./chart-cursor";
import { ChartDataInspector } from "./chart-data-inspector";
import {
  dateTimeOptions,
  downsamplePoints,
  fittingBandLabel,
  formatMetric,
  formatMetricDetails,
  formatTimeTick,
  fullDateTimeOptions,
  isolatedPlotPoints,
  latestPoint,
  observedRuns,
  plotTimeDomain,
  sampleCadence,
  seriesCoverage,
  seriesName,
  uncoveredIntervals,
  withGapBreaks,
} from "./chart-data";
import { useChartEntrance } from "./chart-entrance";
import { calendarTickLabel, calendarTicks, DEFAULT_AREA_OPACITY, horizontalPlotBounds, signedAreaGradient, temporalPosition, visibleBaseline } from "./chart-presentation";
import {
  EMPTY_OPTIONS,
  MAX_SERIES,
  PALETTE,
  chartYAxisLayout,
  configuredTheme,
  resolveChartDomain,
  responsiveChartTicks,
  themedPortal,
  usePlotSize,
  type Point,
  type Series,
} from "./chart-renderer-shared";
import styles from "./charts.module.css";
import chartStyles from "./time-series-chart.module.css";
import { useDashboardTimeZone } from "./dashboard-time-zone";
import chartEntrance from "./chart-entrance.module.css";
import { useDashboardWindow } from "./dashboard-window";
import type { DrilldownContext } from "./drilldown";
import hatchStyles from "./plot-hatch.module.css";
import { usePlotTooltip } from "./plot-tooltip";
import type { QueryResult, Widget, WidgetOptions } from "./schema";
import { resolveSeriesColor } from "./series-colors";
import { displaySeriesNames, fallbackIdentityTitle } from "./series-display";
import { alignPriorPeriod, formatWindowDuration, minimumTimeWindow, normalizeTimeWindow, sameTimeWindow, seriesInWindow, timeWindowExtent, type ObservationWindow } from "./time-window";
import { useTimeWindowBrush, type BrushPoint, type TimeBrushPreview } from "./chart-window-controls";
import { TimeWindowLens } from "./time-window-lens";
import { useTooltipWidgetData } from "./tooltip-widget-data";
import { validTimestamp } from "./widget-context";
import { thresholdPaint } from "./status";
import { useWidgetPresentation } from "./widget-presentation";

const CURVES = {
  linear: undefined,
  step: d3Curve(curveStepAfter),
  monotone: d3Curve(curveMonotoneX),
};

/**
 * Guides participate in autoscaling, but explicit axis bounds win: thresholds, reference lines and the zero line all
 * join the domain, so none of them is clipped.
 */
export function resolveTimeSeriesDomain(series: Series[], options: WidgetOptions): [number, number] | undefined {
  const guides = [
    ...(options.thresholds ?? []).map(threshold => threshold.value),
    ...(options.referenceLines ?? []).map(reference => reference.value),
    ...(options.showZeroLine ? [0] : []),
  ].filter(value => Number.isFinite(value));
  if (!guides.length) return resolveChartDomain(series, options);
  let observedMin = Infinity, observedMax = -Infinity;
  for (const value of guides) { observedMin = Math.min(observedMin, value); observedMax = Math.max(observedMax, value); }
  for (const entry of series) for (const point of entry.points) if (validTimestamp(point.timestamp) && typeof point.value === "number" && Number.isFinite(point.value)) { observedMin = Math.min(observedMin, point.value); observedMax = Math.max(observedMax, point.value); }
  const padding = Math.max((observedMax - observedMin) * .05, observedMin === observedMax ? Math.max(1, Math.abs(observedMin) * .1) : 0);
  let min = options.min ?? observedMin - padding, max = options.max ?? observedMax + padding;
  if (min >= max) {
    if (options.min !== undefined && options.max === undefined) max = min + Math.max(1, Math.abs(min) * .1);
    else if (options.max !== undefined && options.min === undefined) min = max - Math.max(1, Math.abs(max) * .1);
  }
  return [min, max];
}

/**
 * The 2D context that measures band labels. It is probed once, and probed again only when the canvas factory itself is
 * replaced (a polyfill, or a test double), so a measurement never comes from a factory that is no longer in use.
 */
let labelCanvas: { factory: unknown; context: CanvasRenderingContext2D | null } = { factory: undefined, context: null };

/** The width of `text` in a 12px band label of `family`, or undefined where the browser gives no 2D context (happy-dom). */
function measureBandLabel(text: string, family: string): number | undefined {
  const factory = typeof HTMLCanvasElement === "undefined" ? undefined : HTMLCanvasElement.prototype.getContext;
  if (labelCanvas.factory !== factory) {
    let context: CanvasRenderingContext2D | null = null;
    try {
      context = factory ? document.createElement("canvas").getContext("2d") : null;
    } catch {
      // No context from this browser, so the estimate in chart-data.ts stands in.
    }
    labelCanvas = { factory, context };
  }
  const { context } = labelCanvas;
  if (!context) return undefined;
  // The label inherits only the family. Its weight, style and letter spacing are pinned in charts.module.css to match.
  context.font = `400 12px ${family}`;
  return context.measureText(text).width;
}

/** The vertical gridlines' stroke: the chart grid token, with the light theme's value as its fallback. */
const GRIDLINE_STROKE = "var(--gamma-chart-grid, var(--gamma-border, #e4ebed))";

/** The brush's placeholder window when a chart has no time extent. The brush is disabled then, so this only keeps its staleness check defined. */
const NO_WINDOW: ObservationWindow = { start: 0, end: 0 };

/** The drag preview: the span under the pointer, labelled with its duration. */
function TimeBrushOverlay({ preview, top, bottom }: { preview: TimeBrushPreview | null; top: number; bottom: number }) {
  if (!preview) return null;
  const left = Math.min(preview.x1, preview.x2), selected = Math.abs(preview.x2 - preview.x1);
  return <div className={chartStyles.brush} style={{ left, width: selected, top, bottom }} data-time-brush-selection aria-hidden="true"><span>{formatWindowDuration(Math.abs(preview.end - preview.start))}</span></div>;
}

export function TimeSeriesChart({
  widget,
  series,
  onContextChange,
}: {
  widget: Widget;
  series: Series[];
  onContextChange?: (context: DrilldownContext) => void;
}) {
  const { ref, width, height } = usePlotSize();
  // Band labels inherit the plot's font family, so they are measured in it. The family is read once, when the plot mounts.
  const [labelFamily, setLabelFamily] = useState<string>();
  useLayoutEffect(() => {
    if (ref.current) setLabelFamily(getComputedStyle(ref.current).fontFamily || "sans-serif");
  }, [ref]);
  const measureLabel = labelFamily ? (text: string) => measureBandLabel(text, labelFamily) : undefined;
  const [selection, setSelection] = useState<{ source: Series[]; window: ObservationWindow; previous?: QueryResult }>();
  // The full extent a drag or the Compare dialog may select from, and the narrowest window either may commit.
  const extent = useMemo(() => timeWindowExtent(series), [series]);
  const minimumSpan = useMemo(() => extent ? minimumTimeWindow(series, extent) : 1, [series, extent]);
  // Query/variable changes must never reuse a range selected from another result.
  const zoom = selection?.source === series ? selection.window : undefined;
  const visibleSeries = useMemo(() => zoom ? seriesInWindow(series, zoom) : series, [series, zoom]);
  const previousResult = selection?.previous;
  const prior = useMemo(() => zoom && previousResult ? alignPriorPeriod(series.slice(0, MAX_SERIES), previousResult.series ?? [], zoom) : [], [series, zoom, previousResult]);
  const emptyCurrent = !!zoom && !visibleSeries.slice(0, MAX_SERIES).some(entry => latestPoint(entry));
  const emptyZoom = emptyCurrent && !prior.length;
  const cursor = useChartCursor();
  const eventData = useAnnotationEvents();
  const timeZone = useDashboardTimeZone();
  const detailTimeFormat = useMemo(() => new Intl.DateTimeFormat("en", { ...dateTimeOptions, timeZone }), [timeZone]);
  const timestampFormat = useMemo(() => new Intl.DateTimeFormat("en", { ...fullDateTimeOptions, timeZone }), [timeZone]);
  const { embedded, showAxis, descriptionId } = useWidgetPresentation();
  const entering = useChartEntrance({ disabled: embedded, anchor: ref });
  const { rangeEnd } = useDashboardWindow();
  const truncated = useTooltipWidgetData()?.result.truncated;
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
  const displayLabels = useMemo(() => displaySeriesNames(visibleSeries.slice(0, MAX_SERIES)), [visibleSeries]);
  // A lone generic series is identified by the widget's authored title; see fallbackIdentityTitle.
  const identityTitle = useMemo(() => fallbackIdentityTitle(widget, visibleSeries), [widget, visibleSeries]);
  const previousIdentityTitle = useMemo(() => fallbackIdentityTitle(widget, prior.map(entry => entry.original)), [widget, prior]);
  const plotTooltip = usePlotTooltip(widget, visibleSeries, tooltipEnabled, onContextChange, displayLabels);
  const domain = useMemo(
    () => resolveTimeSeriesDomain([...visibleSeries.slice(0, MAX_SERIES), ...prior.map(entry => entry.shifted)], options),
    [visibleSeries, prior, options],
  );
  const previousData = useMemo(() => prior.map(entry => ({ ...entry, color: resolveSeriesColor(entry.original.labels, options.seriesColors, entry.index === 0 && widget.color ? widget.color : PALETTE[entry.index % PALETTE.length]), points: downsamplePoints(entry.shifted.points), plotPoints: downsamplePoints(withGapBreaks(entry.shifted.points, sampleCadence(entry.shifted.points))) })), [prior, widget.color, options.seriesColors]);
  const data = useMemo(
    () =>
      visibleSeries.slice(0, MAX_SERIES).map((entry, index) => {
        const cadence = sampleCadence(entry.points);
        const tag = (point: Point) => ({ ...point, series: seriesName(entry, index), seriesIndex: index });
        // Plot-only: an inferred gap gets a null break so the line ends there. Values, legends and tooltips never see it.
        const plotPoints = downsamplePoints(withGapBreaks(entry.points, cadence)).map(tag);
        return {
          name: seriesName(entry, index),
          latest: latestPoint(entry),
          color: resolveSeriesColor(entry.labels, options.seriesColors,
            index === 0 && widget.color ? widget.color : PALETTE[index % PALETTE.length]),
          points: downsamplePoints(entry.points).map(tag),
          plotPoints,
          // Observations that no line segment reaches. They get dots of their own.
          dotPoints: isolatedPlotPoints(plotPoints),
        };
      }),
    [visibleSeries, widget.color, options.seriesColors],
  );
  // One fill per observed run, so a gap never moves another run's zero line. Runs with the same stops share a gradient.
  // Each fade meets the visible zero line, which is the plot edge nearest zero when the domain excludes zero.
  const baseline = visibleBaseline(domain);
  const areaFills = useMemo(() => {
    const gradients = new Map<string, ChartLinearGradient>();
    const fills = options.display !== "area" ? [] : data.flatMap((entry, index) => observedRuns(entry.plotPoints).map((points, part) => {
      const gradient = signedAreaGradient("", entry.color, points.map(point => point.value), options.fillOpacity ?? DEFAULT_AREA_OPACITY, baseline);
      const key = JSON.stringify(gradient.stops);
      if (!gradients.has(key)) gradients.set(key, { ...gradient, id: `area-gradient-${gradients.size}` });
      return { series: index, id: `area-${index}-${part}`, gradientId: gradients.get(key)!.id, points };
    }));
    return { fills, gradients: [...gradients.values()] };
  }, [data, options.display, options.fillOpacity, baseline]);
  // Coverage comes from every series in the result, not only the plotted ones, so "No samples" is true for the whole
  // result. It is measured on the unsampled points, so downsampling can neither hide nor invent a gap.
  const coverage = useMemo(
    () => series.map((entry) => seriesCoverage(entry.points, sampleCadence(entry.points))),
    [series],
  );
  // The plotted current and prior samples define one time domain. TanStack's x scale, the shared cursor, events,
  // the stale tail and the no-sample bands all map time through it, so every overlay sits on its samples.
  const plottedTimes = [...data, ...previousData].flatMap((entry) =>
    entry.points.length ? [entry.points[0].timestamp, entry.points.at(-1)!.timestamp] : [],
  );
  const dataStart = plottedTimes.length ? Math.min(...plottedTimes) : undefined;
  const dataEnd = plottedTimes.length ? Math.max(...plottedTimes) : undefined;
  // Stale tail: rangeEnd lies beyond the latest observation of any series in the result by more than the limit. It is
  // judged on the unzoomed series and only for a complete result. Without staleAfterSeconds, the limit is two expected
  // intervals. That is a factual "expected samples missing" rule, not a verdict on the source.
  const staleTail = useMemo(() => {
    if (embedded || zoom || truncated || rangeEnd === undefined || !Number.isFinite(rangeEnd)) return undefined;
    const latest = series.flatMap((entry) => {
      const last = latestPoint(entry);
      return last ? [{ entry, last }] : [];
    });
    if (!latest.length) return undefined;
    const at = Math.max(...latest.map((item) => item.last.timestamp));
    // The longest cadence among the series that reported at `at`, so a slow series is not called stale early.
    const cadence = latest.reduce<number | null>((known, item) => {
      const own = item.last.timestamp === at ? sampleCadence(item.entry.points) : null;
      return own === null ? known : Math.max(known ?? 0, own);
    }, null);
    const limit = options.staleAfterSeconds !== undefined ? options.staleAfterSeconds * 1000 : cadence === null ? undefined : 2 * cadence;
    return limit !== undefined && rangeEnd - at > limit ? { from: at, to: rangeEnd } : undefined;
  }, [series, embedded, zoom, truncated, rangeEnd, options.staleAfterSeconds]);
  const timeEnd = staleTail && dataEnd !== undefined ? Math.max(dataEnd, staleTail.to) : dataEnd;
  const timeSpan = dataStart !== undefined && timeEnd !== undefined ? timeEnd - dataStart : 0;
  const timeDomain = useMemo(
    () => (dataStart !== undefined && timeEnd !== undefined ? plotTimeDomain(dataStart, timeEnd) : undefined),
    [dataStart, timeEnd],
  );
  // Calendar ticks sit on the dashboard zone's own boundaries and are placed by true instant. Only the calendar axis reads them.
  const calendarTickList = useMemo(() => options.timeAxis === "calendar" && timeDomain ? calendarTicks(timeDomain[0], timeDomain[1], ticks.x, timeZone) : undefined, [options.timeAxis, timeDomain, ticks.x, timeZone]);
  const calendarLabels = useMemo(() => new Map((calendarTickList ?? []).map(tick => [tick.value, calendarTickLabel(tick, timeZone)] as const)), [calendarTickList, timeZone]);
  const { left: axisLeft, separateUnit } = chartYAxisLayout([...data, ...previousData].flatMap(entry => entry.points.map(point => point.value ?? 0)).concat(domain ?? []), widget.unit, options.decimals, options.yAxisLabel, options.axisUnit);
  // Plot insets: the TanStack margins and every overlay (cursor, bands, events, brush) map time through these bounds.
  const { left: plotLeft, right: plotRight, plotWidth } = horizontalPlotBounds(width, !showAxis ? 8 : options.plotInsetLeft ?? axisLeft, !showAxis ? 8 : options.plotInsetRight ?? 12);
  const xAt = (time: number) => timeDomain ? temporalPosition(time, timeDomain[0], timeDomain[1], plotLeft, plotLeft + plotWidth) : 0;
  const bandBox = (from: number, to: number) => ({ left: xAt(from), width: Math.max(1.5, xAt(to) - xAt(from)) });
  const cursorX = cursor && !embedded && timeDomain && timeSpan > 0 && cursor.timestamp >= timeDomain[0] && cursor.timestamp <= timeDomain[1]
    ? xAt(cursor.timestamp) : undefined;
  // Event markers are decorative and never intercept chart pointer input.
  const eventStart = dataStart ?? 0, eventEnd = timeEnd ?? 0;
  const eventsInView = widget.annotationSource && !embedded && dataStart !== undefined ? eventData.events.filter(event => {
    const at = Date.parse(event.timestamp);
    return at <= eventEnd && Date.parse(event.endTimestamp ?? event.timestamp) >= eventStart;
  }) : [];
  const visibleEvents = eventsInView.slice(0, 20);
  const eventTop = !showAxis ? 8 : separateUnit ? 18 : height < 130 ? 4 : 10;
  const eventBottom = !showAxis ? 8 : options.xAxisLabel ? 47 : 29;
  // Drag across the plot to select a time window. The pointer maps onto the displayed domain, so a drag selects what the plot shows.
  const brush = useTimeWindowBrush({
    enabled: !embedded && !!extent,
    revision: series,
    window: zoom ?? extent ?? NO_WINDOW,
    point: (clientX: number, clientY: number): BrushPoint | null => {
      const box = ref.current?.getBoundingClientRect();
      if (!box?.width || !box.height || !timeDomain) return null;
      const rawX = (clientX - box.left) * width / box.width, y = (clientY - box.top) * height / box.height;
      const x = Math.max(plotLeft, Math.min(plotLeft + plotWidth, rawX));
      return { x, y, inPlot: rawX >= plotLeft && rawX <= plotLeft + plotWidth && y >= eventTop && y <= height - eventBottom, timestamp: timeDomain[0] + (x - plotLeft) / Math.max(1, plotWidth) * (timeDomain[1] - timeDomain[0]) };
    },
    commit: (candidate) => {
      if (!extent) return false;
      const accepted = normalizeTimeWindow(candidate, extent, minimumSpan);
      if (!accepted || (zoom && sameTimeWindow(accepted, zoom))) return false;
      setSelection({ source: series, window: accepted });
      return true;
    },
    onStart: () => {},
  });
  // No-sample bands: time that no series in the result observes. A truncated result may simply lack samples, so it
  // draws no bands and no tail. The stale tail owns everything after the latest observation.
  const bands = useMemo(() => {
    if (embedded || truncated || dataStart === undefined || dataEnd === undefined || dataEnd <= dataStart) return [];
    const holes = uncoveredIntervals(coverage, [dataStart, dataEnd]);
    return staleTail
      ? holes.flatMap((hole) => hole.from >= staleTail.from ? [] : [{ from: hole.from, to: Math.min(hole.to, staleTail.from) }])
      : holes;
  }, [coverage, embedded, truncated, dataStart, dataEnd, staleTail]);
  const visibleBands = embedded || emptyZoom ? [] : bands;
  const intervalCount = visibleBands.length + (staleTail ? 1 : 0);
  const gapsHidden = !embedded && !!truncated && dataStart !== undefined;
  const tailBox = staleTail ? bandBox(staleTail.from, staleTail.to) : undefined;
  // The tail says when its samples stopped if it can hold that, and otherwise says "No samples". It is unlabelled only
  // when neither fits.
  const tailLabel = staleTail && tailBox
    ? fittingBandLabel([`No samples since ${formatTimeTick(staleTail.from, 0, timeZone)}`, "No samples"], tailBox.width, measureLabel)
    : undefined;

  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          ...previousData.map((entry, index) => decorative(lineY(entry.plotPoints, { id: `previous-${index}`, x: "timestamp", y: "value", stroke: entry.color, strokeWidth: options.lineWidth ?? 1.8, strokeDasharray: "5 4", strokeOpacity: .7, curve: CURVES[options.curve ?? "linear"] }))),
          ...data.flatMap((entry, index) => [
          // Fills paint behind observations, one per observed run with the zero-anchored gradient of its own range. Only the line owns hit testing.
          ...(areaFills.fills.filter(fill => fill.series === index).map(fill => decorative(areaY(fill.points, {
            id: fill.id,
            x: "timestamp",
            y: "value",
            fill: `url(#${fill.gradientId})`,
            fillOpacity: 1,
            curve: CURVES[options.curve ?? "linear"],
          })))),
          lineY(entry.plotPoints, {
            id: `line-${index}`,
            x: "timestamp",
            y: "value",
            // Shared timestamps still need distinct groups for nearest-line focus.
            z: "seriesIndex",
            stroke: entry.color,
            strokeWidth: options.lineWidth ?? 1.8,
            curve: CURVES[options.curve ?? "linear"],
          }),
          // An isolated observation has no segment, so it gets its own dot. The dots are decorative: they never take focus
          // or hover, so each observation is still visited once, on the line.
          ...(entry.dotPoints.some((point) => point.value !== null) ? [decorative(lineY(entry.dotPoints, {
            id: `isolated-${index}`,
            x: "timestamp",
            y: "value",
            stroke: entry.color,
            strokeWidth: 0,
            points: true,
          }))] : []),
          ]),
          // The focus guide: a dashed rule at the focused x. It reads focus state only, so it adds no scale input.
          ...(embedded ? [] : [crosshair({ x: { stroke: "var(--gamma-chart-axis, var(--gamma-muted, #52636f))", strokeOpacity: .7, strokeWidth: 1, strokeDasharray: "3 3" }, y: false })]),
        ],
        scales: {
          x: {
            scale: timeDomain ? scaleLinear().domain(timeDomain) : scaleLinear,
            // Vertical gridlines at the x ticks. Off by default, and showGrid false turns off every gridline.
            grid: options.gridX && options.showGrid !== false ? { stroke: GRIDLINE_STROKE } : undefined,
            axis: !showAxis
              ? false
              : {
                  label: options.xAxisLabel
                    ? { text: options.xAxisLabel, opacity: 1 }
                    : undefined,
                  line: false,
                  ticks: calendarTickList
                    ? { values: calendarTickList.map(tick => tick.value), line: false, padding: 10, format: (value: number) => calendarLabels.get(value) ?? "—" }
                    : { count: ticks.x, line: false, padding: 10, format: (value: number) => formatTimeTick(value, timeSpan, timeZone) },
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
                    stroke: "var(--gamma-chart-grid, var(--gamma-border, #e4ebed))",
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
        margin: { top: !showAxis ? 8 : separateUnit ? 18 : height < 130 ? 4 : 10, right: plotRight, bottom: !showAxis ? 8 : options.xAxisLabel ? 47 : 29, left: plotLeft },
        clip: true,
        // The zero-anchored gradients, one per distinct run, drawn only when the chart is an area.
        gradients: options.display === "area" ? areaFills.gradients : undefined,
        // The primary-point ring: a 4px disc in the surface colour with a 2px stroke in the series colour. No glow or blur.
        theme: { ...configuredTheme(options), focusRing: { radius: 4, strokeWidth: 2, fill: "var(--widget-background, var(--gamma-bg))" } },
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
                    `${point.datum.series}\n${detailTimeFormat.format(new Date(point.datum.timestamp))}\n${typeof point.datum.value === "number" ? formatMetricDetails(point.datum.value, widget.unit, options.decimals) : "No data"}`,
                },
      }),
    [
      data,
      previousData,
      widget.unit,
      separateUnit,
      options,
      domain,
      ticks.x,
      ticks.y,
      height,
      timeSpan,
      timeDomain,
      showAxis,
      embedded,
      tooltipEnabled,
      plotTooltip.extension,
      plotLeft,
      plotRight,
      areaFills,
      calendarTickList,
      calendarLabels,
      timeZone,
      detailTimeFormat,
    ],
  );

  return (
    <div className={styles.chart} data-chart-window-start={zoom?.start} data-chart-window-end={zoom?.end} data-prior-overlay={previousData.length || undefined}>
      <div
        className={`${styles.plot} ${chartEntrance.tanstackPlot}`}
        ref={ref}
        {...brush.handlers}
        data-chart-entering={entering || undefined}
        style={{ touchAction: "pan-y", userSelect: "none" }}
        onPointerMoveCapture={(event) => { brush.handlers.onPointerMoveCapture(event); if (tooltipEnabled && !brush.active) plotTooltip.onInteract(); }}
        onPointerDownCapture={(event) => { brush.handlers.onPointerDownCapture(event); if (tooltipEnabled) plotTooltip.onInteract(); }}
        onKeyDownCapture={tooltipEnabled ? plotTooltip.onInteract : undefined}
        onFocusCapture={tooltipEnabled ? plotTooltip.onFocus : undefined}
        onBlurCapture={tooltipEnabled ? plotTooltip.onBlur : undefined}
      >
        {showAxis && separateUnit && <span className={styles.axisUnit} title={widget.unit} data-chart-axis-unit>{widget.unit}</span>}
        {visibleBands.map((band) => {
          const box = bandBox(band.from, band.to);
          // A label is drawn only when its band can hold it, so it is never clipped. The aria-label keeps the times.
          const label = fittingBandLabel(["No samples"], box.width, measureLabel);
          return (
            <span key={`${band.from}-${band.to}`} role="img" aria-label={`No samples from ${timestampFormat.format(new Date(band.from))} to ${timestampFormat.format(new Date(band.to))}`} className={`${hatchStyles.hatch} ${styles.noSampleBand}`} data-no-sample-band data-from={band.from} data-to={band.to} style={{ ...box, top: eventTop, bottom: eventBottom }}>
              {label && <span aria-hidden="true" className={styles.noSampleLabel}>{label}</span>}
            </span>
          );
        })}
        {staleTail && tailBox && <span role="img" aria-label={`No samples after ${timestampFormat.format(new Date(staleTail.from))}`} className={`${hatchStyles.hatch} ${styles.noSampleBand}`} data-stale-tail data-from={staleTail.from} data-to={staleTail.to} style={{ ...tailBox, top: eventTop, bottom: eventBottom }}>
          {tailLabel && <span aria-hidden="true" className={styles.noSampleLabel}>{tailLabel}</span>}
        </span>}
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
          ariaDescription={`${data.length} time series.${embedded ? "" : " Use arrow keys to explore individual values. Drag horizontally to select a time window, or use Compare window."}`}
        />}
        <TimeBrushOverlay preview={brush.preview} top={eventTop} bottom={eventBottom} />
        {cursorX !== undefined && <span aria-hidden="true" className={styles.sharedCursor}
          data-chart-cursor-time={cursor!.timestamp} data-chart-cursor-source={cursor!.source}
          style={{ left: cursorX, top: separateUnit ? 18 : height < 130 ? 4 : 10, bottom: !showAxis ? 8 : options.xAxisLabel ? 47 : 29 }} />}
        {!embedded && domain && domain[1] > domain[0] && !emptyZoom && (options.thresholds ?? []).filter(threshold => threshold.value >= domain[0] && threshold.value <= domain[1]).map((threshold, index) => {
          const top = eventTop + (domain[1] - threshold.value) / (domain[1] - domain[0]) * Math.max(0, height - eventTop - eventBottom);
          // The label sits above its line at the left end, where the newest data on the right is never covered.
          // It moves below the line when there is less than 16px above it inside the plot.
          return <span key={`${threshold.value}-${index}`} role="img" aria-label={`${threshold.label ? `${threshold.label}: ` : "Threshold: "}${formatMetric(threshold.value, widget.unit, false, options.decimals)}`} className={styles.thresholdGuide} data-threshold-value={threshold.value} data-label-placement={top - eventTop < 16 ? "below" : "above"} style={{ left: plotLeft, right: plotRight, top, borderColor: thresholdPaint(threshold) }}><span aria-hidden="true">{threshold.label || formatMetric(threshold.value, widget.unit, false, options.decimals)}</span></span>;
        })}
        {!embedded && domain && domain[1] > domain[0] && !emptyZoom && (options.referenceLines ?? []).filter(reference => reference.value >= domain[0] && reference.value <= domain[1]).map((reference, index) => {
          const top = eventTop + (domain[1] - reference.value) / (domain[1] - domain[0]) * Math.max(0, height - eventTop - eventBottom);
          return <span key={`reference-${index}`} role="img" aria-label={`${reference.label ?? "Reference"}: ${formatMetric(reference.value, widget.unit, false, options.decimals)}`} className={styles.thresholdGuide} data-reference-value={reference.value} data-label-placement={top - eventTop < 16 ? "below" : "above"} style={{ left: plotLeft, right: plotRight, top, borderColor: reference.color ?? "var(--gamma-warning)" }}><span aria-hidden="true">{reference.label ?? formatMetric(reference.value, widget.unit, false, options.decimals)}</span></span>;
        })}
        {!embedded && domain && domain[1] > domain[0] && !emptyZoom && options.showZeroLine && domain[0] <= 0 && domain[1] >= 0 && <span aria-hidden="true" className={chartStyles.zeroLine} data-zero-line="" style={{ left: plotLeft, right: plotRight, top: eventTop + (domain[1] / (domain[1] - domain[0])) * Math.max(0, height - eventTop - eventBottom) }} />}
        {eventEnd > eventStart && visibleEvents.map((event, index) => {
          const at = Date.parse(event.timestamp), finish = event.endTimestamp ? Date.parse(event.endTimestamp) : at;
          const position = xAt;
          return <span key={`${event.timestamp}-${index}`} aria-hidden="true" data-annotation-timestamp={event.timestamp} data-annotation-interval={finish > at ? "true" : undefined} data-severity={event.severity ?? "unclassified"} className={finish > at ? styles.eventRange : styles.eventLine}
            style={{ left: position(Math.max(at, eventStart)), width: finish > at ? Math.max(0, position(Math.min(finish, eventEnd)) - position(Math.max(at, eventStart))) : undefined, top: eventTop, bottom: eventBottom }} />;
        })}
      </div>
      {(options.showLegend !== false || !embedded) && <div className={styles.chartFooter} data-chart-footer data-timeseries-footer role="group" aria-label="Chart legend and controls" tabIndex={previousData.length > 0 ? 0 : undefined}>
      {emptyCurrent && previousData.length > 0 && <span role="status" className={styles.notice}>No current observations in this window; the dashed lines show the preceding period.</span>}
      {gapsHidden && <span className={styles.notice}>Gaps not shown: the provider result was truncated</span>}
      {intervalCount > 0 && <details className={styles.gapDetails} data-gap-intervals onKeyDown={(event) => {
        // Escape closes an open list and returns focus to its summary, so the keyboard user keeps their place.
        if (event.key !== "Escape" || !event.currentTarget.open) return;
        event.stopPropagation();
        event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
      }}>
        <summary>No samples in {intervalCount} {intervalCount === 1 ? "interval" : "intervals"}</summary>
        {/* The open list floats above the footer (see charts.module.css), so opening it never changes the plot's height. */}
        <ul tabIndex={0} aria-label="No-sample intervals" data-gap-list>
          {visibleBands.map((band) => <li key={`${band.from}-${band.to}`}>{detailTimeFormat.format(new Date(band.from))}–{detailTimeFormat.format(new Date(band.to))}</li>)}
          {staleTail && <li>{detailTimeFormat.format(new Date(staleTail.from))}–{detailTimeFormat.format(new Date(staleTail.to))}, after the latest sample</li>}
        </ul>
      </details>}
      {staleTail && <span className={styles.notice}>Latest sample {detailTimeFormat.format(new Date(staleTail.from))}, before the end of the range.</span>}
      {options.showLegend !== false && (
        <div className={styles.legend} role="list" aria-label="Latest values by series" data-series-count={data.length} tabIndex={data.length > 1 ? 0 : undefined}>
          {data.map((entry, index) => {
            // Deliberately not hidden for one series: DESIGN.md keeps identity footer rows, and this footer
            // carries the latest reading and its aria labels. A lone generic series shows only its swatch and
            // reading; the widget title is its accessible name, and the full identity stays in the title.
            const titled = identityTitle !== undefined;
            const reading = entry.latest
              ? `${formatMetricDetails(entry.latest.value, widget.unit, options.decimals)} at ${new Date(entry.latest.timestamp).toISOString()}`
              : undefined;
            return (
              <span
                className={styles.legendItem}
                role="listitem"
                key={`${entry.name}-${index}`}
                title={options.showTooltip === false ? undefined : titled ? `${identityTitle} · ${entry.name}` : entry.name}
                aria-label={titled ? (reading ? `${identityTitle}, latest valid sample: ${reading}` : `${identityTitle}: no valid sample`) : undefined}
              >
                <span
                  className={styles.swatch}
                  aria-hidden="true"
                  style={{ background: entry.color }}
                />
                {!titled && <span className={styles.legendName}>{displayLabels[index] === entry.name ? entry.name : <><span aria-hidden="true">{displayLabels[index]}</span><span className={styles.srOnly}>{entry.name}</span></>}</span>}
                <span
                  className={styles.legendValue}
                  title={options.showTooltip === false ? undefined : entry.latest
                    ? `Latest valid sample · ${timestampFormat.format(new Date(entry.latest.timestamp))}`
                    : "No valid sample"}
                  aria-label={titled ? undefined : entry.latest
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
            );
          })}
        </div>
      )}
      {previousData.length > 0 && zoom && <div className={styles.priorLegend} role="group" aria-label="Previous period overlay" tabIndex={0}>
        <span>Previous period · dashed · aligned to selected window</span>
        {previousData.map(entry => { const last = latestPoint(entry.original); const first = entry.original.points[0]; return <span key={entry.index} data-prior-series={entry.index} data-prior-original-first={first?.timestamp} data-prior-aligned-first={entry.points[0]?.timestamp} title={last ? `Previous sample: ${formatMetricDetails(last.value, widget.unit)} at ${new Date(last.timestamp).toISOString()}` : "No prior sample"}>
          <i aria-hidden="true" style={{ borderColor: entry.color }} />{previousIdentityTitle ?? seriesName(entry.original, entry.index)} · latest valid: {last ? <>{formatMetric(last.value, widget.unit, false, options.decimals)} <time dateTime={new Date(last.timestamp).toISOString()}>{timestampFormat.format(new Date(last.timestamp))}</time></> : "No data"}
        </span> })}
        {selection?.previous?.truncated && <span>Partial prior result</span>}
      </div>}
      {!embedded && <div className={styles.chartActions} data-chart-actions><ChartEvents events={visibleEvents} /><TimeWindowLens title={widget.title} series={series} unit={widget.unit} decimals={options.decimals} zoom={zoom} onZoom={window => setSelection({ source: series, window })} onOverlay={(window, previous) => setSelection({ source: series, window, previous })} onReset={() => setSelection(undefined)} />
      {!embedded && previousData.length > 0 && <ChartDataInspector widget={{ ...widget, title: `${widget.title} · Previous period` }} series={previousData.map(entry => entry.original)} buttonText="Inspect prior data" />}
      <ChartDataInspector widget={widget} series={visibleSeries} /></div>}
      </div>}

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

"use client";

import { ChartTable } from "./chart-table";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTraceFetcher } from "./trace-waterfall";
import { TraceDialog } from "./trace-dialog";
import { TooltipInstructions } from "./tooltip-instructions";
import { MetricDetails } from "./metric-tooltip-content";
export { MetricDetails } from "./metric-tooltip-content";
import { useDashboardWindow } from "./dashboard-window";
import { useDashboardTimeZone } from "./dashboard-time-zone";
import { exactMetric, formatMetric, formatMetricDetails, fullDateTimeFormat, latestPoint, seriesName, timeFormat } from "./chart-data";
import { formatReading, formatSharedScale, joinReading } from "./units";
import { heatmapValueEm, heatmapValueGlyphs, useHeatmapValueFit } from "./heatmap-value-width";
export {
  downsamplePoints,
  latestPoint,
  seriesName,
  formatMetric,
  exactMetric,
  formatTimeTick,
} from "./chart-data";
import { useTooltipWidgetData } from "./tooltip-widget-data";
import { TooltipSubWidget } from "./tooltip-widgets";
import { StatSparkline, isSteadySeries } from "./stat-sparkline";
import sparklineStyles from "./stat-sparkline.module.css";
import { useEmbeddedWidget } from "./widget-presentation";
import { ObservationTooltip, ObservationDetails } from "./observation-tooltip";
export { ObservationTooltip, ObservationDetails, heatmapTooltipSizeLimit, placeHeatmapTooltip, placePlotTooltip, placeOutsideWidgetTooltip, placeClearOutsideWidgetTooltip, outsideTooltipWidthLimit, tooltipOverlapsOtherWidget } from "./observation-tooltip";
import configStyles from "./chart-styles.module.css";
import styles from "./charts.module.css";
import contextStyles from "./widget-context.module.css";
import type { DrilldownContext } from "./drilldown";
import { readableTextColor, widgetTextColor } from "./appearance";
import {
  contextKey,
  metricContext,
  traceContext,
  validTimestamp,
} from "./widget-context";
import type { QueryResult, Threshold, Widget } from "./schema";
import { EMPTY_OPTIONS, PALETTE, thresholdForValue, usePlotSize, type Point, type Series } from "./chart-renderer-shared";
import { widgetSeriesColors } from "./series-colors";
import { thresholdInk, thresholdPaint } from "./status";
import { StatusChip } from "./status-chip";
import { widgetAttention, useWidgetAttentionContext } from "./widget-attention";
import { TimeSeriesChart } from "./time-series-chart";
import { BarChart } from "./bar-chart";
import { displaySeriesNames } from "./series-display";
export { TimeSeriesChart, resolveTimeSeriesDomain } from "./time-series-chart";
export { BarChart } from "./bar-chart";
export { ChartDataInspector } from "./chart-data-inspector";
export {
  thresholdForValue,
  resolveChartDomain,
  responsiveChartTicks,
  chartYAxisLayout,
} from "./chart-renderer-shared";

type Trace = NonNullable<QueryResult["traces"]>[number];

const MAX_ROWS = 100;

/** Heatmap cells take the critical frame only; warning cells keep their fill and label. */
function critical(threshold: Threshold | undefined) {
  return threshold?.status === "critical" ? "critical" : undefined;
}
/**
 * The frame is drawn in the cell's own text colour, which is the ink that reads on its fill. Page ink has only about
 * 1.2 to 1.3:1 against the critical fill, so it would not be visible.
 */
function criticalStroke(threshold: Threshold | undefined): CSSProperties {
  return critical(threshold) ? ({ "--status-stroke-color": "currentColor" } as CSSProperties) : {};
}

/** The value text a heatmap cell shows. Its width (heatmapValueEm) sizes the value so a long unit or number stays inside its cell. */
function heatmapValueText(value: number | undefined, unit: Widget["unit"], decimals: number | undefined): string {
  return value === undefined ? "No data" : formatMetric(value, unit, false, decimals);
}

export const DEFAULT_HEATMAP_THRESHOLDS: Threshold[] = [
  { value: 0, status: "critical", label: "Unhealthy" },
  { value: 1, status: "ok", label: "Healthy" },
];

function Stat({
  widget,
  series,
  result,
  onContextChange,
}: {
  widget: Widget;
  series: Series[];
  /** The whole result, so a truncated response is seen as well as the series. */
  result?: QueryResult;
  onContextChange?: (context: DrilldownContext) => void;
}) {
  const embedded = useEmbeddedWidget();
  const timeZone = useDashboardTimeZone();
  const sampleTime = useMemo(() => new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone, timeZoneName: "short" }), [timeZone]);
  const { rangeEnd } = useDashboardWindow();
  // The tile evaluates its widget once and passes the verdict down. An embedded renderer shows another widget, so it evaluates its own.
  // Outside a tile, the renderer evaluates once itself; a tile's verdict is never recomputed here.
  const tileAttention = useWidgetAttentionContext();
  const attention = useMemo(
    () => !embedded && tileAttention ? tileAttention : widgetAttention(widget, { result: result ?? { series }, rangeEnd }),
    [embedded, tileAttention, widget, series, result, rangeEnd],
  );
  const entries = series
    .map((entry, index) => ({
      entry,
      index,
      name: seriesName(entry, index),
      point: latestPoint(entry),
    }))
    .filter((entry) => entry.point);
  const first = entries[0];
  if (!first?.point) return <EmptyState partial={attention.partial} />;
  // A Single value intentionally displays the last valid observation. A
  // newer missing observation must still be disclosed: otherwise an older
  // healthy value can be mistaken for a current reading. Match the dashboard
  // bundle's last-in-input rule for duplicate latest timestamps.
  let latestObservation: Point | undefined;
  for (const point of first.entry.points) {
    if (validTimestamp(point.timestamp) && (!latestObservation || point.timestamp >= latestObservation.timestamp)) latestObservation = point;
  }
  const latestMissing = latestObservation !== undefined && (typeof latestObservation.value !== "number" || !Number.isFinite(latestObservation.value));
  // Under the reading the card holds three lines: the extra rows and, when more than three series are left over, the note
  // that counts the rest. The latest-missing notice takes the caption's place rather than adding a line, so it needs no
  // room of its own. Measured at 74 px and 148 px (1, 3, 4, 5 and 120 series, shared and older captions, with and
  // without the missing line, at 390, 768 and 1512 px) every combination fits without scrolling.
  const extraSeries = entries.length - 1;
  const noteNeeded = extraSeries > 3;
  const extraRows = noteNeeded ? 2 : extraSeries;
  const shownSeries = extraRows + 1;
  const { ageSeconds, stale, band } = attention;
  const thresholds = widget.options?.thresholds;
  // Colour names the threshold's hue on the trend and the bar; the reading stays in ink (or an author's text colour).
  const textColor = widgetTextColor(widget.options);
  const color = textColor ?? thresholdPaint(band) ?? widget.color;
  const steady = !!widget.options?.showSparkline && isSteadySeries(first.entry);
  const minimum = widget.options?.min, maximum = widget.options?.max;
  const showBar = widget.options?.showStatBar === true && minimum !== undefined && maximum !== undefined && Number.isFinite(minimum) && Number.isFinite(maximum) && minimum < maximum;
  const boundedValue = showBar ? Math.max(minimum, Math.min(maximum, first.point.value)) : 0;
  const span = showBar ? maximum - minimum : 1;
  const magnitude = showBar ? Math.max(Math.abs(minimum), Math.abs(maximum), 1) : 1;
  const fraction = showBar ? Math.max(0, Math.min(1, Number.isFinite(span) ? (boundedValue - minimum) / span : (boundedValue / magnitude - minimum / magnitude) / (maximum / magnitude - minimum / magnitude))) : 0;
  // The reading may rescale its unit (ms to s, bytes to MiB), so the unit span shows the reading's unit, not the authored one.
  // Thresholds stay on their side of the rounded reading: 99.86 never reads 99.9 against a 99.9 threshold.
  const statReading = formatReading(first.point.value, widget.unit, { decimals: widget.options?.decimals, keepSides: (thresholds ?? []).map(threshold => threshold.value) });
  const barColor = thresholdPaint(band) ?? widget.color ?? "var(--gamma-chart-1)";
  // The status chip names a warning or critical band with its glyph and label. A colour-only band above the first one
  // gets a dot and its label; the first band is the normal state and stays unlabelled.
  // A stale sample is a notice, not a breach: it takes the chip slot, so it never pushes the reading out of a one-row card.
  const sampleAge = ageSeconds === undefined ? "" : Math.floor(ageSeconds / 60) >= 1 ? `${Math.floor(ageSeconds / 60)} min` : `${Math.floor(ageSeconds)} sec`;
  const chip = <>
    {band?.status === "warning" || band?.status === "critical"
      ? <StatusChip status={band.status} color={band.color} label={band.label} className={styles.statChip} data-stat-chip={band.status} />
      : band && band.status === undefined && band.color !== undefined && band.label?.trim()
        ? <StatBandChip color={band.color} label={band.label.trim()} />
        : null}
    {stale && <StatNoticeChip visible={`Stale · ${sampleAge}`} full={`Last valid sample: ${sampleAge} before range end.`} dataAttribute="data-stale-observation" />}
    {attention.partial && <StatNoticeChip visible="Partial" full="Provider response may be incomplete. Narrow the query or check the data source." dataAttribute="data-partial-observation" />}
  </>;
  return (
    // The caption's time is in the missing notice when the latest observation is missing, so the caption is visually
    // hidden (kept for assistive technology) exactly as for a shared sample.
    <div className={`${styles.stat} ${embedded ? styles.embeddedStat : ""}`} data-stat-sparkline-enabled={widget.options?.showSparkline || undefined} data-stat-bar-enabled={showBar || undefined} data-caption-merged={latestMissing || undefined}>
      {latestMissing && <div className={styles.missingObservation} role="status" data-latest-missing="" title="The latest returned observation is missing; the displayed value is the last valid sample.">Latest missing · last valid {sampleTime.format(new Date(first.point.timestamp))}</div>}
      <div
        className={`${sparklineStyles.summary} ${widget.options?.showSparkline ? sparklineStyles.withSparkline : ""}`}
        data-stat-summary=""
        data-sparkline-placement={widget.options?.sparklinePlacement ?? "background"}
      >
        {/* Anatomy, in order: reading and unit, status chip beside it, the latest valid sample's time, then the trend. */}
        <div className={sparklineStyles.value} data-stat-reading="">
          <div className={styles.statFigure} data-stat-figure="">
            {/* Plain text: the reading is never a trigger, highlight or details owner. The sparkline inspects recorded samples. */}
            <span
              className={styles.statValue}
              data-metric-value={String(first.point.value)}
              title={exactMetric(first.point.value, widget.unit)}
              style={{ color: textColor }}
            >
              {statReading.value}
              <span className={styles.statUnit}>{statReading.unit}</span>
            </span>
            {chip}
          </div>
          <div className={styles.statMeta}>
            {entries.length > 1 ? `${first.name} · ` : ""}Latest valid sample ·{" "}
            <time dateTime={new Date(first.point.timestamp).toISOString()}>{sampleTime.format(new Date(first.point.timestamp))}</time>
          </div>
        </div>
        {widget.options?.showSparkline && (steady ? (
          <span className={sparklineStyles.steady} data-stat-steady="" title="Every valid sample in this range has the same value.">Steady</span>
        ) : (
          <StatSparkline widget={embedded ? undefined : widget}
            series={first.entry}
            name={first.name}
            unit={widget.unit}
            color={color ?? widgetSeriesColors(series, widget)[first.index]?.color ?? PALETTE[0]}
            onSelect={
              onContextChange
                ? () => onContextChange(metricContext(first.entry, first.index))
                : undefined
            }
          />
        ))}
      </div>
      {showBar && <div className={styles.statBar} role="meter" aria-label={`${widget.title} value on configured scale`}
        aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={boundedValue}
        aria-valuetext={`${formatMetricDetails(first.point.value, widget.unit, widget.options?.decimals)}${first.point.value !== boundedValue ? " (outside configured scale)" : ""}`}
        data-stat-bar="" data-stat-bar-value={first.point.value} data-stat-bar-fraction={fraction}>
        <span className={styles.statBarFill} style={{ width: `${fraction * 100}%`, backgroundColor: barColor }} />
      </div>}
      {entries.length > 1 && (
        // With more than four series the reading and two rows fill the card, so the note takes the third row; the
        // rest are counted in the note. One section for the extra rows and their note, so the card's gap separates the reading from the list once.
        <div className={styles.statExtras} data-stat-extras="">
          {entries.slice(1, extraRows + 1).map((entry) => (
            <div className={styles.statExtra} key={`${entry.name}-${entry.index}`}>
              <span>{entry.name}</span>
              <strong>
                {joinReading(formatReading(entry.point!.value, widget.unit, { decimals: widget.options?.decimals, keepSides: (thresholds ?? []).map(threshold => threshold.value) }))}
              </strong>
            </div>
          ))}
          {entries.length > shownSeries && (
            <span className={styles.notice} role="status">
              +{entries.length - shownSeries} more series. Switch to table to inspect.
            </span>
          )}
        </div>
      )}
      {/* In short cards the rows above are hidden and this one-line note stands in for them. It counts every extra series. */}
      {entries.length > 1 && (
        <span className={styles.statCompactNote} data-stat-compact-note="">
          {entries.length - 1} more series · Switch to table to inspect
        </span>
      )}
    </div>
  );
}

/** A colour-only band's label: a dot in the band's hue, then the label. Non-interactive, like the status chip. */
function StatBandChip({ color, label }: { color: string; label: string }) {
  return (
    <span className={styles.statBandChip} data-stat-chip="band">
      <span className={styles.statBandDot} aria-hidden="true" style={{ background: color }} />
      <span className={styles.statBandText}>{label}</span>
    </span>
  );
}

/**
 * A neutral notice chip for a stat: a stale value is old, not bad, and a partial response is incomplete, not breached.
 * The visible text is short; screen readers hear the full sentence.
 */
function StatNoticeChip({ visible, full, dataAttribute }: { visible: string; full: string; dataAttribute: string }) {
  return (
    <span className={styles.statNoticeChip} role="status" {...{ [dataAttribute]: "" }}>
      <span className={styles.statBandDot} aria-hidden="true" />
      <span className={styles.statBandText}>{visible}</span>
      <span className={styles.statSrOnly}>{full}</span>
    </span>
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
  // Each row's extremes, and one display scale per column, so a column compares in one unit ("1.03 s" beside "1.21 s").
  const tableRows = series.slice(0, MAX_ROWS).map(entry => {
    let min = Infinity;
    let max = -Infinity;
    for (const point of entry.points)
      if (typeof point.value === "number" && Number.isFinite(point.value) && validTimestamp(point.timestamp)) {
        min = Math.min(min, point.value);
        max = Math.max(max, point.value);
      }
    return { entry, latest: latestPoint(entry), min, max };
  });
  const columnLabels = (values: number[]) =>
    widget.options?.decimals === undefined
      ? formatSharedScale(values, widget.unit)
      : values.map(value => formatMetric(value, widget.unit, false, widget.options?.decimals));
  // Rows name themselves with the same compacted labels as the charts; the full identity stays in each row's title.
  const displayNames = displaySeriesNames(series.slice(0, MAX_ROWS));
  const latestLabels = columnLabels(tableRows.map(row => row.latest?.value ?? NaN));
  const minLabels = columnLabels(tableRows.map(row => row.min));
  const maxLabels = columnLabels(tableRows.map(row => row.max));
  return (
    <div
      className={styles.tableWrap}
      tabIndex={0}
      role="region"
      aria-label={`${widget.title} data table`}
    >
      <ChartTable className={styles.table} aria-label={widget.title}>
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
          {tableRows.map(({ entry, latest, min, max }, index) => {
            const name = displayNames[index];
            const fullName = seriesName(entry, index);
            return (
              <tr
                key={`${fullName}-${index}`}
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
                    label={`Inspect series ${fullName}`}
                    enabled={widget.options?.showTooltip !== false}
                    revision={entry}
                    externalAnchor={
                      hoveredRow?.index === index && hoveredRow.entry === entry
                        ? hoveredRow.anchor
                        : undefined
                    }
                    details={
                      <>
                        <MetricDetails widget={widget}
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
                    <span title={fullName}>{name}</span>
                  </ObservationDetails>
                </td>
                <td className={styles.numeric}>
                  {latestLabels[index]}
                </td>
                <td className={styles.numeric}>
                  {minLabels[index]}
                </td>
                <td className={styles.numeric}>
                  {maxLabels[index]}
                </td>
              </tr>
            );
          })}
        </tbody>
      </ChartTable>
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
  const embedded = useEmbeddedWidget();
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
      <ChartTable className={styles.table} aria-label={widget.title}>
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
                    enabled={!embedded && widget.options?.showTooltip !== false}
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
                  {!embedded && fetchTrace && /^[a-fA-F0-9]{32}$/.test(trace.traceId) && <button type="button" data-trace-waterfall-toggle className={styles.traceExpand} aria-expanded={expandedTrace === trace.traceId} onClick={event => { event.stopPropagation(); setExpandedTrace(previous => previous === trace.traceId ? undefined : trace.traceId); }}>
                    {expandedTrace === trace.traceId ? "Close waterfall" : "View waterfall"}
                  </button>}
                  {!embedded && expandedTrace === trace.traceId && <TraceDialog traceId={trace.traceId} onClose={() => setExpandedTrace(undefined)} />}
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
      </ChartTable>
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
    <div className={styles.state} data-widget-state="empty">
      <strong>{incomplete ? "No observations returned" : "No data in this time range"}</strong>
      <p>{partial ? "The provider response may be incomplete. Narrow the query or check the data source." : contextualPartial ? "No observations were included in this incomplete response." : "Try a wider time range or adjust this widget’s query."}</p>
    </div>
  );
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
  // One value text per cell feeds the visible text, its width and both accessible names, so they cannot drift apart.
  const valueTexts = cells.map((cell) => heatmapValueText(cell.value, widget.unit, options.decimals));
  useHeatmapValueFit(cellsRef, valueTexts.join("\u0000"));
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
          const valueText = valueTexts[index];
          const valueStyle = { "--value-em": heatmapValueEm(valueText), "--value-glyphs": heatmapValueGlyphs(valueText) } as CSSProperties;
          const label = `${cell.name}: ${valueText}${threshold?.label ? ` · ${threshold.label}` : ""}`;
          if (embedded)
            return (
              <div
                key={`${cell.name}-${index}`}
                role="img"
                aria-label={label}
                className={`${configStyles.cell} ${hasText ? "" : configStyles.colorOnlyCell}`}
                data-heatmap-cell=""
                data-status-stroke={critical(threshold)}
                style={{
                  background: thresholdPaint(threshold) ?? "#e6e9e0",
                  color:
                    options.textColor ??
                    (thresholdInk(threshold) ?? "#69725f"),
                  ...criticalStroke(threshold),
                }}
              >
                {options.showLabels !== false && (
                  <span className={configStyles.cellName}>{cell.name}</span>
                )}
                {options.showValues !== false && (
                  <strong data-heatmap-value="" style={valueStyle}>{valueText}</strong>
                )}
              </div>
            );
          return (
            <button
              key={`${cell.name}-${index}`}
              type="button"
              className={`${configStyles.cell} ${hasText ? "" : configStyles.colorOnlyCell}`}
              data-heatmap-cell=""
              data-status-stroke={critical(threshold)}
              style={{
                background: thresholdPaint(threshold) ?? "#e6e9e0",
                color:
                  options.textColor ??
                  (thresholdInk(threshold) ?? "#69725f"),
                ...criticalStroke(threshold),
              }}
              aria-label={label}
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
                <strong data-heatmap-value="" style={valueStyle}>{valueText}</strong>
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
                style={{ background: thresholdPaint(selectedThreshold) ?? "#a5ad9b" }}
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
              <i style={{ background: thresholdPaint(threshold) }} />
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

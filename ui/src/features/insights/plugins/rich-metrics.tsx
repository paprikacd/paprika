"use client";

import type { Widget } from "../schema";
import { resolveSeriesColor } from "../series-colors";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { Pin, X } from "lucide-react";
import { ChartDataInspector, EmptyState, MetricDetails, ObservationTooltip, formatMetric } from "../chart-renderers";
import { fullDateTimeFormat, formatTimeTick } from "../chart-data";
import { GammaButton } from "../gamma/button";
import { StatSparkline } from "../stat-sparkline";
import { getWidgetDefinition, registerWidgetPlugin, type WidgetRendererProps } from "../widget-registry";
import { useEmbeddedWidget, useWidgetPresentation } from "../widget-presentation";
import { useChartCursor, useChartCursorPublisher } from "../chart-cursor";
import { compactSeriesLabels } from "../series-display";
import { validTimestamp } from "../widget-context";
import { useAnnotationEvents } from "../annotation-events";
import { TimeWindowLens } from "../time-window-lens";
import { useTooltipWidgetData } from "../tooltip-widget-data";
import { seriesInWindow, type ObservationWindow } from "../time-window";
import type { QueryResult } from "../schema";
import { metricPriorPeriod } from "./metric-prior-period";
import { heatmapColumnAt, heatmapColumnLimit, heatmapColumns, heatmapDensityLevel, heatmapGaps, quantileLine } from "./distribution-heatmap-layout";
import heatmapStyles from "./distribution-heatmap.module.css";
import plotHatchStyles from "../plot-hatch.module.css";
import { PlotHatchDefs, plotHatchFill } from "../plot-hatch";
import { DistributionWindowHistogram, type WindowHistogramBucket } from "./distribution-window-histogram";
import { buildDistribution, buildMetricPlot, directionalConfigSchema, distributionConfigSchema, stackedConfigSchema, MetricDataError, type DistributionCell, type DistributionConfig, type DistributionData, type DistributionRow, type MetricCell, type MetricSeries } from "./rich-metrics-data";
import styles from "./rich-metrics.module.css";
import tooltipStyles from "../chart-styles.module.css";

const palette = ["var(--gamma-chart-1, #2867b9)", "var(--gamma-chart-2, #087f7a)", "var(--gamma-chart-3, #bb5037)", "var(--gamma-chart-4, #977017)", "var(--gamma-chart-5, #7c58ad)", "var(--gamma-chart-6, #427449)"];
// The 24-step heat ramp, lowest density first. Fallbacks are the light-theme values.
const densityPalette = ["var(--gamma-density-0, #13a0ab)", "var(--gamma-density-1, #119ca5)", "var(--gamma-density-2, #0f979f)", "var(--gamma-density-3, #0d939a)", "var(--gamma-density-4, #0a8f94)", "var(--gamma-density-5, #088a8e)", "var(--gamma-density-6, #068689)", "var(--gamma-density-7, #078187)", "var(--gamma-density-8, #087d84)", "var(--gamma-density-9, #087881)", "var(--gamma-density-10, #09747e)", "var(--gamma-density-11, #096f7b)", "var(--gamma-density-12, #096a79)", "var(--gamma-density-13, #086576)", "var(--gamma-density-14, #076073)", "var(--gamma-density-15, #065b70)", "var(--gamma-density-16, #05556d)", "var(--gamma-density-17, #03506b)", "var(--gamma-density-18, #034b67)", "var(--gamma-density-19, #024663)", "var(--gamma-density-20, #02415f)", "var(--gamma-density-21, #013d5b)", "var(--gamma-density-22, #013857)", "var(--gamma-density-23, #003353)"];
/** Histogram rows with at most this many buckets are shown while hovering; pinned rows always show them. */
const hoverHistogramLimit = 12;
/** Bar-mode caps are fixed-size and never encode a value. One per incomplete column, a gap above the partial stack. */
const capHeight = 6, capGap = 1, capHeadroom = 7;
const readoutClock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const stamp = (timestamp: number) => new Date(timestamp).toISOString();
const localEventTime = (timestamp: number) => new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(timestamp));
const number = (value: number) => Number.isFinite(value) ? Number(value.toFixed(3)) : 0;

interface Observation {
  row: number; column: number; value: number | null; timestamp: number;
  series: MetricSeries; name: string; unit: string; color: string; note?: string; bucket?: string;
}

function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 600, height: 240 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const next = { width: Math.round(rect.width), height: Math.max(48, Math.round(rect.height)) };
      setSize(old => old.width === next.width && old.height === next.height ? old : next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, ...size };
}

/** Measure actual SVG tick typography, including minus signs and units, after fonts load. */
function useAxisGutter(labels: string[], root: RefObject<HTMLDivElement | null>, width: number) {
  const key = labels.join("\n");
  const [measured, setMeasured] = useState<{ key: string; size: number }>();
  useLayoutEffect(() => {
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      const ticks = root.current?.querySelectorAll<SVGTextElement>("text[data-value-axis]");
      if (!ticks?.length) return;
      let largest = 0;
      for (const tick of ticks) {
        if (typeof tick.getComputedTextLength !== "function") return;
        largest = Math.max(largest, tick.getComputedTextLength());
      }
      if (!largest) return;
      const size = Math.ceil(largest) + 18;
      setMeasured(previous => previous?.key === key && previous.size === size ? previous : { key, size });
    };
    measure();
    void document.fonts?.ready.then(measure);
    return () => { cancelled = true; };
  }, [key, root, width]);
  // A conservative initial gutter avoids clipping before the first layout measurement.
  return Math.max(32, measured?.key === key ? measured.size : labels.reduce((largest, text) => Math.max(largest, text.length * 7 + 18), 0));
}

/** Who opened an unpinned inspection. Only a pointer inspection ends when the pointer leaves the chart. */
type InspectionOwner = "pointer" | "keyboard";

function useInspection({ result, widget, embedded, onContextChange }: WidgetRendererProps, signature: string, panel: HTMLDivElement | null) {
  const parentEmbedded = useEmbeddedWidget();
  const detailsEnabled = !embedded && !parentEmbedded && widget.options?.showTooltip !== false;
  const enabled = !embedded && !parentEmbedded && (detailsEnabled || !!onContextChange);
  const publisher = useChartCursorPublisher();
  const root = useRef<HTMLDivElement>(null);
  const panelHover = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const restoringFocus = useRef(false);
  const setRoot = useCallback((element: HTMLDivElement | null) => { root.current = element; }, []);
  const [state, setState] = useState<{ observation: Observation; pinned: boolean; owner: InspectionOwner; result: unknown; signature: string }>();
  // A new result ends the inspection rather than hiding it, so a cached result that returns later cannot revive it. The
  // reset runs during render, so React discards the stale observation before anything with the new result is committed.
  const [seenResult, setSeenResult] = useState(result);
  if (seenResult !== result) { setSeenResult(result); setState(undefined); }
  const active = state?.result === result && state.signature === signature && enabled ? state : undefined;
  const timestamp = active?.observation.timestamp, pinned = active?.pinned;
  useEffect(() => {
    if (timestamp !== undefined) publisher.publish(widget.id, timestamp, pinned);
    else publisher.clear(widget.id);
    return () => publisher.clear(widget.id);
  }, [publisher, widget.id, timestamp, pinned, result, signature]);
  useEffect(() => {
    if (!enabled) return;
    const close = (event: globalThis.PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target) && !panel?.contains(event.target)) setState(undefined); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setState(undefined); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [enabled, panel]);
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  const show = (observation: Observation, pinned = false, owner: InspectionOwner = "pointer") => {
    clearTimeout(hideTimer.current);
    if (!enabled || (active?.pinned && !pinned)) return;
    setState({ observation, pinned, owner, result, signature });
    if (pinned) onContextChange?.({ series: observation.name, labels: observation.series.labels, value: observation.value });
  };
  const dismiss = () => {
    clearTimeout(hideTimer.current);
    const returnFocus = panel?.contains(document.activeElement);
    setState(undefined);
    if (returnFocus) {
      // A dismissed inspector returns keyboard users to its chart. This focus
      // event must not immediately create another transient observation.
      restoringFocus.current = true;
      root.current?.querySelector<SVGSVGElement>('svg[role="group"][tabindex="0"]')?.focus({ preventScroll: true });
      restoringFocus.current = false;
    }
  };
  const focus = (observation: Observation) => { if (enabled && !active && !restoringFocus.current) show(observation); };
  const enterPanel = () => { panelHover.current = true; clearTimeout(hideTimer.current); };
  // A pointer leaving the chart ends a pointer inspection only. An inspection the arrow keys or Enter opened ends on
  // Escape, a dismissing pointer press or focus moving away, so a pointer that was over the chart cannot clear it.
  const leave = () => {
    panelHover.current = false;
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => { if (!panelHover.current) setState(current => current?.pinned || current?.owner === "keyboard" ? current : undefined); }, 180);
  };
  const focusPanel = () => { if (!panel) return false; panel.focus({ preventScroll: true }); return true; };
  return { root: setRoot, enabled, detailsEnabled, active, show, focus, dismiss, leave, enterPanel, focusPanel };
}

function Inspector({ widget, observation, peers, extra, footer, pinned, decimals, onPin, onClose, id, anchor, setPanel, onEnter, onLeave }: { widget: Widget; observation: Observation; peers?: { name: string; display: string; color: string; value: number | null }[]; extra?: ReactNode; footer?: ReactNode; pinned: boolean; decimals?: number; onPin: () => void; onClose: () => void; id: string; anchor: SVGSVGElement; setPanel: (element: HTMLDivElement | null) => void; onEnter: () => void; onLeave: () => void }) {
  return <ObservationTooltip id={id} anchor={anchor} avoidWidget pinned={pinned} panelRef={setPanel} role="region" ariaLabel="Observation details" className={styles.inspector} tabIndex={pinned ? 0 : undefined} onDismiss={onClose} onEnter={onEnter} onLeave={onLeave}>
    <div className={styles.inspectorActions}><span>{pinned ? "Pinned observation" : "Observation"}</span><GammaButton size="sm" iconOnly variant="quiet" aria-label="Close observation" onClick={onClose}><X size={14} /></GammaButton></div>
    <div className={styles.inspectorDetails} data-observation-details>
      <MetricDetails widget={widget} series={observation.series} index={observation.row} point={{ timestamp: observation.timestamp, value: observation.value }} unit={observation.unit} decimals={decimals} description="Selected sample" compact={!pinned}>
        {observation.bucket && <span className={tooltipStyles.tooltipEyebrow}>Selected bucket: {observation.bucket}</span>}
      </MetricDetails>
    </div>
    {peers && peers.length > 1 && <ul aria-label="Series at selected time" className={styles.inspectorPeers}>
      {peers.map((peer, index) => <li key={index} data-series-index={index} data-series-name={peer.name} data-series-value={peer.value === null ? "missing" : peer.value}><i aria-hidden="true" style={{ background: peer.color }} /><LegendName name={peer.name} display={peer.display} /><b>{peer.value === null ? "No observation" : formatMetric(peer.value, observation.unit, false, decimals)}</b></li>)}
    </ul>}
    {extra}
    {observation.note && <p className={styles.note}>{observation.note}</p>}
    {pinned && <div className={styles.history}><StatSparkline series={observation.series} name={observation.name} color={observation.color} unit={observation.unit} /></div>}
    {footer}
    {!pinned && <span className={styles.pinHint}>Click or tap chart to pin details</span>}
    <GammaButton size="sm" variant="quiet" onClick={onPin} aria-pressed={pinned}><Pin size={13} />{pinned ? "Unpin observation" : "Pin observation"}</GammaButton>
  </ObservationTooltip>;
}

function timeTicks(timestamps: number[], width: number) {
  const count = width < 360 ? 3 : 5;
  return [...new Set(Array.from({ length: Math.min(count, timestamps.length) }, (_, index) => Math.round(index * (timestamps.length - 1) / Math.max(1, Math.min(count, timestamps.length) - 1))))];
}

function Notices({ children, truncated }: { children?: ReactNode; truncated?: boolean }) {
  return <div className={styles.notices}>{children}{truncated && <span>Partial source response</span>}</div>;
}

function LegendName({ name, display }: { name: string; display: string }) {
  return <span title={name}>{display === name ? name : <><span aria-hidden="true">{display}</span><span className={styles.srOnly}>{name}</span></>}</span>;
}

function SeriesLegend({ children, revision, table = false }: { children: ReactNode; revision: string; table?: boolean }) {
  const ref = useRef<HTMLDivElement>(null), hint = useId();
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let cancelled = false;
    const measure = () => {
      if (!cancelled) setOverflow((element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 1) || (element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    for (const child of element.children) observer?.observe(child);
    void document.fonts?.ready.then(measure);
    return () => { cancelled = true; observer?.disconnect(); };
  }, [revision, table]);
  return <div className={styles.legendContainer}>
    <div ref={ref} className={`${styles.legend} ${table ? styles.legendTableScroll : ""}`} role="region" aria-label={table ? "Series statistics" : "Latest recorded values"} tabIndex={overflow ? 0 : undefined} aria-describedby={overflow ? hint : undefined}>
      {children}
    </div>
    {overflow && <p className={styles.legendHint} id={hint}>{table ? "Scroll to see all statistics" : "Scroll to see all series"} <span aria-hidden="true">↕</span></p>}
  </div>;
}

function coordinates(event: PointerEvent<SVGSVGElement>, width: number, height: number) {
  const bounds = event.currentTarget.getBoundingClientRect();
  return { x: (event.clientX - bounds.left) * width / Math.max(1, bounds.width), y: (event.clientY - bounds.top) * height / Math.max(1, bounds.height) };
}

function cellLabel(lower: number, upper: number, unit: string) {
  if (!Number.isFinite(lower)) return `≤ ${formatMetric(upper, unit)}`;
  if (!Number.isFinite(upper)) return `> ${formatMetric(lower, unit)}`;
  return `${formatMetric(lower, "")}–${formatMetric(upper, unit)}`;
}

/** A nonzero color domain should not be labeled as zero solely because the
 * widget uses fixed decimal places. Preserve the requested precision for
 * ordinary values and use an explicitly approximate scientific label for
 * smaller maxima. */
function densityMaximumLabel(value: number, unit: string, decimals?: number) {
  const places = decimals !== undefined && Number.isFinite(decimals) ? Math.max(0, Math.min(8, Math.floor(decimals))) : undefined;
  if (value > 0 && places !== undefined && value < .5 * 10 ** -places)
    return `≈${value.toExponential(2)}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`;
  return formatMetric(value, unit, false, decimals);
}

/** The readout under the heatmap. The merged p95 is quoted only when the +Inf bucket makes it defined; percentiles are never averaged. */
function quantileReadout(data: DistributionData, unit: string, decimals: number | undefined, clock: (timestamp: number) => string) {
  const { merged, highest } = data;
  // Without +Inf the total is unknown, so no p95 and no window count is quoted against it.
  if (!merged.bounded) return "p95 unavailable: no +Inf bucket";
  const format = (value: number) => formatMetric(value, unit, false, decimals);
  const estimate = merged.estimate, scope = `merged over ${merged.used} of ${merged.windows} windows`;
  const parts: string[] = [];
  if (estimate?.overflow) parts.push(`p95 above ${format(estimate.lower)} · ${scope}`);
  else if (estimate?.estimate !== null && estimate?.estimate !== undefined) parts.push(`p95 ≈ ${format(estimate.estimate)} · ${scope}`);
  else parts.push(merged.used === 0 ? "p95 unavailable: no complete windows" : "p95 unavailable: no observations");
  const excluded = merged.missing + merged.invalid;
  if (excluded) parts.push(`${[merged.missing ? `${merged.missing} missing` : "", merged.invalid ? `${merged.invalid} invalid` : ""].filter(Boolean).join(", ")} ${excluded === 1 ? "window" : "windows"} excluded`);
  // A gap above maxBuckets breaks the line over cells that look complete, so the readout says where it is.
  if (merged.hiddenMissing) parts.push(`${merged.hiddenMissing} ${merged.hiddenMissing === 1 ? "window has" : "windows have"} missing buckets above the shown range`);
  if (merged.hiddenInvalid) parts.push(`${merged.hiddenInvalid} ${merged.hiddenInvalid === 1 ? "window has" : "windows have"} invalid buckets above the shown range`);
  if (highest) parts.push(highest.p95.overflow ? `highest window p95 above ${format(highest.p95.lower)} at ${clock(highest.timestamp)}` : `highest window p95 ${format(highest.p95.estimate!)} at ${clock(highest.timestamp)}`);
  return parts.join(" · ");
}

export function DistributionHeatmap(props: WidgetRendererProps) {
  const { widget, result } = props;
  const config = useMemo(() => distributionConfigSchema.parse(widget.config ?? {}), [widget.config]);
  const prepared = useMemo(() => {
    try { return { data: buildDistribution(result.series ?? [], config) }; }
    catch (error) { if (error instanceof MetricDataError) return { error: error.message }; throw error; }
  }, [result, config]);
  if (prepared.error) return <div className={heatmapStyles.dataError} role="alert"><strong>Histogram data cannot be displayed</strong><p>{prepared.error}</p></div>;
  return <DistributionHeatmapPlot {...props} config={config} fullData={prepared.data!} />;
}

function DistributionHeatmapPlot(props: WidgetRendererProps & { config: DistributionConfig; fullData: DistributionData }) {
  const { widget, result, config, fullData } = props;
  const signature = JSON.stringify([widget.id, config, widget.unit, widget.options]);
  const { ref, width, height } = useSize();
  const [anchor, setAnchor] = useState<SVGSVGElement | null>(null), [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const sharedCursor = useChartCursor();
  const { showAxis, descriptionId, embedded: embeddedChart } = useWidgetPresentation();
  const unit = config.bucketUnit || widget.unit, densityUnit = config.densityUnit ?? "observations/s";
  const tickLabels = fullData.rows.map(row => cellLabel(row.lower, row.upper, unit));
  const gutter = useAxisGutter(tickLabels, ref, width);
  const left = showAxis ? gutter : 4, top = 4, bottom = showAxis ? 24 : 4, plotWidth = Math.max(1, width - left - 10), plotHeight = Math.max(1, height - top - bottom);
  const columnLimit = heatmapColumnLimit(plotWidth, config.maxColumns ?? 60);
  const data = useMemo(() => fullData.timestamps.length <= columnLimit ? fullData : buildDistribution(result.series ?? [], { ...config, maxColumns: columnLimit }), [fullData, columnLimit, result, config]);
  const { root: inspectionRoot, ...inspection } = useInspection(props, `${signature}:${data.timestamps.join(",")}`, panel), id = useId();
  const cellWidth = plotWidth / Math.max(1, data.timestamps.length), cellHeight = plotHeight / Math.max(1, data.rows.length);
  const sourceTimes = useMemo(() => [...new Set((result.series ?? []).filter(series => Object.entries(config.group ?? {}).every(([key, value]) => series.labels[key] === value)).flatMap(series => series.points.map(point => point.timestamp)).filter(validTimestamp))].sort((a, b) => a - b), [result, config.group]);
  const gaps = useMemo(() => heatmapGaps(sourceTimes, left, plotWidth, data.timestamps.length), [sourceTimes, left, plotWidth, data.timestamps.length]);
  const columns = heatmapColumns(data.timestamps, left, plotWidth, gaps);
  // Keep every bucket cell inspectable while thinning labels to the actual
  // available height. Short panels must not stack text over adjacent rows.
  // Use an integer bucket stride: rounding evenly-spaced indices can put two
  // adjacent labels on rows closer than the typography's minimum spacing.
  const axisStride = Math.max(1, Math.ceil(16 / cellHeight));
  const axisRows = new Set(data.rows.map((_, index) => index).filter(index => index % axisStride === 0));
  const timeStart = data.timestamps[0] ?? 0, timeSpan = (data.timestamps.at(-1) ?? timeStart) - timeStart;
  const columnX = (timestamp: number) => left + cellWidth / 2 + (timeSpan ? (timestamp - timeStart) / timeSpan : .5) * Math.max(0, plotWidth - cellWidth);
  const cursorTime = inspection.enabled && sharedCursor && sharedCursor.timestamp >= timeStart && sharedCursor.timestamp <= timeStart + timeSpan ? sharedCursor.timestamp : undefined;
  // Zero is the empty fill and a gap is hatched; neither takes a density colour.
  const densityFill = (value: number) => {
    const level = heatmapDensityLevel(value, data.max, data.minPositive, densityPalette.length, config.colorScale ?? "linear");
    return level === null ? "var(--gamma-chart-empty)" : densityPalette[level];
  };
  const cellFill = (cell: DistributionCell) => cell.state === "missing" ? plotHatchFill(id) : cell.state === "invalid" ? plotHatchFill(id, "warning") : densityFill(cell.value ?? 0);
  const cellTitle = (row: DistributionRow, cell: DistributionCell) => cell.state === "missing" ? "No observation"
    : cell.state === "invalid" ? "Invalid bucket counts: cumulative counts decrease or are negative"
    : `${cellLabel(row.lower, row.upper, unit)} · ${stamp(cell.timestamp)} · ${formatMetric(cell.value ?? 0, densityUnit, false, widget.options?.decimals)}`;
  // Labels come from the full bounds, so a bucket hidden by maxBuckets can still be named in the inspector.
  const bucketLabel = (bucket: number) => cellLabel(bucket ? fullData.bounds[bucket - 1] : -Infinity, fullData.bounds[bucket], unit);
  // The readout names one window, so it shows seconds; the axis format is too coarse to tell neighbours apart.
  const clock = (timestamp: number) => timeSpan >= 86_400_000 ? formatTimeTick(timestamp, timeSpan) : readoutClock.format(new Date(timestamp));
  const observation = (row: number, column: number): Observation => {
    const bucket = data.rows[row], cell = bucket.cells[column], name = cellLabel(bucket.lower, bucket.upper, unit);
    const note = cell.state === "missing" ? "No observation for this bucket at this time. Missing cells are hatched and left out of the p95."
      : cell.state === "invalid" ? "Invalid source counts: cumulative counts decrease or are negative here. The cell is not drawn as density and its time is left out of the p95."
      : "Non-cumulative bucket observation. Input must already be a rate when using a per-second unit.";
    return { row, column, value: cell.value, timestamp: cell.timestamp, name, bucket: name, unit: densityUnit, color: palette[0], series: { name, labels: bucket.labels, points: bucket.cells }, note };
  };
  // The p95 line sits on each drawable window's bucket row. Non-ok windows, source gaps and hidden buckets break it.
  // An overflow window has no finite estimate, so `quantile` is the whole line and `finite` is its solid part.
  const line = { columns, breaks: data.quantiles.map(window => window.breakBefore), rows: data.rows.length, rowCentre: (row: number) => top + (data.rows.length - .5 - row) * cellHeight, gaps };
  const quantile = quantileLine({ ...line, buckets: data.quantiles.map(window => window.state === "ok" && window.p95 ? window.p95.bucket : null) });
  const finite = quantileLine({ ...line, buckets: data.quantiles.map(window => window.state === "ok" && window.p95 && !window.p95.overflow ? window.p95.bucket : null) });
  const overflowRun = data.quantiles.some(window => window.state === "ok" && window.p95?.overflow === true && window.p95.bucket < data.rows.length);
  const embeddedView = props.embedded || embeddedChart;
  const readout = quantileReadout(data, unit, widget.options?.decimals, clock);
  const selected = inspection.active && columns[inspection.active.observation.column] ? {
    x: columns[inspection.active.observation.column].left, width: columns[inspection.active.observation.column].width,
    y: top + (data.rows.length - 1 - inspection.active.observation.row) * cellHeight + .5, height: Math.max(.1, cellHeight - 1),
  } : undefined;
  const windowAt = inspection.active ? data.quantiles[inspection.active.observation.column] : undefined;
  const histogram = inspection.active && windowAt ? <DistributionWindowHistogram
    buckets={data.rows.map((row, bucket): WindowHistogramBucket => ({ bucket, label: cellLabel(row.lower, row.upper, unit), value: row.cells[inspection.active!.observation.column].value, state: row.cells[inspection.active!.observation.column].state, fill: cellFill(row.cells[inspection.active!.observation.column]) })).reverse()}
    selected={inspection.active.observation.row} windowQuantile={windowAt} bucketLabel={bucketLabel} unit={unit} densityUnit={densityUnit} decimals={widget.options?.decimals}
    showList={inspection.active.pinned || data.rows.length <= hoverHistogramLimit} /> : undefined;
  const locate = (event: PointerEvent<SVGSVGElement>) => {
    const point = coordinates(event, width, height);
    if (point.x < left || point.x > left + plotWidth || point.y < top || point.y > top + plotHeight) return;
    const column = heatmapColumnAt(columns, point.x, gaps);
    if (column === undefined) return;
    const row = Math.max(0, Math.min(data.rows.length - 1, data.rows.length - 1 - Math.floor((point.y - top) / cellHeight)));
    return observation(row, column);
  };
  const keys = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!inspection.enabled) return;
    if (event.key === "Tab" && !event.shiftKey && inspection.active?.pinned && inspection.focusPanel()) { event.preventDefault(); return; }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); inspection.dismiss(); return; }
    let row = inspection.active?.observation.row ?? 0, column = inspection.active?.observation.column ?? data.timestamps.length - 1;
    if (event.key === "ArrowRight") column++; else if (event.key === "ArrowLeft") column--;
    else if (event.key === "ArrowUp") row++; else if (event.key === "ArrowDown") row--;
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); inspection.show(observation(row, column), true, "keyboard"); return; } else return;
    event.preventDefault();
    inspection.show(observation(Math.max(0, Math.min(data.rows.length - 1, row)), Math.max(0, Math.min(data.timestamps.length - 1, column))), !!inspection.active?.pinned, "keyboard");
  };
  if (!data.rows.length || !data.timestamps.length) return <EmptyState />;
  return <div className={styles.chart} ref={inspectionRoot} onPointerLeave={inspection.leave}>
    <div className={styles.plot} ref={ref}>
      <svg ref={setAnchor} className={styles.svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`${widget.title}. ${data.rows.length} histogram buckets.${inspection.enabled ? " Arrow keys inspect buckets and time; Enter pins." : ""}`} tabIndex={inspection.enabled ? 0 : undefined} aria-describedby={inspection.active && inspection.detailsEnabled ? id : descriptionId} onKeyDown={keys}
        onFocus={() => inspection.focus(observation(0, data.timestamps.length - 1))}
        onPointerMove={event => { if (event.pointerType === "touch") return; const value = locate(event); if (value) inspection.show(value); else if (inspection.active && !inspection.active.pinned && inspection.active.owner === "pointer") inspection.dismiss(); }}
        onClick={event => { const value = locate(event as unknown as PointerEvent<SVGSVGElement>); if (value) inspection.show(value, true); }}>
        <PlotHatchDefs id={id} />
        <rect x={left} y={top} width={plotWidth} height={plotHeight} className={heatmapStyles.plotBackground} aria-hidden="true" />
        {timeTicks(data.timestamps, plotWidth).map(index => <line key={index} x1={columnX(data.timestamps[index])} x2={columnX(data.timestamps[index])} y1={top} y2={top + plotHeight} className={heatmapStyles.gridLine} aria-hidden="true" />)}
        {gaps.map((gap, index) => <rect key={index} x={gap.left} y={top} width={Math.max(0, gap.right - gap.left)} height={plotHeight} fill={plotHatchFill(id)} pointerEvents="none" aria-hidden="true" data-heatmap-gap />)}
        {data.rows.map((row, rowIndex) => <g key={row.upper}>
          {showAxis && axisRows.has(rowIndex) && <text data-value-axis x={left - 8} y={top + (data.rows.length - rowIndex - .5) * cellHeight} textAnchor="end" dominantBaseline="middle" className={styles.tick}>{tickLabels[rowIndex]}</text>}
          {row.cells.map((cell, column) => <rect key={cell.timestamp} x={columns[column].left} y={top + (data.rows.length - 1 - rowIndex) * cellHeight + .5} width={columns[column].width} height={Math.max(.1, cellHeight - 1)} fill={cellFill(cell)} data-bucket-value={cell.value ?? "unknown"} data-bucket-state={cell.state} data-bucket-upper={row.upper} data-timestamp={cell.timestamp}>{(embeddedChart || props.embedded) && <title>{cellTitle(row, cell)}</title>}</rect>)}
        </g>)}
        {quantile.d !== "" && <>
          <path d={quantile.d} fill="none" stroke="var(--widget-background, var(--gamma-bg))" strokeWidth={4.6} strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" aria-hidden="true" data-quantile-halo />
          {/* With an overflow run the whole line is dashed, then the finite runs are drawn solid over it, so an overflow run and its joins are dashed. */}
          <path d={quantile.d} fill="none" stroke="var(--gamma-ink)" strokeWidth={2} strokeDasharray={overflowRun ? "4 3" : undefined} strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" aria-hidden="true" data-quantile-line data-quantile-overflow={overflowRun || undefined} />
          {overflowRun && finite.d !== "" && <path d={finite.d} fill="none" stroke="var(--gamma-ink)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" aria-hidden="true" data-quantile-solid />}
        </>}
        {quantile.above.map((x, index) => <g key={index} pointerEvents="none" aria-hidden="true">
          <path d={`M${x - 4},${top + 6}L${x},${top + 2}L${x + 4},${top + 6}`} fill="none" stroke="var(--widget-background, var(--gamma-bg))" strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" />
          <path d={`M${x - 4},${top + 6}L${x},${top + 2}L${x + 4},${top + 6}`} fill="none" stroke="var(--gamma-ink)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" data-quantile-above />
        </g>)}
        {selected && <g pointerEvents="none" aria-hidden="true">
          <rect x={selected.x} y={selected.y} width={selected.width} height={selected.height} fill="none" stroke="var(--widget-background, var(--gamma-bg))" strokeWidth={4} />
          <rect x={selected.x} y={selected.y} width={selected.width} height={selected.height} fill="none" stroke="var(--gamma-ink)" strokeWidth={2} data-selected-bucket />
        </g>}
        {cursorTime !== undefined && <>
          <line x1={columnX(cursorTime)} x2={columnX(cursorTime)} y1={top} y2={height - bottom} stroke="var(--widget-background, var(--gamma-bg))" strokeWidth={3} pointerEvents="none" aria-hidden="true" />
          <line x1={columnX(cursorTime)} x2={columnX(cursorTime)} y1={top} y2={height - bottom} className={styles.crosshair} data-shared-cursor={cursorTime} />
        </>}
        {showAxis && timeTicks(data.timestamps, plotWidth).map(index => <text key={index} x={columnX(data.timestamps[index])} y={height - 8} textAnchor={index === 0 ? "start" : index === data.timestamps.length - 1 ? "end" : "middle"} className={styles.tick}>{formatTimeTick(data.timestamps[index], timeSpan)}</text>)}
      </svg>
      {inspection.active && inspection.detailsEnabled && anchor && <Inspector widget={widget} id={id} anchor={anchor} setPanel={setPanel} onEnter={inspection.enterPanel} onLeave={inspection.leave} observation={inspection.active.observation} extra={histogram} pinned={inspection.active.pinned} decimals={widget.options?.decimals} onClose={inspection.dismiss} onPin={() => inspection.active?.pinned ? inspection.dismiss() : inspection.show(inspection.active!.observation, true)} />}
    </div>
    <div className={styles.heatmapFooter}>
    {!embeddedView && <p className={heatmapStyles.quantile} data-heatmap-quantile>{readout}</p>}
    {widget.options?.showLegend !== false && <div className={heatmapStyles.legend} aria-label={`Color encodes bucket ${densityUnit}`}>
      <span>{config.colorScale === "logarithmic" && data.minPositive !== null ? densityMaximumLabel(data.minPositive, densityUnit, widget.options?.decimals) : "> 0"}</span>
      <div className={heatmapStyles.ramp} style={{ background: `linear-gradient(to right, ${densityPalette.join(", ")})` }} />
      <span>{densityMaximumLabel(data.max, densityUnit, widget.options?.decimals)}</span>
      {config.colorScale === "logarithmic" && <span title={data.minPositive === null ? "No positive bucket observations" : `Lowest positive observation: ${data.minPositive} ${densityUnit}`}>Logarithmic · zero separate{data.minPositive !== null && ` · min ≈${data.minPositive.toPrecision(3)}`}</span>}
      <span className={heatmapStyles.key}><i aria-hidden="true" className={plotHatchStyles.emptySwatch} />Zero</span>
      <span className={heatmapStyles.key}><i aria-hidden="true" className={`${plotHatchStyles.hatch} ${plotHatchStyles.swatch}`} />Missing</span>
      {data.invalidCells > 0 && <span className={heatmapStyles.key}><i aria-hidden="true" className={`${plotHatchStyles.hatchWarning} ${plotHatchStyles.swatch}`} />Invalid</span>}
      {finite.d !== "" && <span className={heatmapStyles.key}>
        <svg className={heatmapStyles.quantileSwatch} width={22} height={10} viewBox="0 0 22 10" aria-hidden="true" focusable="false"><path d="M1 5H21" fill="none" stroke="var(--widget-background, var(--gamma-bg))" strokeWidth={4.6} strokeLinecap="round" /><path d="M1 5H21" fill="none" stroke="var(--gamma-ink)" strokeWidth={2} strokeLinecap="round" /></svg>
        p95 bucket
      </span>}
      {overflowRun && <span className={heatmapStyles.key}>
        <svg className={heatmapStyles.quantileSwatch} width={22} height={10} viewBox="0 0 22 10" aria-hidden="true" focusable="false"><path d="M1 5H21" fill="none" stroke="var(--widget-background, var(--gamma-bg))" strokeWidth={4.6} strokeLinecap="round" /><path d="M1 5H21" fill="none" stroke="var(--gamma-ink)" strokeWidth={2} strokeDasharray="4 3" strokeLinecap="round" /></svg>
        p95 above the last bound
      </span>}
      {quantile.above.length > 0 && <span className={heatmapStyles.key}>
        <svg className={heatmapStyles.quantileSwatch} width={22} height={10} viewBox="0 0 22 10" aria-hidden="true" focusable="false"><path d="M7 7L11 3L15 7" fill="none" stroke="var(--widget-background, var(--gamma-bg))" strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" /><path d="M7 7L11 3L15 7" fill="none" stroke="var(--gamma-ink)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" /></svg>
        p95 above shown buckets
      </span>}
    </div>}
    <Notices truncated={result.truncated}>{data.groups > 1 && <span>Sum of {data.groups} compatible histograms</span>}{data.invalidCells > 0 && <span>{data.invalidCells} non-monotonic or negative bucket observations shown hatched, not drawn as density</span>}{data.omittedBuckets > 0 && <span>{data.omittedBuckets} higher buckets not shown</span>}{data.sampled && <span>Sampled observations · column width does not show duration</span>}</Notices>
    </div>
  </div>;
}

function segments(cells: MetricCell[]) {
  const groups: MetricCell[][] = []; let current: MetricCell[] = [];
  for (const cell of cells) {
    if (cell.upper === null || cell.lower === null) { if (current.length) groups.push(current); current = []; }
    else current.push(cell);
  }
  if (current.length) groups.push(current);
  return groups;
}

function MetricPlot(props: WidgetRendererProps & { directional: boolean }) {
  const { widget, result, directional } = props;
  const config = useMemo(() => directional ? directionalConfigSchema.parse(widget.config ?? {}) : stackedConfigSchema.parse(widget.config ?? {}), [directional, widget.config]);
  const signature = JSON.stringify([widget.id, config, widget.unit, widget.options, directional]);
  const fullSeries = useMemo(() => (result.series ?? []).slice(0, config.maxSeries ?? 8), [result.series, config.maxSeries]);
  const [selection, setSelection] = useState<{ source: QueryResult; window: ObservationWindow; previous?: QueryResult }>();
  const zoom = selection?.source === result ? selection.window : undefined;
  const selectedSeries = useMemo(() => zoom ? seriesInWindow(fullSeries, zoom) : fullSeries, [fullSeries, zoom]);
  // A truncated result, or one a tooltip host truncated, makes every absence missing: never ended and never not started.
  const parentData = useTooltipWidgetData(), truncated = result.truncated === true || parentData?.result.truncated === true, staleAfterSeconds = widget.options?.staleAfterSeconds;
  const data = useMemo(() => buildMetricPlot(selectedSeries, config, directional, fullSeries, { truncated, staleAfterSeconds }), [selectedSeries, config, directional, fullSeries, truncated, staleAfterSeconds]);
  const bars = !directional && "display" in config && config.display === "bar";
  const stackTotal = useMemo(() => ({ name: "Stack total", labels: {}, points: data.totals }), [data.totals]);
  const prior = useMemo(() => zoom && selection?.previous ? metricPriorPeriod(fullSeries, selection.previous.series ?? [], zoom, directional) : [], [fullSeries, selection, zoom, directional]);
  const priorTruncated = selection?.previous?.truncated === true;
  const previousPlot = useMemo(() => prior.length ? buildMetricPlot(prior.map(entry => entry.shifted), config, directional, undefined, { truncated: priorTruncated, staleAfterSeconds }) : undefined, [prior, config, directional, priorTruncated, staleAfterSeconds]);
  const canOverlay = useCallback((current: MetricSeries[], previous: MetricSeries[], window: ObservationWindow) => {
    const matched = metricPriorPeriod(current, previous, window, directional);
    return matched.length > 0 && buildMetricPlot(matched.map(entry => entry.shifted), config, directional).tracks.some(track => track.cells.some(cell => cell.upper !== null));
  }, [config, directional]);
  const [anchor, setAnchor] = useState<SVGSVGElement | null>(null), [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const { root: inspectionRoot, ...inspection } = useInspection(props, `${signature}:${zoom?.start ?? "full"}:${zoom?.end ?? "full"}`, panel), { ref, width, height } = useSize(), id = useId();
  const sharedCursor = useChartCursor();
  const eventData = useAnnotationEvents();
  const { showAxis, descriptionId, embedded: embeddedChart } = useWidgetPresentation();
  const displayTimes = data.timestamps.length ? data.timestamps : previousPlot?.timestamps ?? [];
  const currentDrawable = data.tracks.some(track => track.cells.some(cell => cell.upper !== null));
  const previousDrawable = previousPlot?.tracks.some(track => track.cells.some(cell => cell.upper !== null)) ?? false;
  // Bar mode draws the reporting tracks of incomplete columns, so a window holding only partial stacks is not empty.
  const currentPartial = bars && data.columns.some(column => column.partial.length > 0);
  const emptyZoom = !!zoom && !currentDrawable && !currentPartial && !previousDrawable;
  // The overlay draws only complete stacks, so in bar mode only their bounds may widen the axis. Partial stacks it never draws would stretch it.
  const overlayDomain = previousPlot && (bars ? previousPlot.completeDomain : previousPlot.domain);
  const domain: [number, number] = overlayDomain ? [Math.min(data.domain[0], overlayDomain[0]), Math.max(data.domain[1], overlayDomain[1])] : data.domain;
  const minTime = zoom?.start ?? displayTimes[0] ?? 0, span = zoom ? zoom.end - zoom.start : (displayTimes.at(-1) ?? minTime) - minTime;
  const ticks = Array.from({ length: height < 150 ? 3 : 5 }, (_, index) => {
    const fraction = index / (height < 150 ? 2 : 4);
    // Weighted endpoints remain finite when max - min overflows.
    return domain[0] * (1 - fraction) + domain[1] * fraction;
  });
  const tickLabels = ticks.map(value => formatMetric(value, widget.unit, true, widget.options?.decimals));
  const gutter = useAxisGutter(tickLabels, ref, width);
  const left = showAxis ? gutter : 4, right = 12, top = showAxis ? 14 : 4, bottom = showAxis ? 29 : 4;
  const plotWidth = Math.max(1, width - left - right), plotHeight = Math.max(1, height - top - bottom);
  // A cap needs its headroom above the tallest drawn stack, so the scale starts below the plot top only when a drawn
  // column has one. The domain is unchanged; only the drawn range is lowered, which keeps every cap inside the plot.
  const capped = bars && data.columns.some(column => !column.overflow && column.missing.length > 0);
  const headroom = capped ? capHeadroom : 0;
  const scaleTop = top + headroom, scaleHeight = Math.max(1, plotHeight - headroom);
  const x = (timestamp: number) => left + (span ? (timestamp - minTime) / span : .5) * plotWidth;
  const cursorTime = inspection.enabled && sharedCursor && sharedCursor.timestamp >= minTime && sharedCursor.timestamp <= minTime + span ? sharedCursor.timestamp : inspection.active?.observation.timestamp;
  const y = (value: number) => {
    const span = domain[1] - domain[0];
    const fraction = Number.isFinite(span) ? (value - domain[0]) / span : (value / 2 - domain[0] / 2) / (domain[1] / 2 - domain[0] / 2);
    return scaleTop + (1 - fraction) * scaleHeight;
  };
  // Resolve by exact provider label, so changing series order or a shared
  // dashboard filter cannot silently assign a different semantic color.
  const color = (index: number) => {
    const labels = data.tracks[index]?.series.labels ?? {};
    return resolveSeriesColor(labels, config.seriesColors, index === 0 && widget.color ? widget.color : palette[index % palette.length]);
  };
  // Bar geometry is shared by complete bars, partial stacks, caps and hover, so they stay aligned.
  const barAt = (column: number) => {
    const time = data.timestamps;
    const interval = Math.min(column ? x(time[column]) - x(time[column - 1]) : Infinity, column < time.length - 1 ? x(time[column + 1]) - x(time[column]) : Infinity);
    const barWidth = Math.max(1, Math.min(36, Number.isFinite(interval) ? interval * .75 : plotWidth * .5));
    return { x: Math.max(left, Math.min(width - right - barWidth, x(time[column]) - barWidth / 2)), width: barWidth };
  };
  // The positive top of an incomplete stack is its highest reporting bound, or the baseline when every reporting track is negative.
  const stackTop = (column: number) => y(Math.max(0, ...data.columns[column].partial.map(part => part.upper)));
  // The cap's top edge is one gap above the partial stack. The headroom keeps it inside the plot.
  const capTop = (column: number) => stackTop(column) - capGap - capHeight;
  // A track's vertical extent at a time: its complete bounds, or in bar mode its partial stack.
  const extent = (index: number, column: number) => {
    const cell = data.tracks[index].cells[column];
    if (cell.lower !== null && cell.upper !== null) return { lower: cell.lower, upper: cell.upper };
    return bars ? data.columns[column].partial.find(part => part.index === index) : undefined;
  };
  const incomplete = (column: number) => { const { missing, notStarted, ended } = data.columns[column]; return missing.length + notStarted.length + ended.length > 0; };
  const incompleteNote = (column: number) => {
    const { missing, notStarted, ended } = data.columns[column];
    const reporting = data.tracks.length - missing.length - notStarted.length - ended.length;
    const known = data.tracks.reduce((sum, track) => sum + (track.cells[column].value ?? 0), 0);
    const shown = formatMetric(known, widget.unit, false, widget.options?.decimals);
    // With no reporting series there is no known sum, and a zero would read as an observed total.
    const count = `${reporting} of ${data.tracks.length} series report at this time`;
    const status = reporting === 0 ? "No series reports at this time, so the stack total is unavailable."
      : missing.length ? `${count}, so the stack total is unavailable. Known series sum to ${shown}.`
      : `${count}. Their stack total is ${shown}.`;
    // Ended series are grouped by their last sample, so each time is named once.
    const endedAt = new Map<number, string[]>();
    for (const index of ended) {
      const at = data.tracks[index].lastFinite;
      if (at !== null) endedAt.set(at, [...endedAt.get(at) ?? [], data.tracks[index].name]);
    }
    const parts = [status, ...[...endedAt].map(([at, names]) => `${names.join(", ")}: no samples since ${fullDateTimeFormat.format(new Date(at))}.`)];
    const waiting = notStarted.map(index => data.tracks[index].name);
    if (waiting.length) parts.push(`${waiting.join(", ")}: no samples yet.`);
    // Every missing series is named here; the cap is one shape for all of them.
    if (missing.length) parts.push(`${missing.map(index => data.tracks[index].name).join(", ")}: no value at this time.`);
    return parts.join(" ");
  };
  const observation = (row: number, column: number): Observation => {
    const track = data.tracks[row], cell = track.cells[column];
    const note = directional ? "Outbound is drawn below zero; this is the original nonnegative observation."
      : data.columns[column].overflow ? "Recorded value; the stack exceeds the finite numeric range at this timestamp."
      : bars && incomplete(column) ? incompleteNote(column)
      : cell.upper === null && cell.value !== null ? "Recorded value; the stack is unavailable because another series is missing at this timestamp."
      : "Original observation, not the cumulative stacked height.";
    return { row, column, value: cell.value, timestamp: cell.timestamp, series: track.series, name: track.name, unit: widget.unit, color: color(row), note };
  };
  const locate = (event: PointerEvent<SVGSVGElement>) => {
    const point = coordinates(event, width, height);
    if (point.x < left || point.x > width - right || point.y < top || point.y > height - bottom) return;
    const column = data.timestamps.reduce((nearest, time, index) => Math.abs(x(time) - point.x) < Math.abs(x(data.timestamps[nearest]) - point.x) ? index : nearest, 0);
    if (bars && !data.columns[column].overflow && data.columns[column].missing.length) {
      // A cap sits above its stack and stands for its missing series, so caps are tested before the bands.
      // A pointer on the cap selects the first missing series; the inspector lists all of them.
      const bar = barAt(column);
      if (point.x >= bar.x && point.x <= bar.x + bar.width && point.y >= capTop(column) && point.y <= capTop(column) + capHeight) return observation(data.columns[column].missing[0], column);
    }
    let row = 0, distance = Infinity;
    data.tracks.forEach((_, index) => {
      const span = extent(index, column); if (!span) return;
      const upper = y(span.upper), lower = y(span.lower);
      const next = directional ? Math.abs(point.y - upper) : point.y >= Math.min(upper, lower) && point.y <= Math.max(upper, lower) ? 0 : Math.min(Math.abs(point.y - upper), Math.abs(point.y - lower));
      if (next < distance) { row = index; distance = next; }
    });
    return observation(row, column);
  };
  const keys = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!inspection.enabled) return;
    if (event.key === "Tab" && !event.shiftKey && inspection.active?.pinned && inspection.focusPanel()) { event.preventDefault(); return; }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); inspection.dismiss(); return; }
    let row = inspection.active?.observation.row ?? 0, column = inspection.active?.observation.column ?? data.timestamps.length - 1;
    if (event.key === "ArrowRight") column++; else if (event.key === "ArrowLeft") column--;
    else if (event.key === "ArrowUp") row--; else if (event.key === "ArrowDown") row++;
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); inspection.show(observation(row, column), true, "keyboard"); return; } else return;
    event.preventDefault(); inspection.show(observation(Math.max(0, Math.min(data.tracks.length - 1, row)), Math.max(0, Math.min(data.timestamps.length - 1, column))), !!inspection.active?.pinned, "keyboard");
  };
  if (!data.tracks.length || (!displayTimes.length && !zoom)) return <EmptyState />;
  const authored = !directional && "annotations" in config ? config.annotations ?? [] : [];
  const inView = widget.annotationSource && !props.embedded && !embeddedChart ? eventData.events.filter(event => { const at = Date.parse(event.timestamp); return at <= minTime + span && Date.parse(event.endTimestamp ?? event.timestamp) >= minTime }) : [];
  const queried = inView.slice(0, 20);
  const annotations = [...authored, ...queried].map(annotation => ({ ...annotation, at: Date.parse(annotation.timestamp), endAt: "endTimestamp" in annotation && typeof annotation.endTimestamp === "string" ? Date.parse(annotation.endTimestamp) : undefined })).filter(annotation => annotation.at <= minTime + span && (annotation.endAt ?? annotation.at) >= minTime).sort((a, b) => a.at - b.at);
  const tableLegend = config.legendDisplay === "table";
  const displayLabels = compactSeriesLabels(data.tracks.map(track => track.series));
  const legendRevision = JSON.stringify([widget.unit, widget.options?.decimals, config.legendDisplay, data.tracks.map(track => [track.name, track.cells.at(-1)?.value, track.statistics])]);
  const formatSummary = (value: number | null) => value === null ? "No data" : formatMetric(value, widget.unit, false, widget.options?.decimals);
  // The series beyond maxSeries are never plotted, so the total does not include them. Say so.
  const hiddenSeries = (result.series?.length ?? 0) - fullSeries.length;
  // Pinned bar detail only: the stack total's trend, with gaps where the stack is incomplete. Area mode keeps its inspector.
  const stackFooter = bars && inspection.active?.pinned && data.totals.some(total => total.value !== null) ? <figure className={styles.stackTotal} data-stack-total="">
    <div className={styles.history}><StatSparkline series={stackTotal} name={stackTotal.name} color="var(--gamma-muted)" unit={widget.unit} /></div>
    <figcaption className={styles.note}>Stack total of the series shown that report at each time; gaps where a series is missing a value{hiddenSeries > 0 && ` · ${hiddenSeries} hidden series not included`}</figcaption>
  </figure> : undefined;
  return <div className={`${styles.chart} ${styles.metricShell}`} ref={inspectionRoot} onPointerLeave={inspection.leave}>
    <div className={styles.metricContent} data-legend-position={widget.options?.showLegend === false ? "bottom" : config.legendPosition ?? "bottom"} data-legend-display={config.legendDisplay ?? "compact"}>
    <div className={styles.plot} ref={ref}>
      {emptyZoom ? <div role="status">No recorded observations in this window. Reset chart zoom to return to the full view.</div> : <svg ref={setAnchor} className={styles.svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`${widget.title}. ${directional ? "Outbound traffic below zero" : "Stacked observations"}.${inspection.enabled && data.timestamps.length ? " Arrow keys inspect values; Enter pins." : ""}`} tabIndex={inspection.enabled && data.timestamps.length ? 0 : undefined} aria-describedby={inspection.active && inspection.detailsEnabled ? id : descriptionId} onKeyDown={data.timestamps.length ? keys : undefined}
        onFocus={() => { if (data.timestamps.length) inspection.focus(observation(0, data.timestamps.length - 1)); }}
        onPointerMove={event => { if (!data.timestamps.length) return; const value = locate(event); if (value && event.pointerType !== "touch") inspection.show(value); }}
        onClick={event => { if (!data.timestamps.length) return; const value = locate(event as unknown as PointerEvent<SVGSVGElement>); if (value) inspection.show(value, true); }}>
        <defs><clipPath id={`${id}-clip`}><rect x={left} y={top} width={plotWidth} height={plotHeight} /></clipPath></defs>
        {bars && <PlotHatchDefs id={id} />}
        {ticks.map((value, index) => <g key={index}>{widget.options?.showGrid !== false && <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className={styles.gridLine} />}{showAxis && <text data-value-axis x={left - 7} y={y(value)} textAnchor="end" dominantBaseline="middle" className={styles.tick}>{tickLabels[index]}</text>}</g>)}
        <line x1={left} x2={width - right} y1={y(0)} y2={y(0)} className={styles.baseline} />
        {annotations.filter(event => event.endAt !== undefined && event.endAt > event.at).map((event, index) => <rect key={`range-${index}`} data-annotation-interval data-annotation-timestamp={event.timestamp} x={x(Math.max(minTime, event.at))} y={top} width={Math.max(0, x(Math.min(minTime + span, event.endAt!)) - x(Math.max(minTime, event.at)))} height={plotHeight} className={styles.annotationRange} data-severity={event.severity ?? "unclassified"} pointerEvents="none" aria-hidden="true" />)}
        {/* Individual marks are visual only. The focusable chart exposes one
            accessible summary and keyboard navigation into exact observations;
            exposing hundreds of SVG titles as images makes that path unusable. */}
        <g clipPath={`url(#${id}-clip)`} aria-hidden="true" data-metric-marks>{previousPlot?.tracks.map((track, index) => <g key={`prior-${index}`} data-prior-series={prior[index].index} pointerEvents="none" aria-hidden="true">
          {segments(track.cells).map((segment, part) => <path key={part} data-prior-path d={`M${segment.map(cell => `${number(x(cell.timestamp))},${number(y(cell.upper!))}`).join("L")}`} fill="none" stroke={color(prior[index].index)} strokeWidth={widget.options?.lineWidth ?? 1.6} strokeDasharray="5 4" strokeOpacity={.8} />)}
        </g>)}{data.tracks.map((track, index) => <g key={index} data-series={track.name}>
          {bars ? track.cells.map((cell, column) => {
            const bar = barAt(column);
            if (cell.upper === null || cell.lower === null) {
              // An incomplete column draws only the stack of its reporting tracks. A missing or not-started track has no bar here.
              const part = data.columns[column].partial.find(entry => entry.index === index);
              if (!part) return null;
              return <rect key={cell.timestamp} x={bar.x} y={Math.min(y(part.lower), y(part.upper))} width={bar.width} height={Math.max(cell.value === 0 ? 1 : .5, Math.abs(y(part.upper) - y(part.lower)))} fill={color(index)} fillOpacity={.82} data-raw-value={cell.value ?? "unknown"} data-partial-stack="true"><title>{track.name}: {formatMetric(cell.value!, widget.unit, false, widget.options?.decimals)} · {stamp(cell.timestamp)}</title></rect>;
            }
            return <rect key={cell.timestamp} x={bar.x} y={Math.min(y(cell.lower), y(cell.upper))} width={bar.width} height={Math.max(cell.value === 0 ? 1 : .5, Math.abs(y(cell.upper) - y(cell.lower)))} fill={color(index)} fillOpacity={.82} data-raw-value={cell.value ?? "unknown"}><title>{track.name}: {formatMetric(cell.value!, widget.unit, false, widget.options?.decimals)} · {stamp(cell.timestamp)}</title></rect>;
          }) : segments(track.cells).map((segment, part) => {
            const forward = segment.map(cell => `${number(x(cell.timestamp))},${number(y(cell.upper!))}`), back = segment.toReversed().map(cell => `${number(x(cell.timestamp))},${number(y(cell.lower!))}`);
            return <g key={part}><path d={`M${forward.join("L")}L${back.join("L")}Z`} fill={color(index)} fillOpacity={directional ? .16 : .48} /><path d={`M${forward.join("L")}`} fill="none" stroke={color(index)} strokeWidth={widget.options?.lineWidth ?? 1.6} strokeLinejoin="round" />{segment.length === 1 && <circle cx={x(segment[0].timestamp)} cy={y(segment[0].upper!)} r={2.5} fill={color(index)} />}</g>;
          })}
        </g>)}{bars && data.columns.map((column, index) => {
          // One cap per incomplete column, however many series are missing. A single missing series sets its colour.
          if (column.overflow || !column.missing.length) return null;
          const bar = barAt(index), names = column.missing.map(track => data.tracks[track].name).join(", ");
          return <rect key={index} x={bar.x} y={capTop(index)} width={bar.width} height={capHeight} fill={plotHatchFill(id)} stroke={column.missing.length === 1 ? color(column.missing[0]) : "var(--gamma-chart-hatch)"} strokeWidth={1} strokeDasharray="2 2" data-missing-series={names} data-missing-count={column.missing.length} aria-hidden="true"><title>{`${names}: no value at ${stamp(column.timestamp)}`}</title></rect>;
        })}</g>
        {annotations.map((event, index) => <g key={`${event.timestamp}-${index}`} aria-hidden="true">
          {event.at >= minTime && <><line data-annotation-timestamp={event.timestamp} x1={x(event.at)} x2={x(event.at)} y1={top} y2={height - bottom} className={styles.annotationLine} data-severity={event.severity ?? "unclassified"} pointerEvents="none" />
          <circle cx={x(event.at)} cy={top + 4} r={3} className={styles.annotationMarker} data-severity={event.severity ?? "unclassified"} pointerEvents="none" /></>}
        </g>)}
        {cursorTime !== undefined && <line x1={x(cursorTime)} x2={x(cursorTime)} y1={top} y2={height - bottom} className={styles.crosshair} data-shared-cursor={cursorTime} />}
        {showAxis && timeTicks(displayTimes, plotWidth).map(index => <text key={index} x={x(displayTimes[index])} y={height - 8} textAnchor={index === 0 ? "start" : index === displayTimes.length - 1 ? "end" : "middle"} className={styles.tick}>{formatTimeTick(displayTimes[index], span)}</text>)}
      </svg>}
      {inspection.active && inspection.detailsEnabled && anchor && <Inspector widget={widget} id={id} anchor={anchor} setPanel={setPanel} onEnter={inspection.enterPanel} onLeave={inspection.leave} observation={inspection.active.observation} peers={data.tracks.map((track, index) => ({ name: track.name, display: displayLabels[index], color: color(index), value: track.cells[inspection.active!.observation.column].value }))} footer={stackFooter} pinned={inspection.active.pinned} decimals={widget.options?.decimals} onClose={inspection.dismiss} onPin={() => inspection.active?.pinned ? inspection.dismiss() : inspection.show(inspection.active!.observation, true)} />}
    </div>
    {widget.options?.showLegend !== false && <SeriesLegend table={tableLegend} revision={legendRevision}>{tableLegend ? <table className={styles.legendTable}>
      <caption>Raw returned observations. Current is the latest sample, including missing values. Mean is the arithmetic mean of finite samples; max is the largest finite sample. Statistics use all returned samples before display sampling.</caption>
      <thead><tr><th scope="col">Series</th><th scope="col">Current</th><th scope="col">Mean</th><th scope="col">Max</th></tr></thead>
      <tbody>{data.tracks.map((track, index) => <tr key={index} data-legend-series={track.name}>
        <th scope="row"><span className={styles.legendTableName}><i aria-hidden="true" style={{ background: color(index) }} /><LegendName name={track.name} display={displayLabels[index]} /></span></th>
        <td data-summary="current" data-value={track.statistics.current ?? "unknown"} title={track.statistics.currentTimestamp === null ? "No recorded sample" : `Latest sample · ${stamp(track.statistics.currentTimestamp)}`}>{formatSummary(track.statistics.current)}</td>
        <td data-summary="mean" data-value={track.statistics.mean ?? "unknown"} title={`Arithmetic mean of ${track.statistics.finiteSamples} finite samples (${track.statistics.totalSamples} returned)`}>{formatSummary(track.statistics.mean)}</td>
        <td data-summary="max" data-value={track.statistics.max ?? "unknown"} title={`Maximum of ${track.statistics.finiteSamples} finite samples`}>{formatSummary(track.statistics.max)}</td>
      </tr>)}</tbody>
    </table> : data.tracks.map((track, index) => {
      const latest = track.cells.at(-1); return <span className={styles.legendItem} key={index}><i style={{ background: color(index) }} /><LegendName name={track.name} display={displayLabels[index]} /><b>{latest?.value == null ? "No data" : formatMetric(latest.value, widget.unit, false, widget.options?.decimals)}</b></span>;
    })}</SeriesLegend>}
    </div>
    {zoom && !currentDrawable && previousDrawable && <span role="status">No complete current observations in this window; dashed lines show the previous period.</span>}
    {previousPlot && <div className={styles.priorLegend} role="group" aria-label="Previous period overlay" tabIndex={0}>
      <span>{directional ? "Previous directions" : "Previous stacked boundaries"} · dashed · aligned to the selected window</span>
      {prior.map(entry => <span key={entry.index} data-prior-original-first={entry.original.points[0]?.timestamp} data-prior-aligned-first={entry.shifted.points[0]?.timestamp}><i aria-hidden="true" style={{ borderColor: color(entry.index) }} />{entry.original.name ?? Object.entries(entry.original.labels).map(([key, value]) => `${key}=${value}`).join(", ")}</span>)}
      {selection?.previous?.truncated && <span>Partial prior result</span>}
    </div>}
    {!props.embedded && !embeddedChart && <div className={styles.comparisonActions}>
      <TimeWindowLens title={widget.title} series={fullSeries} unit={widget.unit} decimals={widget.options?.decimals} zoom={zoom} onZoom={window => setSelection({ source: result, window })} onOverlay={(window, previous) => setSelection({ source: result, window, previous })} onReset={() => setSelection(undefined)} canOverlay={canOverlay} overlayUnavailable={directional ? undefined : "A previous stacked boundary requires every displayed series to match uniquely and contain recorded values."} />
      {prior.length > 0 && <ChartDataInspector widget={{ ...widget, title: `${widget.title} · Previous period` }} series={prior.map(entry => entry.original)} buttonText="Inspect prior data" />}
    </div>}
    {annotations.length > 0 && !props.embedded && !embeddedChart && <details className={styles.annotationEvents} role="group" aria-label="Chart events"><summary>{annotations.length} {annotations.length === 1 ? "event" : "events"} in view</summary><ul>{annotations.map((event, index) => <li key={`${event.timestamp}-${index}`}><span className={styles.annotationBullet} data-severity={event.severity ?? "unclassified"} aria-hidden="true" /><strong>{event.label}</strong><time dateTime={event.timestamp} title={new Date(event.at).toISOString()}>{localEventTime(event.at)}</time>{event.endAt !== undefined && <time dateTime={new Date(event.endAt).toISOString()}>to {localEventTime(event.endAt)}</time>}<span>{event.severity ?? "unclassified"}</span></li>)}</ul></details>}
    {widget.annotationSource && !props.embedded && !embeddedChart && eventData.error && <p role="status">Events unavailable: {eventData.error}</p>}
    {widget.annotationSource && !props.embedded && !embeddedChart && !!eventData.omitted && <p>{eventData.omitted} invalid or excess event records omitted.</p>}
    {widget.annotationSource && !props.embedded && !embeddedChart && inView.length > queried.length && <p>{inView.length - queried.length} additional events in view omitted.</p>}
    {widget.annotationSource && !props.embedded && !embeddedChart && eventData.truncated && <p>Event source response is partial.</p>}
    <Notices truncated={result.truncated}>{(result.series?.length ?? 0) > fullSeries.length && <span>{(result.series?.length ?? 0) - fullSeries.length} series not shown</span>}{data.sampled && <span>Sampled timestamps · gaps retained</span>}{data.invalidValues > 0 && <span>{data.invalidValues} negative traffic observations omitted</span>}{!!previousPlot?.invalidValues && <span>Previous period: {previousPlot.invalidValues} negative traffic {previousPlot.invalidValues === 1 ? "observation" : "observations"} omitted</span>}{data.overflowColumns > 0 && <span>{data.overflowColumns} time {data.overflowColumns === 1 ? "column" : "columns"} omitted: the stack exceeds the finite numeric range. Reduce values in the query.</span>}{!!previousPlot?.overflowColumns && <span>Previous period: {previousPlot.overflowColumns} time {previousPlot.overflowColumns === 1 ? "column" : "columns"} omitted because the stack exceeds the finite numeric range.</span>}{!directional && data.tracks.some(track => track.cells.some(cell => cell.upper === null && !cell.overflow)) && <span>{bars ? "Hatched caps mark series with no value at that time. Series that have not started or have ended are left out of the stack." : "Incomplete timestamps leave gaps in the stack"}</span>}</Notices>
  </div>;
}

export function StackedTimeseries(props: WidgetRendererProps) { return <MetricPlot {...props} directional={false} />; }
export function DirectionalTraffic(props: WidgetRendererProps) { return <MetricPlot {...props} directional />; }

export function registerRichMetricPlugins() {
  if (!getWidgetDefinition("plugin", "distribution-heatmap")) registerWidgetPlugin({
    id: "distribution-heatmap", label: "Distribution heatmap", description: "Cumulative histogram buckets as density over time", dataKind: "metrics", render: DistributionHeatmap,
    styleControls: ["unit", "decimals", "legend", "tooltips"],
    defaultConfig: { bucketLabel: "le", densityUnit: "observations/s", aggregation: "none", colorScale: "linear", maxBuckets: 24, maxColumns: 60 },
    configFields: [
      { key: "bucketLabel", label: "Bucket boundary label", kind: "text", placeholder: "le" },
      { key: "bucketUnit", label: "Bucket unit override", kind: "text", placeholder: "Widget unit", help: "Leave empty to use the widget unit; this only labels bucket boundaries, never density values." },
      { key: "densityUnit", label: "Density unit", kind: "text", help: "Use a query-side rate for per-second units. The chart only differences cumulative buckets." },
      { key: "colorScale", label: "Color scale", kind: "select", options: [{ value: "linear", label: "Linear" }, { value: "logarithmic", label: "Logarithmic" }], help: "Logarithmic colors spread positive values between the smallest and largest observations in the shown buckets, before time sampling; zero remains separate. Values and query results are unchanged." },
      { key: "aggregation", label: "Histogram groups", kind: "select", options: [{ value: "none", label: "Require a single group" }, { value: "sum", label: "Sum matching bucket boundaries" }] },
      { key: "maxBuckets", label: "Maximum buckets", kind: "number", min: 1, max: 48, step: 1 },
      { key: "maxColumns", label: "Maximum time columns", kind: "number", min: 8, max: 120, step: 1 },
    ], parseConfig: value => distributionConfigSchema.parse(value ?? {}),
  });
  if (!getWidgetDefinition("plugin", "stacked-timeseries")) registerWidgetPlugin({
    id: "stacked-timeseries", label: "Stacked time series", description: "Compare contributions with stacked areas or time bars", dataKind: "metrics", render: StackedTimeseries,
    styleControls: ["unit", "decimals", "color", "legend", "grid", "tooltips"],
    defaultConfig: { display: "area", maxSeries: 8, maxPoints: 120, legendDisplay: "compact", legendPosition: "bottom" },
    configFields: [
      { key: "display", label: "Stack display", kind: "select", options: [{ value: "area", label: "Stacked area" }, { value: "bar", label: "Stacked time bars" }] },
      { key: "legendDisplay", label: "Legend display", kind: "select", options: [{ value: "compact", label: "Compact latest values" }, { value: "table", label: "Current, mean and max table" }], help: "Table statistics use raw returned samples before display sampling. Mean ignores missing values." },
      { key: "legendPosition", label: "Legend position", kind: "select", options: [{ value: "bottom", label: "Below the chart" }, { value: "right", label: "Right side" }], help: "Right-side legends move below the chart in narrow panels." },
      { key: "maxSeries", label: "Maximum series", kind: "number", min: 1, max: 12, step: 1 },
      { key: "maxPoints", label: "Maximum time columns", kind: "number", min: 12, max: 240, step: 1 },
    ], parseConfig: value => stackedConfigSchema.parse(value ?? {}),
  });
  if (!getWidgetDefinition("plugin", "directional-traffic")) registerWidgetPlugin({
    id: "directional-traffic", label: "Directional traffic", description: "Inbound above zero and outbound below, with original values", dataKind: "metrics", render: DirectionalTraffic,
    styleControls: ["unit", "decimals", "color", "legend", "grid", "tooltips"],
    defaultConfig: { directionLabel: "direction", outboundValue: "outbound", symmetricAxis: false, maxSeries: 8, maxPoints: 120, legendDisplay: "compact", legendPosition: "bottom" },
    configFields: [
      { key: "directionLabel", label: "Direction label", kind: "text", placeholder: "direction" },
      { key: "outboundValue", label: "Outbound label value", kind: "text", placeholder: "outbound", help: "Matching series are drawn below zero. Query values must be nonnegative." },
      { key: "symmetricAxis", label: "Center zero on the value axis", kind: "boolean", help: "Use equal positive and negative bounds without changing the recorded traffic values." },
      { key: "legendDisplay", label: "Legend display", kind: "select", options: [{ value: "compact", label: "Compact latest values" }, { value: "table", label: "Current, mean and max table" }], help: "Table statistics preserve raw outbound values. Mean ignores missing values." },
      { key: "legendPosition", label: "Legend position", kind: "select", options: [{ value: "bottom", label: "Below the chart" }, { value: "right", label: "Right side" }], help: "Right-side legends move below the chart in narrow panels." },
      { key: "maxSeries", label: "Maximum series", kind: "number", min: 1, max: 12, step: 1 },
      { key: "maxPoints", label: "Maximum time columns", kind: "number", min: 12, max: 240, step: 1 },
    ], parseConfig: value => directionalConfigSchema.parse(value ?? {}),
  });
}

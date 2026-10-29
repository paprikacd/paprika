"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { Pin, X } from "lucide-react";
import { EmptyState, MetricDetails, formatMetric } from "../chart-renderers";
import { formatTimeTick } from "../chart-data";
import { GammaButton } from "../gamma/button";
import { StatSparkline } from "../stat-sparkline";
import { getWidgetDefinition, registerWidgetPlugin, type WidgetRendererProps } from "../widget-registry";
import { useEmbeddedWidget, useWidgetPresentation } from "../widget-presentation";
import { useChartCursor, useChartCursorPublisher } from "../chart-cursor";
import { buildDistribution, buildMetricPlot, directionalConfigSchema, distributionConfigSchema, stackedConfigSchema, type MetricCell, type MetricSeries } from "./rich-metrics-data";
import styles from "./rich-metrics.module.css";

const palette = ["var(--gamma-chart-1, #2867b9)", "var(--gamma-chart-2, #087f7a)", "var(--gamma-chart-3, #bb5037)", "var(--gamma-chart-4, #977017)", "var(--gamma-chart-5, #7c58ad)", "var(--gamma-chart-6, #427449)"];
const densityPalette = ["var(--gamma-density-0, #dce9f0)", "var(--gamma-density-1, #98bfd7)", "var(--gamma-density-2, #509bbf)", "var(--gamma-density-3, #35a7a2)", "var(--gamma-density-4, #c1bf5d)", "var(--gamma-density-5, #d78642)"];
const stamp = (timestamp: number) => new Date(timestamp).toISOString();
const number = (value: number) => Number.isFinite(value) ? Number(value.toFixed(3)) : 0;

interface Observation {
  row: number; column: number; value: number | null; timestamp: number;
  series: MetricSeries; name: string; unit: string; color: string; note?: string;
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

function useInspection({ result, widget, embedded, onContextChange }: WidgetRendererProps, signature: string) {
  const parentEmbedded = useEmbeddedWidget();
  const detailsEnabled = !embedded && !parentEmbedded && widget.options?.showTooltip !== false;
  const enabled = !embedded && !parentEmbedded && (detailsEnabled || !!onContextChange);
  const publisher = useChartCursorPublisher();
  const root = useRef<HTMLDivElement>(null);
  const setRoot = useCallback((element: HTMLDivElement | null) => { root.current = element; }, []);
  const [state, setState] = useState<{ observation: Observation; pinned: boolean; result: unknown; signature: string }>();
  const active = state?.result === result && state.signature === signature && enabled ? state : undefined;
  const timestamp = active?.observation.timestamp, pinned = active?.pinned;
  useEffect(() => {
    if (timestamp !== undefined) publisher.publish(widget.id, timestamp, pinned);
    else publisher.clear(widget.id);
    return () => publisher.clear(widget.id);
  }, [publisher, widget.id, timestamp, pinned, result, signature]);
  useEffect(() => {
    if (!enabled) return;
    const close = (event: globalThis.PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setState(undefined); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setState(undefined); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [enabled]);
  const show = (observation: Observation, pinned = false) => {
    if (!enabled || (active?.pinned && !pinned)) return;
    setState({ observation, pinned, result, signature });
    if (pinned) onContextChange?.({ series: observation.name, labels: observation.series.labels, value: observation.value });
  };
  return { root: setRoot, enabled, detailsEnabled, active, show, dismiss: () => setState(undefined), leave: () => { if (!active?.pinned) setState(undefined); } };
}

function Inspector({ observation, pinned, decimals, onPin, onClose, id }: { observation: Observation; pinned: boolean; decimals?: number; onPin: () => void; onClose: () => void; id: string }) {
  return <section id={id} className={styles.inspector} aria-label="Observation details">
    <div className={styles.inspectorActions}><span>{pinned ? "Pinned observation" : "Observation"}</span><GammaButton size="sm" iconOnly variant="quiet" aria-label="Close observation" onClick={onClose}><X size={14} /></GammaButton></div>
    <MetricDetails series={observation.series} index={observation.row} point={{ timestamp: observation.timestamp, value: observation.value }} unit={observation.unit} decimals={decimals} description="Selected sample" />
    {observation.note && <p className={styles.note}>{observation.note}</p>}
    <div className={styles.history}><StatSparkline series={observation.series} name={observation.name} color={observation.color} unit={observation.unit} /></div>
    <GammaButton size="sm" variant="quiet" onClick={onPin} aria-pressed={pinned}><Pin size={13} />{pinned ? "Unpin observation" : "Pin observation"}</GammaButton>
  </section>;
}

function timeTicks(timestamps: number[], width: number) {
  const count = width < 360 ? 3 : 5;
  return [...new Set(Array.from({ length: Math.min(count, timestamps.length) }, (_, index) => Math.round(index * (timestamps.length - 1) / Math.max(1, Math.min(count, timestamps.length) - 1))))];
}

function Notices({ children, truncated }: { children?: ReactNode; truncated?: boolean }) {
  return <div className={styles.notices}>{children}{truncated && <span>Partial source response</span>}</div>;
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

export function DistributionHeatmap(props: WidgetRendererProps) {
  const { widget, result } = props;
  const config = useMemo(() => distributionConfigSchema.parse(widget.config ?? {}), [widget.config]);
  const signature = JSON.stringify([widget.id, config, widget.unit, widget.options]);
  const data = useMemo(() => buildDistribution(result.series ?? [], config), [result, config]);
  const { ref, width, height } = useSize();
  const { root: inspectionRoot, ...inspection } = useInspection(props, signature), id = useId();
  const sharedCursor = useChartCursor();
  const { showAxis, descriptionId } = useWidgetPresentation();
  const unit = config.bucketUnit || widget.unit, densityUnit = config.densityUnit ?? "observations/s";
  const tickLabels = data.rows.map(row => cellLabel(row.lower, row.upper, unit));
  const gutter = useAxisGutter(tickLabels, ref, width);
  const left = showAxis ? gutter : 4, top = 4, bottom = showAxis ? 24 : 4, plotWidth = Math.max(1, width - left - 10), plotHeight = Math.max(1, height - top - bottom);
  const cellWidth = plotWidth / Math.max(1, data.timestamps.length), cellHeight = plotHeight / Math.max(1, data.rows.length);
  // Keep every bucket cell inspectable while thinning labels to the actual
  // available height. Short panels must not stack text over adjacent rows.
  // Use an integer bucket stride: rounding evenly-spaced indices can put two
  // adjacent labels on rows closer than the typography's minimum spacing.
  const axisStride = Math.max(1, Math.ceil(16 / cellHeight));
  const axisRows = new Set(data.rows.map((_, index) => index).filter(index => index % axisStride === 0));
  const timeStart = data.timestamps[0] ?? 0, timeSpan = (data.timestamps.at(-1) ?? timeStart) - timeStart;
  const columnX = (timestamp: number) => left + cellWidth / 2 + (timeSpan ? (timestamp - timeStart) / timeSpan : .5) * Math.max(0, plotWidth - cellWidth);
  const cursorTime = inspection.enabled && sharedCursor && sharedCursor.timestamp >= timeStart && sharedCursor.timestamp <= timeStart + timeSpan ? sharedCursor.timestamp : undefined;
  const observation = (row: number, column: number): Observation => {
    const bucket = data.rows[row], cell = bucket.cells[column], name = cellLabel(bucket.lower, bucket.upper, unit);
    return { row, column, ...cell, name, unit: densityUnit, color: palette[0], series: { name, labels: bucket.labels, points: bucket.cells }, note: "Non-cumulative bucket observation. Input must already be a rate when using a per-second unit." };
  };
  const locate = (event: PointerEvent<SVGSVGElement>) => {
    const point = coordinates(event, width, height);
    if (point.x < left || point.x > left + plotWidth || point.y < top || point.y > top + plotHeight) return;
    const column = data.timestamps.reduce((nearest, time, index) => Math.abs(columnX(time) - point.x) < Math.abs(columnX(data.timestamps[nearest]) - point.x) ? index : nearest, 0);
    const row = Math.max(0, Math.min(data.rows.length - 1, data.rows.length - 1 - Math.floor((point.y - top) / cellHeight)));
    return observation(row, column);
  };
  const keys = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!inspection.enabled) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); inspection.dismiss(); return; }
    let row = inspection.active?.observation.row ?? 0, column = inspection.active?.observation.column ?? data.timestamps.length - 1;
    if (event.key === "ArrowRight") column++; else if (event.key === "ArrowLeft") column--;
    else if (event.key === "ArrowUp") row++; else if (event.key === "ArrowDown") row--;
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); inspection.show(observation(row, column), true); return; } else return;
    event.preventDefault();
    inspection.show(observation(Math.max(0, Math.min(data.rows.length - 1, row)), Math.max(0, Math.min(data.timestamps.length - 1, column))), !!inspection.active?.pinned);
  };
  if (!data.rows.length || !data.timestamps.length) return <EmptyState />;
  return <div className={styles.chart} ref={inspectionRoot} onPointerLeave={inspection.leave}>
    <div className={styles.plot} ref={ref}>
      <svg className={styles.svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`${widget.title}. ${data.rows.length} histogram buckets.${inspection.enabled ? " Arrow keys inspect buckets and time; Enter pins." : ""}`} tabIndex={inspection.enabled ? 0 : undefined} aria-describedby={inspection.active && inspection.detailsEnabled ? id : descriptionId} onKeyDown={keys}
        onFocus={() => { if (inspection.enabled && !inspection.active) inspection.show(observation(0, data.timestamps.length - 1)); }}
        onPointerMove={event => { const value = locate(event); if (value && event.pointerType !== "touch") inspection.show(value); }}
        onClick={event => { const value = locate(event as unknown as PointerEvent<SVGSVGElement>); if (value) inspection.show(value, true); }}>
        {data.rows.map((row, rowIndex) => <g key={row.upper}>
          {showAxis && axisRows.has(rowIndex) && <text data-value-axis x={left - 8} y={top + (data.rows.length - rowIndex - .5) * cellHeight} textAnchor="end" dominantBaseline="middle" className={styles.tick}>{tickLabels[rowIndex]}</text>}
          {row.cells.map((cell, column) => {
            const fill = cell.value === null ? "var(--gamma-surface)" : densityPalette[Math.min(5, Math.floor((data.max ? cell.value / data.max : 0) * 5))];
            const active = inspection.active?.observation.row === rowIndex && inspection.active.observation.column === column;
            const interval = Math.min(cellWidth, column ? columnX(cell.timestamp) - columnX(row.cells[column - 1].timestamp) : cellWidth, column < row.cells.length - 1 ? columnX(row.cells[column + 1].timestamp) - columnX(cell.timestamp) : cellWidth);
            return <rect key={cell.timestamp} x={columnX(cell.timestamp) - interval / 2 + .5} y={top + (data.rows.length - 1 - rowIndex) * cellHeight + .5} width={Math.max(.1, interval - 1)} height={Math.max(.1, cellHeight - 1)} fill={fill} stroke={active ? "var(--gamma-ink)" : cell.value === null ? "var(--gamma-border)" : "none"} strokeWidth={active ? 2 : .5} strokeDasharray={cell.value === null ? "2 2" : undefined} data-bucket-value={cell.value ?? "unknown"} data-bucket-upper={row.upper} data-timestamp={cell.timestamp}><title>{cellLabel(row.lower, row.upper, unit)} · {stamp(cell.timestamp)} · {cell.value === null ? "No observations" : formatMetric(cell.value, densityUnit, false, widget.options?.decimals)}</title></rect>;
          })}
        </g>)}
        {cursorTime !== undefined && <line x1={columnX(cursorTime)} x2={columnX(cursorTime)} y1={top} y2={height - bottom} className={styles.crosshair} data-shared-cursor={cursorTime} />}
        {showAxis && timeTicks(data.timestamps, plotWidth).map(index => <text key={index} x={columnX(data.timestamps[index])} y={height - 8} textAnchor={index === 0 ? "start" : index === data.timestamps.length - 1 ? "end" : "middle"} className={styles.tick}>{formatTimeTick(data.timestamps[index], timeSpan)}</text>)}
      </svg>
      {inspection.active && inspection.detailsEnabled && <Inspector id={id} observation={inspection.active.observation} pinned={inspection.active.pinned} decimals={widget.options?.decimals} onClose={inspection.dismiss} onPin={() => inspection.active?.pinned ? inspection.dismiss() : inspection.show(inspection.active!.observation, true)} />}
    </div>
    <div className={styles.heatmapFooter}>
    {widget.options?.showLegend !== false && <div className={styles.densityLegend} aria-label={`Color encodes bucket ${densityUnit}`}><span>0</span><div>{densityPalette.map(color => <i key={color} style={{ background: color }} />)}</div><span>{formatMetric(data.max, densityUnit, false, widget.options?.decimals)}</span><span className={styles.unknownKey}>Missing</span></div>}
    <Notices truncated={result.truncated}>{data.groups > 1 && <span>Sum of {data.groups} compatible histograms</span>}{data.invalidCells > 0 && <span>{data.invalidCells} non-monotonic or negative bucket observations omitted</span>}{data.omittedBuckets > 0 && <span>{data.omittedBuckets} higher buckets not shown</span>}{data.sampled && <span>Sampled timestamps · gaps retained</span>}</Notices>
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
  const data = useMemo(() => buildMetricPlot(result.series ?? [], config, directional), [result, config, directional]);
  const { root: inspectionRoot, ...inspection } = useInspection(props, signature), { ref, width, height } = useSize(), id = useId();
  const sharedCursor = useChartCursor();
  const { showAxis, descriptionId } = useWidgetPresentation();
  const domain = data.domain, minTime = data.timestamps[0] ?? 0, span = (data.timestamps.at(-1) ?? minTime) - minTime;
  const ticks = Array.from({ length: height < 150 ? 3 : 5 }, (_, index) => domain[0] + index * (domain[1] - domain[0]) / (height < 150 ? 2 : 4));
  const tickLabels = ticks.map(value => formatMetric(value, widget.unit, true, widget.options?.decimals));
  const gutter = useAxisGutter(tickLabels, ref, width);
  const left = showAxis ? gutter : 4, right = 12, top = showAxis ? 14 : 4, bottom = showAxis ? 29 : 4;
  const plotWidth = Math.max(1, width - left - right), plotHeight = Math.max(1, height - top - bottom);
  const x = (timestamp: number) => left + (span ? (timestamp - minTime) / span : .5) * plotWidth;
  const cursorTime = inspection.enabled && sharedCursor && sharedCursor.timestamp >= minTime && sharedCursor.timestamp <= minTime + span ? sharedCursor.timestamp : inspection.active?.observation.timestamp;
  const y = (value: number) => top + (domain[1] - value) / (domain[1] - domain[0]) * plotHeight;
  const color = (index: number) => index === 0 && widget.color ? widget.color : palette[index % palette.length];
  const observation = (row: number, column: number): Observation => {
    const track = data.tracks[row], cell = track.cells[column];
    return { row, column, value: cell.value, timestamp: cell.timestamp, series: track.series, name: track.name, unit: widget.unit, color: color(row), note: directional ? "Outbound is drawn below zero; this is the original nonnegative observation." : cell.upper === null && cell.value !== null ? "Recorded value; the stack is unavailable because another series is missing at this timestamp." : "Original observation, not the cumulative stacked height." };
  };
  const locate = (event: PointerEvent<SVGSVGElement>) => {
    const point = coordinates(event, width, height);
    if (point.x < left || point.x > width - right || point.y < top || point.y > height - bottom) return;
    const column = data.timestamps.reduce((nearest, time, index) => Math.abs(x(time) - point.x) < Math.abs(x(data.timestamps[nearest]) - point.x) ? index : nearest, 0);
    let row = 0, distance = Infinity;
    data.tracks.forEach((track, index) => {
      const cell = track.cells[column]; if (cell.upper === null || cell.lower === null) return;
      const upper = y(cell.upper), lower = y(cell.lower);
      const next = directional ? Math.abs(point.y - upper) : point.y >= Math.min(upper, lower) && point.y <= Math.max(upper, lower) ? 0 : Math.min(Math.abs(point.y - upper), Math.abs(point.y - lower));
      if (next < distance) { row = index; distance = next; }
    });
    return observation(row, column);
  };
  const keys = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!inspection.enabled) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); inspection.dismiss(); return; }
    let row = inspection.active?.observation.row ?? 0, column = inspection.active?.observation.column ?? data.timestamps.length - 1;
    if (event.key === "ArrowRight") column++; else if (event.key === "ArrowLeft") column--;
    else if (event.key === "ArrowUp") row--; else if (event.key === "ArrowDown") row++;
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); inspection.show(observation(row, column), true); return; } else return;
    event.preventDefault(); inspection.show(observation(Math.max(0, Math.min(data.tracks.length - 1, row)), Math.max(0, Math.min(data.timestamps.length - 1, column))), !!inspection.active?.pinned);
  };
  if (!data.tracks.length || !data.timestamps.length) return <EmptyState />;
  const bars = !directional && "display" in config && config.display === "bar";
  const tableLegend = config.legendDisplay === "table";
  const legendRevision = JSON.stringify([widget.unit, widget.options?.decimals, config.legendDisplay, data.tracks.map(track => [track.name, track.cells.at(-1)?.value, track.statistics])]);
  const formatSummary = (value: number | null) => value === null ? "No data" : formatMetric(value, widget.unit, false, widget.options?.decimals);
  return <div className={`${styles.chart} ${styles.metricShell}`} ref={inspectionRoot} onPointerLeave={inspection.leave}>
    <div className={styles.metricContent} data-legend-position={widget.options?.showLegend === false ? "bottom" : config.legendPosition ?? "bottom"} data-legend-display={config.legendDisplay ?? "compact"}>
    <div className={styles.plot} ref={ref}>
      <svg className={styles.svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`${widget.title}. ${directional ? "Outbound traffic below zero" : "Stacked observations"}.${inspection.enabled ? " Arrow keys inspect values; Enter pins." : ""}`} tabIndex={inspection.enabled ? 0 : undefined} aria-describedby={inspection.active && inspection.detailsEnabled ? id : descriptionId} onKeyDown={keys}
        onFocus={() => { if (inspection.enabled && !inspection.active) inspection.show(observation(0, data.timestamps.length - 1)); }}
        onPointerMove={event => { const value = locate(event); if (value && event.pointerType !== "touch") inspection.show(value); }}
        onClick={event => { const value = locate(event as unknown as PointerEvent<SVGSVGElement>); if (value) inspection.show(value, true); }}>
        <defs><clipPath id={`${id}-clip`}><rect x={left} y={top} width={plotWidth} height={plotHeight} /></clipPath></defs>
        {ticks.map((value, index) => <g key={value}>{widget.options?.showGrid !== false && <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className={styles.gridLine} />}{showAxis && <text data-value-axis x={left - 7} y={y(value)} textAnchor="end" dominantBaseline="middle" className={styles.tick}>{tickLabels[index]}</text>}</g>)}
        <line x1={left} x2={width - right} y1={y(0)} y2={y(0)} className={styles.baseline} />
        <g clipPath={`url(#${id}-clip)`}>{data.tracks.map((track, index) => <g key={index} data-series={track.name}>
          {bars ? track.cells.map((cell, column) => {
            if (cell.upper === null || cell.lower === null) return null;
            const interval = Math.min(column ? x(cell.timestamp) - x(track.cells[column - 1].timestamp) : Infinity, column < track.cells.length - 1 ? x(track.cells[column + 1].timestamp) - x(cell.timestamp) : Infinity);
            const barWidth = Math.max(1, Math.min(36, Number.isFinite(interval) ? interval * .75 : plotWidth * .5));
            return <rect key={cell.timestamp} x={Math.max(left, Math.min(width - right - barWidth, x(cell.timestamp) - barWidth / 2))} y={Math.min(y(cell.lower), y(cell.upper))} width={barWidth} height={Math.max(cell.value === 0 ? 1 : .5, Math.abs(y(cell.upper) - y(cell.lower)))} fill={color(index)} fillOpacity={.82} data-raw-value={cell.value ?? "unknown"}><title>{track.name}: {formatMetric(cell.value!, widget.unit, false, widget.options?.decimals)} · {stamp(cell.timestamp)}</title></rect>;
          }) : segments(track.cells).map((segment, part) => {
            const forward = segment.map(cell => `${number(x(cell.timestamp))},${number(y(cell.upper!))}`), back = segment.toReversed().map(cell => `${number(x(cell.timestamp))},${number(y(cell.lower!))}`);
            return <g key={part}><path d={`M${forward.join("L")}L${back.join("L")}Z`} fill={color(index)} fillOpacity={directional ? .16 : .48} /><path d={`M${forward.join("L")}`} fill="none" stroke={color(index)} strokeWidth={widget.options?.lineWidth ?? 1.6} strokeLinejoin="round" />{segment.length === 1 && <circle cx={x(segment[0].timestamp)} cy={y(segment[0].upper!)} r={2.5} fill={color(index)} />}</g>;
          })}
        </g>)}</g>
        {cursorTime !== undefined && <line x1={x(cursorTime)} x2={x(cursorTime)} y1={top} y2={height - bottom} className={styles.crosshair} data-shared-cursor={cursorTime} />}
        {showAxis && timeTicks(data.timestamps, plotWidth).map(index => <text key={index} x={x(data.timestamps[index])} y={height - 8} textAnchor={index === 0 ? "start" : index === data.timestamps.length - 1 ? "end" : "middle"} className={styles.tick}>{formatTimeTick(data.timestamps[index], span)}</text>)}
      </svg>
      {inspection.active && inspection.detailsEnabled && <Inspector id={id} observation={inspection.active.observation} pinned={inspection.active.pinned} decimals={widget.options?.decimals} onClose={inspection.dismiss} onPin={() => inspection.active?.pinned ? inspection.dismiss() : inspection.show(inspection.active!.observation, true)} />}
    </div>
    {widget.options?.showLegend !== false && <SeriesLegend table={tableLegend} revision={legendRevision}>{tableLegend ? <table className={styles.legendTable}>
      <caption>Raw returned observations. Current is the latest sample, including missing values. Mean is the arithmetic mean of finite samples; max is the largest finite sample. Statistics use all returned samples before display sampling.</caption>
      <thead><tr><th scope="col">Series</th><th scope="col">Current</th><th scope="col">Mean</th><th scope="col">Max</th></tr></thead>
      <tbody>{data.tracks.map((track, index) => <tr key={index} data-legend-series={track.name}>
        <th scope="row"><span className={styles.legendTableName}><i aria-hidden="true" style={{ background: color(index) }} /><span title={track.name}>{track.name}</span></span></th>
        <td data-summary="current" data-value={track.statistics.current ?? "unknown"} title={track.statistics.currentTimestamp === null ? "No recorded sample" : `Latest sample · ${stamp(track.statistics.currentTimestamp)}`}>{formatSummary(track.statistics.current)}</td>
        <td data-summary="mean" data-value={track.statistics.mean ?? "unknown"} title={`Arithmetic mean of ${track.statistics.finiteSamples} finite samples (${track.statistics.totalSamples} returned)`}>{formatSummary(track.statistics.mean)}</td>
        <td data-summary="max" data-value={track.statistics.max ?? "unknown"} title={`Maximum of ${track.statistics.finiteSamples} finite samples`}>{formatSummary(track.statistics.max)}</td>
      </tr>)}</tbody>
    </table> : data.tracks.map((track, index) => {
      const latest = track.cells.at(-1); return <span className={styles.legendItem} key={index}><i style={{ background: color(index) }} /><span title={track.name}>{track.name}</span><b>{latest?.value == null ? "No data" : formatMetric(latest.value, widget.unit, false, widget.options?.decimals)}</b></span>;
    })}</SeriesLegend>}
    </div>
    <Notices truncated={result.truncated}>{data.omittedSeries > 0 && <span>{data.omittedSeries} series not shown</span>}{data.sampled && <span>Sampled timestamps · gaps retained</span>}{data.invalidValues > 0 && <span>{data.invalidValues} negative traffic observations omitted</span>}{!directional && data.tracks.some(track => track.cells.some(cell => cell.upper === null)) && <span>Incomplete timestamps leave gaps in the stack</span>}</Notices>
  </div>;
}

export function StackedTimeseries(props: WidgetRendererProps) { return <MetricPlot {...props} directional={false} />; }
export function DirectionalTraffic(props: WidgetRendererProps) { return <MetricPlot {...props} directional />; }

export function registerRichMetricPlugins() {
  if (!getWidgetDefinition("plugin", "distribution-heatmap")) registerWidgetPlugin({
    id: "distribution-heatmap", label: "Distribution heatmap", description: "Cumulative histogram buckets as density over time", dataKind: "metrics", render: DistributionHeatmap,
    styleControls: ["unit", "decimals", "legend", "tooltips"],
    defaultConfig: { bucketLabel: "le", densityUnit: "observations/s", aggregation: "none", maxBuckets: 24, maxColumns: 60 },
    configFields: [
      { key: "bucketLabel", label: "Bucket boundary label", kind: "text", placeholder: "le" },
      { key: "bucketUnit", label: "Bucket unit override", kind: "text", placeholder: "Widget unit", help: "Leave empty to use the widget unit; this only labels bucket boundaries, never density values." },
      { key: "densityUnit", label: "Density unit", kind: "text", help: "Use a query-side rate for per-second units. The chart only differences cumulative buckets." },
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
    defaultConfig: { directionLabel: "direction", outboundValue: "outbound", maxSeries: 8, maxPoints: 120, legendDisplay: "compact", legendPosition: "bottom" },
    configFields: [
      { key: "directionLabel", label: "Direction label", kind: "text", placeholder: "direction" },
      { key: "outboundValue", label: "Outbound label value", kind: "text", placeholder: "outbound", help: "Matching series are drawn below zero. Query values must be nonnegative." },
      { key: "legendDisplay", label: "Legend display", kind: "select", options: [{ value: "compact", label: "Compact latest values" }, { value: "table", label: "Current, mean and max table" }], help: "Table statistics preserve raw outbound values. Mean ignores missing values." },
      { key: "legendPosition", label: "Legend position", kind: "select", options: [{ value: "bottom", label: "Below the chart" }, { value: "right", label: "Right side" }], help: "Right-side legends move below the chart in narrow panels." },
      { key: "maxSeries", label: "Maximum series", kind: "number", min: 1, max: 12, step: 1 },
      { key: "maxPoints", label: "Maximum time columns", kind: "number", min: 12, max: 240, step: 1 },
    ], parseConfig: value => directionalConfigSchema.parse(value ?? {}),
  });
}

"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { z } from "zod";
import { EmptyState, MetricDetails, ObservationTooltip } from "../chart-renderers";
import { downsamplePoints, formatMetric, formatTimeTick, latestPoint, seriesName, type Point, type Series } from "../chart-data";
import { validTimestamp } from "../widget-context";
import { compactSeriesLabels } from "../series-display";
import { useEmbeddedWidget } from "../widget-presentation";
import { getWidgetDefinition, registerWidgetPlugin, type WidgetRendererProps } from "../widget-registry";
import type { QueryResult, Widget } from "../schema";
import styles from "./small-multiples.module.css";

const configSchema = z.strictObject({ maxSeries: z.number().int().min(1).max(12).optional(), columns: z.number().int().min(1).max(6).optional(), maxPoints: z.number().int().min(8).max(240).optional() });
const palette = ["var(--gamma-chart-1, #2867b9)", "var(--gamma-chart-2, #087f7a)", "var(--gamma-chart-3, #bb5037)", "var(--gamma-chart-4, #977017)", "var(--gamma-chart-5, #7c58ad)", "var(--gamma-chart-6, #427449)"];
const left = 2, right = 598, top = 8, bottom = 92;
type Domains = { start: number; end: number; min: number; max: number };

/** Shared axes derive from every returned observation, not only sampled marks. */
export function smallMultiplesDomains(series: readonly Series[], options: Widget["options"]): Domains | undefined {
  let start = Infinity, end = -Infinity, min = Infinity, max = -Infinity;
  for (const entry of series) for (const point of entry.points) {
    if (!validTimestamp(point.timestamp)) continue;
    start = Math.min(start, point.timestamp); end = Math.max(end, point.timestamp);
    if (typeof point.value === "number" && Number.isFinite(point.value)) { min = Math.min(min, point.value); max = Math.max(max, point.value); }
  }
  if (!Number.isFinite(start)) return;
  if (!Number.isFinite(min)) { min = 0; max = 1; }
  min = options?.min ?? min; max = options?.max ?? max;
  if (min >= max) { if (options?.min !== undefined) max = min + Math.max(1, Math.abs(min) * .1); else min = max - Math.max(1, Math.abs(max) * .1); }
  if (start === end) end = start + 1;
  return { start, end, min, max };
}
function coordinates(point: Point, domain: Domains) {
  const x = left + (point.timestamp - domain.start) / (domain.end - domain.start) * (right - left);
  const y = typeof point.value === "number" && Number.isFinite(point.value) ? bottom - (point.value - domain.min) / (domain.max - domain.min) * (bottom - top) : undefined;
  return { x, y };
}
export function smallMultiplesPath(points: readonly Point[], domain: Domains) {
  let drawing = false;
  return points.map(point => {
    const { x, y } = coordinates(point, domain);
    if (y === undefined) { drawing = false; return ""; }
    const command = drawing ? "L" : "M"; drawing = true;
    return `${command}${x.toFixed(2)},${y.toFixed(2)}`;
  }).filter(Boolean).join(" ");
}

function SmallMultiple({ entry, index, displayName, domain, widget, result, maxPoints, interactive, detailsEnabled, onContextChange }: { entry: Series; index: number; displayName: string; domain: Domains; widget: Widget; result: QueryResult; maxPoints: number; interactive: boolean; detailsEnabled: boolean; onContextChange: WidgetRendererProps["onContextChange"] }) {
  const points = useMemo(() => downsamplePoints(entry.points, maxPoints), [entry.points, maxPoints]);
  const name = seriesName(entry, index), latest = latestPoint(entry), color = index === 0 && widget.color ? widget.color : palette[index % palette.length];
  const id = useId(), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), interaction = useRef({ hovered: false, focused: false, panel: false });
  const [active, setActive] = useState<{ index: number; anchor: SVGSVGElement; pinned: boolean; revision: QueryResult }>();
  const current = active?.revision === result ? active : undefined;
  const selected = current ? points[current.index] : undefined;
  const clear = useCallback(() => clearTimeout(timer.current), []);
  const dismiss = useCallback(() => { clear(); interaction.current.panel = false; setActive(undefined); }, [clear]);
  const leave = useCallback(() => { clear(); timer.current = setTimeout(() => { const state = interaction.current; if (!state.hovered && !state.focused && !state.panel) setActive(previous => previous?.pinned ? previous : undefined); }, 180); }, [clear]);
  useEffect(() => clear, [clear]);
  const show = (pointIndex: number, anchor: SVGSVGElement, pin = false) => {
    if (!interactive || !points[pointIndex]) return;
    clear(); setActive(previous => previous?.pinned && !pin ? previous : { index: pointIndex, anchor, pinned: pin, revision: result });
  };
  const pointAt = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !points.length) return undefined;
    const x = (event.clientX - bounds.left) / bounds.width * 600;
    if (x < left || x > right) return undefined;
    const timestamp = domain.start + (x - left) / (right - left) * (domain.end - domain.start);
    if (timestamp < points[0].timestamp || timestamp > points[points.length - 1].timestamp) return undefined;
    return points.reduce((nearest, point, i) => Math.abs(point.timestamp - timestamp) < Math.abs(points[nearest].timestamp - timestamp) ? i : nearest, 0);
  };
  const select = (pointIndex: number, anchor: SVGSVGElement) => {
    const point = points[pointIndex]; if (!point) return;
    onContextChange?.({ labels: entry.labels, series: name, value: typeof point.value === "number" && Number.isFinite(point.value) ? point.value : null });
    if (current?.pinned && current.index === pointIndex) dismiss(); else show(pointIndex, anchor, true);
  };
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    const position = current?.index ?? Math.max(0, points.length - 1);
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault(); const next = position + (event.key === "ArrowRight" ? 1 : -1);
      show(Math.max(0, Math.min(points.length - 1, next)), event.currentTarget, !!current?.pinned);
    } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(position, event.currentTarget); }
  };
  const path = smallMultiplesPath(points, domain), coordinatesOfSelected = selected ? coordinates(selected, domain) : undefined;
  // A singleton observation has no line segment; draw it explicitly without
  // connecting it across missing samples.
  const isolated = points.flatMap((point, pointIndex) => {
    if (typeof point.value !== "number" || !Number.isFinite(point.value)) return [];
    const hasValue = (other: Point | undefined) => typeof other?.value === "number" && Number.isFinite(other.value);
    return !hasValue(points[pointIndex - 1]) && !hasValue(points[pointIndex + 1]) ? [coordinates(point, domain)] : [];
  });
  return <section className={styles.panel} data-multiple-series={name}>
    <div className={styles.heading}><span className={styles.name} title={name} aria-label={name}>{displayName}</span><span className={styles.value}>{latest ? formatMetric(latest.value, widget.unit, false, widget.options?.decimals) : "No data"}</span></div>
    <div className={styles.plotLayout}><div className={styles.yAxis} aria-hidden="true"><span>{formatMetric(domain.max, widget.unit, false, widget.options?.decimals)}</span><span>{formatMetric(domain.min, widget.unit, false, widget.options?.decimals)}</span></div>
    <svg className={styles.plot} viewBox="0 0 600 100" preserveAspectRatio="none" role="group" aria-label={`${name} trend. Shared scales.${interactive && points.length ? " Arrow keys inspect samples; Enter pins." : ""}`} aria-describedby={detailsEnabled && selected ? id : undefined} tabIndex={interactive && points.length ? 0 : undefined}
      data-domain-start={domain.start} data-domain-end={domain.end} data-domain-min={domain.min} data-domain-max={domain.max}
      onFocus={event => { interaction.current.focused = true; show(points.length - 1, event.currentTarget); }}
      onBlur={() => { interaction.current.focused = false; leave(); }} onKeyDown={onKey}
      onPointerMove={event => { if (event.pointerType === "touch") return; const point = pointAt(event); if (point !== undefined) { interaction.current.hovered = true; show(point, event.currentTarget); } else { interaction.current.hovered = false; leave(); } }}
      onPointerLeave={() => { interaction.current.hovered = false; leave(); }} onClick={event => { const point = pointAt(event as unknown as PointerEvent<SVGSVGElement>); if (point !== undefined) select(point, event.currentTarget); }}>
      <defs><clipPath id={`${id}-plot`}><rect x={left} y={top} width={right-left} height={bottom-top} /></clipPath></defs>
      {widget.options?.showGrid !== false && [top, (top + bottom) / 2, bottom].map(y => <line key={y} x1={left} x2={right} y1={y} y2={y} className={styles.gridLine} />)}
      <g clipPath={`url(#${id}-plot)`}><path d={path} className={styles.line} stroke={color} data-multiple-path="true" />
      {isolated.map(({x,y}, pointIndex) => <circle key={pointIndex} cx={x} cy={y} r="3" fill={color} className={styles.point} data-isolated-sample="true" />)}
      {coordinatesOfSelected?.y !== undefined && <circle cx={coordinatesOfSelected.x} cy={coordinatesOfSelected.y} r="3" fill={color} className={styles.point} />}</g>
    </svg>
    <div className={styles.xAxis} aria-hidden="true"><span>{formatTimeTick(domain.start, domain.end - domain.start)}</span><span>{formatTimeTick(domain.end, domain.end - domain.start)}</span></div></div>
    {detailsEnabled && current && selected && <ObservationTooltip id={id} anchor={current.anchor} avoidWidget pinned={current.pinned} onDismiss={dismiss} onEnter={() => { interaction.current.panel = true; clear(); }} onLeave={() => { interaction.current.panel = false; leave(); }}>
      <MetricDetails widget={widget} series={entry} index={index} point={selected} unit={widget.unit} decimals={widget.options?.decimals} description="Recorded sample" />
      <span className={styles.hint}>{current.pinned ? "Pinned · press Enter to close" : "Click or press Enter to keep open"} · Esc to close</span>
    </ObservationTooltip>}
  </section>;
}

export function SmallMultiples({ widget, result, embedded, onContextChange }: WidgetRendererProps) {
  const config = configSchema.parse(widget.config ?? {}), parentEmbedded = useEmbeddedWidget();
  const series = useMemo(() => (result.series ?? []).slice(0, config.maxSeries ?? 6), [result.series, config.maxSeries]);
  // Resolve names against all returned peers, not just visible panels, so an
  // omitted series cannot make a shortened identity ambiguous.
  const displayNames = useMemo(() => compactSeriesLabels(result.series ?? []), [result.series]);
  const domain = useMemo(() => smallMultiplesDomains(series, widget.options), [series, widget.options]);
  const scroll = useRef<HTMLDivElement>(null), grid = useRef<HTMLDivElement>(null), overflowId = useId();
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const viewport = scroll.current, content = grid.current;
    if (!viewport || !content) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setOverflow(viewport.scrollHeight > viewport.clientHeight + 1));
    };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(viewport); observer?.observe(content); window.addEventListener("resize", measure); measure();
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [domain, series.length, config.columns]);
  if (!domain || !series.length) return <EmptyState />;
  const interactive = !embedded && !parentEmbedded && (widget.options?.showTooltip !== false || !!onContextChange);
  const detailsEnabled = interactive && widget.options?.showTooltip !== false;
  const scrollKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || !["Home", "End", "PageUp", "PageDown"].includes(event.key)) return;
    event.preventDefault();
    const viewport = event.currentTarget, maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const next = event.key === "Home" ? 0 : event.key === "End" ? maximum : viewport.scrollTop + (event.key === "PageDown" ? viewport.clientHeight : -viewport.clientHeight);
    viewport.scrollTo({ top: Math.max(0, Math.min(maximum, next)), behavior: "instant" });
  };
  return <div className={styles.root}><div className={styles.scroll} ref={scroll} role="region" aria-label={`${widget.title} trends`} aria-describedby={overflow ? overflowId : undefined} tabIndex={overflow && !embedded && !parentEmbedded ? 0 : undefined} onKeyDown={scrollKeys}>
    <div className={styles.grid} ref={grid} style={{ "--multiple-columns": config.columns ?? 3 } as CSSProperties}>
      {series.map((entry, index) => <SmallMultiple key={index} entry={entry} index={index} displayName={displayNames[index]} domain={domain} widget={widget} result={result} maxPoints={config.maxPoints ?? 120} interactive={interactive} detailsEnabled={detailsEnabled} onContextChange={onContextChange} />)}
    </div></div><div className={styles.footer}><span>Shared time and value scales · latest valid readings</span>{overflow && <span id={overflowId}>Scroll to see all series</span>}{(result.series?.length ?? 0) > series.length && <span>Showing {series.length} of {result.series?.length} series</span>}{result.truncated && <span>Partial source response</span>}</div></div>;
}
export function registerSmallMultiplesPlugin() {
  if (!getWidgetDefinition("plugin", "small-multiples")) registerWidgetPlugin({ id: "small-multiples", label: "Small multiples", description: "Compare metric series using shared time and value scales", dataKind: "metrics", render: SmallMultiples,
    defaultConfig: { maxSeries: 6, columns: 3, maxPoints: 120 }, styleControls: ["unit", "decimals", "grid", "tooltips"],
    configFields: [{ key: "maxSeries", label: "Maximum series", kind: "number", min: 1, max: 12, step: 1 }, { key: "columns", label: "Columns", kind: "number", min: 1, max: 6, step: 1 }, { key: "maxPoints", label: "Maximum plotted samples", kind: "number", min: 8, max: 240, step: 1 }],
    parseConfig: config => configSchema.parse(config ?? {}) });
}

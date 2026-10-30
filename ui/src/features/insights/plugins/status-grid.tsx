"use client";

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { z } from "zod";
import { DEFAULT_HEATMAP_THRESHOLDS, EmptyState, MetricDetails, ObservationTooltip, exactMetric, seriesName, thresholdForValue } from "../chart-renderers";
import type { Point, Series } from "../chart-data";
import type { QueryResult } from "../schema";
import { validTimestamp } from "../widget-context";
import { useEmbeddedWidget } from "../widget-presentation";
import { getWidgetDefinition, registerWidgetPlugin, type WidgetRendererProps } from "../widget-registry";
import styles from "./status-grid.module.css";

export const statusGridConfigSchema = z.strictObject({ maxSeries: z.number().int().min(1).max(2048).optional() });

/** The current status is the newest recorded sample, even when it is null. */
export function latestStatusPoint(series: Series): Point | undefined {
  return series.points.reduce<Point | undefined>((latest, point) => validTimestamp(point.timestamp) && (!latest || point.timestamp >= latest.timestamp) ? point : latest, undefined);
}

export function StatusGrid({ widget, result, onContextChange, embedded }: WidgetRendererProps) {
  const config = statusGridConfigSchema.parse(widget.config ?? {}), parentEmbedded = useEmbeddedWidget();
  const interactive = !embedded && !parentEmbedded, detailsEnabled = interactive && widget.options?.showTooltip !== false;
  const id = useId(), grid = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const interaction = useRef({ hovered: false, focused: false, panel: false });
  const [keyboardIndex, setKeyboardIndex] = useState(0);
  const [overflow, setOverflow] = useState(false);
  const [state, setState] = useState<{ index: number; anchor: HTMLButtonElement; pinned: boolean; revision: QueryResult }>();
  const clearHide = useCallback(() => clearTimeout(timer.current), []);
  const dismiss = useCallback(() => { clearHide(); interaction.current.panel = false; setState(undefined); }, [clearHide]);
  const scheduleHide = useCallback(() => {
    clearHide(); timer.current = setTimeout(() => {
      const current = interaction.current;
      if (!current.hovered && !current.focused && !current.panel) setState(previous => previous?.pinned ? previous : undefined);
    }, 180);
  }, [clearHide]);
  useEffect(() => clearHide, [clearHide]);
  const all = result.series ?? [], selected = all.slice(0, config.maxSeries ?? 512);
  useEffect(() => {
    const element = scroll.current, content = grid.current;
    if (!element || !content) return;
    let stopped = false;
    const measure = () => { if (!stopped) setOverflow(element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 1); };
    measure();
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(measure); });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element); observer?.observe(content);
    return () => { stopped = true; cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [result, config.maxSeries]);
  if (!selected.length) return <EmptyState />;
  const thresholds = widget.options?.thresholds?.length ? widget.options.thresholds : DEFAULT_HEATMAP_THRESHOLDS;
  const cells = selected.map((entry, index) => {
    const point = latestStatusPoint(entry), value = typeof point?.value === "number" && Number.isFinite(point.value) ? point.value : undefined;
    return { entry, index, point, value, name: seriesName(entry, index), threshold: value === undefined ? undefined : thresholdForValue(value, thresholds) };
  });
  const active = detailsEnabled && state?.revision === result && state.index < cells.length ? state : undefined;
  const current = active ? cells[active.index] : undefined;
  const show = (index: number, anchor: HTMLButtonElement, pinned = false) => {
    if (!detailsEnabled) return;
    clearHide(); setState(previous => previous?.pinned && !pinned ? previous : { index, anchor, pinned, revision: result });
  };
  const tabIndex = Math.min(keyboardIndex, cells.length - 1);
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    const columns = Math.max(1, getComputedStyle(grid.current!).gridTemplateColumns.split(/\s+/).filter(Boolean).length);
    if (event.key === "ArrowLeft") next--;
    else if (event.key === "ArrowRight") next++;
    else if (event.key === "ArrowUp") next -= columns;
    else if (event.key === "ArrowDown") next += columns;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = cells.length - 1;
    else return;
    event.preventDefault(); next = Math.max(0, Math.min(cells.length - 1, next)); setKeyboardIndex(next);
    grid.current?.querySelector<HTMLButtonElement>(`[data-status-index="${next}"]`)?.focus();
  };
  const counts = thresholds.map(threshold => ({ ...threshold, count: cells.filter(cell => cell.threshold === threshold).length }));
  const unknown = cells.filter(cell => cell.value === undefined).length;
  return <div className={styles.wrapper}>
    {interactive && <span className={styles.srOnly} id={`${id}-keys`}>Use arrow keys to navigate monitors, and Enter or Space to keep details open.</span>}
    <div ref={scroll} className={styles.scroll} role="region" aria-label={`${widget.title} monitor statuses`} tabIndex={interactive && overflow ? 0 : undefined} aria-describedby={overflow ? `${id}-overflow` : undefined} data-status-overflow={overflow || undefined}>
      <div ref={grid} className={styles.grid} data-status-grid>
        {cells.map(cell => {
          const status = cell.value === undefined ? "Unknown" : cell.threshold?.label ?? "Observed";
          const label = `${cell.name}: ${cell.value === undefined ? "No data" : exactMetric(cell.value, widget.unit)} · ${status}`;
          const className = `${styles.cell} ${cell.value === undefined ? styles.unknown : ""}`;
          const color = cell.threshold?.color ?? widget.color ?? "var(--gamma-chart-2)";
          const style = cell.value === undefined ? undefined : { "--status-color": color } as CSSProperties;
          if (!interactive) return <span key={cell.index} className={className} style={style} role="img" aria-label={label} />;
          return <button key={cell.index} type="button" className={className} style={style} data-status-index={cell.index}
            data-status-value={cell.value ?? "unknown"} aria-label={label} aria-pressed={detailsEnabled ? active?.index === cell.index && active.pinned : undefined}
            aria-describedby={`${id}-keys${active?.index === cell.index ? ` ${id}` : ""}`} tabIndex={cell.index === tabIndex ? 0 : -1}
            onPointerEnter={event => { if (event.pointerType !== "touch") { interaction.current.hovered = true; show(cell.index,event.currentTarget); } }}
            onPointerLeave={() => { interaction.current.hovered = false; scheduleHide(); }}
            onFocus={event => { setKeyboardIndex(cell.index); interaction.current.focused = true; show(cell.index,event.currentTarget); }}
            onBlur={() => { interaction.current.focused = false; scheduleHide(); }} onKeyDown={event => navigate(event,cell.index)}
            onClick={event => { onContextChange?.({ labels:cell.entry.labels, value:cell.value ?? null, series:cell.name }); if (active?.pinned && active.index === cell.index) dismiss(); else show(cell.index,event.currentTarget,true); }} />;
        })}
      </div>
    </div>
    <div className={styles.footer}>
      <span>{cells.length} {cells.length === 1 ? "monitor" : "monitors"}</span>
      {overflow && <span id={`${id}-overflow`}>Scroll to see all monitors</span>}
      {widget.options?.showLegend !== false && <div role="group" aria-label="Monitor status legend" className={styles.legend}>
        {counts.map((threshold, index) => <span key={index}><i style={{ background:threshold.color }} />{threshold.label ?? `≥ ${exactMetric(threshold.value, widget.unit)}`} <b>{threshold.count}</b></span>)}
        <span><i className={styles.unknownKey} />Unknown <b>{unknown}</b></span>
      </div>}
      {all.length > cells.length && <span>Showing {cells.length} of {all.length}</span>}
      {result.truncated && <span>Partial source response</span>}
    </div>
    {current && active && <ObservationTooltip id={id} anchor={active.anchor} avoidWidget pinned={active.pinned} onDismiss={dismiss}
      onEnter={() => { interaction.current.panel = true; clearHide(); }} onLeave={() => { interaction.current.panel = false; scheduleHide(); }}>
      <MetricDetails series={current.entry} index={current.index} point={current.point} unit={widget.unit} decimals={widget.options?.decimals} description="Latest sample">
        <span>{current.value === undefined ? "Unknown" : current.threshold?.label ?? "Observed"}</span>
      </MetricDetails>
      <div className={styles.tooltipHint}>{active.pinned ? "Pinned · tap again to close" : "Click or tap to keep open"} · Esc to close</div>
    </ObservationTooltip>}
  </div>;
}

export function registerStatusGridPlugin() {
  if (!getWidgetDefinition("plugin", "status-grid")) registerWidgetPlugin({
    id:"status-grid", label:"Monitor status grid", description:"Compare the latest status of many monitors in a compact grid", dataKind:"metrics", render:StatusGrid,
    styleControls:["unit", "decimals", "legend", "tooltips"], defaultOptions:{ thresholds:DEFAULT_HEATMAP_THRESHOLDS }, defaultConfig:{ maxSeries:512 },
    configFields:[{key:"maxSeries",label:"Maximum monitors",kind:"number",min:1,max:2048,step:1,help:"Show up to this many returned series. Omitted monitors are counted below the grid."}],
    parseConfig:config => statusGridConfigSchema.parse(config ?? {}),
  });
}

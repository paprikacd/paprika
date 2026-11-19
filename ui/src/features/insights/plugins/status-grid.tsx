"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { z } from "zod";
import { DEFAULT_HEATMAP_THRESHOLDS, EmptyState, MetricDetails, ObservationTooltip, seriesName, thresholdForValue } from "../chart-renderers";
import { thresholdPaint } from "../status";
import { StatusChip, bandReading, statusStrokeLevel, statusStrokeStyle, useTrackSize } from "../status-chip";
import { formatMetricDetails, type Point, type Series } from "../chart-data";
import { formatBounds } from "../units";
import { compactSeriesLabels } from "../series-display";
import { TooltipPinHint } from "../tooltip-content";
import { occurrenceKeys } from "../tooltip-identity";
import { validTimestamp } from "../widget-context";
import { truncationNote } from "../truncation";
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
  // The cells that own the pointer and focus, not booleans: a preview closes only when its own cell is neither hovered nor focused.
  const interaction = useRef<{ hovered: HTMLButtonElement | null; focused: HTMLButtonElement | null; panel: boolean }>({ hovered: null, focused: null, panel: false });
  const [keyboardIndex, setKeyboardIndex] = useState(0);
  const [overflow, setOverflow] = useState(false);
  // The open cell is named by its series, so a refresh keeps the preview or pin on the same monitor with its new values.
  const [state, setState] = useState<{ key: string; anchor: HTMLButtonElement; pinned: boolean }>();
  const clearHide = useCallback(() => clearTimeout(timer.current), []);
  const dismiss = useCallback(() => { clearHide(); interaction.current.panel = false; setState(undefined); }, [clearHide]);
  const scheduleHide = useCallback(() => {
    clearHide(); timer.current = setTimeout(() => {
      const current = interaction.current;
      setState(previous => previous && !previous.pinned && !current.panel && current.hovered !== previous.anchor && current.focused !== previous.anchor ? undefined : previous);
    }, 180);
  }, [clearHide]);
  useEffect(() => clearHide, [clearHide]);
  const all = result.series ?? [], selected = all.slice(0, config.maxSeries ?? 512);
  // Duplicate names get an occurrence suffix, so a pin on the second "api" never resolves to the first.
  const keys = occurrenceKeys(selected.map((entry, index) => seriesName(entry, index)));
  // A monitor that left the result closes its preview, and a pin on it is released.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- a stale pin must be released once its monitor has left the result
  useEffect(() => { if (state && !keys.includes(state.key)) setState(undefined); }, [state, keys]);
  // The anchor follows its monitor when the grid reorders or re-renders.
  useLayoutEffect(() => {
    if (!state) return;
    const index = keys.indexOf(state.key);
    const element = index < 0 ? null : grid.current?.querySelector<HTMLButtonElement>(`[data-status-index="${index}"]`);
    if (element && element !== state.anchor) setState(previous => previous && previous.key === state.key ? { ...previous, anchor: element } : previous);
  }, [state, keys]);
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
  // Cells share one CSS size, so the first measured cell gives the frame gate the real size.
  const cellSize = useTrackSize(grid, "[data-status-grid] > *", result);
  if (!selected.length) return <EmptyState />;
  const thresholds = widget.options?.thresholds?.length ? widget.options.thresholds : DEFAULT_HEATMAP_THRESHOLDS;
  // Short names for the visible labels, aria text and heading; the full identity stays in Source details.
  const names = compactSeriesLabels(selected);
  const cells = selected.map((entry, index) => {
    const point = latestStatusPoint(entry), value = typeof point?.value === "number" && Number.isFinite(point.value) ? point.value : undefined;
    return { entry, index, point, value, name: names[index], threshold: value === undefined ? undefined : thresholdForValue(value, thresholds) };
  });
  const openIndex = detailsEnabled && state ? keys.indexOf(state.key) : -1;
  const active = openIndex >= 0 && state ? { ...state, index: openIndex } : undefined;
  const current = active ? cells[active.index] : undefined;
  const show = (index: number, anchor: HTMLButtonElement, pinned = false) => {
    if (!detailsEnabled) return;
    clearHide(); setState(previous => previous?.pinned && !pinned ? previous : { key: keys[index], anchor, pinned });
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
  // Legend bounds share one formatter, so neighbouring thresholds never print the same text.
  const legendBounds = formatBounds(thresholds.map(threshold => threshold.value), widget.unit, widget.options?.decimals);
  const legendBound = (index: number) => `≥ ${legendBounds[index]}`;
  return <div className={styles.wrapper}>
    {interactive && <span className={styles.srOnly} id={`${id}-keys`}>Use arrow keys to navigate monitors, and Enter or Space to keep details open.</span>}
    <div ref={scroll} className={styles.scroll} role="region" aria-label={`${widget.title} monitor statuses`} tabIndex={interactive && overflow ? 0 : undefined} aria-describedby={overflow ? `${id}-overflow` : undefined} data-status-overflow={overflow || undefined}>
      <div ref={grid} className={styles.grid} data-status-grid>
        {cells.map(cell => {
          const status = cell.value === undefined ? "Unknown" : bandReading(cell.threshold);
          const label = `${cell.name}: ${cell.value === undefined ? "No data" : formatMetricDetails(cell.value, widget.unit, widget.options?.decimals)} · ${status}`;
          const className = `${styles.cell} ${cell.value === undefined ? styles.unknown : ""}`;
          const color = thresholdPaint(cell.threshold) ?? widget.color ?? "var(--gamma-chart-2)";
          const style = cell.value === undefined ? undefined : { "--status-color": color, ...statusStrokeStyle(cell.threshold, cellSize) } as CSSProperties;
          const stroke = cell.value === undefined ? undefined : statusStrokeLevel(cell.threshold, cellSize);
          if (!interactive) return <span key={cell.index} className={className} style={style} data-status-stroke={stroke} role="img" aria-label={label} />;
          return <button key={cell.index} type="button" className={className} style={style} data-status-stroke={stroke} data-status-index={cell.index}
            data-status-value={cell.value ?? "unknown"} aria-label={label} aria-pressed={detailsEnabled ? active?.index === cell.index && active.pinned : undefined}
            aria-describedby={`${id}-keys${active?.index === cell.index ? ` ${id}` : ""}`} tabIndex={cell.index === tabIndex ? 0 : -1}
            onPointerEnter={event => { if (event.pointerType !== "touch") { interaction.current.hovered = event.currentTarget; show(cell.index,event.currentTarget); } }}
            onPointerLeave={event => { if (interaction.current.hovered === event.currentTarget) interaction.current.hovered = null; scheduleHide(); }}
            onFocus={event => { setKeyboardIndex(cell.index); interaction.current.focused = event.currentTarget; show(cell.index,event.currentTarget); }}
            onBlur={event => { if (interaction.current.focused === event.currentTarget) interaction.current.focused = null; scheduleHide(); }} onKeyDown={event => navigate(event,cell.index)}
            onClick={event => { onContextChange?.({ labels:cell.entry.labels, value:cell.value ?? null, series:seriesName(cell.entry, cell.index) }); if (active?.pinned && active.index === cell.index) dismiss(); else show(cell.index,event.currentTarget,true); }} />;
        })}
      </div>
    </div>
    <div className={styles.footer}>
      <span>{cells.length} {cells.length === 1 ? "monitor" : "monitors"}</span>
      {overflow && <span id={`${id}-overflow`}>Scroll to see all monitors</span>}
      {widget.options?.showLegend !== false && <div role="group" aria-label="Monitor status legend" className={styles.legend}>
        {counts.map((threshold, index) => <span key={index}>{threshold.status
          ? <StatusChip status={threshold.status} color={threshold.color} label={threshold.label ?? legendBound(index)} />
          : <><i style={{ background:thresholdPaint(threshold) }} />{threshold.label ?? legendBound(index)}</>} <b>{threshold.count}</b></span>)}
        <span><i className={styles.unknownKey} />Unknown <b>{unknown}</b></span>
      </div>}
      {all.length > cells.length && <span>Showing {cells.length} of {all.length}</span>}
      {truncationNote(result) && <span>{truncationNote(result)}</span>}
    </div>
    {current && active && <ObservationTooltip id={id} anchor={active.anchor} avoidWidget anchorOwnsHistoryKeys pinned={active.pinned} onDismiss={dismiss}
      onEnter={() => { interaction.current.panel = true; clearHide(); }} onLeave={() => { interaction.current.panel = false; scheduleHide(); }}>
      <MetricDetails widget={widget} series={current.entry} index={current.index} point={current.point} unit={widget.unit} decimals={widget.options?.decimals} subject={current.name} seriesLabel={widget.title} description="Latest sample">
        {current.value === undefined
          ? <span>No data</span>
          : current.threshold?.status
            ? <StatusChip status={current.threshold.status} color={current.threshold.color} label={current.threshold.label} />
            : <span>{current.threshold?.label ?? "Observed"}</span>}
      </MetricDetails>
      <TooltipPinHint pinned={active.pinned} />
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

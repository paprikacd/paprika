"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { z } from "zod";
import { EmptyState, MetricDetails, ObservationTooltip } from "../chart-renderers";
import { seriesName, type Series } from "../chart-data";
import type { QueryResult } from "../schema";
import { useEmbeddedWidget } from "../widget-presentation";
import { getWidgetDefinition, registerWidgetPlugin, type WidgetRendererProps } from "../widget-registry";
import { UTC_DAY, uptimeObservations, type ObservationDay } from "./uptime-observations";
import styles from "./uptime-views.module.css";

const configSchema = z.strictObject({ maxDays: z.number().int().min(7).max(366).optional(), maxSeries: z.number().int().min(1).max(24).optional() });
const defaultThresholds = [{ value: 0, color: "#e34b4b", label: "Down" }, { value: 1, color: "#36b96b", label: "Up" }];
const dayText = (day: number) => new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(day * UTC_DAY));
const monthText = (day: number) => new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", timeZone: "UTC" }).format(new Date(day * UTC_DAY));
const stateText = (day: ObservationDay) => day.kind === "unknown" ? "No recorded value" : day.kind === "mixed" ? "Mixed or incomplete observations" : day.label ?? "Observed";
type Active = { entry: Series; index: number; day: ObservationDay; anchor: HTMLButtonElement; pinned: boolean; revision: QueryResult };

function UptimeView({ widget, result, onContextChange, embedded, calendar }: WidgetRendererProps & { calendar: boolean }) {
  const config = configSchema.parse(widget.config ?? {});
  const source = useMemo(() => result.series ?? [], [result.series]);
  const thresholds = widget.options?.thresholds?.length ? widget.options.thresholds : defaultThresholds;
  const data = useMemo(() => uptimeObservations(source, thresholds, config.maxDays ?? 90, config.maxSeries ?? (calendar ? 1 : 8)), [source, thresholds, config.maxDays, config.maxSeries, calendar]);
  const parentEmbedded = useEmbeddedWidget(), interactive = !embedded && !parentEmbedded, detailsEnabled = interactive && widget.options?.showTooltip !== false;
  const id = useId(), root = useRef<HTMLDivElement>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const interaction = useRef({ hover: false, focus: false, panel: false });
  const [active, setActive] = useState<Active>();
  const [focusKey, setFocusKey] = useState("0-0");
  const open = active?.revision === result && detailsEnabled ? active : undefined;
  const clear = useCallback(() => clearTimeout(timer.current), []);
  const dismiss = useCallback(() => { clear(); interaction.current.panel = false; setActive(undefined); }, [clear]);
  const leave = useCallback(() => { clear(); timer.current = setTimeout(() => { if (!interaction.current.hover && !interaction.current.focus && !interaction.current.panel) setActive(previous => previous?.pinned ? previous : undefined); }, 180); }, [clear]);
  useEffect(() => clear, [clear]);
  if (!data.rows.length) return <EmptyState />;
  const show = (entry: Series, index: number, day: ObservationDay, anchor: HTMLButtonElement, pin = false) => {
    if (!detailsEnabled) return;
    clear(); setActive(previous => previous?.pinned && !pin ? previous : { entry, index, day, anchor, pinned: pin, revision: result });
  };
  const key = (row: number, day: number) => `${row}-${day}`;
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, row: number, index: number) => {
    let nextRow = row, nextIndex = index;
    if (event.key === "ArrowLeft") nextIndex--;
    else if (event.key === "ArrowRight") nextIndex++;
    else if (event.key === "ArrowUp") { if (calendar) nextIndex -= 7; else nextRow--; }
    else if (event.key === "ArrowDown") { if (calendar) nextIndex += 7; else nextRow++; }
    else return;
    event.preventDefault(); nextRow = Math.max(0, Math.min(data.rows.length - 1, nextRow));
    nextIndex = Math.max(0, Math.min(data.rows[nextRow].days.length - 1, nextIndex));
    const next = key(nextRow, nextIndex); setFocusKey(next); root.current?.querySelector<HTMLButtonElement>(`[data-uptime-key="${next}"]`)?.focus();
  };
  const cell = (entry: Series, day: ObservationDay, row: number, index: number) => {
    const name = seriesName(entry, row), state = stateText(day), label = `${name} · ${dayText(day.day)} UTC · ${state} · ${day.count} recorded samples`;
    const color = day.kind === "observed" ? day.color ?? widget.color ?? "var(--gamma-accent)" : undefined;
    const className = `${styles.cell} ${styles[day.kind]}`;
    if (!interactive) return <span key={day.day} className={className} title={label} style={{ backgroundColor: color }} />;
    const [focusedRow, focusedIndex] = focusKey.split("-").map(Number);
    const tabKey = data.rows[focusedRow]?.days[focusedIndex] ? focusKey : "0-0";
    return <button key={day.day} type="button" data-uptime-key={key(row,index)} data-uptime-day={day.day} data-uptime-state={day.kind} aria-label={label} aria-describedby={`${id}-help${open?.anchor.dataset.uptimeKey === key(row,index) ? ` ${id}` : ""}`} aria-pressed={detailsEnabled ? open?.pinned && open.anchor.dataset.uptimeKey === key(row,index) : undefined} tabIndex={tabKey === key(row,index) ? 0 : -1} className={className} style={{ backgroundColor: color }}
      onPointerEnter={event => { if (event.pointerType !== "touch") { interaction.current.hover = true; show(entry,row,day,event.currentTarget); } }}
      onPointerLeave={() => { interaction.current.hover = false; leave(); }}
      onFocus={event => { interaction.current.focus = true; setFocusKey(key(row,index)); show(entry,row,day,event.currentTarget); }}
      onBlur={() => { interaction.current.focus = false; leave(); }} onKeyDown={event => navigate(event,row,index)}
      onClick={event => { onContextChange?.({ labels: entry.labels, value: typeof day.latest?.value === "number" && Number.isFinite(day.latest.value) ? day.latest.value : null, series: name }); if (open?.pinned && open.anchor === event.currentTarget) dismiss(); else show(entry,row,day,event.currentTarget,true); }} />;
  };
  return <div className={styles.root} ref={root}>
    <span className={styles.srOnly} id={`${id}-help`}>Use arrow keys to move between days. Enter pins details; Escape closes them.</span>
    <div className={styles.scroll} role="region" aria-label={`${widget.title} observations`} tabIndex={interactive ? 0 : undefined}>
      {data.rows.map(({entry,days}, row) => <section key={row} className={calendar ? styles.calendarRow : styles.timelineRow} style={{"--uptime-days": days.length} as CSSProperties}>
        <div className={styles.rowHead}><strong title={seriesName(entry,row)}>{seriesName(entry,row)}</strong>{!calendar && <span>Latest displayed day: {stateText(days.at(-1)!)}</span>}</div>
        {calendar ? <div className={styles.months}>{Array.from(new Set(days.map(day => monthText(day.day)))).map(month => {
          const monthDays = days.map((day,index) => ({ day,index })).filter(item => monthText(item.day.day) === month);
          const date = new Date(monthDays[0].day.day * UTC_DAY), firstWeekday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).getUTCDay();
          const offset = firstWeekday + date.getUTCDate() - 1;
          return <div className={styles.month} key={month}><span className={styles.monthTitle}>{month}</span><div className={styles.calendarGrid}>{Array.from({length: offset}, (_,index) => <span key={`pad-${index}`} aria-hidden="true" />)}{monthDays.map(item => cell(entry,item.day,row,item.index))}</div></div>;
        })}</div> : <><div className={styles.timeline}>{days.map((day,index) => cell(entry,day,row,index))}</div><div className={styles.axis}><span>{dayText(days[0].day)}</span><span>{dayText(days.at(-1)!.day)} UTC</span></div></>}
      </section>)}
    </div>
    <div className={styles.footer}>{widget.options?.showLegend !== false && <div className={styles.legend} role="group" aria-label="Recorded day legend">{thresholds.map((threshold,index) => <span key={index}><i style={{ background: threshold.color }} />{threshold.label ?? `≥ ${threshold.value}`}</span>)}<span><i className={styles.mixed} />Mixed / incomplete</span><span><i className={styles.unknown} />No recorded value</span></div>}<span>Recorded observations · UTC days</span><span>Not a measured uptime percentage</span>{data.truncatedDays && <span>Showing latest {config.maxDays ?? 90} days</span>}{data.truncatedSeries && <span>Showing {data.rows.length} of {source.length} series</span>}{result.truncated && <span>Partial source response</span>}</div>
    {open && <ObservationTooltip id={id} anchor={open.anchor} avoidWidget pinned={open.pinned} onDismiss={dismiss} onEnter={() => { interaction.current.panel = true; clear(); }} onLeave={() => { interaction.current.panel = false; leave(); }}>
      <div className={styles.detail}><strong>{dayText(open.day.day)} UTC</strong><span>{stateText(open.day)}</span><span>{open.day.count} recorded sample{open.day.count === 1 ? "" : "s"}{open.day.missing ? ` · ${open.day.missing} missing` : ""}</span><span>Samples do not establish availability for the full day.</span></div>
      {open.day.latest && <MetricDetails series={open.entry} index={open.index} point={open.day.latest} unit={widget.unit} decimals={widget.options?.decimals} description="Latest recorded sample that day" />}
    </ObservationTooltip>}
  </div>;
}

export function UptimeCalendar(props: WidgetRendererProps) { return <UptimeView {...props} calendar />; }
export function UptimeTimeline(props: WidgetRendererProps) { return <UptimeView {...props} calendar={false} />; }
export function registerUptimeViews() {
  const fields = [
    { key: "maxDays", label: "Maximum days", kind: "number" as const, min: 7, max: 366, step: 1, help: "Days between recorded samples, grouped in UTC." },
    { key: "maxSeries", label: "Maximum series", kind: "number" as const, min: 1, max: 24, step: 1 },
  ];
  if (!getWidgetDefinition("plugin", "uptime-calendar")) registerWidgetPlugin({ id: "uptime-calendar", label: "Uptime calendar", description: "Daily recorded observations in a UTC calendar; does not infer uptime", dataKind: "metrics", render: UptimeCalendar, defaultConfig: { maxDays: 90, maxSeries: 1 }, defaultOptions: { thresholds: defaultThresholds }, configFields: fields, parseConfig: config => configSchema.parse(config ?? {}), styleControls: ["unit", "decimals", "legend", "tooltips"] });
  if (!getWidgetDefinition("plugin", "uptime-timeline")) registerWidgetPlugin({ id: "uptime-timeline", label: "Uptime timeline", description: "Daily recorded observations by series; does not infer uptime", dataKind: "metrics", render: UptimeTimeline, defaultConfig: { maxDays: 90, maxSeries: 8 }, defaultOptions: { thresholds: defaultThresholds }, configFields: fields, parseConfig: config => configSchema.parse(config ?? {}), styleControls: ["unit", "decimals", "legend", "tooltips"] });
}

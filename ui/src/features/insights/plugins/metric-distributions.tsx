"use client"

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { arc, pie } from "d3-shape"
import { z } from "zod"
import { EmptyState, MetricDetails, ObservationTooltip, formatMetric, seriesName, thresholdForValue } from "../chart-renderers"
import type { Point, Series } from "../chart-data"
import type { QueryResult } from "../schema"
import { validTimestamp } from "../widget-context"
import { TooltipInstructions } from "../tooltip-instructions"
import { useEmbeddedWidget } from "../widget-presentation"
import { compactSeriesLabels } from "../series-display"
import { getWidgetDefinition, registerWidgetPlugin, type WidgetRendererProps } from "../widget-registry"
import styles from "./records.module.css"
import historyStyles from "./status-history.module.css"
import tooltipStyles from "../chart-styles.module.css"
import { statusHistoryLayout } from "./status-history-data"

const pieConfig = z.strictObject({ donut: z.boolean().optional() })
const historyConfig = z.strictObject({ maxSeries: z.number().int().min(1).max(24).optional(), maxPoints: z.number().int().min(8).max(120).optional(), labelField: z.string().trim().min(1).max(128).optional(), showTimeAxis: z.boolean().optional(), segmented: z.boolean().optional() })

/** UTC ticks represent the observed chart domain, not invented samples. */
export function statusHistoryTicks(start: number, end: number) {
  const span = end - start
  if (!(span > 0)) return []
  const format: Intl.DateTimeFormatOptions = span >= 86400_000
    ? { timeZone: "UTC", month: "short", day: "numeric" }
    : span < 120_000 ? { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }
      : { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
  const formatter = new Intl.DateTimeFormat(undefined, format)
  return Array.from({ length: 5 }, (_, index) => {
    const timestamp = start + span * index / 4
    return { timestamp, label: formatter.format(timestamp) }
  })
}

export function MetricPie({ widget, result, onContextChange, embedded }: WidgetRendererProps) {
  const config = pieConfig.parse(widget.config ?? {})
  const parentEmbedded = useEmbeddedWidget(), interactive = !embedded && !parentEmbedded
  const detailsEnabled = interactive && widget.options?.showTooltip !== false
  const id = useId(), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const legendRef = useRef<HTMLDivElement>(null)
  const [legendOverflow,setLegendOverflow] = useState(false)
  const interaction = useRef({ hovered: false, focused: false, panel: false })
  const [state, setState] = useState<{ entry: Series; point: Point; index: number; anchor: SVGGElement; pinned: boolean; revision: QueryResult }>()
  const clearHide = useCallback(() => clearTimeout(timer.current), [])
  const dismiss = useCallback(() => { clearHide(); interaction.current.panel = false; setState(undefined) }, [clearHide])
  const scheduleHide = useCallback(() => {
    clearHide(); timer.current = setTimeout(() => {
      const current = interaction.current
      if (!current.hovered && !current.focused && !current.panel) setState(previous => previous?.pinned ? previous : undefined)
    }, 180)
  }, [clearHide])
  useEffect(() => clearHide, [clearHide])
  useEffect(() => {
    const element=legendRef.current
    if(!element)return
    const measure=()=>setLegendOverflow(element.scrollHeight>element.clientHeight+1)
    measure()
    const observer=typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    return ()=>observer?.disconnect()
  },[result,widget.options?.showLegend])
  const samples = useMemo(() => (result.series ?? []).map((series, index) => {
    const latest = series.points.filter(point => validTimestamp(point.timestamp)).reduce<(typeof series.points)[number] | undefined>((last, point) => !last || point.timestamp >= last.timestamp ? point : last, undefined)
    return { series, name: seriesName(series,index), latest }
  }), [result])
  const positive = samples.filter(sample => typeof sample.latest?.value === "number" && Number.isFinite(sample.latest.value) && sample.latest.value > 0)
  const active = detailsEnabled && state?.revision === result ? state : undefined
  const show = (entry: Series, point: Point, index: number, anchor: SVGGElement, pin = false) => {
    if (!detailsEnabled) return
    clearHide(); setState(previous => previous?.pinned && !pin ? previous : { entry, point, index, anchor, pinned: pin, revision: result })
  }
  if (!positive.length) return <EmptyState />
  // Normalizing before summation preserves finite relative shares even when
  // adding the original values would overflow to Infinity.
  const largest = positive.reduce((maximum,sample)=>Math.max(maximum,sample.latest!.value!),0)
  const weight = (value:number) => value / largest
  const slices = pie<(typeof positive)[number]>().value(sample => weight(sample.latest!.value!)).sort(null)(positive)
  const path = arc<(typeof slices)[number]>().innerRadius(config.donut === false ? 0 : 58).outerRadius(92).padAngle(.02).cornerRadius(2)
  const total = positive.reduce((sum,sample)=>sum+weight(sample.latest!.value!),0)
  const displayNames = compactSeriesLabels(positive.map(sample=>sample.series))
  return <div className={styles.wrapper}>
    <svg className={styles.treemap} viewBox="0 0 360 210" role="group" aria-label={widget.title}>{slices.map((slice,index) => {
      const sample = slice.data, formatted = formatMetric(sample.latest!.value!,widget.unit,false,widget.options?.decimals)
      const activate = (anchor: SVGGElement) => {
        if (!interactive) return
        onContextChange?.({ labels:sample.series.labels, value:sample.latest!.value!, series:sample.name, timestamp:sample.latest!.timestamp })
        if (active?.pinned && active.anchor === anchor) dismiss()
        else show(sample.series,sample.latest!,index,anchor,true)
      }
      const actionable = interactive && (detailsEnabled || !!onContextChange)
      return <g key={index} role={actionable ? "button" : "img"} tabIndex={actionable ? 0 : undefined} aria-label={`${sample.name}: ${formatted}`} aria-describedby={active?.anchor.dataset.pieIndex === String(index) ? id : undefined} aria-pressed={detailsEnabled ? !!(active?.pinned && active.anchor.dataset.pieIndex === String(index)) : undefined} data-pie-index={index} data-pie-value={sample.latest!.value!} data-pie-timestamp={sample.latest!.timestamp}
        onPointerEnter={event => { if (event.pointerType !== "touch") { interaction.current.hovered = true; show(sample.series,sample.latest!,index,event.currentTarget) } }}
        onPointerLeave={() => { interaction.current.hovered = false; scheduleHide() }}
        onFocus={event => { interaction.current.focused = true; show(sample.series,sample.latest!,index,event.currentTarget) }}
        onBlur={() => { interaction.current.focused = false; scheduleHide() }}
        onClick={event => activate(event.currentTarget)}
        onKeyDown={event => { if (event.key === "Enter" || event.key === " ") {event.preventDefault();activate(event.currentTarget)} }}><path transform="translate(180 105)" d={path(slice) ?? ""} fill={`var(--record-color-${index%6})`} stroke="var(--gamma-border)" strokeWidth={.5}/></g>
    })}</svg>
    {active && <ObservationTooltip id={id} anchor={active.anchor} avoidWidget pinned={active.pinned} onDismiss={dismiss} onEnter={() => { interaction.current.panel = true; clearHide() }} onLeave={() => { interaction.current.panel = false; scheduleHide() }}><MetricDetails series={{...active.entry,name:positive[active.index].name}} index={active.index} point={active.point} unit={widget.unit} decimals={widget.options?.decimals} description="Latest observation" timestampFirst>{total > 0 && <span>Share of positive observations: {formatMetric(weight(active.point.value!) / total * 100,"%",false,widget.options?.decimals)}</span>}</MetricDetails><div className={tooltipStyles.tooltipFooter}><small>{active.pinned ? "Pinned · select again to close" : "Click, tap or press Enter to keep open"}</small><small><TooltipInstructions /></small></div></ObservationTooltip>}
    {widget.options?.showLegend !== false && <><div ref={legendRef} className={`${styles.legend} ${styles.pieLegend}`} role="region" aria-label={`Legend for ${widget.title}`} tabIndex={legendOverflow ? 0 : undefined}>{positive.map((sample,index) => <span key={index} role="group" title={sample.name} aria-label={`${sample.name}: ${formatMetric(sample.latest!.value!,widget.unit,false,widget.options?.decimals)}`}><i aria-hidden="true" style={{background:`var(--record-color-${index%6})`}} />{displayNames[index]} <b>{formatMetric(sample.latest!.value!,widget.unit,false,widget.options?.decimals)}</b></span>)}</div>{legendOverflow && <p className={styles.note}>Scroll the legend to see more series.</p>}</>}
    {positive.length < samples.length && <p className={styles.note}>{samples.length-positive.length} zero, missing or negative latest values have no slice area</p>}
    {result.truncated && <p className={styles.note}>Partial source response</p>}
  </div>
}

export function StatusHistory({ widget,result,onContextChange,embedded }: WidgetRendererProps) {
  const config = historyConfig.parse(widget.config ?? {}), maxSeries = config.maxSeries ?? 12, maxPoints = config.maxPoints ?? 60
  const series = useMemo(() => result.series ?? [], [result.series])
  const parentEmbedded = useEmbeddedWidget(), interactive = !embedded && !parentEmbedded
  const detailsEnabled = interactive && widget.options?.showTooltip !== false
  const id = useId(), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const interaction = useRef({ hovered: false, focused: false, panel: false })
  const [state, setState] = useState<{ entry: Series; point: Point; index: number; anchor: HTMLButtonElement; pinned: boolean; revision: QueryResult }>()
  const historyRef = useRef<HTMLDivElement>(null)
  const [keyboardKey, setKeyboardKey] = useState("0-0")
  const active = detailsEnabled && state?.revision === result ? state : undefined
  const clearHide = useCallback(() => clearTimeout(timer.current), [])
  const dismiss = useCallback(() => { clearHide(); interaction.current.panel = false; setState(undefined) }, [clearHide])
  const scheduleHide = useCallback(() => {
    clearHide(); timer.current = setTimeout(() => {
      const current = interaction.current
      if (!current.hovered && !current.focused && !current.panel) setState(previous => previous?.pinned ? previous : undefined)
    }, 180)
  }, [clearHide])
  useEffect(() => clearHide, [clearHide])
  const show = (entry: Series, point: Point, index: number, anchor: HTMLButtonElement, pin = false) => {
    if (!detailsEnabled) return
    clearHide(); setState(previous => previous?.pinned && !pin ? previous : { entry, point, index, anchor, pinned: pin, revision: result })
  }
  const thresholds = useMemo(() => widget.options?.thresholds ?? [], [widget.options?.thresholds])
  const data = useMemo(() => statusHistoryLayout(series.slice(0, maxSeries), maxPoints, thresholds), [series, maxSeries, maxPoints, thresholds])
  if (!data.rows.length) return <EmptyState />
  const keys = data.rows.flatMap((row, rowIndex) => row.cells.map((_, cellIndex) => `${rowIndex}-${cellIndex}`))
  const tabKey = keys.includes(keyboardKey) ? keyboardKey : keys[0]
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, rowIndex: number, cellIndex: number) => {
    const row = data.rows[rowIndex], current = row.cells[cellIndex]
    let nextRow = rowIndex, nextCell = cellIndex
    if (event.key === "ArrowLeft") nextCell = Math.max(0, cellIndex - 1)
    else if (event.key === "ArrowRight") nextCell = Math.min(row.cells.length - 1, cellIndex + 1)
    else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const direction = event.key === "ArrowUp" ? -1 : 1
      let candidate = rowIndex + direction
      while (candidate >= 0 && candidate < data.rows.length && !data.rows[candidate].cells.length) candidate += direction
      if (candidate >= 0 && candidate < data.rows.length) {
        nextRow = candidate
        nextCell = data.rows[candidate].cells.reduce((closest, cell, index, cells) =>
          Math.abs(cell.point.timestamp - current.point.timestamp) < Math.abs(cells[closest].point.timestamp - current.point.timestamp) ? index : closest, 0)
      }
    } else return
    event.preventDefault()
    const next = `${nextRow}-${nextCell}`
    setKeyboardKey(next)
    historyRef.current?.querySelector<HTMLButtonElement>(`[data-history-key="${next}"]`)?.focus()
  }
  const activeThreshold = active && typeof active.point.value === "number" ? thresholdForValue(active.point.value, thresholds) : undefined
  const hasMixed = data.rows.some(row => row.bridges.some(bridge => bridge.kind === "mixed"))
  const labelFor = (entry: Series, index: number) => (config.labelField && entry.labels?.[config.labelField]) || seriesName(entry,index)
  const ticks = config.showTimeAxis && data.domain ? statusHistoryTicks(data.domain.start, data.domain.end) : []
  return <div className={`${styles.wrapper} ${styles.historyWrapper}`}>{interactive && <span className={historyStyles.srOnly} id={`${id}-keys`}>Use arrow keys to move through history.</span>}<div className={styles.scroll} role="region" aria-label={`${widget.title} history`}><div ref={historyRef} className={`${styles.history} ${historyStyles.lanes}`}>{data.rows.map(({entry,cells,bridges},index) => {
    const name = labelFor(entry,index)
    const chars = Array.from(name), split = chars.length > 10 ? chars.length - 3 : chars.length
    return <div key={index} className={styles.historyRow} data-history-series={name}><strong title={name} aria-label={name} className={historyStyles.seriesLabel}><span aria-hidden="true">{chars.slice(0,split).join("")}</span>{split < chars.length && <span aria-hidden="true">{chars.slice(split).join("")}</span>}</strong><div className={`${styles.historyCells} ${historyStyles.cells}`} data-segmented={config.segmented || undefined}>{bridges.map((bridge,i) => bridge.kind === "gap" ? null : <span key={`band-${i}`} data-history-band={bridge.kind} className={`${historyStyles.band} ${bridge.kind === "mixed" ? historyStyles.mixed : ""}`} aria-hidden={bridge.kind === "stable" ? true : undefined} role={bridge.kind === "mixed" ? "img" : undefined} aria-label={bridge.kind === "mixed" ? `Changes, missing samples or duplicate timestamps from ${new Date(bridge.from).toLocaleString()} to ${new Date(bridge.to).toLocaleString()}` : undefined} style={{left:`${bridge.left}%`,width:`${bridge.width}%`,...(bridge.kind === "stable" && typeof bridge.value === "number" ? {background:thresholdForValue(bridge.value,thresholds)?.color ?? widget.color ?? "var(--gamma-accent, #53876a)"} : {})}} />)}{cells.map(({point,left,width},i) => {
      const finite = typeof point.value === "number" && Number.isFinite(point.value), threshold = finite ? thresholdForValue(point.value!,thresholds) : undefined
      const title = `${name} · ${new Date(point.timestamp).toLocaleString()} · ${finite ? formatMetric(point.value!,widget.unit,false,widget.options?.decimals) : "No data"}${threshold?.label ? ` · ${threshold.label}` : ""}`
      const color = finite ? threshold?.color ?? widget.color ?? "var(--gamma-accent, #53876a)" : undefined
      // Keep the portion of an endpoint mark that lies inside the time axis
      // as its actual hit area. A centered mark at 0% or 100% otherwise has
      // its center outside the clipped lane, making pointer activation fail.
      const visibleStart = Math.max(0, left - width / 2), visibleEnd = Math.min(100, left + width / 2)
      const edge = data.domain && data.domain.start !== data.domain.end ? point.timestamp === data.domain.start ? "start" : point.timestamp === data.domain.end ? "end" : undefined : undefined
      const position = { left: `${edge === "start" ? 0 : edge === "end" ? 100 : (visibleStart + visibleEnd) / 2}%`, width: `${Math.max(0, visibleEnd - visibleStart)}%`, ...(color ? { background: color } : {}) }
      if (!interactive) return <span key={i} aria-hidden="true" data-history-edge={edge} className={`${historyStyles.mark} ${finite ? "" : historyStyles.unknown}`} style={position} />
      return <button key={i} type="button" tabIndex={`${index}-${i}` === tabKey ? 0 : -1} aria-label={title} aria-describedby={`${id}-keys${active?.anchor?.dataset.historyKey === `${index}-${i}` ? ` ${id}` : ""}`} aria-pressed={detailsEnabled ? active?.pinned && active.anchor.dataset.historyKey === `${index}-${i}` : undefined} data-history-key={`${index}-${i}`} data-history-edge={edge} data-history-timestamp={point.timestamp} data-history-value={point.value ?? "unknown"} className={`${historyStyles.mark} ${finite ? "" : historyStyles.unknown}`} style={position}
        onPointerEnter={event => { if (event.pointerType !== "touch") { interaction.current.hovered = true; show(entry,point,index,event.currentTarget) } }}
        onPointerLeave={() => { interaction.current.hovered = false; scheduleHide() }}
        onFocus={event => { setKeyboardKey(`${index}-${i}`); interaction.current.focused = true; show(entry,point,index,event.currentTarget) }}
        onKeyDown={event => navigate(event,index,i)}
        onBlur={() => { interaction.current.focused = false; scheduleHide() }}
        onClick={event => { onContextChange?.({labels:entry.labels,value:finite ? point.value : null,series:name,timestamp:point.timestamp}); if (active?.pinned && active.anchor === event.currentTarget) dismiss(); else show(entry,point,index,event.currentTarget,true) }} />
    })}</div></div>
  })}</div></div>{ticks.length > 0 && <div className={historyStyles.timeAxis} role="group" aria-label="Status history time scale in UTC"><span>UTC</span><div className={historyStyles.tickRow}>{ticks.map((tick,index) => <time key={index} dateTime={new Date(tick.timestamp).toISOString()} title={new Date(tick.timestamp).toISOString()}>{tick.label}</time>)}</div></div>}<div className={`${styles.note} ${historyStyles.footer}`}>{widget.options?.showLegend !== false && <div className={historyStyles.legend} role="group" aria-label="Status history legend">{thresholds.map((threshold,index) => <span key={index}><i style={{background:threshold.color}} />{threshold.label ?? (index === 0 ? thresholds[1] ? `Below ${formatMetric(thresholds[1].value,widget.unit,false,widget.options?.decimals)}` : "All values" : `≥ ${formatMetric(threshold.value,widget.unit,false,widget.options?.decimals)}`)}</span>)}{!thresholds.length && <span><i style={{background:widget.color ?? "var(--gamma-accent, #53876a)"}} />Observed</span>}<span><i className={historyStyles.unknown} />Unknown</span>{hasMixed && <span><i className={historyStyles.mixed} />Mixed / uncertain</span>}</div>}<span title="Empty intervals are unobserved" aria-label="Earlier to latest; empty intervals are unobserved">Earlier → latest</span>{series.length > maxSeries ? <span>Sampled view · {Math.min(maxSeries,series.length)} of {series.length} series</span> : data.sampled && <span>Sampled</span>}{hasMixed && widget.options?.showLegend === false && <span>Striped intervals: mixed / uncertain</span>}{data.duplicateTimes && <span>Multiple observations share a timestamp</span>}{result.truncated && <span>Partial source response</span>}</div>
    {active && <ObservationTooltip id={id} anchor={active.anchor} avoidWidget pinned={active.pinned} onDismiss={dismiss} onEnter={() => { interaction.current.panel = true; clearHide() }} onLeave={() => { interaction.current.panel = false; scheduleHide() }}><MetricDetails series={{...active.entry,name:labelFor(active.entry,active.index)}} index={active.index} point={active.point} unit={widget.unit} decimals={widget.options?.decimals} description="Recorded sample">{activeThreshold?.label && <span>{activeThreshold.label}</span>}</MetricDetails><div className={historyStyles.legend}><span>{active.pinned ? "Pinned · tap again to close" : "Click or tap to keep open"}</span><TooltipInstructions /></div></ObservationTooltip>}
  </div>
}

export function registerMetricDistributionPlugins() {
  if (!getWidgetDefinition("plugin","pie")) registerWidgetPlugin({id:"pie",label:"Pie / donut",description:"Compare positive shares at the latest observation",dataKind:"metrics",render:MetricPie,parseConfig:config=>pieConfig.parse(config ?? {})})
  if (!getWidgetDefinition("plugin","status-history")) registerWidgetPlugin({id:"status-history",label:"Status history",description:"See recorded states over time, including unknown samples",dataKind:"metrics",render:StatusHistory,parseConfig:config=>historyConfig.parse(config ?? {}),configFields:[
    {key:"maxSeries",label:"Maximum series",kind:"number",min:1,max:24},
    {key:"maxPoints",label:"Maximum samples per series",kind:"number",min:8,max:120},
    {key:"labelField",label:"Series label field",kind:"text",help:"Optional metric label used to name each row; missing labels retain the series name."},
    {key:"showTimeAxis",label:"Show time axis",kind:"boolean",help:"Show the shared observed time domain in UTC."},
    {key:"segmented",label:"Separate samples",kind:"boolean",help:"Draw fine boundaries at each recorded sample."},
  ]})
}

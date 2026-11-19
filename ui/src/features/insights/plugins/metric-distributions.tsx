"use client"

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { arc, pie } from "d3-shape"
import { z } from "zod"
import { EmptyState, MetricDetails, ObservationTooltip, formatMetric, seriesName, thresholdForValue } from "../chart-renderers"
import { thresholdPaint } from "../status"
import { StatusChip, bandReading, statusStrokeLevel, statusStrokeStyle, useTrackSize } from "../status-chip"
import type { Point, Series } from "../chart-data"
import type { QueryResult, Threshold } from "../schema"
import { validTimestamp } from "../widget-context"
import { TooltipPinHint } from "../tooltip-content"
import { truncationNote } from "../truncation"
import { useEmbeddedWidget } from "../widget-presentation"
import { compactSeriesLabels } from "../series-display"
import { getWidgetDefinition, registerWidgetPlugin, type WidgetRendererProps } from "../widget-registry"
import styles from "./records.module.css"
import historyStyles from "./status-history.module.css"
import { useDashboardTimeZone } from "../dashboard-time-zone"
import { historyHitSlices, statusHistoryLayout } from "./status-history-data"
import { occurrenceKeys } from "../tooltip-identity"

const pieConfig = z.strictObject({ donut: z.boolean().optional() })
const historyConfig = z.strictObject({ maxSeries: z.number().int().min(1).max(24).optional(), maxPoints: z.number().int().min(8).max(120).optional(), labelField: z.string().trim().min(1).max(128).optional(), showTimeAxis: z.boolean().optional(), segmented: z.boolean().optional() })

/** Zoned ticks represent the observed chart domain, not invented samples. */
export function statusHistoryTicks(start: number, end: number, timeZone = "UTC") {
  const span = end - start
  if (!(span > 0)) return []
  const format: Intl.DateTimeFormatOptions = span >= 86400_000
    ? { timeZone, month: "short", day: "numeric" }
    : span < 120_000 ? { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }
      : { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
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
  // The elements that own the pointer and focus: a preview closes only when its own mark is neither hovered nor focused.
  const interaction = useRef<{ hovered: Element | null; focused: Element | null; panel: boolean }>({ hovered: null, focused: null, panel: false })
  const [state, setState] = useState<{ entry: Series; point: Point; index: number; anchor: SVGGElement; pinned: boolean; revision: QueryResult }>()
  const clearHide = useCallback(() => clearTimeout(timer.current), [])
  const dismiss = useCallback(() => { clearHide(); interaction.current.panel = false; setState(undefined) }, [clearHide])
  const scheduleHide = useCallback(() => {
    clearHide(); timer.current = setTimeout(() => {
      const current = interaction.current
      setState(previous => previous && !previous.pinned && !current.panel && current.hovered !== previous.anchor && current.focused !== previous.anchor ? undefined : previous)
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
        onPointerEnter={event => { if (event.pointerType !== "touch") { interaction.current.hovered = event.currentTarget; show(sample.series,sample.latest!,index,event.currentTarget) } }}
        onPointerLeave={event => { if (interaction.current.hovered === event.currentTarget) interaction.current.hovered = null; scheduleHide() }}
        onFocus={event => { interaction.current.focused = event.currentTarget; show(sample.series,sample.latest!,index,event.currentTarget) }}
        onBlur={event => { if (interaction.current.focused === event.currentTarget) interaction.current.focused = null; scheduleHide() }}
        onClick={event => activate(event.currentTarget)}
        onKeyDown={event => { if (event.key === "Enter" || event.key === " ") {event.preventDefault();activate(event.currentTarget)} }}><path transform="translate(180 105)" d={path(slice) ?? ""} fill={`var(--record-color-${index%6})`} stroke="var(--gamma-border)" strokeWidth={.5}/></g>
    })}</svg>
    {active && <ObservationTooltip id={id} anchor={active.anchor} avoidWidget pinned={active.pinned} onDismiss={dismiss} onEnter={() => { interaction.current.panel = true; clearHide() }} onLeave={() => { interaction.current.panel = false; scheduleHide() }}><MetricDetails widget={widget} series={{...active.entry,name:positive[active.index].name}} index={active.index} point={active.point} unit={widget.unit} decimals={widget.options?.decimals} description="Latest observation" timestampFirst>{total > 0 && <span>Share of positive observations: {formatMetric(weight(active.point.value!) / total * 100,"%",false,widget.options?.decimals)}</span>}</MetricDetails><TooltipPinHint pinned={active.pinned} /></ObservationTooltip>}
    {widget.options?.showLegend !== false && <><div ref={legendRef} className={`${styles.legend} ${styles.pieLegend}`} role="region" aria-label={`Legend for ${widget.title}`} tabIndex={legendOverflow ? 0 : undefined}>{positive.map((sample,index) => <span key={index} role="group" title={sample.name} aria-label={`${sample.name}: ${formatMetric(sample.latest!.value!,widget.unit,false,widget.options?.decimals)}`}><i aria-hidden="true" style={{background:`var(--record-color-${index%6})`}} />{displayNames[index]} <b>{formatMetric(sample.latest!.value!,widget.unit,false,widget.options?.decimals)}</b></span>)}</div>{legendOverflow && <p className={styles.note}>Scroll the legend to see more series.</p>}</>}
    {positive.length < samples.length && <p className={styles.note}>{samples.length-positive.length} zero, missing or negative latest values have no slice area</p>}
    {truncationNote(result) && <p className={styles.note}>{truncationNote(result)}</p>}
  </div>
}

/**
 * Contiguous samples in the same band form one run. A warning or critical run is framed once, so a continuous
 * period reads as one box rather than separate framed marks with broken stubs between them.
 */
function statusRuns(cells: readonly { point: Point; left: number; width: number }[], thresholds: readonly Threshold[]) {
  const runs: { threshold: Threshold; start: number; end: number; last: number }[] = []
  cells.forEach((cell, index) => {
    const value = cell.point.value
    const threshold = typeof value === "number" && Number.isFinite(value) ? thresholdForValue(value, thresholds) : undefined
    const start = Math.max(0, cell.left - cell.width / 2), end = Math.min(100, cell.left + cell.width / 2)
    const previous = runs.at(-1)
    if (!threshold) return
    if (previous && previous.threshold === threshold && previous.last === index - 1) { previous.end = end; previous.last = index }
    else runs.push({ threshold, start, end, last: index })
  })
  return runs
}

/** The series label a history row shows, from the configured label field when it is present. */
function historyLabel(entry: Series, index: number, labelField?: string) {
  return (labelField && entry.labels?.[labelField]) || seriesName(entry, index)
}
/** The row keys of the history rows: labels can repeat, so repeats are numbered and a pin stays on its own row. */
function historyRowKeys(entries: readonly Series[], labelField?: string) {
  return occurrenceKeys(entries.map((entry, index) => historyLabel(entry, index, labelField)))
}
/**
 * The stable identity of an open sample: its row key, its timestamp and its place among cells with that timestamp.
 * A refresh keeps the row and usually the timestamp; `findHistorySample` handles the rest.
 */
type HistoryIdentity = { row: string; timestamp: number; occurrence: number }
function historyIdentity(rowKeys: readonly string[], row: number, cells: readonly { point: Point }[], cell: number): HistoryIdentity {
  const timestamp = cells[cell].point.timestamp
  return { row: rowKeys[row], timestamp, occurrence: cells.slice(0, cell + 1).filter(({ point }) => point.timestamp === timestamp).length }
}
/**
 * Finds the open sample in the current rows: its exact timestamp, or, when a refresh moved every timestamp, the nearest
 * sample in the same row within half the row's cadence. Anything further away is no longer in the result.
 */
function findHistorySample(rows: readonly { entry: Series; cells: readonly { point: Point }[] }[], rowKeys: readonly string[], identity: HistoryIdentity) {
  const row = rowKeys.indexOf(identity.row)
  if (row < 0) return undefined
  const cells = rows[row].cells
  let cell = -1, seen = 0
  for (let index = 0; index < cells.length && cell < 0; index++) if (cells[index].point.timestamp === identity.timestamp && ++seen === identity.occurrence) cell = index
  if (cell < 0) {
    // The typical gap between samples is the median of the positive gaps. The smallest gap is not used: a first gap can be
    // much shorter than the rest (a partial first bucket), and a tolerance taken from it would drop a pin on any real refresh.
    const times = cells.map(({ point }) => point.timestamp).toSorted((a, b) => a - b)
    const gaps = times.slice(1).map((time, index) => time - times[index]).filter(gap => gap > 0).toSorted((a, b) => a - b)
    const cadence = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0
    let distance = Infinity
    cells.forEach(({ point }, index) => { const next = Math.abs(point.timestamp - identity.timestamp); if (next < distance) { distance = next; cell = index } })
    // A row with no measurable cadence (one sample, or only repeated timestamps) has nothing to re-find the sample by, so only an exact match counts.
    if (cell < 0 || distance > cadence / 2) return undefined
  }
  return { entry: rows[row].entry, point: cells[cell].point, index: row, cell }
}

export function StatusHistory({ widget,result,onContextChange,embedded }: WidgetRendererProps) {
  const timeZone = useDashboardTimeZone()
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(undefined, { timeZone, dateStyle: "medium", timeStyle: "medium" }), [timeZone])
  // A city/zone stays accurate when the historical range crosses a DST change.
  const zoneLabel = timeZone.split("/").at(-1)!.replaceAll("_", " ")
  const config = historyConfig.parse(widget.config ?? {}), maxSeries = config.maxSeries ?? 12, maxPoints = config.maxPoints ?? 60
  const series = useMemo(() => result.series ?? [], [result.series])
  const parentEmbedded = useEmbeddedWidget(), interactive = !embedded && !parentEmbedded
  const detailsEnabled = interactive && widget.options?.showTooltip !== false
  const id = useId(), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // The marks that own the pointer and focus: a preview closes only when its own sample is neither hovered nor focused.
  const interaction = useRef<{ hovered: HTMLButtonElement | null; focused: HTMLButtonElement | null; panel: boolean }>({ hovered: null, focused: null, panel: false })
  // The sample is named by its series label and timestamp, so a refresh keeps it open with its new value.
  const [state, setState] = useState<{ identity: HistoryIdentity; anchor: HTMLButtonElement; pinned: boolean }>()
  const historyRef = useRef<HTMLDivElement>(null)
  const [keyboardKey, setKeyboardKey] = useState("0-0")
  // The focused sample that shows a keyboard ring; the ring is its own element, above the run frame.
  const [ringKey, setRingKey] = useState<string>()
  // The measured track sizes each mark, so thin marks keep their fill and get no frame.
  const track = useTrackSize(historyRef, "[data-history-track]", result)
  const sizeOf = (percent: number) => track && { width: percent / 100 * track.width, height: track.height }
  const clearHide = useCallback(() => clearTimeout(timer.current), [])
  const dismiss = useCallback(() => { clearHide(); interaction.current.panel = false; setState(undefined) }, [clearHide])
  const scheduleHide = useCallback(() => {
    clearHide(); timer.current = setTimeout(() => {
      const current = interaction.current
      setState(previous => previous && !previous.pinned && !current.panel && current.hovered !== previous.anchor && current.focused !== previous.anchor ? undefined : previous)
    }, 180)
  }, [clearHide])
  useEffect(() => clearHide, [clearHide])
  const labelOf = (entry: Series, index: number) => historyLabel(entry, index, config.labelField)
  const show = (identity: HistoryIdentity, anchor: HTMLButtonElement, pin = false) => {
    if (!detailsEnabled) return
    clearHide(); setState(previous => previous?.pinned && !pin ? previous : { identity, anchor, pinned: pin })
  }
  const thresholds = useMemo(() => widget.options?.thresholds ?? [], [widget.options?.thresholds])
  // Not memoised: the layout is cheap, and the hover and pin lookups below read it on every render.
  const data = statusHistoryLayout(series.slice(0, maxSeries), maxPoints, thresholds)
  // A sample that left the result closes its preview and releases its pin; a sample that stays keeps its anchor on the current mark.
  const labelField = config.labelField
  const rowKeys = historyRowKeys(data.rows.map(row => row.entry), labelField)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- a stale pin must be released once its sample has left the result
  useEffect(() => { if (state && !findHistorySample(data.rows, rowKeys, state.identity)) setState(undefined) }, [state, data, rowKeys])
  // The anchor and the identity follow the sample: after a refresh the identity records the timestamp it resolved to, so the next refresh resolves from there.
  useLayoutEffect(() => {
    const found = state && findHistorySample(data.rows, rowKeys, state.identity)
    if (!state || !found) return
    const element = historyRef.current?.querySelector<HTMLButtonElement>(`[data-history-key="${found.index}-${found.cell}"]`)
    const identity = historyIdentity(rowKeys, found.index, data.rows[found.index].cells, found.cell)
    const moved = identity.timestamp !== state.identity.timestamp || identity.occurrence !== state.identity.occurrence
    if ((element && element !== state.anchor) || moved) setState(previous => previous && previous.identity === state.identity ? { ...previous, identity, anchor: element ?? previous.anchor } : previous)
  }, [state, data, rowKeys])
  const located = detailsEnabled && state ? findHistorySample(data.rows, rowKeys, state.identity) : undefined
  const active = located && state ? { entry: located.entry, point: located.point, index: located.index, cell: located.cell, anchor: state.anchor, pinned: state.pinned } : undefined
  if (!data.rows.length) return <EmptyState />
  const keys = data.rows.flatMap((row, rowIndex) => row.cells.map((_, cellIndex) => `${rowIndex}-${cellIndex}`))
  const tabKey = keys.includes(keyboardKey) ? keyboardKey : keys[0]
  // A focus ring for the focused sample in this row: a tile-coloured gap, then a text-coloured ring, outside the fill.
  const focusRing = (row: number, cells: readonly { left: number; width: number }[]) => {
    if (!ringKey?.startsWith(`${row}-`)) return null
    const cell = cells[Number(ringKey.slice(ringKey.indexOf("-") + 1))]
    if (!cell) return null
    const start = Math.max(0, cell.left - cell.width / 2), end = Math.min(100, cell.left + cell.width / 2)
    return <span aria-hidden="true" data-history-focus-ring="" className={historyStyles.focusRing} style={{ left: `${start}%`, width: `${end - start}%` }} />
  }
  const runFrames = (cells: readonly { point: Point; left: number; width: number }[]) => statusRuns(cells, thresholds).flatMap(run => {
    const size = sizeOf(run.end - run.start), level = statusStrokeLevel(run.threshold, size)
    return level ? [<span key={`run-${run.start}`} aria-hidden="true" data-status-run={level} data-status-stroke={level} className={historyStyles.run}
      style={{ left: `${run.start}%`, width: `${run.end - run.start}%`, ...statusStrokeStyle(run.threshold, size) }} />] : []
  })
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
  const labelFor = labelOf
  const legendLabel = (threshold: Threshold, index: number) => threshold.label ?? (index === 0 ? thresholds[1] ? `Below ${formatMetric(thresholds[1].value,widget.unit,false,widget.options?.decimals)}` : "All values" : `≥ ${formatMetric(threshold.value,widget.unit,false,widget.options?.decimals)}`)
  const ticks = config.showTimeAxis && data.domain ? statusHistoryTicks(data.domain.start, data.domain.end, timeZone) : []
  // An endpoint sample sits on its time-axis edge; any other sample is centred on its own interval.
  const markEdge = (point: Point) => data.domain && data.domain.start !== data.domain.end ? point.timestamp === data.domain.start ? "start" : point.timestamp === data.domain.end ? "end" : undefined : undefined
  const markGeometry = (point: Point, left: number, width: number) => {
    const visibleStart = Math.max(0, left - width / 2), visibleEnd = Math.min(100, left + width / 2), edge = markEdge(point)
    const centre = edge === "start" ? 0 : edge === "end" ? 100 : (visibleStart + visibleEnd) / 2
    return { edge, centre, width: visibleEnd - visibleStart }
  }
  // Each sample's pointer target is a lane slice that never overlaps a neighbour's, so the element under a
  // sample's centre or inside its drawn edges belongs to that sample.
  const hitSlicesFor = (cells: readonly { point: Point; left: number; width: number }[]) => {
    if (!track || !interactive) return []
    const toPx = (percent: number) => percent / 100 * track.width
    return historyHitSlices(cells.map(({ point, left, width }) => { const mark = markGeometry(point, left, width); return { centre: toPx(mark.centre), halfWidth: Math.max(3, toPx(mark.width) / 2) } }), track.width)
  }
  // A sample's pointer slice is a child of its button, so the button is the anchor for every pointer that lands on the
  // slice: a click toggles the pin, and the outside-click dismissal never fires for it. The slice is placed in the
  // button's own box (see .mark: centred, or pinned to an endpoint edge; min-width 2px at an endpoint, 1px otherwise).
  const hitStyle = (slice: { start: number; end: number }, mark: { centre: number; width: number }, edge: string | undefined) => {
    const centre = track ? mark.centre / 100 * track.width : 0, boxWidth = track ? Math.max(mark.width / 100 * track.width, edge ? 2 : 1) : 0
    const boxLeft = edge === "start" ? centre : edge === "end" ? centre - boxWidth : centre - boxWidth / 2
    return { left: slice.start - boxLeft, width: Math.max(0, slice.end - slice.start) }
  }
  return <div className={`${styles.wrapper} ${styles.historyWrapper}`}>{interactive && <span className={historyStyles.srOnly} id={`${id}-keys`}>Use arrow keys to move through history.</span>}<div className={styles.scroll} role="region" aria-label={`${widget.title} history`}><div ref={historyRef} className={`${styles.history} ${historyStyles.lanes}`}>{data.rows.map(({entry,cells,bridges},index) => {
    const name = labelFor(entry,index)
    const hits = hitSlicesFor(cells)
    const chars = Array.from(name), split = chars.length > 10 ? chars.length - 3 : chars.length
    return <div key={index} className={styles.historyRow} data-history-series={name}><strong title={name} aria-label={name} className={historyStyles.seriesLabel}><span aria-hidden="true">{chars.slice(0,split).join("")}</span>{split < chars.length && <span aria-hidden="true">{chars.slice(split).join("")}</span>}</strong><div className={`${styles.historyCells} ${historyStyles.cells}`} data-history-track="" data-segmented={config.segmented || undefined}>{bridges.map((bridge,i) => bridge.kind === "gap" ? null : <span key={`band-${i}`} data-history-band={bridge.kind} className={`${historyStyles.band} ${bridge.kind === "mixed" ? historyStyles.mixed : ""}`} aria-hidden={bridge.kind === "stable" ? true : undefined} role={bridge.kind === "mixed" ? "img" : undefined} aria-label={bridge.kind === "mixed" ? `Changes, missing samples or duplicate timestamps from ${dateFormat.format(bridge.from)} to ${dateFormat.format(bridge.to)}` : undefined} style={{left:`${bridge.left}%`,width:`${bridge.width}%`,...(bridge.kind === "stable" && typeof bridge.value === "number" ? {background:thresholdPaint(thresholdForValue(bridge.value,thresholds)) ?? widget.color ?? "var(--gamma-accent, #53876a)"} : {})}} />)}{cells.map(({point,left,width},i) => {
      const finite = typeof point.value === "number" && Number.isFinite(point.value), threshold = finite ? thresholdForValue(point.value!,thresholds) : undefined
      const title = `${name} · ${dateFormat.format(point.timestamp)} · ${finite ? formatMetric(point.value!,widget.unit,false,widget.options?.decimals) : "No data"}${threshold && bandReading(threshold, "") ? ` · ${bandReading(threshold, "")}` : ""}`
      const color = finite ? thresholdPaint(threshold) ?? widget.color ?? "var(--gamma-accent, #53876a)" : undefined
      // Keep the portion of an endpoint mark that lies inside the time axis
      // as its actual hit area. A centered mark at 0% or 100% otherwise has
      // its center outside the clipped lane, making pointer activation fail.
      const mark = markGeometry(point, left, width), edge = mark.edge
      const position = { left: `${mark.centre}%`, width: `${Math.max(0, mark.width)}%`, ...(color ? { background: color } : {}) }
      if (!interactive) return <span key={i} aria-hidden="true" data-history-edge={edge} className={`${historyStyles.mark} ${finite ? "" : historyStyles.unknown}`} style={position} />
      return <button key={i} type="button" tabIndex={`${index}-${i}` === tabKey ? 0 : -1} aria-label={title} aria-describedby={`${id}-keys${active?.index === index && active.cell === i ? ` ${id}` : ""}`} aria-pressed={detailsEnabled && active?.index === index && active.cell === i ? active.pinned : undefined} data-history-key={`${index}-${i}`} data-history-edge={edge} data-history-timestamp={point.timestamp} data-history-value={point.value ?? "unknown"} className={`${historyStyles.mark} ${finite ? "" : historyStyles.unknown}`} style={position}
        onPointerEnter={event => { if (event.pointerType !== "touch") { interaction.current.hovered = event.currentTarget; show(historyIdentity(rowKeys,index,cells,i),event.currentTarget) } }}
        onPointerLeave={event => { if (interaction.current.hovered === event.currentTarget) interaction.current.hovered = null; scheduleHide() }}
        onFocus={event => { setKeyboardKey(`${index}-${i}`); setRingKey(event.currentTarget.matches(":focus-visible") ? `${index}-${i}` : undefined); interaction.current.focused = event.currentTarget; show(historyIdentity(rowKeys,index,cells,i),event.currentTarget) }}
        onKeyDown={event => navigate(event,index,i)}
        onBlur={event => { setRingKey(undefined); if (interaction.current.focused === event.currentTarget) interaction.current.focused = null; scheduleHide() }}
        onClick={event => { onContextChange?.({labels:entry.labels,value:finite ? point.value : null,series:name,timestamp:point.timestamp}); if (active?.pinned && active.anchor === event.currentTarget) dismiss(); else show(historyIdentity(rowKeys,index,cells,i),event.currentTarget,true) }}>{hits[i] && <span aria-hidden="true" data-history-hit={`${index}-${i}`} className={historyStyles.hit} style={hitStyle(hits[i], mark, edge)} />}</button>
    })}{runFrames(cells)}{focusRing(index, cells)}</div></div>
  })}</div></div>{ticks.length > 0 && <div className={historyStyles.timeAxis} role="group" aria-label={`Status history time scale in ${timeZone}`}><span title={timeZone}>{zoneLabel}</span><div className={historyStyles.tickRow}>{ticks.map((tick,index) => <time key={index} dateTime={new Date(tick.timestamp).toISOString()} title={new Date(tick.timestamp).toISOString()}>{tick.label}</time>)}</div></div>}<div className={`${styles.note} ${historyStyles.footer}`}>{widget.options?.showLegend !== false && <div className={historyStyles.legend} role="group" aria-label="Status history legend">{thresholds.map((threshold,index) => <span key={index}>{threshold.status ? <StatusChip status={threshold.status} color={threshold.color} label={legendLabel(threshold,index)} /> : <><i style={{background:thresholdPaint(threshold)}} />{legendLabel(threshold,index)}</>}</span>)}{!thresholds.length && <span><i style={{background:widget.color ?? "var(--gamma-accent, #53876a)"}} />Observed</span>}<span><i className={historyStyles.unknown} />Unknown</span>{hasMixed && <span><i className={historyStyles.mixed} />Mixed / uncertain</span>}</div>}<span title="Empty intervals are unobserved" aria-label="Earlier to latest; empty intervals are unobserved">Earlier → latest</span>{series.length > maxSeries ? <span>Sampled view · {Math.min(maxSeries,series.length)} of {series.length} series</span> : data.sampled && <span>Sampled</span>}{hasMixed && widget.options?.showLegend === false && <span>Striped intervals: mixed / uncertain</span>}{data.duplicateTimes && <span>Multiple observations share a timestamp</span>}{truncationNote(result) && <span>{truncationNote(result)}</span>}</div>
    {active && <ObservationTooltip id={id} anchor={active.anchor} avoidWidget pinned={active.pinned} onDismiss={dismiss} onEnter={() => { interaction.current.panel = true; clearHide() }} onLeave={() => { interaction.current.panel = false; scheduleHide() }}><MetricDetails widget={widget} series={{...active.entry,name:labelFor(active.entry,active.index)}} index={active.index} point={active.point} unit={widget.unit} decimals={widget.options?.decimals} subject={labelFor(active.entry,active.index)} seriesLabel={widget.title} description="Recorded sample">{activeThreshold?.status ? <StatusChip status={activeThreshold.status} color={activeThreshold.color} label={activeThreshold.label} /> : activeThreshold?.label && <span>{activeThreshold.label}</span>}</MetricDetails><TooltipPinHint pinned={active.pinned} /></ObservationTooltip>}
  </div>
}

export function registerMetricDistributionPlugins() {
  if (!getWidgetDefinition("plugin","pie")) registerWidgetPlugin({id:"pie",label:"Pie / donut",description:"Compare positive shares at the latest observation",dataKind:"metrics",render:MetricPie,parseConfig:config=>pieConfig.parse(config ?? {}),styleControls:["decimals"]})
  if (!getWidgetDefinition("plugin","status-history")) registerWidgetPlugin({id:"status-history",label:"Status history",description:"See recorded states over time, including unknown samples",dataKind:"metrics",render:StatusHistory,parseConfig:config=>historyConfig.parse(config ?? {}),styleControls:["decimals"],configFields:[
    {key:"maxSeries",label:"Maximum series",kind:"number",min:1,max:24},
    {key:"maxPoints",label:"Maximum samples per series",kind:"number",min:8,max:120},
    {key:"labelField",label:"Series label field",kind:"text",help:"Optional metric label used to name each row; missing labels retain the series name."},
    {key:"showTimeAxis",label:"Show time axis",kind:"boolean",help:"Show the observed time domain in the dashboard timezone."},
    {key:"segmented",label:"Separate samples",kind:"boolean",help:"Draw fine boundaries at each recorded sample."},
  ]})
}

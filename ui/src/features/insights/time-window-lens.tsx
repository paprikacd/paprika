"use client"

import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from "react"
import type { Series } from "./chart-data"
import { formatMetricDetails, seriesName } from "./chart-data"
import { GammaButton } from "./gamma/button"
import { lockBodyScroll } from "./gamma/scroll-lock"
import { alignPriorPeriod, comparePriorPeriod, compareWindow, observationTimes, type ObservationWindow } from "./time-window"
import { useDashboardWindow } from "./dashboard-window"
import type { QueryResult } from "./schema"
import { validTimestamp } from "./widget-context"
import styles from "./time-window-lens.module.css"

type Props = { title: string; series: Series[]; unit: string; decimals?: number; zoom?: ObservationWindow; onZoom: (window: ObservationWindow) => void; onReset: () => void; onOverlay?: (window: ObservationWindow, result: QueryResult) => void; canOverlay?: (current: Series[], previous: Series[], window: ObservationWindow) => boolean; overlayUnavailable?: string; maxSeries?: number; seriesUnits?: readonly string[] }

export function TimeWindowLens(props: Props) {
  const [open, setOpen] = useState(false)
  // Match the caller’s plotting limit; hidden series must not determine
  // selectable windows that contain no displayed observations.
  const times = useMemo(() => observationTimes(props.series.slice(0, props.maxSeries ?? 12)), [props.series, props.maxSeries])
  if (times.length < 2) return null
  return <div className={styles.actions} data-window-lens>
    <GammaButton variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={`Compare window for ${props.title}`}>Compare window</GammaButton>
    {props.zoom && <GammaButton variant="ghost" size="sm" onClick={props.onReset}>Reset chart zoom</GammaButton>}
    {open && <WindowDialog {...props} times={times} onClose={() => setOpen(false)} />}
  </div>
}

function WindowDialog({ title, series, unit, decimals, zoom, onZoom, onOverlay, canOverlay, overlayUnavailable, maxSeries = 12, seriesUnits, onClose, times }: Props & { times: number[]; onClose: () => void }) {
  const id = useId(), dialog = useRef<HTMLDialogElement>(null), close = useRef<HTMLButtonElement>(null)
  const { apply, previous } = useDashboardWindow()
  const pending = useRef<AbortController | undefined>(undefined)
  const [savedPrior, setPrior] = useState<{ key: string; source: Series[]; fetch: typeof previous; state: "loading" | "ready" | "error"; data?: QueryResult; error?: string }>()
  const closest = (time: number) => times.reduce((best, value, index) => Math.abs(value - time) < Math.abs(times[best] - time) ? index : best, 0)
  const [start, setStart] = useState(() => zoom ? Math.min(closest(zoom.start), times.length - 2) : 0)
  const [end, setEnd] = useState(() => zoom ? Math.max(closest(zoom.end), 1) : times.length - 1)
  const [dragStart, setDragStart] = useState<number | null>(null)
  const [dragEnd, setDragEnd] = useState<number | null>(null)
  const selected = useMemo(() => ({ start: times[start], end: times[end] }), [times, start, end])
  const selectedKey = `${selected.start}:${selected.end}`
  const prior = savedPrior?.key === selectedKey && savedPrior.source === series && savedPrior.fetch === previous ? savedPrior : undefined
  useEffect(() => () => pending.current?.abort(), [selected.start, selected.end, previous])
  const priorComparison = useMemo(() => prior?.state === "ready" ? comparePriorPeriod(series.slice(0, maxSeries), prior.data?.series ?? [], selected) : [], [series, prior, selected, maxSeries])
  const overlayAvailable = useMemo(() => prior?.state === "ready" && (canOverlay ? canOverlay(series.slice(0, maxSeries), prior.data?.series ?? [], selected) : alignPriorPeriod(series.slice(0, maxSeries), prior.data?.series ?? [], selected).length > 0), [series, prior, selected, canOverlay, maxSeries])
  const loadPrevious = () => {
    if (!previous) return
    pending.current?.abort()
    const controller = new AbortController(); pending.current = controller
    setPrior({ key: selectedKey, source: series, fetch: previous, state: "loading" })
    previous(selected, controller.signal).then(data => { if (!controller.signal.aborted) setPrior({ key: selectedKey, source: series, fetch: previous, state: "ready", data }) }, error => { if (!controller.signal.aborted) setPrior({ key: selectedKey, source: series, fetch: previous, state: "error", error: error instanceof Error ? error.message : "Could not query the previous period." }) })
  }
  const setBounds = (nextStart: number, nextEnd: number) => {
    pending.current?.abort(); setPrior(undefined); setStart(nextStart); setEnd(nextEnd)
  }
  // Differences between percentages are percentage points; the separate
  // parenthesized figure is relative change from the first observation.
  const compared = useMemo(() => compareWindow(series.slice(0, maxSeries), { start: times[start], end: times[end] }), [series, times, start, end, maxSeries])
  const points = series.slice(0, 3).flatMap(entry => entry.points.filter(point => validTimestamp(point.timestamp) && typeof point.value === "number" && Number.isFinite(point.value)))
  const min = Math.min(...points.map(point => point.value!)), max = Math.max(...points.map(point => point.value!))
  const x = (time: number) => (time - times[0]) / (times.at(-1)! - times[0]) * 100
  const paths = series.slice(0, 3).map(entry => {
    const sorted = [...entry.points].sort((a, b) => a.timestamp - b.timestamp)
    let drawing = false
    return sorted.map(point => {
      if (point.value === null || !Number.isFinite(point.value) || !validTimestamp(point.timestamp)) { drawing = false; return "" }
      const position = `${x(point.timestamp).toFixed(2)} ${(32 - (point.value - min) / (max - min || 1) * 28).toFixed(2)}`
      const instruction = `${drawing ? "L" : "M"}${position}`; drawing = true; return instruction
    }).join(" ")
  })
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    const opener = document.activeElement, unlock = lockBodyScroll()
    element.showModal(); close.current?.focus()
    return () => { element.close(); unlock(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus() }
  }, [])
  const indexAt = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)))
    return closest(times[0] + fraction * (times.at(-1)! - times[0]))
  }
  const applyDrag = (index: number) => {
    if (dragStart === null) return
    const left = Math.min(dragStart, index), right = Math.max(dragStart, index)
    if (right > left) setBounds(left, right)
    setDragStart(null); setDragEnd(null)
  }
  const brushStart = dragStart === null || dragEnd === null ? start : Math.min(dragStart, dragEnd)
  const brushEnd = dragStart === null || dragEnd === null ? end : Math.max(dragStart, dragEnd)
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={event => event.stopPropagation()}>
    <div className={styles.header}><div><h2 id={`${id}-title`}>Compare a window</h2><span>{title}</span></div><GammaButton ref={close} variant="ghost" size="sm" onClick={onClose}>Close</GammaButton></div>
    <p id={`${id}-description`}>Drag across the overview or use the sliders. Comparisons use the first and last valid samples in the selected window; no missing values are interpolated.</p>
    <svg className={styles.overview} data-window-overview viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true" onPointerDown={event => { const index = indexAt(event); setDragStart(index); setDragEnd(index); event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={event => { if (dragStart !== null) setDragEnd(indexAt(event)) }} onPointerUp={event => applyDrag(indexAt(event))} onPointerCancel={() => { setDragStart(null); setDragEnd(null) }}>
      {paths.map((path, index) => <path key={index} d={path} className={styles.line} data-series={index} vectorEffect="non-scaling-stroke" />)}
      <rect x={x(times[brushStart])} width={Math.max(.2, x(times[brushEnd]) - x(times[brushStart]))} y="0" height="36" className={styles.selected} vectorEffect="non-scaling-stroke" />
    </svg>
    <div className={styles.controls}>
      <label>Window start <time dateTime={new Date(selected.start).toISOString()}>{new Date(selected.start).toLocaleString()}</time><input aria-label="Window start" aria-valuetext={new Date(selected.start).toLocaleString()} type="range" min={0} max={times.length - 2} value={start} onChange={event => setBounds(Math.min(Number(event.target.value), end - 1), end)} /></label>
      <label>Window end <time dateTime={new Date(selected.end).toISOString()}>{new Date(selected.end).toLocaleString()}</time><input aria-label="Window end" aria-valuetext={new Date(selected.end).toLocaleString()} type="range" min={1} max={times.length - 1} value={end} onChange={event => setBounds(start, Math.max(Number(event.target.value), start + 1))} /></label>
    </div>
    <div className={styles.tableScroll} role="region" aria-label="Window comparison" tabIndex={0}><table><thead><tr><th>Series</th><th>First sample</th><th>Last sample</th><th>Change</th></tr></thead><tbody>{compared.map(({ entry, start: first, end: last, delta, percent }, index) => {
      const seriesUnit = seriesUnits?.[index] ?? unit, deltaUnit = seriesUnit === "%" ? "pp" : seriesUnit
      const tiny = delta !== undefined && delta !== 0 && decimals !== undefined && Math.abs(delta) < .5 * 10 ** -decimals
      const relativeTiny = percent !== undefined && percent !== 0 && Math.abs(percent) < .005
      return <tr key={index}><th scope="row">{seriesName(entry, index)}</th><td data-label="First sample">{first ? <><span title={formatMetricDetails(first.value!, seriesUnit)} aria-label={`Exact first value ${formatMetricDetails(first.value!, seriesUnit)}`}>{formatMetricDetails(first.value!, seriesUnit, decimals)}</span><time dateTime={new Date(first.timestamp).toISOString()}>{new Date(first.timestamp).toLocaleString()}</time></> : "—"}</td><td data-label="Last sample">{last ? <><span title={formatMetricDetails(last.value!, seriesUnit)} aria-label={`Exact last value ${formatMetricDetails(last.value!, seriesUnit)}`}>{formatMetricDetails(last.value!, seriesUnit, decimals)}</span><time dateTime={new Date(last.timestamp).toISOString()}>{new Date(last.timestamp).toLocaleString()}</time></> : "—"}</td><td data-label="Change">{delta === undefined ? "Unavailable" : <span title={formatMetricDetails(delta, deltaUnit)} aria-label={`Exact change ${formatMetricDetails(delta, deltaUnit)}`}>{tiny ? `≈${formatMetricDetails(0, deltaUnit, decimals)}` : `${delta > 0 ? "+" : ""}${formatMetricDetails(delta, deltaUnit, decimals)}`}</span>}{percent !== undefined && <small title="Change divided by the absolute first value"> ({relativeTiny ? "≈0.00" : `${percent > 0 ? "+" : ""}${percent.toFixed(2)}`}%)</small>}</td></tr>
    })}</tbody></table></div>
    {previous && <section aria-label="Previous period comparison">
      <GammaButton variant="quiet" size="sm" onClick={loadPrevious} disabled={prior?.state === "loading"}>Compare previous period</GammaButton>
      {prior?.state === "loading" && <p role="status">Querying the preceding period…</p>}
      {prior?.state === "error" && <p role="alert">{prior.error}</p>}
      {prior?.state === "ready" && <><p>Latest valid recorded samples in this window and the immediately preceding window of equal duration. The preceding window ends before the selected start.</p>{prior.data?.truncated && <p role="status">Previous-period results are partial; some series may be unavailable.</p>}<div className={styles.tableScroll} role="region" aria-label="Previous period results" tabIndex={0}><table><thead><tr><th>Series</th><th>Previous</th><th>Selected</th><th>Change</th></tr></thead><tbody>{priorComparison.map(({ entry, prior: earlier, actual, delta, percent }, index) => {
        const seriesUnit = seriesUnits?.[index] ?? unit, deltaUnit = seriesUnit === "%" ? "pp" : seriesUnit
        const tiny = delta !== undefined && delta !== 0 && decimals !== undefined && Math.abs(delta) < .5 * 10 ** -decimals
        const relativeTiny = percent !== undefined && percent !== 0 && Math.abs(percent) < .005
        return <tr key={index}><th scope="row">{seriesName(entry, index)}</th><td data-label="Previous">{earlier ? <>{formatMetricDetails(earlier.value!, seriesUnit, decimals)}<time dateTime={new Date(earlier.timestamp).toISOString()}>{new Date(earlier.timestamp).toLocaleString()}</time></> : "Unavailable"}</td><td data-label="Selected">{actual ? <>{formatMetricDetails(actual.value!, seriesUnit, decimals)}<time dateTime={new Date(actual.timestamp).toISOString()}>{new Date(actual.timestamp).toLocaleString()}</time></> : "Unavailable"}</td><td data-label="Change">{delta === undefined ? "Unavailable" : <span title={formatMetricDetails(delta, deltaUnit)} aria-label={`Exact change ${formatMetricDetails(delta, deltaUnit)}`}>{tiny ? `≈${formatMetricDetails(0, deltaUnit, decimals)}` : `${delta > 0 ? "+" : ""}${formatMetricDetails(delta, deltaUnit, decimals)}`}</span>}{percent !== undefined && <small title="Change divided by the absolute previous value"> ({relativeTiny ? "≈0.00" : `${percent > 0 ? "+" : ""}${percent.toFixed(2)}`}%)</small>}</td></tr>
      })}</tbody></table></div>{onOverlay && <GammaButton variant="quiet" size="sm" disabled={!overlayAvailable} onClick={() => { if (prior.data) { onOverlay(selected, prior.data); onClose() } }}>Overlay previous period</GammaButton>}{onOverlay && overlayAvailable && <p>Overlay shifts prior samples to align the windows without interpolating. Inspect prior data for their recorded timestamps.</p>}{onOverlay && !overlayAvailable && <p role="status">{overlayUnavailable ?? "No uniquely matched previous series contain recorded values to overlay."}</p>}</>}
    </section>}
    <div className={styles.footer}><span>{apply ? "Zoom affects this chart only. Apply to dashboard updates all widgets without saving." : "Zoom affects this chart only."}</span>{apply && <GammaButton variant="quiet" size="sm" onClick={() => { apply(selected); onClose() }}>Apply to dashboard</GammaButton>}<GammaButton variant="primary" size="sm" onClick={() => { onZoom(selected); onClose() }}>Zoom chart to window</GammaButton></div>
  </dialog>
}

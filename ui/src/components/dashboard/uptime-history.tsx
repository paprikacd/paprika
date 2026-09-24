"use client"

import { useId, useState, type KeyboardEvent } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import type { SLOSummary } from "@/gen/paprika/v1/api_pb"
import styles from "./application-health.module.css"

export function durationSeconds(value: string): number {
  const units: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 }
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(d|h|m|s)/g)]
  if (parts.map((part) => part[0]).join("") !== value) return 0
  return parts.reduce((total, part) => total + Number(part[1]) * units[part[2]], 0)
}

export type UptimeInterval = {
  start: number; end: number; healthy: number; failed: number; unknown: number
  unobserved: number; state: "healthy" | "failed" | "partial" | "unknown"
}

// Match the controller's epoch-aligned buckets. Never interpolate aggregate
// counts into individual probes or count the pre-monitoring period as uptime.
export function uptimeIntervals(result: SLOSummary | undefined, window: string, now: number): UptimeInterval[] {
  const interval = Number(result?.intervalSeconds) || 30
  const count = Number(result?.expected) || Math.max(1, Math.floor((Number(result?.windowSeconds) || durationSeconds(window) || 2592000) / interval))
  const width = Math.max(1, Math.ceil(count / 60))
  const lastSlot = Math.floor(now / interval)
  const firstSlot = lastSlot - count + 1
  const firstBucket = Math.floor(firstSlot / width)
  const lastBucket = Math.floor(lastSlot / width)
  const reported = new Map(result?.timeline.map((bucket) => [Number(bucket.startedAt), bucket]))
  return Array.from({ length: lastBucket - firstBucket + 1 }, (_, index) => {
    const startSlot = (firstBucket + index) * width
    const start = Math.max(startSlot, firstSlot) * interval
    const end = Math.min((startSlot + width) * interval, now)
    const expected = Math.min(startSlot + width - 1, lastSlot) - Math.max(startSlot, firstSlot) + 1
    const bucket = reported.get(startSlot * interval)
    const healthy = Number(bucket?.healthy ?? 0)
    const failed = Number(bucket?.unhealthy ?? 0)
    const unknown = Number(bucket?.unknown ?? 0)
    const unobserved = Math.max(0, expected - healthy - failed - unknown)
    const state = failed ? "failed" : !healthy ? "unknown" : unknown || unobserved ? "partial" : "healthy"
    return { start, end, healthy, failed, unknown, unobserved, state }
  })
}

const labels = { healthy: "Healthy", failed: "Failed", partial: "Incomplete coverage", unknown: "No observations" }
function date(value: number) { return new Date(value * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) }
export function intervalLabel(bucket: UptimeInterval): string {
  return `${date(bucket.start)} to ${date(bucket.end)}: ${labels[bucket.state]}; ${bucket.healthy} healthy, ${bucket.failed} failed, ${bucket.unknown} missed or invalid, ${bucket.unobserved} unobserved slots`
}

export function UptimeHistory({ result, window, now, compact = false }: { result?: SLOSummary; window: string; now: number; compact?: boolean }) {
  const intervals = uptimeIntervals(result, window, now)
  const [selected, setSelected] = useState<number | null>(null)
  const id = useId()
  const index = Math.min(selected ?? intervals.length - 1, intervals.length - 1)
  const active = intervals[index]
  function move(event: KeyboardEvent<HTMLButtonElement>, current: number) {
    const next = event.key === "ArrowRight" ? Math.min(current + 1, intervals.length - 1) : event.key === "ArrowLeft" ? Math.max(current - 1, 0) : event.key === "Home" ? 0 : event.key === "End" ? intervals.length - 1 : null
    if (next === null) return
    event.preventDefault()
    setSelected(next)
    const buttons = event.currentTarget.parentElement?.querySelectorAll("button")
    buttons?.[next]?.focus()
  }
  return <div className={compact ? styles.historyCompact : styles.history}>
    <div className={styles.bars} role="group" aria-label={`${window} uptime history`}>
      {intervals.map((bucket, i) => compact ? <span key={bucket.start} className={styles.bar} data-state={bucket.state} aria-label={intervalLabel(bucket)} /> :
        <button key={bucket.start} type="button" className={styles.bar} data-state={bucket.state} data-selected={i === index} aria-label={intervalLabel(bucket)} aria-pressed={i === index} aria-controls={id} tabIndex={i === index ? 0 : -1} onFocus={() => setSelected(i)} onClick={() => setSelected(i)} onKeyDown={(event) => move(event, i)} />)}
    </div>
    <div className={styles.axis}><span>{new Date(intervals[0].start * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span><span>{window} rolling window</span><span>Now</span></div>
    {!compact ? <>
      <div className={styles.legend}>{Object.entries(labels).map(([state, label]) => <span key={state}><i data-state={state} />{label}</span>)}</div>
      <div className={styles.interval} id={id} aria-live="polite" aria-atomic="true">
        <div className={styles.intervalTop}><p><strong>{date(active.start)}</strong><span> – {date(active.end)}</span></p><div className={styles.stepper}><button type="button" aria-label="Previous interval" disabled={index === 0} onClick={() => setSelected(index - 1)}><ChevronLeft size={16} /></button><button type="button" aria-label="Next interval" disabled={index === intervals.length - 1} onClick={() => setSelected(index + 1)}><ChevronRight size={16} /></button></div></div>
        <p className={styles.intervalCounts}><span className={styles.stateLabel} data-state={active.state}>{labels[active.state]}</span><span>{active.healthy.toLocaleString()} healthy</span><span>{active.failed.toLocaleString()} failed</span><span>{active.unknown.toLocaleString()} missed / invalid</span><span>{active.unobserved.toLocaleString()} unobserved</span></p>
      </div>
      <p className={styles.note}>Each bar groups probe observations. Select an interval or use arrow keys to inspect it. Hatched time is unknown, never counted as uptime.</p>
    </> : null}
  </div>
}

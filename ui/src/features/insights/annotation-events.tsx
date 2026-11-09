"use client"

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { z } from "zod"
import type { QueryResult, Widget } from "./schema"
import { queryIdentity, type QueryFetcher } from "./query"

type AnnotationSource = NonNullable<Widget["annotationSource"]>
export type RecordedEvent = { timestamp: string; endTimestamp?: string; label: string; severity?: "info" | "warning" | "critical" }
type AnnotationState = { events: RecordedEvent[]; error?: string; omitted?: number; truncated?: boolean; loading?: boolean }
export interface RetainedAnnotationEvents { key: string; revision: QueryFetcher; value: AnnotationState }
export interface AnnotationEventsRetention {
  read: () => RetainedAnnotationEvents | undefined
  write: (state: RetainedAnnotationEvents) => void
}
const AnnotationContext = createContext<AnnotationState>({ events: [] })
const timestampText = z.iso.datetime({ offset: true })
export const useAnnotationEvents = () => useContext(AnnotationContext)
export function AnnotationEventsProvider({ state, children }: { state: AnnotationState; children: ReactNode }) {
  return <AnnotationContext.Provider value={state}>{children}</AnnotationContext.Provider>
}

/** Consume only real returned record fields; unknown timestamps stay unknown. */
export function recordedEvents(result: QueryResult, source: AnnotationSource, start: number, end: number): { events: RecordedEvent[]; omitted: number; truncated: boolean } {
  const frame = result.records
  if (!frame) throw new Error("The event query did not return records.")
  const index = (key: string) => {
    const found = frame.columns.findIndex(column => column.key === key)
    if (found < 0) throw new Error(`Event query has no “${key}” column.`)
    return found
  }
  const time = index(source.timestampColumn), finish = source.endColumn ? index(source.endColumn) : -1, label = index(source.labelColumn), severity = source.severityColumn ? index(source.severityColumn) : -1
  if (!(["string", "timestamp", "number"] as string[]).includes(frame.columns[time].type) || finish >= 0 && !(["string", "timestamp", "number"] as string[]).includes(frame.columns[finish].type) || frame.columns[label].type !== "string" || severity >= 0 && frame.columns[severity].type !== "string")
    throw new Error("Event timestamp, label or severity columns have an unsupported type.")
  const events: RecordedEvent[] = []
  let omitted = 0
  for (const row of frame.rows) {
    const value = row[time], text = row[label]
    const stamp = typeof value === "number" ? value : typeof value === "string" && timestampText.safeParse(value).success ? Date.parse(value) : NaN
    if (!Number.isFinite(stamp) || stamp <= 0 || !Number.isFinite(new Date(stamp).getTime()) || typeof text !== "string" || !text.trim() || text.length > 100) { omitted++; continue }
    const endValue = finish < 0 ? null : row[finish]
    const finishStamp = endValue == null ? undefined : typeof endValue === "number" ? endValue : typeof endValue === "string" && timestampText.safeParse(endValue).success ? Date.parse(endValue) : NaN
    if (finishStamp !== undefined && (!Number.isFinite(finishStamp) || finishStamp < stamp || !Number.isFinite(new Date(finishStamp).getTime()))) { omitted++; continue }
    if ((finishStamp ?? stamp) < start * 1000 || stamp > end * 1000) continue
    if (events.length >= 1000) { omitted++; continue }
    const level = severity < 0 ? undefined : row[severity]
    events.push({ timestamp: new Date(stamp).toISOString(), ...(finishStamp !== undefined ? { endTimestamp: new Date(finishStamp).toISOString() } : {}), label: text, ...(level === "info" || level === "warning" || level === "critical" ? { severity: level } : {}) })
  }
  return { events, omitted, truncated: !!(frame.truncated || result.truncated) }
}

/** The host supplies its normal saved-query resolver and scheduler. */
export function useRecordedEvents(source: AnnotationSource | undefined, fetcher: QueryFetcher, providerId: string, start: number, end: number, enabled: boolean, retention?: AnnotationEventsRetention): AnnotationState {
  const sourceKey = JSON.stringify([source, providerId, start, end])
  const prepared = useMemo(() => {
    const [selected, provider, from, to] = JSON.parse(sourceKey) as [AnnotationSource | null, string, number, number]
    return selected ? { selected, request: { providerId: provider, query: "event query", kind: "records" as const, queryRef: selected.queryRef, start: from, end: to, step: Math.max(1, Math.ceil((to - from) / 300)) } } : undefined
  }, [sourceKey])
  const identity = prepared ? queryIdentity(prepared.request, fetcher) : undefined
  // Both the resolved records request and the source's column mapping own the
  // derived events; changing either must never reveal another mapping's data.
  const key = JSON.stringify([sourceKey, identity?.key])
  const revision = identity?.revision
  const fetcherRef = useRef(fetcher)
  useLayoutEffect(() => { fetcherRef.current = fetcher }, [fetcher])
  const retentionRef = useRef(retention)
  useLayoutEffect(() => { retentionRef.current = retention }, [retention])
  const [state, setState] = useState<RetainedAnnotationEvents | undefined>(() => retention?.read())
  useEffect(() => {
    if (!enabled || !prepared || !revision) return
    const controller = new AbortController()
    const settle = (value: AnnotationState) => {
      if (controller.signal.aborted) return
      const next = { key, revision, value }
      setState(next)
      retentionRef.current?.write(next)
    }
    Promise.resolve().then(async () => {
      controller.signal.throwIfAborted()
      const retained = retentionRef.current?.read()
      if (retained?.key === key && retained.revision === revision) {
        setState(retained)
        return
      }
      const result = await fetcherRef.current(prepared.request, controller.signal)
      settle(recordedEvents(result, prepared.selected, prepared.request.start, prepared.request.end))
    }).catch(error => settle({ events: [], error: error instanceof Error ? error.message : "Event query failed." }))
    return () => controller.abort()
  }, [enabled, revision, key, prepared])
  if (!source || !enabled) return { events: [] }
  return state?.key === key && state.revision === revision ? state.value : { events: [], loading: true }
}

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { recordedEvents, useRecordedEvents, type AnnotationEventsRetention, type RetainedAnnotationEvents } from "./annotation-events"
import { createQueryScheduler, createResolvedQueryFetcher } from "./query"
import { dashboardUsesSavedQuery } from "./saved-queries"
import type { Dashboard, QueryResult, Widget } from "./schema"
import { AnnotationSourceEditor } from "./annotation-source-editor"
import { SavedQueryLibraryProvider } from "./saved-query-context"

const source = { queryRef: { id: "events", bindings: [{ parameter: "service", source: "variable" as const, variable: "service" }] }, timestampColumn: "date", labelColumn: "label", severityColumn: "status" }
const frame = (rows: (string | number | null)[][]): QueryResult => ({ records: { columns: [{ key: "date", type: "string" }, { key: "label", type: "string" }, { key: "status", type: "string" }], rows } })

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })
function retainedSlot() {
  let state: RetainedAnnotationEvents | undefined
  return { read: () => state, write: (value: RetainedAnnotationEvents) => { state = value } } satisfies AnnotationEventsRetention
}

describe("recorded chart events", () => {
  it("keeps overlapping intervals, rejects invalid ends and preserves exact endpoints", () => {
    const result: QueryResult = { records: { columns: [{ key:"date", type:"timestamp" }, { key:"end", type:"timestamp" }, { key:"label", type:"string" }, { key:"status", type:"string" }], rows: [
      ["2026-10-26T00:00:00Z", "2026-10-26T00:40:00Z", "Incident", "critical"],
      ["2026-10-26T00:35:00Z", "2026-10-26T00:34:00Z", "Invalid", "warning"],
      ["2026-10-26T00:50:00Z", null, "Deployment", "info"],
      ["2026-10-26T02:00:00Z", "2026-10-26T03:00:00Z", "Outside", "critical"]
    ] } }
    const mapped=recordedEvents(result, {...source,endColumn:"end"}, Date.parse("2026-10-26T00:30:00Z")/1000, Date.parse("2026-10-26T01:00:00Z")/1000)
    expect(mapped.events).toEqual([{timestamp:"2026-10-26T00:00:00.000Z",endTimestamp:"2026-10-26T00:40:00.000Z",label:"Incident",severity:"critical"}, {timestamp:"2026-10-26T00:50:00.000Z",label:"Deployment",severity:"info"}])
    expect(mapped.omitted).toBe(1)
  })
  it("filters by the requested range before applying the display cap and preserves unknown severity", () => {
    const outside = Array.from({ length: 25 }, () => ["2026-01-01T00:00:00Z", "outside", "warning"])
    const result = frame([...outside, ["2026-10-26T00:30:00Z", "Deployment", "unclassified"], ["not a date", "Invalid", "info"], ["2026-02-30T00:00:00Z", "Impossible", "info"]])
    const events = recordedEvents(result, source, Date.parse("2026-10-26T00:00:00Z") / 1000, Date.parse("2026-10-26T01:00:00Z") / 1000)
    expect(events.events).toEqual([{ timestamp: "2026-10-26T00:30:00.000Z", label: "Deployment" }])
    expect(events.omitted).toBe(2)
    expect(() => recordedEvents(frame([]), { ...source, timestampColumn: "absent" }, 1, 2)).toThrow(/no “absent” column/)
  })
  it("cancels stale queries and never shows their events after the range changes", async () => {
    const pending: { signal: AbortSignal; resolve: (value: QueryResult) => void }[] = []
    const fetcher = vi.fn((_request, signal: AbortSignal) => new Promise<QueryResult>(resolve => pending.push({ signal, resolve })))
    const start = Date.parse("2026-10-26T00:00:00Z") / 1000
    const retention = retainedSlot()
    const { result, rerender, unmount } = renderHook(({ offset }) => useRecordedEvents(source, fetcher, "metric-provider", start + offset, start + 3600 + offset, true, retention), { initialProps: { offset: 0 } })
    await waitFor(() => expect(pending).toHaveLength(1))
    rerender({ offset: 3600 })
    await waitFor(() => expect(pending).toHaveLength(2))
    expect(pending[0].signal.aborted).toBe(true)
    await act(async () => pending[0].resolve(frame([["2026-10-26T00:30:00Z", "Old", "warning"]])))
    expect(result.current.events).toEqual([])
    expect(retention.read()).toBeUndefined()
    await act(async () => pending[1].resolve(frame([["2026-10-26T01:30:00Z", "New", "critical"]])))
    expect(result.current.events[0].label).toBe("New")
    expect(retention.read()?.value.events[0].label).toBe("New")
    unmount()
    expect(pending[1].signal.aborted).toBe(true)
  })
  it("protects annotation-only saved queries from removal", () => {
    const widget = { id: "chart", type: "plugin", pluginId: "stacked-timeseries", annotationSource: source } as Widget
    const dashboard = { widgets: [widget] } as Dashboard
    expect(dashboardUsesSavedQuery(dashboard, "events")).toBe(true)
    expect(dashboardUsesSavedQuery(dashboard, "other")).toBe(false)
  })
  it("surfaces secondary query failures without inventing event data", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("Event provider unavailable"))
    const { result } = renderHook(() => useRecordedEvents(source, fetcher, "metrics", 1, 100, true))
    await waitFor(() => expect(result.current.error).toBe("Event provider unavailable"))
    expect(result.current.events).toEqual([])
    expect(fetcher.mock.calls[0][0]).toMatchObject({ kind: "records", queryRef: source.queryRef, start: 1, end: 100 })
  })
  it("retains mapped events after editor remounts beyond the scheduler TTL and ignores unrelated resolver changes", async () => {
    vi.useFakeTimers()
    const start = Date.parse("2026-10-26T00:00:00Z") / 1000
    const provider = vi.fn().mockResolvedValue(frame([["2026-10-26T00:30:00Z", "Deployment", "info"]]))
    const scheduler = createQueryScheduler(provider)
    const fetcher = () => createResolvedQueryFetcher(scheduler, request => request)
    const retention = retainedSlot()
    const before = renderHook(() => useRecordedEvents(source, fetcher(), "metrics", start, start + 3600, true, retention))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(before.result.current.events[0].label).toBe("Deployment")
    before.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })
    const after = renderHook(({ enabled }) => useRecordedEvents(structuredClone(source), fetcher(), "metrics", start, start + 3600, enabled, retention), { initialProps: { enabled: true } })
    expect(after.result.current.events[0].label).toBe("Deployment")
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })
    after.rerender({ enabled: false })
    expect(after.result.current.events).toEqual([])
    after.rerender({ enabled: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(after.result.current.events[0].label).toBe("Deployment")
    expect(provider).toHaveBeenCalledTimes(1)
  })
  it.each(["mapping", "reference", "provider", "window", "binding", "revision"] as const)("invalidates retained events when their %s changes", async change => {
    vi.useFakeTimers()
    const start = Date.parse("2026-10-26T00:00:00Z") / 1000
    const provider = vi.fn().mockResolvedValue(frame([["2026-10-26T00:30:00Z", "Deployment", "critical"]]))
    const scheduler = createQueryScheduler(provider)
    const fetcher = createResolvedQueryFetcher(scheduler, request => request)
    const retention = retainedSlot()
    const before = renderHook(() => useRecordedEvents(source, fetcher, "metrics", start, start + 3600, true, retention))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    before.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })
    const nextSource = change === "mapping" ? { ...source, labelColumn: "status" }
      : change === "reference" ? { ...source, queryRef: { id: "other-events", bindings: [] } } : source
    const nextFetcher = change === "revision" ? createResolvedQueryFetcher(createQueryScheduler(provider), request => request)
      : change === "binding" ? createResolvedQueryFetcher(scheduler, request => ({ ...request, query: "other-service" })) : fetcher
    const after = renderHook(() => useRecordedEvents(nextSource, nextFetcher, change === "provider" ? "other" : "metrics", start, start + (change === "window" ? 7200 : 3600), true, retention))
    expect(after.result.current.events).toEqual([])
    expect(after.result.current.loading).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(provider).toHaveBeenCalledTimes(2)
    expect(after.result.current.events[0].label).toBe(change === "mapping" ? "critical" : "Deployment")
  })
  it("keeps explicit parameter bindings when reselecting the same event query", () => {
    const widget = { id: "chart", type: "plugin", pluginId: "stacked-timeseries", annotationSource: source } as Widget
    const query = { schemaVersion: 1 as const, id: "events", name: "Events", providerId: "db", kind: "records" as const, query: "SELECT 1", parameters: [{ name: "service", type: "string" as const }] }
    const change = vi.fn()
    render(<SavedQueryLibraryProvider queries={[query]} variables={[{ name: "service", label: "Service" }]} values={{ service: "checkout" }}><AnnotationSourceEditor widget={widget} onChange={change} /></SavedQueryLibraryProvider>)
    fireEvent.click(screen.getByRole("combobox", { name: "Event saved query" }))
    fireEvent.click(screen.getByRole("option", { name: /Events/ }))
    expect(change.mock.lastCall?.[0].annotationSource.queryRef).toEqual(source.queryRef)
  })
})

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { TraceFetcherProvider, TraceWaterfall, filterTraceRows, traceRows } from "./trace-waterfall"
import { WidgetVisualization } from "./charts"
import type { Widget } from "./schema"

const spans = [
  { spanId: "child", parentSpanId: "root", service: "db", operation: "select", startTime: 1010, durationMs: 40, status: "error" },
  { spanId: "root", service: "api", operation: "GET", startTime: 1000, durationMs: 100, status: "ok" },
  { spanId: "orphan", parentSpanId: "missing", service: "queue", operation: "send", startTime: 1020, durationMs: 20, status: "unknown" },
]

describe("trace waterfall", () => {
  it("orders children beneath their actual parent and retains orphans", () => {
    expect(traceRows(spans).map(row => [row.span.spanId, row.depth])).toEqual([["root", 0], ["child", 1], ["orphan", 0]])
  })
  it("filters spans while retaining real parents as context, even with broken or cyclic relationships", () => {
    const rows = traceRows([...spans, { spanId: "cycle-a", parentSpanId: "cycle-b", service: "cycle", operation: "one", startTime: 1030, durationMs: 1, status: "ok" }, { spanId: "cycle-b", parentSpanId: "cycle-a", service: "cycle", operation: "two", startTime: 1040, durationMs: 1, status: "error" }])
    const result = filterTraceRows(rows, "select", true)
    expect(result.rows.map(row => row.span.spanId)).toEqual(["root", "child"])
    expect([...result.matches]).toEqual(["child"])
    expect(filterTraceRows(rows, "cycle", true).rows.map(row => row.span.spanId)).toEqual(["cycle-a", "cycle-b"])
    expect(filterTraceRows(rows, "absent", false).rows).toEqual([])
  })
  it("ends visible branches after filtering and distinguishes cyclic from missing parents", () => {
    const rows = traceRows([...spans, { spanId: "sibling", parentSpanId: "root", service: "cache", operation: "get", startTime: 1030, durationMs: 5, status: "ok" }, { spanId: "cycle", parentSpanId: "cycle", service: "loop", operation: "self", startTime: 1040, durationMs: 1, status: "unknown" }])
    const filtered = filterTraceRows(rows, "select", false)
    expect(filtered.rows.find(row => row.span.spanId === "child")?.last).toBe(true)
    expect(rows.find(row => row.span.spanId === "orphan")?.orphan).toBe(true)
    expect(rows.find(row => row.span.spanId === "cycle")?.unresolved).toBe(true)
    expect(rows.find(row => row.span.spanId === "cycle")?.orphan).toBe(false)
  })
  it("continues an ancestor guide past descendants when a later sibling remains", () => {
    const rows = traceRows([...spans, { spanId: "sibling", parentSpanId: "root", service: "cache", operation: "get", startTime: 1030, durationMs: 5, status: "ok" }, { spanId: "grandchild", parentSpanId: "child", service: "store", operation: "read", startTime: 1020, durationMs: 2, status: "ok" }])
    expect(rows.find(row => row.span.spanId === "grandchild")?.guides).toEqual([true])
  })
  it("filters recorded span details locally, preserves parent context, and never re-fetches", async () => {
    const records = spans.map(span => span.spanId === "child" ? { ...span, attributes: [{ key: "db.system.name", value: "postgresql" }] } : span)
    const fetchTrace = vi.fn().mockResolvedValue({ spans: records })
    const { container } = render(<TraceFetcherProvider fetchTrace={fetchTrace}><TraceWaterfall traceId="abc" /></TraceFetcherProvider>)
    await screen.findByRole("region", { name: "Trace abc waterfall" })
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter trace spans" }), { target: { value: "postgresql" } })
    expect(screen.getByRole("status")).toHaveTextContent("1 matching span of 3 returned · parents shown for context")
    expect(container.querySelector('[data-span-id="root"]')).toHaveAttribute("data-parent-context", "true")
    expect(container.querySelector('[data-span-id="child"]')).toBeInTheDocument()
    expect(container.querySelector('[data-span-id="orphan"]')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Errors only" }))
    expect(screen.getByRole("button", { name: "Errors only" })).toHaveAttribute("aria-pressed", "true")
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter trace spans" }), { target: { value: "not found" } })
    expect(screen.getByText(/No matching spans/)).toBeInTheDocument()
    expect(fetchTrace).toHaveBeenCalledTimes(1)
  })
  it("does not carry a filter or selected span into a different trace", async () => {
    const fetchTrace = vi.fn().mockResolvedValue({ spans })
    const rendered = render(<TraceFetcherProvider fetchTrace={fetchTrace}><TraceWaterfall traceId="first" /></TraceFetcherProvider>)
    await screen.findByRole("region", { name: "Trace first waterfall" })
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter trace spans" }), { target: { value: "select" } })
    fireEvent.click(screen.getByRole("button", { name: "Errors only" }))
    rendered.rerender(<TraceFetcherProvider fetchTrace={fetchTrace}><TraceWaterfall traceId="second" /></TraceFetcherProvider>)
    await screen.findByRole("region", { name: "Trace second waterfall" })
    expect(screen.getByRole("searchbox", { name: "Filter trace spans" })).toHaveValue("")
    expect(screen.getByRole("button", { name: "Errors only" })).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByRole("button", { name: "Span details for queue send (orphan)" })).toBeInTheDocument()
  })
  it("shows actual returned durations, errors and partial results", async () => {
    const fetchTrace = vi.fn().mockResolvedValue({ spans, truncated: true })
    const { container } = render(<TraceFetcherProvider fetchTrace={fetchTrace}><TraceWaterfall traceId="abc" /></TraceFetcherProvider>)
    await screen.findByRole("region", { name: "Trace abc waterfall" })
    expect(fetchTrace).toHaveBeenCalledWith("abc", expect.any(AbortSignal))
    expect(screen.getByText("40.00 ms")).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "Trace duration axis from 0 milliseconds to 100 milliseconds" })).toBeInTheDocument()
    expect(screen.getByText(/Partial trace/)).toBeInTheDocument()
    expect(container.querySelector('[data-span-id="child"] [data-span-status="error"]')).toHaveStyle({ left: "10%", width: "40%" })
    expect(container.querySelector('[data-span-id="child"]')).toHaveTextContent("Error")
  })
  it("aligns all spans to a shared axis and visibly connects recorded parent relationships", async () => {
    const fetchTrace = vi.fn().mockResolvedValue({ spans: [...spans, { spanId: "grandchild", parentSpanId: "child", service: "store", operation: "read", startTime: 1020, durationMs: 10, status: "ok" }] })
    const { container } = render(<TraceFetcherProvider fetchTrace={fetchTrace}><TraceWaterfall traceId="abc" /></TraceFetcherProvider>)
    await screen.findByRole("region", { name: "Trace abc waterfall" })
    expect(screen.getByText("Time from first recorded span")).toBeInTheDocument()
    expect(screen.getByText("25.00 ms")).toBeInTheDocument()
    expect(container.querySelector('[data-span-id="child"] [data-trace-branch]')).toBeInTheDocument()
    expect(container.querySelector('[data-span-id="grandchild"] [data-trace-branch]')).toBeInTheDocument()
    expect(container.querySelector('[data-span-id="root"] [data-trace-stem]')).toBeInTheDocument()
    expect(container.querySelector('[data-span-id="child"] [data-trace-stem]')).toBeInTheDocument()
    expect(container.querySelector('[data-span-id="grandchild"] [data-trace-stem]')).not.toBeInTheDocument()
    expect(container.querySelector('[data-span-id="grandchild"] [data-span-status]')).toHaveStyle({ left: "20%", width: "10%" })
    expect(container.querySelector('[data-span-id="orphan"]')).toHaveTextContent("Parent not returned")
    expect(container.querySelector('[data-span-id="child"]')).toHaveTextContent("+10.00 ms")
  })
  it("reports omitted invalid timing and does not stretch a zero-duration span", async () => {
    const fetchTrace = vi.fn().mockResolvedValue({ spans: [{ spanId: "zero", service: "api", operation: "instant", startTime: 1000, durationMs: 0, status: "ok" }, { spanId: "bad", service: "api", operation: "bad", startTime: 2000, durationMs: -1, status: "unknown" }] })
    const { container } = render(<TraceFetcherProvider fetchTrace={fetchTrace}><TraceWaterfall traceId="abc" /></TraceFetcherProvider>)
    expect(await screen.findByText(/1 span omitted because its timing is invalid/)).toBeInTheDocument()
    expect(container.querySelector('[data-span-id="zero"] [data-span-status]')).toHaveStyle({ width: "0%" })
    expect(container.querySelector('[data-span-id="zero"] [data-span-status]')).toHaveAttribute("data-instant", "true")
  })
  it("opens recorded span details and only shows returned safe attributes", async () => {
    const records = spans.map(span => span.spanId === "child" ? { ...span, attributes: [{ key: "db.system.name", value: "postgresql" }, { key: "db.operation.name", value: "SELECT" }], attributesOmitted: 2 } : span)
    const fetchTrace = vi.fn().mockResolvedValue({ spans: records })
    render(<TraceFetcherProvider fetchTrace={fetchTrace}><TraceWaterfall traceId="abc" /></TraceFetcherProvider>)
    const button = await screen.findByRole("button", { name: "Span details for db select (child)" })
    fireEvent.click(button)
    expect(button).toHaveAttribute("aria-expanded", "true")
    const detail = screen.getByRole("region", { name: "Details for db select" })
    expect(detail).toHaveTextContent("postgresql")
    expect(detail).toHaveTextContent("db.operation.name")
    expect(detail).toHaveTextContent("2 other attributes were withheld")
    expect(detail).toHaveTextContent("Parent span ID")
    const recordedTime = detail.querySelector("time")
    expect(recordedTime).toHaveAttribute("datetime", "1970-01-01T00:00:01.010Z")
    expect(recordedTime).toHaveAttribute("title", "1970-01-01T00:00:01.010Z")
    expect(recordedTime).toHaveTextContent(new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(new Date(1010)))
    fireEvent.click(button)
    expect(screen.queryByRole("region", { name: "Details for db select" })).not.toBeInTheDocument()
  })
  it("cancels requests on close and exposes provider errors", async () => {
    let signal: AbortSignal | undefined
    const fetchTrace = vi.fn((_id: string, next: AbortSignal) => { signal = next; return Promise.reject(new Error("Not available")) })
    const rendered = render(<TraceFetcherProvider fetchTrace={fetchTrace}><TraceWaterfall traceId="abc" /></TraceFetcherProvider>)
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Not available"))
    rendered.unmount()
    expect(signal?.aborted).toBe(true)
  })
  it("reports a zero-duration trace truthfully rather than its rendering fallback", async () => {
    const fetchTrace = vi.fn().mockResolvedValue({ spans: [{ spanId: "zero", service: "api", operation: "instant", startTime: 1000, durationMs: 0, status: "ok" }] })
    render(<TraceFetcherProvider fetchTrace={fetchTrace}><TraceWaterfall traceId="abc" /></TraceFetcherProvider>)
    expect(await screen.findByRole("img", { name: "Trace duration axis from 0 milliseconds to 0 milliseconds" })).toBeInTheDocument()
  })
  it("does not select the surrounding trace row when the waterfall button receives focus", () => {
    const select = vi.fn()
    const widget: Widget = { id: "traces", title: "Traces", type: "traces", providerId: "tempo", query: "{}", unit: "", layout: { x: 0, y: 0, w: 8, h: 4 } }
    render(<TraceFetcherProvider fetchTrace={vi.fn()}><WidgetVisualization widget={widget} onContextChange={select} result={{ traces: [{ traceId: "00112233445566778899aabbccddeeff", service: "api", operation: "GET", status: "unknown", durationMs: 10, startTime: 1000 }] }} /></TraceFetcherProvider>)
    fireEvent.focus(screen.getByRole("button", { name: "View waterfall" }))
    expect(select).not.toHaveBeenCalled()
  })
  it("announces trace overflow and clears the hint when the table fits", async () => {
    let height = 600
    let width = 600
    let notify: (() => void) | undefined
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => height)
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(250)
    const scrollWidth = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(() => width)
    const clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(250)
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { notify = callback } observe() {} disconnect() {} })
    try {
      const widget: Widget = { id: "traces", title: "Traces", type: "traces", providerId: "tempo", query: "{}", unit: "", layout: { x: 0, y: 0, w: 8, h: 4 } }
      render(<WidgetVisualization widget={widget} result={{ traces: [{ traceId: "00112233445566778899aabbccddeeff", service: "api", operation: "GET", status: "unknown", durationMs: 10, startTime: 1000 }] }} />)
      const region = screen.getByRole("region", { name: "Traces traces" })
      const hint = await screen.findByText("Scroll to see all traces and columns")
      expect(region).toHaveAccessibleDescription("Scroll to see all traces and columns")
      expect(region).toHaveAttribute("aria-describedby", hint.id)
      height = 250; width = 250
      act(() => notify?.())
      await waitFor(() => expect(screen.queryByText("Scroll to see all traces and columns")).not.toBeInTheDocument())
      expect(region).not.toHaveAttribute("aria-describedby")
    } finally {
      scrollHeight.mockRestore(); clientHeight.mockRestore(); scrollWidth.mockRestore(); clientWidth.mockRestore(); vi.unstubAllGlobals()
    }
  })
})

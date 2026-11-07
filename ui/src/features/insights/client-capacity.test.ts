import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createInsightsClient } from "./client"
import type { Dashboard, SavedQuery } from "./schema"

const dashboard: Dashboard = {
  schemaVersion: 1, id: "overview", title: "Overview", timeRange: "1h", refreshInterval: 0, widgets: [],
}
const query: SavedQuery = {
  schemaVersion: 1, id: "requests", name: "Requests", providerId: "observe-metrics", kind: "metrics", query: "up",
}
function response(document: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(document), { status, headers: { "Content-Type": "application/json", ...headers } })
}
function limited(retryAfter?: string) {
  return response({ error: "too many active observability requests; retry shortly" }, 429,
    retryAfter === undefined ? {} : { "Retry-After": retryAfter })
}
function mockFetch(...responses: Response[]) {
  const fetcher = vi.fn()
  responses.forEach(item => fetcher.mockResolvedValueOnce(item))
  vi.stubGlobal("fetch", fetcher)
  return fetcher
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-29T12:00:00Z")) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe("document capacity backoff", () => {
  it.each([undefined, '"query-revision"'])("retries a rejected saved query with the exact body and precondition %s", async etag => {
    const fetcher = mockFetch(limited("1"), response(query, 200, { "X-Paprika-Document-ETag": '"saved"' }))
    const pending = createInsightsClient("/api/insights", () => "same-principal").saveSavedQuery(query, etag)
    await vi.advanceTimersByTimeAsync(999)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toBe('"saved"')
    expect(fetcher).toHaveBeenCalledTimes(2)
    const [first, second] = fetcher.mock.calls
    expect(first[0]).toBe("/api/insights/saved-queries/requests")
    expect(second[0]).toBe(first[0])
    expect(second[1].method).toBe("PUT")
    expect(second[1].body).toBe(first[1].body)
    expect([...second[1].headers]).toEqual([...first[1].headers])
    expect(second[1].headers.get(etag ? "If-Match" : "If-None-Match")).toBe(etag ?? "*")
  })

  it("honors an HTTP-date cooldown for dashboard saves", async () => {
    const fetcher = mockFetch(limited("Thu, 29 Oct 2026 12:00:03 GMT"), response(dashboard))
    const pending = createInsightsClient().save(dashboard, '"reviewed"')
    await vi.advanceTimersByTimeAsync(2999)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(fetcher.mock.calls[1][1].headers.get("If-Match")).toBe('"reviewed"')
  })

  it("bounds repeated rejections to three retries with increasing fallback delays", async () => {
    const fetcher = mockFetch(limited(), limited("invalid"), limited(), limited())
    const rejected = expect(createInsightsClient().saveSavedQuery(query)).rejects.toThrow(/retry shortly/)
    await vi.advanceTimersByTimeAsync(999)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetcher).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(3001)
    await rejected
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["11", "99999999999999999999999999999999999", "Thu, 29 Oct 2026 12:01:00 GMT"])("never retries earlier than a long server cooldown %s", async retryAfter => {
    const fetcher = mockFetch(limited(retryAfter))
    await expect(createInsightsClient().saveSavedQuery(query)).rejects.toThrow(/retry shortly/)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps conditional document cache validation during backoff", async () => {
    const fetcher = mockFetch(response({ dashboards: [dashboard] }, 200, { ETag: 'W/"library"' }), limited("1"), new Response(null, { status: 304 }))
    const api = createInsightsClient()
    const original = await api.list()
    const pending = api.list()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toBe(original)
    expect(fetcher.mock.calls[2][1].headers.get("If-None-Match")).toBe('W/"library"')
  })

  it("cancels a waiting document read without sending another request", async () => {
    const fetcher = mockFetch(limited("1"))
    const abort = new AbortController()
    const rejected = expect(createInsightsClient().get(dashboard.id, abort.signal)).rejects.toMatchObject({ name: "AbortError" })
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    abort.abort()
    await rejected
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not replay a write after an account change during backoff", async () => {
    let token = "first-account"
    const fetcher = mockFetch(limited("1"))
    const rejected = expect(createInsightsClient("/api/insights", () => token).saveSavedQuery(query)).rejects.toThrow(/session changed/)
    await vi.advanceTimersByTimeAsync(0)
    token = "second-account"
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it("preserves concurrent-edit conflicts after a capacity retry", async () => {
    const fetcher = mockFetch(limited("1"), response({ error: "changed" }, 412))
    const rejected = expect(createInsightsClient().saveSavedQuery(query, '"reviewed"')).rejects.toThrow(/changed on the server/)
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][1].headers.get("If-Match")).toBe('"reviewed"')
  })

  it.each([401, 403, 409, 412, 500, 502, 503, 504])("does not replay a write for HTTP %s", async status => {
    const fetcher = mockFetch(response({ error: "Rejected or uncertain write" }, status, { "Retry-After": "1" }))
    await expect(createInsightsClient().saveSavedQuery(query)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("leaves lost write acknowledgements to the importer's read-back reconciliation", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    vi.stubGlobal("fetch", fetcher)
    await expect(createInsightsClient().saveSavedQuery(query)).rejects.toThrow(/Failed to fetch/)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not retry provider operations or an unconditioned document mutation", async () => {
    const fetcher = mockFetch(limited("1"), limited("1"))
    const api = createInsightsClient()
    await expect(api.saveProvider({ id: "metrics", name: "Metrics", type: "prometheus", url: "http://metrics:9090" })).rejects.toThrow(/retry shortly/)
    await expect(api.remove(dashboard.id)).rejects.toThrow(/retry shortly/)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("read-only query capacity backoff", () => {
  const input = { providerId: "metrics", kind: "metrics" as const, query: "up", start: 0, end: 1000, step: 1 }
  it("retries an explicit 429 with the exact query and returns the result", async () => {
    const fetcher = mockFetch(limited("1"), response({ series: [] }))
    const pending = createInsightsClient().query(input, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toEqual({ series: [] })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][1].body).toEqual(fetcher.mock.calls[0][1].body)
  })
  it("cancels backoff when a widget is hidden or its query changes", async () => {
    const fetcher = mockFetch(limited("1"))
    const abort = new AbortController()
    const rejected = expect(createInsightsClient().query(input, abort.signal)).rejects.toMatchObject({ name: "AbortError" })
    await vi.advanceTimersByTimeAsync(0)
    abort.abort()
    await rejected
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("does not replay under a different principal", async () => {
    let token = "first"
    const fetcher = mockFetch(limited("1"))
    const rejected = expect(createInsightsClient("/api/insights", () => token).query(input, new AbortController().signal)).rejects.toThrow(/session changed/)
    await vi.advanceTimersByTimeAsync(0)
    token = "second"
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it("surfaces the error after three retries and never retries a 5xx", async () => {
    const fetcher = mockFetch(limited(), limited(), limited(), limited(), response({ error: "unavailable" }, 503))
    const api = createInsightsClient()
    const rejected = expect(api.query(input, new AbortController().signal)).rejects.toThrow(/retry shortly/)
    await vi.advanceTimersByTimeAsync(7000)
    await rejected
    expect(fetcher).toHaveBeenCalledTimes(4)
    await expect(api.query(input, new AbortController().signal)).rejects.toThrow(/unavailable/)
    expect(fetcher).toHaveBeenCalledTimes(5)
  })
  it("does not retry an ambiguous network failure", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    vi.stubGlobal("fetch", fetcher)
    await expect(createInsightsClient().query(input, new AbortController().signal)).rejects.toThrow(/Failed to fetch/)
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

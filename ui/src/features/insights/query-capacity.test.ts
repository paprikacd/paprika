import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createInsightsClient, InsightsQueryError } from "./client"
import { createQueryScheduler } from "./query"
import type { QueryRequest, QueryResult } from "./schema"

const request: QueryRequest = { providerId: "metrics", kind: "metrics", query: "up", start: 0, end: 1000, step: 1 }
const data: QueryResult = { series: [] }

function refusal(retryAfter: string | null) {
  // The scheduler reads a refusal's status and Retry-After, as the client's InsightsHTTPError carries them.
  return Object.assign(new Error("too many active queries; retry shortly"), { status: 429, retryAfter })
}

// A refusal that names the provider scope, which holds only its own provider.
function providerRefusal(retryAfter: string | null) {
  return Object.assign(refusal(retryAfter), { limitScope: "provider" })
}

function response(document: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(document), { status, headers: { "Content-Type": "application/json", ...headers } })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-11-18T12:00:00Z"))
  // Neutral jitter for exact-delay assertions; the spread test below pins both ends.
  vi.spyOn(Math, "random").mockReturnValue(0.5)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe("query scheduler capacity backoff", () => {
  it("releases the execution slot while a refused query waits", async () => {
    const calls: string[] = []
    const fetcher = vi.fn(async (r: QueryRequest) => {
      calls.push(r.query)
      if (r.query === "first") throw providerRefusal("2")
      return data
    })
    const scheduler = createQueryScheduler(fetcher, { concurrency: 1, cacheTTL: 0 })
    let firstState = "pending"
    const first = scheduler({ ...request, query: "first" }, new AbortController().signal).then(
      () => { firstState = "resolved" },
      () => { firstState = "rejected" },
    )
    // A different provider: the first's refusal holds only its own provider's queue.
    const second = scheduler({ ...request, providerId: "logs", query: "second" }, new AbortController().signal)
    // The second query runs during the first's 2 s backoff, because the slot is free.
    // The first is still pending: a refusal backs off rather than settling.
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual(["first", "second"])
    expect(firstState).toBe("pending")
    expect(await second).toBe(data)
    // The first keeps refusing, so it settles only after its replays are spent.
    await vi.advanceTimersByTimeAsync(60_000)
    await first
    expect(firstState).toBe("rejected")
  })

  it("holds queued entries for the refused provider during its backoff, and starts other providers", async () => {
    const calls: string[] = []
    let firstRefusals = 0
    const fetcher = vi.fn(async (r: QueryRequest) => {
      calls.push(r.query)
      if (r.query === "first" && firstRefusals++ === 0) throw providerRefusal("2")
      return data
    })
    const scheduler = createQueryScheduler(fetcher, { concurrency: 1, cacheTTL: 0 })
    const signal = () => new AbortController().signal
    const first = scheduler({ ...request, query: "first" }, signal())
    const second = scheduler({ ...request, query: "second" }, signal())
    const other = scheduler({ ...request, providerId: "logs", query: "other" }, signal())
    // The first is refused for 2 s. The second shares its provider and waits. The other provider starts.
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual(["first", "other"])
    await vi.advanceTimersByTimeAsync(1999)
    expect(calls).toEqual(["first", "other"])
    // When the hold ends, the replayed first runs before the second, which queued behind it.
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.slice(0, 3)).toEqual(["first", "other", "first"])
    await Promise.all([first, second, other])
    expect(calls).toEqual(["first", "other", "first", "second"])
  })

  it("holds every provider while a board-wide refusal (budget, edge or queue) backs off", async () => {
    const calls: string[] = []
    let firstRefusals = 0
    const fetcher = vi.fn(async (r: QueryRequest) => {
      calls.push(r.query)
      if (r.query === "first" && firstRefusals++ === 0) {
        throw Object.assign(refusal("2"), { limitScope: "budget" })
      }
      return data
    })
    const scheduler = createQueryScheduler(fetcher, { concurrency: 1, cacheTTL: 0 })
    const signal = () => new AbortController().signal
    const first = scheduler({ ...request, query: "first" }, signal())
    const other = scheduler({ ...request, providerId: "logs", query: "other" }, signal())
    // The budget refused the first, so the other provider waits too, instead of starting during the backoff.
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual(["first"])
    await vi.advanceTimersByTimeAsync(2000)
    await Promise.all([first, other])
    expect(calls).toEqual(["first", "first", "other"])
  })

  // Insights' own query pool names no scope, and neither does an older gateway. Both
  // hold the board, and so does a scope the scheduler does not know.
  for (const limitScope of [undefined, "principal", "unknown", "PROVIDER"]) {
    it(`holds every provider when a refusal names ${limitScope ?? "no"} scope`, async () => {
      const calls: string[] = []
      let firstRefusals = 0
      const fetcher = vi.fn(async (r: QueryRequest) => {
        calls.push(r.query)
        if (r.query === "first" && firstRefusals++ === 0) throw Object.assign(refusal("2"), { limitScope })
        return data
      })
      const scheduler = createQueryScheduler(fetcher, { concurrency: 1, cacheTTL: 0 })
      const signal = () => new AbortController().signal
      const first = scheduler({ ...request, query: "first" }, signal())
      const other = scheduler({ ...request, providerId: "logs", query: "other" }, signal())
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toEqual(["first"])
      await vi.advanceTimersByTimeAsync(1999)
      expect(calls).toEqual(["first"])
      // The board hold clears on time: the replay and the other provider both run.
      await vi.advanceTimersByTimeAsync(1)
      await Promise.all([first, other])
      expect(calls).toEqual(["first", "first", "other"])
    })
  }

  it("does not reorder or hold other providers behind a provider-scoped hold", async () => {
    const calls: string[] = []
    let firstRefusals = 0
    const fetcher = vi.fn(async (r: QueryRequest) => {
      calls.push(r.query)
      if (r.query === "first" && firstRefusals++ === 0) throw providerRefusal("2")
      return data
    })
    const scheduler = createQueryScheduler(fetcher, { concurrency: 1, cacheTTL: 0 })
    const signal = () => new AbortController().signal
    const first = scheduler({ ...request, query: "first" }, signal())
    const queued = [
      scheduler({ ...request, providerId: "logs", query: "logs-1" }, signal()),
      scheduler({ ...request, query: "metrics-2" }, signal()),
      scheduler({ ...request, providerId: "traces", query: "traces-1" }, signal()),
      scheduler({ ...request, providerId: "logs", query: "logs-2" }, signal()),
    ]
    // The other providers run in their queued order while metrics holds.
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual(["first", "logs-1", "traces-1", "logs-2"])
    await vi.advanceTimersByTimeAsync(2000)
    await Promise.all([first, ...queued])
    expect(calls).toEqual(["first", "logs-1", "traces-1", "logs-2", "first", "metrics-2"])
  })

  it("keeps other providers running while a provider-scoped refusal backs off", async () => {
    const calls: string[] = []
    let firstRefusals = 0
    const fetcher = vi.fn(async (r: QueryRequest) => {
      calls.push(r.query)
      if (r.query === "first" && firstRefusals++ === 0) {
        throw Object.assign(refusal("2"), { limitScope: "provider" })
      }
      return data
    })
    const scheduler = createQueryScheduler(fetcher, { concurrency: 1, cacheTTL: 0 })
    const signal = () => new AbortController().signal
    const first = scheduler({ ...request, query: "first" }, signal())
    const other = scheduler({ ...request, providerId: "logs", query: "other" }, signal())
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual(["first", "other"])
    // The refused first replays once its own provider's hold ends.
    await vi.advanceTimersByTimeAsync(2000)
    await Promise.all([first, other])
    expect(calls).toEqual(["first", "other", "first"])
  })

  it("re-drains the held provider when its hold ends, after the refused entry is cancelled", async () => {
    const calls: string[] = []
    const fetcher = vi.fn(async (r: QueryRequest) => {
      calls.push(r.query)
      if (r.query === "first") throw providerRefusal("2")
      return data
    })
    const scheduler = createQueryScheduler(fetcher, { concurrency: 1, cacheTTL: 0 })
    const refused = new AbortController()
    const first = scheduler({ ...request, query: "first" }, refused.signal).catch((error: unknown) => error)
    const second = scheduler({ ...request, query: "second" }, new AbortController().signal)
    // The first is refused and backs off for 2 s, holding its provider. The second queues behind the hold.
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual(["first"])
    // Cancelling the refused entry clears its replay timer, but the provider's hold stays in force.
    refused.abort()
    expect(await first).toMatchObject({ name: "AbortError" })
    // The hold timer re-drains the queue: the second starts at the hold's end, not before.
    await vi.advanceTimersByTimeAsync(1999)
    expect(calls).toEqual(["first"])
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toEqual(["first", "second"])
    expect(await second).toBe(data)
  })

  it("honours Retry-After within the plus-or-minus 30 percent jitter", async () => {
    vi.mocked(Math.random).mockReturnValue(0)
    const fetcher = vi.fn().mockRejectedValueOnce(refusal("2")).mockResolvedValueOnce(data)
    const scheduler = createQueryScheduler(fetcher, { cacheTTL: 0 })
    const pending = scheduler(request, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(1399)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toBe(data)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("replays a refusal at most three times, then settles with the refusal", async () => {
    const fetcher = vi.fn().mockRejectedValue(refusal("1"))
    const scheduler = createQueryScheduler(fetcher, { cacheTTL: 0 })
    const pending = scheduler(request, new AbortController().signal)
    const settled = pending.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(await settled).toMatchObject({ status: 429 })
  })

  it("settles at once when the server asks for longer than the replay cap", async () => {
    const fetcher = vi.fn().mockRejectedValue(refusal("30"))
    const scheduler = createQueryScheduler(fetcher, { cacheTTL: 0 })
    await expect(scheduler(request, new AbortController().signal)).rejects.toMatchObject({ status: 429 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("does not replay errors that are not capacity refusals", async () => {
    const fetcher = vi.fn().mockRejectedValue(Object.assign(new Error("provider unavailable"), { status: 502 }))
    const scheduler = createQueryScheduler(fetcher, { cacheTTL: 0 })
    await expect(scheduler(request, new AbortController().signal)).rejects.toThrow("provider unavailable")
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("stops replaying once the total backoff budget is spent", async () => {
    const fetcher = vi.fn().mockRejectedValue(refusal("10"))
    const scheduler = createQueryScheduler(fetcher, { cacheTTL: 0, maxCapacityWaitMs: 15_000 })
    const settled = scheduler(request, new AbortController().signal).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(await settled).toMatchObject({ status: 429 })
  })

  it("lets an identical widget join a query that is backing off", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(refusal("1")).mockResolvedValueOnce(data)
    const scheduler = createQueryScheduler(fetcher, { cacheTTL: 0 })
    const first = scheduler(request, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(0)
    const joined = scheduler(request, new AbortController().signal)
    // Half the 1 s backoff is the jitter's neutral point: both callers settle on the replay.
    await vi.advanceTimersByTimeAsync(1000)
    expect(await first).toBe(data)
    expect(await joined).toBe(data)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("cancels the replay timer when the last caller aborts during the wait", async () => {
    const fetcher = vi.fn().mockRejectedValue(refusal("5"))
    const scheduler = createQueryScheduler(fetcher, { cacheTTL: 0 })
    const controller = new AbortController()
    const pending = scheduler(request, controller.signal).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect(await pending).toMatchObject({ name: "AbortError" })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("records the replays and the backoff in the diagnostics ledger", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(refusal("2")).mockResolvedValueOnce(data)
    const scheduler = createQueryScheduler(fetcher, { cacheTTL: 0 })
    const pending = scheduler(request, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(0)
    const waiting = scheduler.diagnostics!.getSnapshot().at(-1)
    expect(waiting).toMatchObject({ state: "queued", attempts: 1, capacityWaitMs: 2000 })
    await vi.advanceTimersByTimeAsync(2000)
    await pending
    expect(scheduler.diagnostics!.getSnapshot().at(-1)).toMatchObject({ state: "complete", attempts: 1, capacityWaitMs: 2000 })
  })
})

describe("query client replay", () => {
  it("leaves an admission 429 to the caller when replayCapacity is false", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ error: "too many active queries; retry shortly" }, 429, { "Retry-After": "2" }))
    vi.stubGlobal("fetch", fetcher)
    const pending = createInsightsClient("/api/insights", () => "same-principal").query(request, new AbortController().signal, { replayCapacity: false })
    const failure = await pending.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(InsightsQueryError)
    expect(failure).toMatchObject({ status: 429, retryAfter: "2" })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it("keeps a known limit scope from the envelope and drops anything else", async () => {
    for (const [sent, kept] of [["provider", "provider"], ["principal", "principal"], ["gateway said hello", undefined], [42, undefined]] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: "busy", code: "rate_limited", limitScope: sent }, 429, { "Retry-After": "1" })))
      const failure = await createInsightsClient("/api/insights", () => "same-principal").query(request, new AbortController().signal, { replayCapacity: false }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(InsightsQueryError)
      expect((failure as InsightsQueryError).limitScope).toBe(kept)
    }
  })

  it("still replays inside the client by default", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ error: "busy" }, 429, { "Retry-After": "1" }))
      .mockResolvedValueOnce(response(data))
    vi.stubGlobal("fetch", fetcher)
    const pending = createInsightsClient("/api/insights", () => "same-principal").query(request, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(1300)
    expect(await pending).toEqual(data)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

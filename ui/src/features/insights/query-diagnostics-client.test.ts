import { afterEach, describe, expect, it, vi } from "vitest"
import { createInsightsClient, InsightsQueryError, type InsightsSession } from "./client"
import { parseQueryDiagnostics, type QueryDiagnostics, type QueryRequest } from "./schema"

const input: QueryRequest = { providerId: "metrics", kind: "metrics", query: "up", start: 1_794_310_000, end: 1_794_310_300, step: 15 }
const series = [{ name: "up", labels: { service: "checkout" }, points: [{ timestamp: input.start * 1000, value: 0 }, { timestamp: input.end * 1000, value: null }] }]

function receipt(overrides: Partial<QueryDiagnostics> = {}): QueryDiagnostics {
  return {
    version: 1,
    executionId: "execution-a",
    outcome: "success",
    source: { providerId: "metrics", providerType: "prometheus", transport: "direct" },
    requested: { start: input.start, end: input.end, step: input.step },
    effective: { start: input.start, end: input.end, step: input.step, dispatched: true, rangeApplied: true, scope: "provider" },
    phases: [
      { name: "admission", owner: "insights", clock: "server-monotonic", durationMs: 10, relationship: "exclusive" },
      { name: "upstream", owner: "insights", clock: "server-monotonic", durationMs: 800, relationship: "exclusive" },
      { name: "normalization", owner: "insights", clock: "server-monotonic", durationMs: 40, relationship: "exclusive" },
      { name: "provider", owner: "provider", clock: "unavailable", durationMs: null, relationship: "nested", parent: "upstream" },
    ],
    totalMs: 850,
    counts: { series: 1, points: 2, traces: 0, spans: 0, rows: 0 },
    truncated: false,
    ...overrides,
  }
}

function response(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } })
}

function mockFetch(...responses: Response[]) {
  const fetcher = vi.fn()
  responses.forEach(item => fetcher.mockResolvedValueOnce(item))
  vi.stubGlobal("fetch", fetcher)
  return fetcher
}

function query() {
  return createInsightsClient().query(input, new AbortController().signal)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("query diagnostic transport", () => {
  it("retains unknown provider timing separately from measured service phases and exact values", async () => {
    const diagnostics = receipt()
    const fetcher = mockFetch(response({ series, diagnostics }))
    const result = await query()
    expect(result).toEqual({ series, diagnostics })
    expect(result.diagnostics?.phases.at(-1)).toMatchObject({ durationMs: null, clock: "unavailable", relationship: "nested", parent: "upstream" })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it("retains a partial records receipt through record-frame normalization", async () => {
    const records = { columns: [{ key: "queue_seconds", type: "number", unit: "s" }], rows: [[0], [null], [0.94]], truncated: true }
    const diagnostics = receipt({ outcome: "partial", source: { providerId: "warehouse", providerType: "postgresql", transport: "gateway" }, counts: { series: 0, points: 0, traces: 0, spans: 0, rows: 3 }, truncated: true })
    mockFetch(response({ records, diagnostics }))
    const result = await createInsightsClient().query({ ...input, providerId: "warehouse", kind: "records" }, new AbortController().signal)
    expect(result).toEqual({ records, diagnostics, truncated: true })
    expect(result.records?.rows).toEqual([[0], [null], [0.94]])
  })

  it("strips unrecognized endpoint, credential and query fields at every receipt level", async () => {
    const safe = receipt()
    const diagnostics = {
      ...safe,
      query: "private expression",
      authorization: "Bearer should-not-be-retained",
      variables: { customer: "private customer" },
      source: { ...safe.source, url: "https://private.internal", headers: { Authorization: "private bearer" } },
      requested: { ...safe.requested, token: "private token" },
      effective: { ...safe.effective, endpoint: "https://private.internal" },
      phases: safe.phases.map(phase => ({ ...phase, rawError: "private upstream body" })),
      counts: { ...safe.counts, credential: "private credential" },
    }
    mockFetch(response({ series, diagnostics }))
    const result = await query()
    expect(result.diagnostics).toEqual(safe)
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/private|Bearer|credential|authorization/)
  })

  it.each([
    ["unknown version", { ...receipt(), version: 2 }],
    ["negative elapsed time", { ...receipt(), totalMs: -1 }],
    ["unbounded phase list", { ...receipt(), phases: Array.from({ length: 9 }, () => receipt().phases[0]) }],
    ["fractional result count", { ...receipt(), counts: { ...receipt().counts, series: 0.5 } }],
    ["credential URL in source identity", { ...receipt(), source: { ...receipt().source, providerId: "https://user:secret@private.internal" } }],
  ])("ignores an optional receipt with %s without losing valid query data", async (_name, diagnostics) => {
    mockFetch(response({ series, diagnostics }))
    expect(await query()).toEqual({ series })
  })

  it("accepts an older backend without receipts and rejects non-finite diagnostic values", async () => {
    mockFetch(response({ series }))
    expect(await query()).toEqual({ series })
    expect(parseQueryDiagnostics({ ...receipt(), totalMs: Number.POSITIVE_INFINITY })).toBeUndefined()
    expect(parseQueryDiagnostics({ ...receipt(), phases: [{ ...receipt().phases[0], durationMs: Number.NaN }] })).toBeUndefined()
  })

  it.each([
    ["measured provider time on an unavailable clock", { ...receipt().phases[3], durationMs: 800 }],
    ["provider work owned by Insights", { ...receipt().phases[3], owner: "insights" }],
    ["provider work charged as exclusive", { ...receipt().phases[3], relationship: "exclusive" }],
    ["provider work using the service clock", { ...receipt().phases[3], clock: "server-monotonic" }],
    ["provider work without its containing span", { ...receipt().phases[3], parent: undefined }],
    ["unmeasured service work labelled measured", { ...receipt().phases[0], durationMs: null }],
    ["service work charged as a nested span", { ...receipt().phases[0], relationship: "nested", parent: "upstream" }],
  ])("does not expose contradictory timing: %s", async (_name, phase) => {
    mockFetch(response({ series, diagnostics: { ...receipt(), phases: [phase] } }))
    expect(await query()).toEqual({ series })
  })

  it("rejects duplicate phases and overcharged elapsed time while allowing unmeasured overhead", () => {
    const complete = receipt()
    expect(parseQueryDiagnostics({ ...complete, phases: [...complete.phases, complete.phases[0]] })).toBeUndefined()
    expect(parseQueryDiagnostics({ ...complete, totalMs: 849.99 })).toBeUndefined()
    expect(parseQueryDiagnostics({ ...complete, totalMs: 849.9995 })?.totalMs).toBe(849.9995)
    expect(parseQueryDiagnostics({ ...complete, totalMs: 900 })?.totalMs).toBe(900)
  })

  it.each([
    [504, "timeout", "timeout"],
    [429, "rate_limited", "capacity"],
    [408, "canceled", "cancelled"],
    [403, "forbidden", "error"],
  ] as const)("retains typed HTTP %s failure identity and sanitized receipts without the raw body", async (status, code, outcome) => {
    const diagnostics = receipt({ outcome })
    delete diagnostics.counts
    const fetcher = mockFetch(response({ code, error: "Insights fixed message for this failure.", diagnostics: { ...diagnostics, body: "private upstream body" } }, status, { "Retry-After": "11" }))
    const error: unknown = await query().catch(error => error)
    expect(error).toBeInstanceOf(InsightsQueryError)
    // A recognised code selects its classified copy; the server's text is kept only when no code is sent.
    const copy: Record<string, string> = {
      timeout: "The query timed out. Narrow the time range or simplify the query and try again.",
      rate_limited: "Query capacity is busy; retry shortly.",
      canceled: "The query was cancelled.",
      forbidden: "Access to this data source was refused. Check its Observability permissions or provider credentials.",
    };
    expect(error).toMatchObject({ status, code, diagnostics, message: copy[code] });
    expect((error as InsightsQueryError).diagnostics?.counts).toBeUndefined()
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(/private/)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it("retains only the final execution receipt after a bounded capacity retry", async () => {
    vi.useFakeTimers()
    const denied = receipt({ executionId: "rejected-attempt", outcome: "capacity", counts: undefined })
    const completed = receipt({ executionId: "completed-attempt" })
    const fetcher = mockFetch(response({ code: "rate_limited", diagnostics: denied }, 429, { "Retry-After": "1" }), response({ series, diagnostics: completed }))
    const pending = query()
    // Replays are jittered by +-30% of Retry-After, so the longest wait is 1.3 s.
    await vi.advanceTimersByTimeAsync(1300)
    expect(await pending).toEqual({ series, diagnostics: completed })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][1].body).toBe(fetcher.mock.calls[0][1].body)
  })

  it("preserves admission rejection without claiming effective bounds or zero returned results", async () => {
    const diagnostics = receipt({
      outcome: "capacity",
      effective: { dispatched: false, rangeApplied: false, scope: "provider" },
      phases: [{ name: "admission", owner: "insights", clock: "server-monotonic", durationMs: 700, relationship: "exclusive" }],
      totalMs: 700,
    })
    delete diagnostics.counts
    mockFetch(response({ code: "rate_limited", diagnostics }, 429, { "Retry-After": "11" }))
    const error: unknown = await query().catch(error => error)
    expect(error).toMatchObject({ code: "rate_limited", diagnostics })
    expect((error as InsightsQueryError).diagnostics?.effective).toEqual({ dispatched: false, rangeApplied: false, scope: "provider" })
    expect((error as InsightsQueryError).diagnostics).not.toHaveProperty("counts")
  })

  it("ignores a receipt that assigns applied bounds to an undispatched request", async () => {
    mockFetch(response({ series, diagnostics: { ...receipt(), effective: { ...receipt().effective, dispatched: false } } }))
    expect(await query()).toEqual({ series })
  })

  it("classifies a direct provider failure by its code, not the server text", async () => {
    mockFetch(response({ code: "invalid_query", error: "provider query failed; check the query and provider configuration" }, 502))
    const rejected: unknown = await query().catch(error => error)
    expect(rejected).toMatchObject({ status: 502, code: "invalid_query", message: "The data source rejected this query. Check the expression and time bounds." })
    expect(String(rejected)).not.toContain("provider query failed")
  })

  it("keeps the server text for a failure with no recognised code", async () => {
    mockFetch(response({ error: "provider query failed; check the query and provider configuration" }, 400), response({ code: "unknown-code", error: "Gateway says no." }, 400))
    const plain: unknown = await query().catch(error => error)
    expect(plain).toMatchObject({ status: 400, message: "provider query failed; check the query and provider configuration" })
    const unknown: unknown = await query().catch(error => error)
    expect(unknown).toMatchObject({ status: 400, message: "Gateway says no." })
  })

  it("shows the envelope's own text, and falls back by code for unrecognized codes and proxy pages", async () => {
    mockFetch(response({ code: "private-credential", error: "Query failed at the data source.", diagnostics: { ...receipt(), totalMs: -1 } }, 502), new Response("private proxy body", { status: 504 }))
    const failure: unknown = await query().catch(error => error)
    expect(failure).toMatchObject({ status: 502, code: "provider_error", message: "Query failed at the data source.", diagnostics: undefined })
    const timeout: unknown = await query().catch(error => error)
    expect(timeout).toMatchObject({ status: 504, code: "timeout", message: "The query timed out. Narrow the time range or simplify the query and try again.", diagnostics: undefined })
    expect(String(timeout)).not.toContain("private")
  })

  it("uses the service-level copy for a 5xx without an envelope, and keeps the data-source copy for coded failures", async () => {
    mockFetch(new Response("no healthy upstream", { status: 503, headers: { "Content-Type": "text/plain" } }), new Response("upstream reset", { status: 500, headers: { "Content-Type": "text/plain" } }), response({ code: "provider_error" }, 502))
    const unavailable: unknown = await query().catch(error => error)
    expect(unavailable).toMatchObject({ status: 503, code: "provider_error", message: "Insights is unavailable. Check the service and provider configuration.", diagnostics: undefined })
    expect(String(unavailable)).not.toContain("no healthy upstream")
    const internal: unknown = await query().catch(error => error)
    expect(internal).toMatchObject({ status: 500, code: "provider_error", message: "Insights is unavailable. Check the service and provider configuration." })
    const coded: unknown = await query().catch(error => error)
    expect(coded).toMatchObject({ status: 502, code: "provider_error", message: "The data source could not complete this query. Retry, or check its connection." })
  })

  it("names a validation error as the request problem, not the data source", async () => {
    mockFetch(response({ error: "query must contain between 1 and 16384 bytes" }, 400))
    const failure: unknown = await query().catch(error => error)
    expect(failure).toMatchObject({ status: 400, code: "invalid_query", message: "query must contain between 1 and 16384 bytes" })
  })

  it("does not replace caller cancellation with a provider failure or receipt", async () => {
    const controller = new AbortController()
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    }))
    vi.stubGlobal("fetch", fetcher)
    const pending = createInsightsClient().query(input, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

describe("query receipt session isolation", () => {
  function host() {
    let bearer = "initial-token"
    let principal = "account-a:permissions-1"
    const session: InsightsSession = {
      ensureToken: vi.fn(async () => bearer),
      identity: () => principal,
      recoverUnauthorized: vi.fn(async () => { bearer = "renewed-token"; return bearer }),
      clearRejectedSession: vi.fn(),
    }
    const onUnauthorized = vi.fn()
    return {
      session,
      onUnauthorized,
      switchAccount: () => { bearer = "other-token"; principal = "account-b:permissions-2" },
      api: createInsightsClient("/api/insights", () => bearer, onUnauthorized, session),
    }
  }

  it("replays a read after same-principal renewal and exposes only the authorized final receipt", async () => {
    const { api, session } = host()
    const diagnostics = receipt()
    const fetcher = mockFetch(response({ error: "private rejected body", diagnostics: receipt({ executionId: "unauthorized" }) }, 401), response({ series, diagnostics }))
    const signal = new AbortController().signal
    expect(await api.query(input, signal)).toEqual({ series, diagnostics })
    expect(session.recoverUnauthorized).toHaveBeenCalledWith("initial-token")
    expect(fetcher.mock.calls[1][1].headers.get("Authorization")).toBe("Bearer renewed-token")
    expect(fetcher.mock.calls[1][1].signal).toBe(signal)
  })

  it.each([200, 504])("discards HTTP %s data and receipt if the account changes while its body loads", async status => {
    const { api, switchAccount, onUnauthorized } = host()
    let finish!: (value: unknown) => void
    const incoming = response({}, status)
    const json = vi.spyOn(incoming, "json").mockReturnValue(new Promise(resolve => { finish = resolve }))
    mockFetch(incoming)
    const pending = api.query(input, new AbortController().signal)
    await vi.waitFor(() => expect(json).toHaveBeenCalled())
    switchAccount()
    finish({ series, code: "timeout", diagnostics: receipt() })
    const error: unknown = await pending.catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toMatch(/session changed/)
    expect(error).not.toBeInstanceOf(InsightsQueryError)
    expect(error).not.toHaveProperty("diagnostics")
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it("does not publish a receipt or replay under another principal during renewal", async () => {
    const { api, session, switchAccount, onUnauthorized } = host()
    vi.mocked(session.recoverUnauthorized).mockImplementation(async () => { switchAccount(); return "other-token" })
    const fetcher = mockFetch(response({ diagnostics: receipt() }, 401))
    const error: unknown = await api.query(input, new AbortController().signal).catch(error => error)
    expect(String(error)).toMatch(/session changed/)
    expect(error).not.toHaveProperty("diagnostics")
    expect(fetcher).toHaveBeenCalledOnce()
    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})

describe("server result cache receipts", () => {
  const cachedPhase = { name: "cache" as const, owner: "insights" as const, clock: "server-monotonic" as const, durationMs: 1.2, relationship: "exclusive" as const }

  function cachedReceipt(status: "hit" | "joined", overrides: Partial<QueryDiagnostics> = {}): QueryDiagnostics {
    return receipt({
      effective: { dispatched: false, rangeApplied: false, scope: "provider" },
      phases: [cachedPhase],
      totalMs: 1.2,
      cache: { status, sourceExecutionId: "execution-a", ageMs: 120 },
      ...overrides,
    })
  }

  it("parses a cache hit and a join that made no provider request", () => {
    expect(parseQueryDiagnostics(cachedReceipt("hit"))?.cache).toEqual({ status: "hit", sourceExecutionId: "execution-a", ageMs: 120 })
    expect(parseQueryDiagnostics(cachedReceipt("joined"))?.cache?.status).toBe("joined")
  })

  it("rejects a cached delivery that claims a provider dispatch or an upstream phase", () => {
    expect(parseQueryDiagnostics(cachedReceipt("hit", { effective: { dispatched: true, rangeApplied: true, scope: "provider", start: input.start, end: input.end, step: input.step } }))).toBeUndefined()
    expect(parseQueryDiagnostics(cachedReceipt("joined", { phases: [cachedPhase, { name: "upstream", owner: "insights", clock: "server-monotonic", durationMs: 800, relationship: "exclusive" }] }))).toBeUndefined()
  })

  it("drops a malformed cache object and keeps the rest of the receipt", () => {
    const parsed = parseQueryDiagnostics(receipt({ cache: { status: "stale" } as unknown as QueryDiagnostics["cache"] }))
    expect(parsed).toBeDefined()
    expect(parsed?.cache).toBeUndefined()
  })

  it("sends the cache refresh header only when a refresh is asked for", async () => {
    const fetcher = mockFetch(response({ series, diagnostics: receipt() }), response({ series, diagnostics: receipt() }))
    await createInsightsClient().query(input, new AbortController().signal, { refresh: true })
    await createInsightsClient().query(input, new AbortController().signal)
    const refreshHeaders = new Headers(fetcher.mock.calls[0][1].headers)
    const plainHeaders = new Headers(fetcher.mock.calls[1][1].headers)
    expect(refreshHeaders.get("X-Insights-Cache")).toBe("refresh")
    expect(plainHeaders.get("X-Insights-Cache")).toBeNull()
  })
})

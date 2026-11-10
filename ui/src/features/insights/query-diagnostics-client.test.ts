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
    const fetcher = mockFetch(response({ code, error: "https://user:private-password@private.internal?token=private-token", diagnostics: { ...diagnostics, body: "private upstream body" } }, status, { "Retry-After": "11" }))
    const error: unknown = await query().catch(error => error)
    expect(error).toBeInstanceOf(InsightsQueryError)
    expect(error).toMatchObject({ status, code, diagnostics })
    expect((error as InsightsQueryError).diagnostics?.counts).toBeUndefined()
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toMatch(/private|https:|token=/)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it("retains only the final execution receipt after a bounded capacity retry", async () => {
    vi.useFakeTimers()
    const denied = receipt({ executionId: "rejected-attempt", outcome: "capacity", counts: undefined })
    const completed = receipt({ executionId: "completed-attempt" })
    const fetcher = mockFetch(response({ code: "rate_limited", diagnostics: denied }, 429, { "Retry-After": "1" }), response({ series, diagnostics: completed }))
    const pending = query()
    await vi.advanceTimersByTimeAsync(1000)
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

  it("uses a local fallback for unrecognized error codes and malformed proxy responses", async () => {
    mockFetch(response({ code: "private-credential", error: "private expression", diagnostics: { ...receipt(), totalMs: -1 } }, 502), new Response("private proxy body", { status: 504 }))
    const failure: unknown = await query().catch(error => error)
    expect(failure).toMatchObject({ status: 502, code: "provider_error", diagnostics: undefined })
    expect(`${String(failure)} ${JSON.stringify(failure)}`).not.toContain("private")
    const timeout: unknown = await query().catch(error => error)
    expect(timeout).toMatchObject({ status: 504, code: "timeout", diagnostics: undefined })
    expect(String(timeout)).not.toContain("private")
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

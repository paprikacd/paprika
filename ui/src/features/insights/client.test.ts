import { afterEach, describe, expect, it, vi } from "vitest"
import { createInsightsClient, type InsightsSession } from "./client"
import type { Dashboard, SavedQuery } from "./schema"

const dashboard: Dashboard = {
  schemaVersion: 1,
  id: "production",
  title: "Production",
  timeRange: "1h",
  refreshInterval: 0,
  widgets: [],
}
function response(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}
function mockFetch(...responses: Response[]) {
  const fetcher = vi.fn()
  responses.forEach((item) => fetcher.mockResolvedValueOnce(item))
  vi.stubGlobal("fetch", fetcher)
  return fetcher
}
afterEach(() => vi.unstubAllGlobals())

describe("Insights renewable sessions", () => {
  function host() {
    let bearer: string | null = "initial"
    let principal = "account-a:1"
    const session: InsightsSession = {
      ensureToken: vi.fn(async () => bearer),
      identity: () => principal,
      recoverUnauthorized: vi.fn(async () => { bearer = "renewed"; return bearer }),
      clearRejectedSession: vi.fn((rejected) => { if (rejected === bearer) { bearer = null; principal = "anonymous:2" } }),
    }
    const onUnauthorized = vi.fn()
    return {
      session, onUnauthorized,
      rotate: () => { bearer = "rotated" },
      switchAccount: () => { bearer = "other"; principal = "account-b:2" },
      api: createInsightsClient("/api/insights", () => bearer, onUnauthorized, session),
    }
  }

  it("waits for bootstrap and replays a read once with its exact ETag after renewal", async () => {
    const { api, session } = host()
    const fetcher = mockFetch(response({ dashboards: [dashboard] }, 200, { ETag: '"v1"' }), response({}, 401), new Response(null, { status: 304 }))
    const first = await api.list()
    expect(await api.list()).toBe(first)
    expect(session.ensureToken).toHaveBeenCalledTimes(2)
    expect(session.recoverUnauthorized).toHaveBeenCalledWith("initial")
    expect(fetcher.mock.calls[2][1].headers.get("Authorization")).toBe("Bearer renewed")
    expect(fetcher.mock.calls[2][1].headers.get("If-None-Match")).toBe('"v1"')
  })

  it("keeps same-account snapshots across token rotation and discards them on account change", async () => {
    const { api, rotate, switchAccount } = host()
    const fetcher = mockFetch(response({ dashboards: [dashboard] }, 200, { ETag: '"private"' }), new Response(null, { status: 304 }), response({ dashboards: [] }))
    const first = await api.list()
    rotate()
    expect(await api.list()).toBe(first)
    switchAccount()
    expect(await api.list()).toEqual([])
    expect(fetcher.mock.calls[2][1].headers.has("If-None-Match")).toBe(false)
  })

  it("never replays a dashboard write even after successful renewal", async () => {
    const { api, session, onUnauthorized } = host()
    const fetcher = mockFetch(response({}, 401))
    await expect(api.save(dashboard, '"v1"')).rejects.toThrow(/renewed.*retry/)
    expect(session.recoverUnauthorized).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0][1].headers.get("If-Match")).toBe('"v1"')
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it("replays read-only provider queries with their cancellation signal", async () => {
    const { api } = host()
    const fetcher = mockFetch(response({}, 401), response({ series: [] }))
    const signal = new AbortController().signal
    await api.query({ providerId: "metrics", query: "up", kind: "metrics", start: 1, end: 2, step: 1 }, signal)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][1].signal).toBe(signal)
  })

  it("retains the session and avoids login redirects during temporary renewal failure", async () => {
    const { api, session, onUnauthorized } = host()
    vi.mocked(session.recoverUnauthorized).mockRejectedValue(new Error("Session service temporarily unavailable"))
    mockFetch(response({}, 401))
    await expect(api.providers()).rejects.toThrow(/temporarily unavailable/)
    expect(session.clearRejectedSession).not.toHaveBeenCalled()
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it("stops after a second unauthorized response instead of looping", async () => {
    const { api, session, onUnauthorized } = host()
    const fetcher = mockFetch(response({}, 401), response({}, 401))
    await expect(api.providers()).rejects.toThrow(/Sign in/)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(session.clearRejectedSession).toHaveBeenCalledWith("renewed")
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it("does not replay a request after the user changes accounts during renewal", async () => {
    const { api, session, switchAccount, onUnauthorized } = host()
    vi.mocked(session.recoverUnauthorized).mockImplementation(async () => { switchAccount(); return "other" })
    const fetcher = mockFetch(response({}, 401))
    await expect(api.providers()).rejects.toThrow(/session changed/)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it("rejects provider data when an account changes while its response body loads", async () => {
    const { api, switchAccount } = host()
    let finish!: (value: unknown) => void
    const result = response({})
    const json = vi.spyOn(result, "json").mockReturnValue(new Promise(resolve => { finish = resolve }))
    mockFetch(result)
    const pending = api.providers()
    await vi.waitFor(() => expect(json).toHaveBeenCalled())
    switchAccount()
    finish({ providers: [{ id: "private-provider" }] })
    await expect(pending).rejects.toThrow(/session changed/)
  })
})

describe("Insights HTTP client", () => {
  it("discovers the authenticated Observe MCP connection and keeps cancellation wired", async () => {
    const connection = { configured: true, connected: true, transport: "mcp", providerCount: 2, protocolVersion: "2025-06-18", tools: [{ name: "query_metrics", description: "Run a metrics query" }] }
    const fetcher = mockFetch(response(connection), response({ providers: [{ id: "observe-metrics", name: "Metrics", type: "prometheus", transport: "mcp", capabilities: ["metrics"] }] }))
    const api = createInsightsClient("/api/insights", () => "session-token")
    const signal = new AbortController().signal
    expect(await api.observeConnection!(signal)).toEqual(connection)
    expect(fetcher.mock.calls[0][0]).toBe("/api/insights/observe-connection")
    expect(fetcher.mock.calls[0][1].signal).toBe(signal)
    expect(fetcher.mock.calls[0][1].headers.get("Authorization")).toBe("Bearer session-token")
    expect((await api.providers())[0].transport).toBe("mcp")
  })

  it("distinguishes a disabled Observe connection from denied access", async () => {
    const disabled = { configured: false, connected: false, transport: "mcp", providerCount: 0, tools: [] }
    mockFetch(response(disabled), response({ error: "private upstream detail" }, 403))
    const api = createInsightsClient()
    expect(await api.observeConnection!()).toEqual(disabled)
    await expect(api.observeConnection!()).rejects.toThrow("Your account does not have access to Paprika Observe. Check your Observability permissions.")
  })

  it("conditionally refreshes each library and reuses its validated 304 snapshot", async () => {
    const saved: SavedQuery = { schemaVersion: 1, id: "signal", name: "Signal", providerId: "metrics", kind: "metrics", query: "up" }
    const fetcher = mockFetch(
      response({ dashboards: [dashboard] }, 200, { ETag: '\"d1\"' }),
      response({ queries: [{ ...saved, etag: '\"q1\"' }] }, 200, { ETag: '\"library1\"' }),
      new Response(null, { status: 304 }), new Response(null, { status: 304 }),
    )
    const api = createInsightsClient()
    const dashboards = await api.list(), queries = await api.listSavedQueries()
    expect(await api.list()).toBe(dashboards)
    expect(await api.listSavedQueries()).toBe(queries)
    expect(fetcher.mock.calls[2][1].headers.get("If-None-Match")).toBe('\"d1\"')
    expect(fetcher.mock.calls[3][1].headers.get("If-None-Match")).toBe('\"library1\"')
  })

  it("revalidates active dashboard ETags even when the canonical contents are unchanged", async () => {
    const fetcher = mockFetch(
      response(dashboard, 200, { ETag: '\"d1\"' }),
      response({ ...dashboard }, 200, { ETag: '\"d2\"' }),
      new Response(null, { status: 304 }),
    )
    const api = createInsightsClient()
    expect((await api.get(dashboard.id)).etag).toBe('\"d1\"')
    expect((await api.get(dashboard.id)).etag).toBe('\"d2\"')
    expect((await api.get(dashboard.id)).etag).toBe('\"d2\"')
    expect(fetcher.mock.calls[1][1].headers.get("If-None-Match")).toBe('\"d1\"')
    expect(fetcher.mock.calls[2][1].headers.get("If-None-Match")).toBe('\"d2\"')
  })

  it("keeps compressed HTTP validators separate from strong dashboard write revisions", async () => {
    const fetcher = mockFetch(
      response(dashboard, 200, { ETag: 'W/"d1"', "X-Paprika-Document-ETag": '"d1"' }),
      new Response(null, { status: 304, headers: { ETag: 'W/"d1"' } }),
      response({}, 200, { ETag: 'W/"d2"', "X-Paprika-Document-ETag": '"d2"' }),
      new Response(null, { status: 204 }),
    )
    const api = createInsightsClient()
    const loaded = await api.get(dashboard.id)
    expect(loaded.etag).toBe('"d1"')
    const revalidated = await api.get(dashboard.id)
    expect(revalidated).toBe(loaded)
    expect(revalidated.etag).toBe('"d1"')
    expect(fetcher.mock.calls[1][1].headers.get("If-None-Match")).toBe('W/"d1"')
    const nextTag = await api.save({ ...dashboard, title: "Edited from the UI" }, revalidated.etag)
    expect(fetcher.mock.calls[2][1].headers.get("If-Match")).toBe('"d1"')
    expect(nextTag).toBe('"d2"')
    await api.remove(dashboard.id, nextTag)
    expect(fetcher.mock.calls[3][1].headers.get("If-Match")).toBe('"d2"')
  })

  it("uses exact saved-query document revisions for updates and deletes through compression", async () => {
    const saved: SavedQuery = { schemaVersion: 1, id: "signal", name: "Signal", providerId: "metrics", kind: "metrics", query: "up" }
    const fetcher = mockFetch(
      response(saved, 200, { ETag: 'W/"q1"', "X-Paprika-Document-ETag": '"q1"' }),
      response({}, 200, { ETag: 'W/"q2"', "X-Paprika-Document-ETag": '"q2"' }),
      new Response(null, { status: 204 }),
    )
    const api = createInsightsClient()
    const loaded = await api.getSavedQuery(saved.id)
    expect(loaded.etag).toBe('"q1"')
    const nextTag = await api.saveSavedQuery({ ...saved, description: "Edited from the UI" }, loaded.etag)
    expect(fetcher.mock.calls[1][1].headers.get("If-Match")).toBe('"q1"')
    expect(nextTag).toBe('"q2"')
    await api.removeSavedQuery(saved.id, nextTag)
    expect(fetcher.mock.calls[2][1].headers.get("If-Match")).toBe('"q2"')
  })

  it("never reuses a previous account's cached library", async () => {
    let bearer: string | null = "first-account"
    const fetcher = mockFetch(
      response({ dashboards: [dashboard] }, 200, { ETag: '\"private\"' }),
      response({ dashboards: [] }, 200, { ETag: '\"empty\"' }),
      new Response(null, { status: 304 }),
    )
    const api = createInsightsClient("/api/insights", () => bearer)
    await api.list()
    bearer = null
    expect(await api.list()).toEqual([])
    expect(fetcher.mock.calls[1][1].headers.has("If-None-Match")).toBe(false)
    expect(fetcher.mock.calls[1][1].headers.has("Authorization")).toBe(false)
    expect(await api.list()).toEqual([])
    expect(fetcher.mock.calls[2][1].headers.get("If-None-Match")).toBe('\"empty\"')
  })

  it("does not let an earlier library response replace a newer conditional cache", async () => {
    const fetcher = vi.fn()
    let finish!: (response: Response) => void
    fetcher.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve }))
    fetcher.mockResolvedValueOnce(response({ dashboards: [{ ...dashboard, title: "New version" }] }, 200, { ETag: '\"new\"' }))
    fetcher.mockResolvedValueOnce(new Response(null, { status: 304 }))
    vi.stubGlobal("fetch", fetcher)
    const api = createInsightsClient()
    const pending = api.list()
    await api.list()
    finish(response({ dashboards: [dashboard] }, 200, { ETag: '\"old\"' }))
    await pending
    expect((await api.list())[0].title).toBe("New version")
    expect(fetcher.mock.calls[2][1].headers.get("If-None-Match")).toBe('\"new\"')
  })

  it("rejects an old account's response when the session changes in flight", async () => {
    let bearer = "first-account"
    let finish!: (response: Response) => void
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>(resolve => { finish = resolve })))
    const api = createInsightsClient("/api/insights", () => bearer)
    const pending = api.list()
    bearer = "second-account"
    finish(response({ dashboards: [dashboard] }, 200, { ETag: '\"private\"' }))
    await expect(pending).rejects.toThrow(/session changed/)
  })

  it("does not cache a response from an aborted library refresh", async () => {
    const controller = new AbortController()
    const fetcher = mockFetch(response({ dashboards: [dashboard] }, 200, { ETag: '\"old\"' }), response({ dashboards: [] }))
    const api = createInsightsClient()
    const pending = api.list(controller.signal)
    controller.abort()
    await pending
    expect(await api.list()).toEqual([])
    expect(fetcher.mock.calls[1][1].headers.has("If-None-Match")).toBe(false)
  })

  it("uses per-provider ETags without sending response metadata or resolved credentials", async () => {
    const fetcher = mockFetch(
      response({}),
      response({}),
      response({ values: ["http_requests_total"] }),
    )
    const client = createInsightsClient()
    await client.saveProvider({
      id: "metrics",
      name: "Metrics",
      type: "prometheus",
      url: "http://metrics:9090",
      managed: true,
      etag: '"p1"',
      bearerTokenEnv: "PAPRIKA_PROVIDER_TOKEN",
    })
    expect(fetcher.mock.calls[0][1].headers.get("If-Match")).toBe('"p1"')
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      id: "metrics",
      name: "Metrics",
      type: "prometheus",
      url: "http://metrics:9090",
      bearerTokenEnv: "PAPRIKA_PROVIDER_TOKEN",
    })
    await client.removeProvider("metrics", '"p2"')
    expect(fetcher.mock.calls[1][1].headers.get("If-Match")).toBe('"p2"')
    const controller = new AbortController()
    await client.metadata(
      "metrics",
      { kind: "values", label: "service", metric: "http_requests_total" },
      controller.signal,
    )
    expect(fetcher.mock.calls[2][0]).toBe(
      "/api/insights/providers/metrics/metadata?kind=values&label=service&metric=http_requests_total",
    )
    expect(fetcher.mock.calls[2][1].signal).toBe(controller.signal)
  })
  it("distinguishes provider administration from dashboard access and preserves provider conflicts", async () => {
    mockFetch(
      response({ error: "denied" }, 403),
      response({ error: "Provisioned providers are immutable" }, 409),
    )
    const client = createInsightsClient()
    await expect(client.providerConfigs()).rejects.toThrow(/administrator access/)
    await expect(client.removeProvider("metrics")).rejects.toThrow(
      "Provisioned providers are immutable",
    )
  })
  it("explains provider permissions without misreporting the whole workspace as inaccessible", async () => {
    mockFetch(response({ error: "forbidden" }, 403), response({ error: "forbidden" }, 403))
    const client = createInsightsClient()
    await expect(client.query({ providerId: "observe-shared", query: "up", kind: "metrics", start: 1000, end: 1100, step: 10 }, new AbortController().signal)).rejects.toThrow(/data source.*Observability permissions/)
    await expect(client.metadata("observe-shared", { kind: "metrics" })).rejects.toThrow(/data source.*Observability permissions/)
  })

  it("reads the current authentication token for each request", async () => {
    const fetcher = mockFetch(response({ providers: [] }), response({ providers: [] }))
    let token = "old-token"
    const client = createInsightsClient("/api/insights", () => token)
    await client.providers()
    expect(fetcher.mock.calls[0][1].headers.get("Authorization")).toBe("Bearer old-token")
    token = "new-token"
    await client.providers()
    expect(fetcher.mock.calls[1][1].headers.get("Authorization")).toBe("Bearer new-token")
  })

  it("does not send a bearer header when no user token exists", async () => {
    const fetcher = mockFetch(response({ providers: [] }))
    await createInsightsClient("/api/insights", () => null).providers()
    expect(fetcher.mock.calls[0][1].headers.has("Authorization")).toBe(false)
  })

  it("carries ETags from reads and uses conditional create/update/delete", async () => {
    const fetcher = mockFetch(
      response(dashboard, 200, { ETag: '"v1"' }),
      response({}, 200, { ETag: '"v2"' }),
      response({}, 201, { ETag: '"new"' }),
      response({}),
    )
    const client = createInsightsClient()
    const loaded = await client.get(dashboard.id)
    expect(loaded).toEqual({ dashboard, etag: '"v1"' })
    expect(await client.save(dashboard, loaded.etag)).toBe('"v2"')
    expect(fetcher.mock.calls[1][1].headers.get("If-Match")).toBe('"v1"')
    expect(fetcher.mock.calls[1][1].headers.has("If-None-Match")).toBe(false)
    await client.save(dashboard)
    expect(fetcher.mock.calls[2][1].headers.get("If-None-Match")).toBe("*")
    await client.remove(dashboard.id, '"v2"')
    expect(fetcher.mock.calls[3][1].headers.get("If-Match")).toBe('"v2"')
    expect(fetcher.mock.calls[3][1].method).toBe("DELETE")
  })

  it.each([409, 412])("surfaces HTTP %s as a concurrent editing conflict", async (status) => {
    mockFetch(response({ error: "conflict" }, status))
    await expect(createInsightsClient().save(dashboard, '"old"')).rejects.toThrow(
      /changed on the server/,
    )
  })

  it.each([
    [401, /Sign in/],
    [403, /does not have access/],
  ] as const)(
    "reports HTTP %s authentication and authorization failures",
    async (status, message) => {
      mockFetch(response({ error: "denied" }, status))
      await expect(createInsightsClient().list()).rejects.toThrow(message)
    },
  )

  it("asks the host to sign in once across concurrent unauthorized requests", async () => {
    mockFetch(response({}, 401), response({}, 401), response({}, 401))
    const onUnauthorized = vi.fn()
    const api = createInsightsClient("/api/insights", () => null, onUnauthorized)
    const outcomes = await Promise.allSettled([api.providers(), api.list(), api.listSavedQueries()])
    expect(outcomes.every(result => result.status === "rejected" && /Sign in/.test(result.reason.message))).toBe(true)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it("keeps forbidden responses local instead of restarting login", async () => {
    mockFetch(response({}, 403))
    const onUnauthorized = vi.fn()
    await expect(createInsightsClient("/api/insights", () => "valid-token", onUnauthorized).list()).rejects.toThrow(/does not have access/)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it("does not sign out a new session when an older request returns unauthorized", async () => {
    let token = "old-token"
    let respond!: (value: Response) => void
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { respond = resolve })))
    const onUnauthorized = vi.fn()
    const pending = createInsightsClient("/api/insights", () => token, onUnauthorized).list()
    token = "new-token"
    respond(response({}, 401))
    await expect(pending).rejects.toThrow(/Sign in/)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it("validates dashboard documents on both read and write", async () => {
    const fetcher = mockFetch(
      response({ ...dashboard, schemaVersion: 22 }),
      response({ dashboards: [{ ...dashboard, script: "x" }] }),
    )
    const client = createInsightsClient()
    await expect(client.get(dashboard.id)).rejects.toThrow()
    await expect(client.list()).rejects.toThrow()
    await expect(client.save({ ...dashboard, title: "" })).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("passes cancellation to provider queries and sends only the provider id", async () => {
    const fetcher = mockFetch(response({ series: [] }))
    const controller = new AbortController()
    const query = {
      providerId: "prometheus",
      query: "up",
      kind: "metrics" as const,
      start: 1000,
      end: 1100,
      step: 10,
    }
    await createInsightsClient().query(query, controller.signal)
    expect(fetcher.mock.calls[0][0]).toBe("/api/insights/query")
    expect(fetcher.mock.calls[0][1].signal).toBe(controller.signal)
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(query)
  })

  it("returns a useful error for non-JSON gateway failures", async () => {
    mockFetch(new Response("Bad gateway", { status: 502 }))
    await expect(createInsightsClient().providers()).rejects.toThrow(/Insights is unavailable/)
  })
})


describe("saved query HTTP contracts", () => {
  const saved: SavedQuery = { schemaVersion: 1, id: "service-rate", name: "Service rate", providerId: "metrics", kind: "metrics", query: "up{service={{service}}}", parameters: [{ name: "service", type: "string" }] }
  it("reads documents and ETags and uses conditional creates, updates and deletes", async () => {
    const fetcher = mockFetch(response({ queries: [{ ...saved, etag: '\"v1\"' }] }), response(saved, 200, { ETag: '\"v1\"' }), response({}, 201, { ETag: '\"new\"' }), response({}, 200, { ETag: '\"v2\"' }), response({}))
    const api = createInsightsClient()
    const signal = new AbortController().signal
    expect(await api.listSavedQueries(signal)).toEqual([{ ...saved, etag: '\"v1\"' }])
    expect(fetcher.mock.calls[0][1].signal).toBe(signal)
    expect(await api.getSavedQuery(saved.id)).toEqual({ query: saved, etag: '\"v1\"' })
    expect(await api.saveSavedQuery(saved)).toBe('\"new\"')
    expect(fetcher.mock.calls[2][1].headers.get("If-None-Match")).toBe("*")
    expect(await api.saveSavedQuery(saved, '\"v1\"')).toBe('\"v2\"')
    expect(fetcher.mock.calls[3][1].headers.get("If-Match")).toBe('\"v1\"')
    expect(JSON.parse(fetcher.mock.calls[3][1].body)).toEqual(saved)
    await api.removeSavedQuery(saved.id, '\"v2\"')
    expect(fetcher.mock.calls[4][1].headers.get("If-Match")).toBe('\"v2\"')
  })
  it("rejects malformed templates and unresolved references before network execution", async () => {
    const fetcher = mockFetch()
    const api = createInsightsClient()
    await expect(api.saveSavedQuery({ ...saved, query: 'up{service="{{service}}"}' })).rejects.toThrow()
    await expect(api.removeSavedQuery(saved.id)).rejects.toThrow(/Reload/)
    await expect(api.query({ providerId: "metrics", query: "up", queryRef: { id: saved.id }, kind: "metrics", start: 1000, end: 1100, step: 10 }, new AbortController().signal)).rejects.toThrow(/Resolve/)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("preserves in-use errors and explains conflicting edits", async () => {
    mockFetch(response({ error: "used by dashboard production" }, 409), response({ error: "conflict" }, 412))
    const api = createInsightsClient()
    await expect(api.removeSavedQuery(saved.id, '\"old\"')).rejects.toThrow(/used by dashboard/)
    await expect(api.saveSavedQuery(saved, '\"old\"')).rejects.toThrow(/saved query changed on the server/)
  })
  it("validates every document returned by the library", async () => {
    mockFetch(response({ queries: [{ ...saved, code: "unexpected" }] }), response({ ...saved, parameters: [{ name: "factor", type: "number", defaultValue: "1" }] }))
    const api = createInsightsClient()
    await expect(api.listSavedQueries()).rejects.toThrow()
    await expect(api.getSavedQuery(saved.id)).rejects.toThrow()
  })
})

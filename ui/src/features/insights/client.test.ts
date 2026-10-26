import { afterEach, describe, expect, it, vi } from "vitest"
import { createInsightsClient } from "./client"
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

describe("Insights HTTP client", () => {
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

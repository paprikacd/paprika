import { describe, expect, it, vi } from "vitest"
import { createBundleImporter, type BundleImportEnvironment, type BundleImportRequest } from "./bundle-import"
import { buildDashboardBundle, savedQueryFingerprint } from "./workspace-transfer"
import { documentFingerprint } from "./fingerprint"
import type { Dashboard, Provider, SavedQuery } from "./schema"

const providers: Provider[] = [
  { id: "prom", name: "Metrics", type: "prometheus", capabilities: ["metrics"] },
  { id: "other", name: "Other metrics", type: "prometheus", capabilities: ["metrics"] },
]
const query: SavedQuery = {
  schemaVersion: 1, id: "requests", name: "Requests", providerId: "source", kind: "metrics",
  description: "Production request throughput", imageUrl: "/images/requests.png", tags: ["production", "traffic"], metadata: { team: "platform", runbook: "https://docs.example.com/requests" },
  query: "rate(requests{service={{service}}}[5m])", parameters: [{ name: "service", type: "string", defaultValue: "api" }],
}
const dashboard: Dashboard = {
  schemaVersion: 1, id: "overview", title: "Overview", timeRange: "1h", refreshInterval: 0,
  variables: [{ name: "service", defaultValue: "api" }],
  widgets: [{
    id: "requests", title: "Requests", type: "timeseries", providerId: "dormant", query: "retained_custom_query", unit: "rps",
    layout: { x: 0, y: 0, w: 6, h: 4 },
    queryRef: { id: query.id, bindings: [{ parameter: "service", source: "variable", variable: "service" }] },
    options: { tooltipView: { type: "bar", source: { type: "saved", ref: { id: query.id, bindings: [{ parameter: "service", source: "label", label: "service" }] } } } },
  }],
}
function request(documents = [dashboard], definitions = [query]): BundleImportRequest {
  return { sessionId: "session", bundle: buildDashboardBundle(documents, definitions), providerMapping: { source: "prom" }, queryChoices: {} }
}
function fixture(initialQueries: SavedQuery[] = []) {
  const queries = new Map(initialQueries.map(item => [item.id, structuredClone(item)]))
  const dashboards = new Map<string, Dashboard>()
  const events: string[] = []
  const client: BundleImportEnvironment["client"] = {
    list: vi.fn(async () => [...dashboards.values()].map(item => structuredClone(item))),
    listSavedQueries: vi.fn(async () => [...queries.values()].map(item => ({ ...structuredClone(item), etag: "query-etag" }))),
    getSavedQuery: vi.fn(async id => {
      events.push(`get-query:${id}`)
      const item = queries.get(id)
      if (!item) throw new Error("Query not found")
      return { query: structuredClone(item), etag: "query-etag" }
    }),
    saveSavedQuery: vi.fn(async (item, etag) => {
      events.push(`save-query:${item.id}`)
      if (queries.has(item.id) ? etag !== "query-etag" : etag !== undefined) throw new Error("Conditional write conflict")
      queries.set(item.id, structuredClone(item))
      return "query-etag"
    }),
    save: vi.fn(async (item, etag) => {
      events.push(`save-dashboard:${item.id}`)
      if (dashboards.has(item.id) ? etag !== "dashboard-etag" : etag !== undefined) throw new Error("Conditional write conflict")
      dashboards.set(item.id, structuredClone(item))
      return "dashboard-etag"
    }),
    get: vi.fn(async id => {
      const item = dashboards.get(id)
      if (!item) throw new Error("Dashboard not found")
      return { dashboard: structuredClone(item), etag: "dashboard-etag" }
    }),
  }
  const environment: BundleImportEnvironment = {
    client, providers, dashboards: [], onQueriesChange: vi.fn(),
    onDashboardSaved: vi.fn(item => { environment.dashboards = [...environment.dashboards.filter(saved => saved.id !== item.id), item] }),
  }
  return { queries, dashboards, events, client, environment, run: createBundleImporter() }
}

describe("portable bundle persistence", () => {
  it("creates a shared dependency once before its dashboard, preserving typed templates and both bindings", async () => {
    const f = fixture()
    const result = await f.run(request(), f.environment)
    expect(result).toMatchObject({ complete: true, added: 1, totalAdded: 1, queriesAdded: 1, queriesReused: 0, errors: [] })
    expect(f.queries.get(query.id)).toEqual({ ...query, providerId: "prom" })
    const saved = [...f.dashboards.values()][0]
    expect(saved.id).not.toBe(dashboard.id)
    expect(saved.widgets).toEqual(dashboard.widgets)
    expect(f.events).toEqual([`save-query:${query.id}`, `get-query:${query.id}`, `save-dashboard:${saved.id}`])
    expect(f.environment.onDashboardSaved).toHaveBeenCalledWith(saved, "dashboard-etag")
    expect(await f.run(request(), f.environment)).toMatchObject({ complete: true, added: 0, totalAdded: 1 })
    expect(f.client.save).toHaveBeenCalledTimes(1)
  })

  it("reuses identical mapped definitions without a write and copies conflicts with both references updated", async () => {
    const identical = fixture([{ ...query, providerId: "prom" }])
    const reuse = request(); reuse.queryChoices = { requests: "reuse" }
    expect(await identical.run(reuse, identical.environment)).toMatchObject({ complete: true, queriesReused: 1, queriesAdded: 0 })
    expect(identical.client.saveSavedQuery).not.toHaveBeenCalled()
    const original = { ...query, providerId: "prom", query: "different_existing_query" }
    const f = fixture([original])
    expect(await f.run(request(), f.environment)).toMatchObject({ complete: false, added: 0 })
    expect(f.client.save).not.toHaveBeenCalled()
    const copy = request(); copy.queryChoices = { requests: "copy" }
    expect(await f.run(copy, f.environment)).toMatchObject({ complete: true, queriesAdded: 1 })
    const saved = [...f.dashboards.values()][0]
    const id = saved.widgets[0].queryRef!.id
    expect(id).not.toBe(query.id)
    expect(saved.widgets[0].options?.tooltipView?.source).toMatchObject({ type: "saved", ref: { id } })
    expect(f.queries.get(id)).toEqual({ ...query, providerId: "prom", id })
    expect(f.queries.get(query.id)).toEqual(original)
  })

  it("recovers successful writes whose acknowledgements were lost", async () => {
    const f = fixture()
    vi.mocked(f.client.saveSavedQuery).mockImplementationOnce(async item => { f.queries.set(item.id, item); throw new Error("Connection lost") })
    vi.mocked(f.client.save).mockImplementationOnce(async item => { f.dashboards.set(item.id, item); throw new Error("Connection lost") })
    expect(await f.run(request(), f.environment)).toMatchObject({ complete: true, added: 1, queriesAdded: 1, errors: [] })
    expect(f.queries.size).toBe(1)
    expect(f.dashboards.size).toBe(1)
  })

  it("retains allocated query and dashboard IDs when confirmation also fails, then recovers on retry", async () => {
    const f = fixture()
    const copy = request(); copy.queryChoices = { requests: "copy" }
    vi.mocked(f.client.saveSavedQuery).mockImplementationOnce(async item => { f.queries.set(item.id, item); throw new Error("Query response lost") })
    vi.mocked(f.client.getSavedQuery).mockRejectedValueOnce(new Error("Query confirmation unavailable"))
    expect(await f.run(copy, f.environment)).toMatchObject({ complete: false, added: 0 })
    const queryId = [...f.queries.keys()][0]
    vi.mocked(f.client.save).mockImplementationOnce(async item => { f.dashboards.set(item.id, item); throw new Error("Dashboard response lost") })
    vi.mocked(f.client.get).mockRejectedValueOnce(new Error("Dashboard confirmation unavailable"))
    expect(await f.run(copy, f.environment)).toMatchObject({ complete: false, added: 0, queriesReused: 1 })
    const dashboardId = [...f.dashboards.keys()][0]
    expect(await f.run(copy, f.environment)).toMatchObject({ complete: true, added: 1, queriesReused: 1 })
    expect([...f.queries.keys()]).toEqual([queryId])
    expect([...f.dashboards.keys()]).toEqual([dashboardId])
    expect(f.client.saveSavedQuery).toHaveBeenCalledTimes(1)
  })

  it("allows independent success, preserves cross-dashboard drilldowns and retries only the remaining document", async () => {
    const f = fixture()
    const first = structuredClone(dashboard)
    first.widgets[0].drilldowns = [{ id: "details", title: "Details", dashboardId: "detail" }]
    const second = { ...dashboard, id: "detail", title: "Detail" }
    const batch = request([first, second])
    const save = f.client.save
    vi.mocked(f.client.save).mockImplementationOnce(async () => { throw new Error("First dashboard unavailable") })
    const result = await f.run(batch, f.environment)
    expect(result).toMatchObject({ complete: false, added: 1, totalAdded: 1, failed: [first] })
    const detailId = [...f.dashboards.keys()][0]
    const firstId = vi.mocked(save).mock.calls[0][0].id
    expect(await f.run(batch, f.environment)).toMatchObject({ complete: true, added: 1, totalAdded: 2 })
    expect(f.dashboards.get(firstId)?.widgets[0].drilldowns?.[0].dashboardId).toBe(detailId)
    expect(f.client.save).toHaveBeenCalledTimes(3)
  })

  it("does not save dashboards whose own dependency failed while importing unrelated dashboards", async () => {
    const f = fixture()
    const otherQuery = { ...query, id: "other-query" }
    const otherDashboard = structuredClone(dashboard)
    otherDashboard.id = "other-dashboard"
    otherDashboard.widgets[0].queryRef = { id: otherQuery.id }
    delete otherDashboard.widgets[0].options
    vi.mocked(f.client.saveSavedQuery).mockRejectedValueOnce(new Error("Query denied"))
    expect(await f.run(request([dashboard, otherDashboard], [query, otherQuery]), f.environment)).toMatchObject({ complete: false, added: 1, failed: [dashboard] })
    expect([...f.dashboards.values()][0].widgets[0].queryRef?.id).toBe(otherQuery.id)
  })

  it("allows remapping a remaining copied dependency without changing a previously created query", async () => {
    const f = fixture()
    const copy = request(); copy.queryChoices = { requests: "copy" }
    vi.mocked(f.client.save).mockRejectedValueOnce(new Error("Dashboard unavailable"))
    expect(await f.run(copy, f.environment)).toMatchObject({ complete: false, queriesAdded: 1 })
    const firstQueryId = [...f.queries.keys()][0]
    expect(await f.run({ ...copy, providerMapping: { source: "other" } }, f.environment)).toMatchObject({ complete: true, queriesAdded: 1 })
    expect(f.queries.get(firstQueryId)?.providerId).toBe("prom")
    const nextQueryId = [...f.dashboards.values()][0].widgets[0].queryRef!.id
    expect(nextQueryId).not.toBe(firstQueryId)
    expect(f.queries.get(nextQueryId)?.providerId).toBe("other")
  })

  it("rejects reuse changes, conditional-create collisions, and edits between query preparation and dashboard persistence", async () => {
    const changed = { ...query, providerId: "prom", query: "changed_query" }
    const f = fixture([{ ...query, providerId: "prom" }])
    vi.mocked(f.client.getSavedQuery).mockResolvedValueOnce({ query: changed })
    const reuse = request(); reuse.queryChoices = { requests: "reuse" }
    expect(await f.run(reuse, f.environment)).toMatchObject({ complete: false, added: 0 })
    expect(f.client.save).not.toHaveBeenCalled()
    const g = fixture()
    vi.mocked(g.client.saveSavedQuery).mockImplementationOnce(async item => { g.queries.set(item.id, changed); throw new Error("Conditional create conflict") })
    expect(await g.run(request(), g.environment)).toMatchObject({ complete: false, added: 0 })
    expect(g.client.save).not.toHaveBeenCalled()
    const h = fixture()
    vi.mocked(h.client.getSavedQuery).mockResolvedValueOnce({ query: changed })
    expect(await h.run(request(), h.environment)).toMatchObject({ complete: false, added: 0 })
    expect(h.client.save).not.toHaveBeenCalled()
  })

  it("resolves legacy references from the destination and rejects missing or incompatible dependencies", async () => {
    const legacy = { ...request(), bundle: { dashboards: [dashboard] } }
    const f = fixture([{ ...query, providerId: "prom" }])
    expect(await f.run(legacy, f.environment)).toMatchObject({ complete: true, added: 1 })
    expect(f.client.saveSavedQuery).not.toHaveBeenCalled()
    const missing = fixture()
    expect(await missing.run(legacy, missing.environment)).toMatchObject({ complete: false, added: 0 })
    const invalid = fixture([{ ...query, providerId: "prom", parameters: [{ name: "different", type: "string", defaultValue: "x" }], query: "up{job={{different}}}" }])
    expect(await invalid.run(legacy, invalid.environment)).toMatchObject({ complete: false, added: 0 })
    expect(invalid.client.save).not.toHaveBeenCalled()
  })

  it("validates size, provider mapping and unchanged session source before any write", async () => {
    const f = fixture()
    f.environment.dashboards = Array.from({ length: 100 }, (_, index) => ({ ...dashboard, id: `existing-${index}` }))
    await expect(f.run(request(), f.environment)).rejects.toThrow("up to 100")
    f.environment.dashboards = []
    await expect(f.run({ ...request(), providerMapping: {} }, f.environment)).rejects.toThrow()
    await expect(f.run(request([{ ...dashboard, title: "Changed source" }]), f.environment)).rejects.toThrow("document changed")
    expect(f.client.saveSavedQuery).not.toHaveBeenCalled()
    expect(f.client.save).not.toHaveBeenCalled()
  })

  it("imports custom-only dashboards without requiring or clearing the saved-query library", async () => {
    const f = fixture()
    vi.mocked(f.client.listSavedQueries).mockRejectedValue(new Error("Library unavailable"))
    const custom = structuredClone(dashboard)
    delete custom.widgets[0].queryRef
    delete custom.widgets[0].options
    custom.widgets[0].providerId = "source"
    expect(await f.run(request([custom], []), f.environment)).toMatchObject({ complete: true, added: 1 })
    expect(f.client.listSavedQueries).not.toHaveBeenCalled()
    expect(f.environment.onQueriesChange).not.toHaveBeenCalled()
  })

  it("guards simultaneous attempts and releases the guard after a read failure", async () => {
    const f = fixture()
    let reject!: (reason: Error) => void
    vi.mocked(f.client.listSavedQueries).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    const pending = f.run(request(), f.environment)
    await expect(f.run(request(), f.environment)).rejects.toThrow("current import")
    await vi.waitFor(() => expect(reject).toBeDefined())
    reject(new Error("Library unavailable"))
    await expect(pending).rejects.toThrow("Library unavailable")
    expect(await f.run(request(), f.environment)).toMatchObject({ complete: true })
  })
})


describe("reviewed import updates", () => {
  function existing() {
    const currentQuery = { ...query, providerId: "prom", query: "existing_requests{service={{service}}}" }
    const currentDashboard = { ...dashboard, title: "Existing overview" }
    const f = fixture([currentQuery])
    f.dashboards.set(dashboard.id, currentDashboard)
    f.environment.dashboards = [currentDashboard]
    const update = request()
    update.dashboardChoices = { overview: "replace" }
    update.queryChoices = { requests: "replace" }
    update.dashboardBaselines = { overview: { fingerprint: documentFingerprint(currentDashboard), etag: "dashboard-etag" } }
    update.queryBaselines = { requests: { fingerprint: savedQueryFingerprint(currentQuery), etag: "query-etag" } }
    return { ...f, update, currentQuery, currentDashboard }
  }
  it("replaces matching IDs with their reviewed ETags and never creates duplicates", async () => {
    const f = existing()
    expect(await f.run(f.update, f.environment)).toMatchObject({ complete: true, added: 0, dashboardsReplaced: 1, queriesReplaced: 1, totalAdded: 1 })
    expect(f.client.saveSavedQuery).toHaveBeenCalledWith({ ...query, providerId: "prom" }, "query-etag")
    expect(f.client.save).toHaveBeenCalledWith(dashboard, "dashboard-etag")
    expect(f.dashboards.size).toBe(1)
    expect(f.queries.size).toBe(1)
    expect(await f.run(f.update, f.environment)).toMatchObject({ complete: true, dashboardsReplaced: 0 })
    expect(f.client.save).toHaveBeenCalledTimes(1)
  })
  it("treats prototype-named dashboard IDs as ordinary IDs with default copy decisions", async () => {
    const f = fixture()
    const source = { ...dashboard, id: "constructor" }
    expect(await f.run({ ...request([source]), dashboardChoices: {} }, f.environment)).toMatchObject({ complete: true, added: 1 })
    expect([...f.dashboards.keys()][0]).toMatch(/^dashboard-/)
  })
  it("keeps a dashboard without mapping or importing any of its incoming dependencies", async () => {
    const f = existing()
    f.update.dashboardChoices = { overview: "keep" }
    f.update.providerMapping = {}
    expect(await f.run(f.update, f.environment)).toMatchObject({ complete: true, dashboardsKept: 1, queriesReplaced: 0 })
    expect(f.client.listSavedQueries).not.toHaveBeenCalled()
    expect(f.client.saveSavedQuery).not.toHaveBeenCalled()
    expect(f.client.save).not.toHaveBeenCalled()
    expect(f.dashboards.get(dashboard.id)).toEqual(f.currentDashboard)
  })
  it("keeps a compatible different query without requiring its incoming provider", async () => {
    const f = existing()
    f.update.queryChoices = { requests: "keep" }
    f.update.providerMapping = {}
    expect(await f.run(f.update, f.environment)).toMatchObject({ complete: true, dashboardsReplaced: 1, queriesReused: 1 })
    expect(f.client.saveSavedQuery).not.toHaveBeenCalled()
    expect(f.queries.get(query.id)).toEqual(f.currentQuery)
  })
  it("rejects stale dashboard and query comparisons without overwriting them", async () => {
    const f = existing()
    f.dashboards.set(dashboard.id, { ...f.currentDashboard, title: "Newer title" })
    await expect(f.run(f.update, f.environment)).rejects.toThrow("changed after review")
    expect(f.client.saveSavedQuery).not.toHaveBeenCalled()
    expect(f.client.save).not.toHaveBeenCalled()
    const g = existing()
    g.queries.set(query.id, { ...g.currentQuery, name: "Newer name" })
    expect(await g.run(g.update, g.environment)).toMatchObject({ complete: false, dashboardsReplaced: 0, queriesReplaced: 0 })
    expect(g.client.saveSavedQuery).not.toHaveBeenCalled()
    expect(g.client.save).not.toHaveBeenCalled()
  })
  it("does not finalize Keep when a later preflight fails before returning review progress", async () => {
    const f = existing()
    const other = { ...dashboard, id: "other", title: "Other" }
    f.dashboards.set(other.id, other)
    f.update.bundle = buildDashboardBundle([dashboard, other], [query])
    f.update.dashboardChoices = { overview: "keep", other: "replace" }
    f.update.dashboardBaselines!.other = { fingerprint: "stale", etag: "dashboard-etag" }
    await expect(f.run(f.update, f.environment)).rejects.toThrow("changed after review")
    f.update.dashboardChoices.overview = "replace"
    f.update.dashboardBaselines!.other = { fingerprint: documentFingerprint(other), etag: "dashboard-etag" }
    expect(await f.run(f.update, f.environment)).toMatchObject({ complete: true, dashboardsKept: 0, dashboardsReplaced: 2 })
    expect(f.dashboards.get(dashboard.id)?.title).toBe(dashboard.title)
  })
  it("requires explicit reviewed revisions even if replacement contents are identical", async () => {
    const f = existing()
    f.update.dashboardBaselines = {}
    await expect(f.run(f.update, f.environment)).rejects.toThrow("Refresh the comparison")
    const g = existing()
    g.update.queryBaselines = { requests: { fingerprint: savedQueryFingerprint(g.currentQuery) } }
    expect(await g.run(g.update, g.environment)).toMatchObject({ complete: false, queriesReplaced: 0 })
    expect(g.client.saveSavedQuery).not.toHaveBeenCalled()
  })
  it("rejects replacing provider identity or breaking external dashboard bindings", async () => {
    const f = existing()
    f.update.providerMapping = { source: "other" }
    expect(await f.run(f.update, f.environment)).toMatchObject({ complete: false, queriesReplaced: 0 })
    expect(f.client.saveSavedQuery).not.toHaveBeenCalled()
    const g = existing()
    const changed = { ...query, parameters: [{ name: "replacement", type: "string" as const, defaultValue: "api" }], query: "up{job={{replacement}}}" }
    const incoming = structuredClone(dashboard)
    incoming.widgets[0].queryRef = { id: query.id }
    delete incoming.widgets[0].options
    g.update.bundle = buildDashboardBundle([incoming], [changed])
    expect(await g.run(g.update, g.environment)).toMatchObject({ complete: false, queriesReplaced: 0 })
    expect(g.client.saveSavedQuery).not.toHaveBeenCalled()
    expect(g.client.save).not.toHaveBeenCalled()
  })
  it("recovers acknowledged query replacements when a dependent dashboard fails and retries without writing the query again", async () => {
    const f = existing()
    vi.mocked(f.client.save).mockRejectedValueOnce(new Error("Dashboard unavailable"))
    expect(await f.run(f.update, f.environment)).toMatchObject({ complete: false, queriesReplaced: 1 })
    expect(await f.run(f.update, f.environment)).toMatchObject({ complete: true, dashboardsReplaced: 1, queriesReplaced: 0, queriesReused: 1 })
    expect(f.client.saveSavedQuery).toHaveBeenCalledTimes(1)
  })
  it("recovers replacement writes with lost acknowledgements and refuses a later external edit", async () => {
    const f = existing()
    vi.mocked(f.client.save).mockImplementationOnce(async item => { f.dashboards.set(item.id, item); throw new Error("Response lost") })
    expect(await f.run(f.update, f.environment)).toMatchObject({ complete: true, dashboardsReplaced: 1 })
    const g = existing()
    vi.mocked(g.client.save).mockRejectedValueOnce(new Error("Dashboard unavailable"))
    await g.run(g.update, g.environment)
    g.queries.set(query.id, { ...query, providerId: "prom", name: "External change" })
    expect(await g.run(g.update, g.environment)).toMatchObject({ complete: false, dashboardsReplaced: 0 })
    expect(g.client.saveSavedQuery).toHaveBeenCalledTimes(1)
  })
  it("preserves mixed keep/replace/copy drilldowns and prevents changing copy destinations after a partial write", async () => {
    const f = existing()
    const copied = { ...dashboard, id: "copy-source" }
    const replacement = structuredClone(dashboard)
    replacement.widgets[0].drilldowns = [{ id: "detail", title: "Details", dashboardId: copied.id }]
    f.update.bundle = buildDashboardBundle([replacement, copied], [query])
    f.update.dashboardChoices = { overview: "replace", "copy-source": "copy" }
    vi.mocked(f.client.save).mockRejectedValueOnce(new Error("First write unavailable"))
    const partial = await f.run(f.update, f.environment)
    expect(partial).toMatchObject({ complete: false, added: 1 })
    const copyId = [...f.dashboards.keys()].find(id => id !== dashboard.id)!
    await expect(f.run({ ...f.update, dashboardChoices: { overview: "copy", "copy-source": "copy" } }, f.environment)).rejects.toThrow("destinations are fixed")
    expect(await f.run(f.update, f.environment)).toMatchObject({ complete: true })
    expect(f.dashboards.get(dashboard.id)?.widgets[0].drilldowns?.[0].dashboardId).toBe(copyId)
  })
})

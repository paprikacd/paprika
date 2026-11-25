import { beforeEach, describe, expect, it, vi } from "vitest"
import type { InsightsClient } from "../client"
import { newDashboard } from "../schema"
import { documentFingerprint } from "../fingerprint"
import { EXAMPLE_STORAGE_KEY, writeExampleWorkspace } from "../example-storage"
import type { RepositoryWorkspace } from "./lazy-panels"
import { exampleBackend, liveBackend } from "./workspace-backend"

function stubClient(overrides: Partial<InsightsClient> = {}): InsightsClient {
  return {
    query: vi.fn(async () => ({ series: [] })),
    metadata: vi.fn(async () => ({ values: ["live"], truncated: false })),
    get: vi.fn(async (id: string) => ({ dashboard: { ...newDashboard(), id }, etag: "\"live-1\"" })),
    save: vi.fn(async () => "\"live-2\""),
    remove: vi.fn(async () => undefined),
    listSavedQueries: vi.fn(async () => []),
    removeSavedQuery: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as InsightsClient
}

function stubRuntime(): RepositoryWorkspace {
  return {
    repositoryWorkspaceQuery: vi.fn(async () => ({ series: [] })),
    repositoryWorkspaceMetadata: vi.fn(async () => ({ values: ["example"], truncated: false })),
    repositoryWorkspaceQueries: [],
    readRepositoryExampleWorkspace: (storage: Pick<Storage, "getItem">) => {
      const stored = storage.getItem(EXAMPLE_STORAGE_KEY)
      return stored ? JSON.parse(stored) : { dashboards: [], activeId: "" }
    },
  } as unknown as RepositoryWorkspace
}

describe("WorkspaceBackend", () => {
  beforeEach(() => localStorage.clear())

  describe("query paths", () => {
    it("runs live queries through the client and skips the cache right after a manual refresh", async () => {
      const client = stubClient()
      const backend = liveBackend(client)
      const request = { providerId: "p", kind: "metrics", query: "up", start: 0, end: 60, step: 15 } as never
      await backend.scheduledQuery(Date.now())(request, new AbortController().signal)
      expect(client.query).toHaveBeenCalledWith(request, expect.any(AbortSignal), { replayCapacity: false, refresh: true })
      await backend.scheduledQuery(0)(request, new AbortController().signal)
      expect(client.query).toHaveBeenLastCalledWith(request, expect.any(AbortSignal), { replayCapacity: false, refresh: false })
      expect(backend.client).toBe(client)
    })

    it("reads the example fixture for queries and metadata", async () => {
      const client = stubClient()
      const runtime = stubRuntime()
      const backend = exampleBackend(client, runtime, localStorage)
      expect(backend.scheduledQuery(Date.now())).toBe(runtime.repositoryWorkspaceQuery)
      await backend.client.metadata("p", { kind: "labels" }, new AbortController().signal)
      expect(runtime.repositoryWorkspaceMetadata).toHaveBeenCalled()
      expect(client.metadata).not.toHaveBeenCalled()
    })

    it("scopes variable values by kind and principal", () => {
      expect(liveBackend(stubClient()).variableScope("ada")).toBe("live:ada")
      expect(exampleBackend(stubClient(), stubRuntime(), localStorage).variableScope(undefined)).toBe("example:anonymous")
    })

    it("refuses a selector only in an example", () => {
      expect(() => liveBackend(stubClient()).assertSelector("{job=\"api\"}")).not.toThrow()
      const example = exampleBackend(stubClient(), stubRuntime(), localStorage)
      expect(() => example.assertSelector(undefined)).not.toThrow()
      expect(() => example.assertSelector("{job=\"api\"}")).toThrow("Selector-filtered values are not available in examples")
    })

    it("keeps an example's saved queries in this browser, and the live client's in the service", async () => {
      const client = stubClient()
      expect(liveBackend(client).savedQueries(() => newDashboard())).toBe(client)
      const library = exampleBackend(client, stubRuntime(), localStorage).savedQueries(() => newDashboard())
      expect(library).not.toBe(client)
      expect(await library.listSavedQueries(new AbortController().signal)).toEqual([])
      expect(client.listSavedQueries).not.toHaveBeenCalled()
      // Without storage (no window), an example falls back to the client.
      expect(exampleBackend(client, stubRuntime(), undefined).savedQueries(() => newDashboard())).toBe(client)
    })
  })

  describe("persistence", () => {
    it("loads, saves, removes and moves live dashboards through the client with their ETags", async () => {
      const client = stubClient()
      const backend = liveBackend(client)
      const document = { ...newDashboard(), id: "d1" }
      expect((await backend.load(document)).etag).toBe("\"live-1\"")
      expect(await backend.save(document, { saved: "", dashboards: [], etag: "\"e0\"" })).toBe("\"live-2\"")
      expect(client.save).toHaveBeenCalledWith(document, "\"e0\"")
      await backend.remove("d1", [], "\"e1\"")
      expect(client.remove).toHaveBeenCalledWith("d1", "\"e1\"")
      expect(await backend.move(document, [document], "d0", "\"e2\"")).toBe("\"live-2\"")
      expect(backend.afterDelete([document])).toBeUndefined()
    })

    it("stores example dashboards in this browser and refuses a save over a changed stored copy", async () => {
      const backend = exampleBackend(stubClient(), stubRuntime(), localStorage)
      const first = { ...newDashboard(), id: "a", title: "A" }
      const second = { ...newDashboard(), id: "b", title: "B" }
      writeExampleWorkspace(localStorage, [first, second], "a")
      expect((await backend.load(first)).dashboard).toBe(first)
      const edited = { ...first, title: "A edited" }
      await expect(backend.save(edited, { saved: documentFingerprint(first), dashboards: [first, second] })).resolves.toBeUndefined()
      expect(JSON.parse(localStorage.getItem(EXAMPLE_STORAGE_KEY)!).dashboards.find((item: { id: string }) => item.id === "a").title).toBe("A edited")
      // The stored copy now differs from the fingerprint this draft was opened with.
      await expect(backend.save({ ...first, title: "stale" }, { saved: documentFingerprint(first), dashboards: [edited, second] }))
        .rejects.toThrow("The saved dashboard changed.")
      backend.opened([edited, second], second)
      expect(JSON.parse(localStorage.getItem(EXAMPLE_STORAGE_KEY)!).activeId).toBe("b")
      await backend.remove("a", [second], undefined)
      expect(JSON.parse(localStorage.getItem(EXAMPLE_STORAGE_KEY)!).dashboards.map((item: { id: string }) => item.id)).toEqual(["b"])
      expect(backend.afterDelete([second])).toBe(second)
      expect(await backend.move({ ...second, folder: "team" }, [second], "b")).toBeUndefined()
      expect(JSON.parse(localStorage.getItem(EXAMPLE_STORAGE_KEY)!).dashboards[0].folder).toBe("team")
    })

    it("keeps revisions only for a live host that lists them", () => {
      expect(liveBackend(stubClient()).revisions).toBe(false)
      expect(liveBackend(stubClient({ listRevisions: vi.fn() } as Partial<InsightsClient>)).revisions).toBe(true)
      expect(exampleBackend(stubClient({ listRevisions: vi.fn() } as Partial<InsightsClient>), stubRuntime(), localStorage).revisions).toBe(false)
    })
  })

  describe("flags and copy", () => {
    it("names each kind", () => {
      const live = liveBackend(stubClient())
      const example = exampleBackend(stubClient(), stubRuntime(), localStorage)
      expect([live.example, example.example]).toEqual([false, true])
      expect(live.copy.saved).toBe("Dashboard saved.")
      expect(example.copy.saved).toBe("Example saved in this browser.")
      expect(live.copy.environmentDetail(3)).toBe("3 configured data sources")
      expect(example.copy.environmentDetail(3)).toBe("Sample data · stored locally")
      expect([live.copy.badge, example.copy.badge]).toEqual(["Live providers", "Sample data"])
      expect([live.copy.footer, example.copy.footer]).toEqual(["Provider queries run server-side", "Generated sample data"])
      expect([live.copy.environment, example.copy.environment]).toEqual(["Connected workspace", "Example workspace"])
    })
  })
})

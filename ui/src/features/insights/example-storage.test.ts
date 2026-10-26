import { describe, expect, it, vi } from "vitest"
import {
  EXAMPLE_STORAGE_KEY,
  createExampleDashboardImportClient,
  readExampleWorkspace,
  saveExampleWorkspace,
  writeExampleWorkspace,
} from "./example-storage"
import { exampleDashboard } from "./example"
import type { Dashboard } from "./schema"

function document(id: string): Dashboard {
  return {
    schemaVersion: 1,
    id,
    title: `Dashboard ${id}`,
    timeRange: "1h",
    refreshInterval: 0,
    widgets: [],
  }
}
function storage(initial: string | null = null) {
  let value = initial
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next
    }),
  }
}

describe("example workspace persistence", () => {
  it("preserves an intentionally empty workspace and imports made beside an unsaved draft", () => {
    const store = storage()
    writeExampleWorkspace(store, [], "")
    expect(readExampleWorkspace(store)).toEqual({ dashboards: [], activeId: "" })
    writeExampleWorkspace(store, [document("imported")], "unsaved-draft")
    expect(readExampleWorkspace(store)).toEqual({
      dashboards: [document("imported")],
      activeId: "imported",
    })
  })
  it("saves several dashboards, restores the active one, and replaces only the matching id", () => {
    const store = storage()
    let documents = saveExampleWorkspace(store, [], document("a"))
    documents = saveExampleWorkspace(store, documents, document("b"))
    documents = saveExampleWorkspace(store, documents, { ...document("a"), title: "Updated A" })
    const workspace = readExampleWorkspace(store)
    expect(workspace.activeId).toBe("a")
    expect(workspace.dashboards).toEqual([document("b"), { ...document("a"), title: "Updated A" }])
    expect(documents).toEqual(workspace.dashboards)
    expect(store.setItem).toHaveBeenLastCalledWith(EXAMPLE_STORAGE_KEY, JSON.stringify(workspace))
  })

  it("migrates the legacy single-document format on the next save", () => {
    const legacy = document("legacy")
    const store = storage(JSON.stringify(legacy))
    const workspace = readExampleWorkspace(store)
    expect(workspace).toEqual({ dashboards: [legacy], activeId: "legacy" })
    saveExampleWorkspace(store, workspace.dashboards, document("second"))
    expect(readExampleWorkspace(store)).toEqual({
      dashboards: [legacy, document("second")],
      activeId: "second",
    })
  })

  it.each([
    null,
    "not-json",
    "null",
    JSON.stringify({ schemaVersion: 1 }),
    JSON.stringify({ dashboards: [], activeId: "missing" }),
    JSON.stringify({ dashboards: [document("a")], activeId: "missing" }),
    JSON.stringify({ dashboards: [{ ...document("a"), title: "" }], activeId: "a" }),
    JSON.stringify({
      dashboards: Array.from({ length: 101 }, (_, i) => document(`a-${i}`)),
      activeId: "a-0",
    }),
  ])("falls back to the working example for invalid storage: %s", (source) => {
    expect(readExampleWorkspace(storage(source))).toEqual({
      dashboards: [exampleDashboard],
      activeId: exampleDashboard.id,
    })
  })

  it("handles unavailable browser storage when loading", () => {
    const store = {
      getItem: () => {
        throw new DOMException("Denied", "SecurityError")
      },
    }
    expect(readExampleWorkspace(store).activeId).toBe(exampleDashboard.id)
  })

  it("propagates a quota failure while preserving the existing saved documents", () => {
    const existing = { dashboards: [document("a")], activeId: "a" }
    const store = storage(JSON.stringify(existing))
    store.setItem.mockImplementationOnce(() => {
      throw new DOMException("Full", "QuotaExceededError")
    })
    const documents = [document("a")]
    expect(() => saveExampleWorkspace(store, documents, document("b"))).toThrow(/Full/)
    expect(readExampleWorkspace(store)).toEqual(existing)
    expect(documents).toEqual([document("a")])
  })

  it("rejects invalid documents and excess dashboards before writing", () => {
    const store = storage()
    expect(() => saveExampleWorkspace(store, [], { ...document("invalid"), title: "" })).toThrow()
    expect(() =>
      saveExampleWorkspace(
        store,
        Array.from({ length: 100 }, (_, i) => document(`a-${i}`)),
        document("one-too-many"),
      ),
    ).toThrow(/100 dashboards/)
    expect(store.setItem).not.toHaveBeenCalled()
  })
})


it("conditionally replaces a persisted example dashboard and rejects stale reviews or create collisions", async () => {
  const store = storage()
  writeExampleWorkspace(store, [document("a"), document("b")], "b")
  const client = createExampleDashboardImportClient(store)
  const review = await client.get("a")
  const changed = { ...document("a"), title: "Imported replacement" }
  await expect(client.save(changed)).rejects.toThrow("changed")
  await client.save(changed, review.etag)
  expect(await client.list()).toEqual([document("b"), changed])
  expect(readExampleWorkspace(store).activeId).toBe("b")
  await expect(client.save(document("a"), review.etag)).rejects.toThrow("changed")
  await expect(client.save(document("new"), review.etag)).rejects.toThrow("changed")
  expect((await client.get("a")).dashboard).toEqual(changed)
})

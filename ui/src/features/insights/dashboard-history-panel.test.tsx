import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DashboardRevisionList } from "@/gen/paprika/insights/v1/revisions_pb"
import InsightsApp from "./insights-app"
import { liveClient, liveDashboard } from "./lazy-panels-shared"

vi.mock("./canvas", async () => (await import("./lazy-panels-shared")).canvasMock())

const revisions = DashboardRevisionList.fromJson({
  dashboardId: "a",
  retentionLimit: 20,
  currentEtag: '"v1"',
  revisions: [
    { number: 2, etag: '"v1"', source: "REVISION_SOURCE_UI", createdAtUnixMs: "1700000000000", widgetCount: 1, title: "Dashboard A", restoredFrom: 0, savedQueries: [], driftedSavedQueries: [], sizeBytes: 1 },
    { number: 1, etag: '"first"', source: "REVISION_SOURCE_BASELINE", createdAtUnixMs: "1699999999000", widgetCount: 0, title: "Dashboard A", restoredFrom: 0, savedQueries: [], driftedSavedQueries: [], sizeBytes: 1 },
  ],
} as unknown as Parameters<typeof DashboardRevisionList.fromJson>[0])

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, "", "/dashboard/insights/")
})

describe("revision history panel in the dashboard", () => {
  it("opens from the toolbar, previews a revision and restores it through the app", async () => {
    const restored = { ...liveDashboard, title: "Dashboard A (restored)" }
    const restoreRevision = vi.fn(async () => ({ dashboard: restored, etag: '"v3"', revision: 3 }))
    const client = liveClient({
      listRevisions: vi.fn(async () => revisions),
      getRevision: vi.fn(async () => ({ dashboard: restored, etag: '"first"' })),
      restoreRevision,
    })
    render(<InsightsApp client={client} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: /^History$/ }))
    const list = await screen.findByRole("list", { name: "Revisions, newest first" })
    expect(within(list).getAllByRole("button")).toHaveLength(2)
    fireEvent.click(within(list).getByRole("button", { name: /Revision 1/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Restore revision 1" }))
    fireEvent.click(screen.getByRole("button", { name: "Restore revision 1" }))
    await waitFor(() => expect(restoreRevision).toHaveBeenCalledWith("a", 1, '"v1"'))
    expect(await screen.findByText("Dashboard restored from an earlier revision.")).toBeInTheDocument()
  })

  it("keeps restore disabled while the canvas holds unsaved edits", async () => {
    const restoreRevision = vi.fn()
    const client = liveClient({
      listRevisions: vi.fn(async () => revisions),
      getRevision: vi.fn(async () => ({ dashboard: { ...liveDashboard, title: "Earlier" }, etag: '"first"' })),
      restoreRevision,
    })
    render(<InsightsApp client={client} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Dashboard title" }), { target: { value: "Dashboard A edited" } })
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /^History$/ }))
    const list = await screen.findByRole("list", { name: "Revisions, newest first" })
    fireEvent.click(within(list).getByRole("button", { name: /Revision 1/ }))
    const restore = await screen.findByRole("button", { name: "Restore revision 1" })
    expect(restore).toBeDisabled()
    expect(restore).toHaveAccessibleDescription("Save or discard your edits on the canvas before restoring.")
    expect(restoreRevision).not.toHaveBeenCalled()
  })

  it("hides the History entry for sample data", async () => {
    render(<InsightsApp client={liveClient()} initialExample />)
    expect(await screen.findByRole("button", { name: "Edit dashboard" }, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^History$/ })).not.toBeInTheDocument()
  })
})

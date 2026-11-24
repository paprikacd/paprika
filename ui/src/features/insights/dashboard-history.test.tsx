import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { DashboardRevisionList } from "@/gen/paprika/insights/v1/revisions_pb"
import { InsightsHTTPError } from "./client"
import { DashboardHistory, revisionChanges, type HistoryClient } from "./dashboard-history"
import { liveDashboard } from "./lazy-panels-shared"
import type { Dashboard } from "./schema"

const CURRENT = '"current"'

type RevisionListJSON = Parameters<typeof DashboardRevisionList.fromJson>[0]
function revisionList(revisions: unknown[] = [
  { number: 2, etag: CURRENT, author: { subject: "ada", name: "Ada" }, source: "REVISION_SOURCE_UI", message: "Add latency", createdAtUnixMs: "1700000000000", widgetCount: 1, title: "Dashboard A", restoredFrom: 0, savedQueries: [], driftedSavedQueries: [], sizeBytes: 200 },
  { number: 1, etag: '"first"', source: "REVISION_SOURCE_BASELINE", createdAtUnixMs: "1699999999000", widgetCount: 0, title: "Dashboard A", restoredFrom: 0, savedQueries: [], driftedSavedQueries: [], sizeBytes: 120 },
]) {
  return DashboardRevisionList.fromJson({ dashboardId: "a", retentionLimit: 20, currentEtag: CURRENT, revisions } as unknown as RevisionListJSON, { ignoreUnknownFields: true })
}

const earlier: Dashboard = { ...liveDashboard, title: "Dashboard A (early)", widgets: [] }

function client(overrides: Partial<HistoryClient> = {}): HistoryClient {
  return {
    listRevisions: vi.fn(async () => revisionList()),
    getRevision: vi.fn(async (_id: string, number: number) => ({ dashboard: number === 1 ? earlier : liveDashboard, etag: '"first"' })),
    restoreRevision: vi.fn(async () => ({ dashboard: earlier, etag: '"restored"', revision: 3 })),
    ...overrides,
  }
}

function renderPanel(options: { client?: HistoryClient; canRestore?: boolean; onRestored?: () => void; onClose?: () => void } = {}) {
  const onRestored = options.onRestored ?? vi.fn()
  const onClose = options.onClose ?? vi.fn()
  const view = render(
    <DashboardHistory
      dashboard={liveDashboard}
      client={options.client ?? client()}
      canRestore={options.canRestore ?? true}
      refreshKey="saved-1"
      onRestored={onRestored}
      onClose={onClose}
    />,
  )
  return { ...view, onRestored, onClose }
}

describe("DashboardHistory", () => {
  it("lists revisions newest first with who, when, source and message", async () => {
    const { container } = renderPanel()
    const list = await screen.findByRole("list", { name: "Revisions, newest first" })
    const items = within(list).getAllByRole("button")
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent("Revision 2")
    expect(items[0]).toHaveTextContent("Current")
    expect(items[0]).toHaveTextContent("Ada")
    expect(items[0]).toHaveTextContent("Add latency")
    expect(items[1]).toHaveTextContent("Revision 1")
    expect(items[1]).toHaveTextContent("Earliest saved version")
    expect(container.querySelector("ol")?.textContent).not.toContain("undefined")
  })

  it("shows the empty state when the dashboard has no revisions", async () => {
    renderPanel({ client: client({ listRevisions: vi.fn(async () => revisionList([])) }) })
    expect(await screen.findByText(/No revisions yet/)).toBeInTheDocument()
    expect(screen.queryByRole("list", { name: "Revisions, newest first" })).not.toBeInTheDocument()
  })

  it("shows an error with a retry when the list cannot be read", async () => {
    const listRevisions = vi.fn()
      .mockRejectedValueOnce(new Error("Insights is down"))
      .mockResolvedValueOnce(revisionList())
    renderPanel({ client: client({ listRevisions }) })
    expect(await screen.findByRole("alert")).toHaveTextContent("Insights is down")
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(await screen.findByRole("list", { name: "Revisions, newest first" })).toBeInTheDocument()
    expect(listRevisions).toHaveBeenCalledTimes(2)
  })

  it("previews a selected revision read-only and summarises the widget changes", async () => {
    const fetched = client()
    renderPanel({ client: fetched })
    fireEvent.click(await screen.findByRole("button", { name: /Revision 1/ }))
    expect(await screen.findByRole("heading", { name: "Preview of revision 1" })).toBeInTheDocument()
    expect(fetched.getRevision).toHaveBeenCalledWith("a", 1, expect.any(AbortSignal))
    expect(screen.getByText(/Title: Dashboard A → Dashboard A \(early\)/)).toBeInTheDocument()
    expect(screen.getByRole("list", { name: "Widget changes" })).toHaveTextContent("Removed: Request latency")
    expect(fetched.restoreRevision).not.toHaveBeenCalled()
  })

  it("marks the current revision and offers no restore for it", async () => {
    renderPanel()
    fireEvent.click(await screen.findByRole("button", { name: /Revision 2/ }))
    expect(await screen.findByText("This is the current revision.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Restore revision 2" })).not.toBeInTheDocument()
  })

  it("restores only after the confirm step, with the list's current ETag, then reports the new revision", async () => {
    const fetched = client()
    const { onRestored } = renderPanel({ client: fetched })
    fireEvent.click(await screen.findByRole("button", { name: /Revision 1/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Restore revision 1" }))
    expect(fetched.restoreRevision).not.toHaveBeenCalled()
    const confirm = screen.getByRole("group", { name: "Confirm restore" })
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus()
    fireEvent.click(within(confirm).getByRole("button", { name: "Restore revision 1" }))
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(earlier, '"restored"'))
    expect(fetched.restoreRevision).toHaveBeenCalledWith("a", 1, CURRENT)
    expect(await screen.findByRole("status")).toHaveTextContent("Restored revision 1 as revision 3.")
  })

  it("cancelling the confirm step restores nothing", async () => {
    const fetched = client()
    renderPanel({ client: fetched })
    fireEvent.click(await screen.findByRole("button", { name: /Revision 1/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Restore revision 1" }))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("group", { name: "Confirm restore" })).not.toBeInTheDocument()
    expect(fetched.restoreRevision).not.toHaveBeenCalled()
  })

  it("on a conflict, reloads the history and says nothing was restored", async () => {
    const listRevisions = vi.fn()
      .mockResolvedValueOnce(revisionList())
      .mockResolvedValueOnce(revisionList())
    const restoreRevision = vi.fn().mockRejectedValue(new InsightsHTTPError("changed", 412, null))
    const onRestored = vi.fn()
    renderPanel({ client: client({ listRevisions, restoreRevision }), onRestored })
    fireEvent.click(await screen.findByRole("button", { name: /Revision 1/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Restore revision 1" }))
    fireEvent.click(screen.getByRole("button", { name: "Restore revision 1" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("This dashboard changed on the server, so nothing was restored.")
    expect(listRevisions).toHaveBeenCalledTimes(2)
    expect(onRestored).not.toHaveBeenCalled()
  })

  it("on a 409 conflict, also reloads", async () => {
    const restoreRevision = vi.fn().mockRejectedValue(new InsightsHTTPError("changed", 409, null))
    renderPanel({ client: client({ restoreRevision }) })
    fireEvent.click(await screen.findByRole("button", { name: /Revision 1/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Restore revision 1" }))
    fireEvent.click(screen.getByRole("button", { name: "Restore revision 1" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("nothing was restored")
  })

  it("keeps the restore disabled with a reason while the canvas has unsaved edits", async () => {
    renderPanel({ canRestore: false })
    fireEvent.click(await screen.findByRole("button", { name: /Revision 1/ }))
    const restore = await screen.findByRole("button", { name: "Restore revision 1" })
    expect(restore).toBeDisabled()
    expect(restore).toHaveAccessibleDescription("Save or discard your edits on the canvas before restoring.")
  })

  it("explains when the server has no history endpoint", async () => {
    renderPanel({ client: client({ listRevisions: undefined }) })
    expect(await screen.findByRole("alert")).toHaveTextContent("Revision history is not available on this server.")
  })

  it("keeps the confirmed restore from running once the canvas gains edits", async () => {
    const fetched = client()
    const { rerender } = renderPanel({ client: fetched })
    fireEvent.click(await screen.findByRole("button", { name: /Revision 1/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Restore revision 1" }))
    rerender(
      <DashboardHistory dashboard={liveDashboard} client={fetched} canRestore={false} refreshKey="saved-1" onRestored={vi.fn()} onClose={vi.fn()} />,
    )
    const confirm = within(screen.getByRole("group", { name: "Confirm restore" })).getByRole("button", { name: "Restore revision 1" })
    expect(confirm).toBeDisabled()
    expect(confirm).toHaveAccessibleDescription("Save or discard your edits on the canvas before restoring.")
    fireEvent.click(confirm)
    expect(fetched.restoreRevision).not.toHaveBeenCalled()
  })

  it("explains a refused restore for an account that can only read", async () => {
    const restoreRevision = vi.fn().mockRejectedValue(new InsightsHTTPError("Your account does not have access to Insights.", 403, null))
    const onRestored = vi.fn()
    renderPanel({ client: client({ restoreRevision }), onRestored })
    fireEvent.click(await screen.findByRole("button", { name: /Revision 1/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Restore revision 1" }))
    fireEvent.click(screen.getByRole("button", { name: "Restore revision 1" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Your account can view this dashboard but not change it, so nothing was restored.")
    expect(onRestored).not.toHaveBeenCalled()
  })

  it("reloads the history when the revision was pruned before the restore", async () => {
    const listRevisions = vi.fn(async () => revisionList())
    const restoreRevision = vi.fn().mockRejectedValue(new InsightsHTTPError("revision not found", 404, null))
    renderPanel({ client: client({ listRevisions, restoreRevision }) })
    fireEvent.click(await screen.findByRole("button", { name: /Revision 1/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Restore revision 1" }))
    fireEvent.click(screen.getByRole("button", { name: "Restore revision 1" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Revision 1 is no longer kept, so nothing was restored.")
    expect(listRevisions).toHaveBeenCalledTimes(2)
  })

  it("says an unsaved dashboard has no history yet", async () => {
    renderPanel({ client: client({ listRevisions: vi.fn().mockRejectedValue(new InsightsHTTPError("dashboard not found", 404, null)) }) })
    expect(await screen.findByRole("alert")).toHaveTextContent("This dashboard has not been saved yet. Its history starts with the first save.")
  })

  it("names the saved queries a restore did not bring back, in the list and after the restore", async () => {
    const restoredEntry = {
      number: 3, etag: '"restored"', source: "REVISION_SOURCE_RESTORE", restoredFrom: 1, createdAtUnixMs: "1700000001000", widgetCount: 0,
      title: "Dashboard A", savedQueries: [{ id: "latency", etag: '"q1"' }], driftedSavedQueries: [{ id: "latency", etag: '"q1"' }, { id: "gone", etag: '"q2"' }], sizeBytes: 120,
    }
    const listRevisions = vi.fn()
      .mockResolvedValueOnce(revisionList())
      .mockResolvedValue(revisionList([restoredEntry, ...revisionList().revisions.map(revision => revision.toJson())]))
    const view = render(
      <DashboardHistory dashboard={liveDashboard} client={client({ listRevisions })} canRestore refreshKey="saved-1" onRestored={vi.fn()} onClose={vi.fn()}
        savedQueries={[{ id: "latency", name: "Request latency" }]} />,
    )
    fireEvent.click(await screen.findByRole("button", { name: /Revision 1/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Restore revision 1" }))
    fireEvent.click(screen.getByRole("button", { name: "Restore revision 1" }))
    const drift = "Saved queries are not restored. 2 saved queries changed since revision 1: Request latency, gone."
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(`Restored revision 1 as revision 3. ${drift}`))
    expect(within(screen.getByRole("list", { name: "Revisions, newest first" })).getByRole("button", { name: /Revision 3/ })).toHaveTextContent(drift)
    view.unmount()
  })

  it("computes widget changes by ID and title", () => {
    const widget = (id: string, title: string) => ({ ...liveDashboard.widgets[0], id, title })
    const current = { ...liveDashboard, widgets: [widget("a", "A"), widget("b", "B")] }
    const revision = { ...liveDashboard, widgets: [widget("a", "A2"), widget("c", "C")] }
    expect(revisionChanges(current, revision)).toEqual({ added: ["C"], removed: ["B"], changed: ["A2"] })
  })
})

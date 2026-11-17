import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import InsightsApp from "./insights-app"
import type { InsightsClient } from "./client"
import type { Dashboard } from "./schema"

vi.mock("./canvas", () => ({ DashboardCanvas: () => <div /> }))
const saved: Dashboard = { schemaVersion: 1, id: "overview", title: "Saved overview", widgets: [], timeRange: "1h", refreshInterval: 0 }
const incoming = { ...saved, title: "Imported overview" }
function fixture() {
  let document = saved
  const api: InsightsClient = {
    providers: vi.fn().mockResolvedValue([]), list: vi.fn(async () => [document]),
    get: vi.fn(async () => ({ dashboard: document, etag: "reviewed-version" })),
    save: vi.fn(async next => { document = next; return "imported-version" }),
    remove: vi.fn(), query: vi.fn().mockResolvedValue({ series: [] }),
    listSavedQueries: vi.fn().mockResolvedValue([]), getSavedQuery: vi.fn(), saveSavedQuery: vi.fn(), removeSavedQuery: vi.fn(),
    providerConfigs: vi.fn().mockResolvedValue([]), saveProvider: vi.fn(), removeProvider: vi.fn(), testProvider: vi.fn(), metadata: vi.fn(),
  }
  return api
}
beforeEach(() => {
  window.history.replaceState(null, "", "/dashboard/insights/")
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false, media: "", onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })
})
afterEach(() => vi.restoreAllMocks())
async function reviewReplacement() {
  fireEvent.click(screen.getByRole("button", { name: "Manage dashboards" }))
  fireEvent.click(screen.getByRole("combobox", { name: "Library import format" }))
  fireEvent.click(screen.getByRole("option", { name: "JSON" }))
  fireEvent.change(screen.getByLabelText("Library import source"), { target: { value: JSON.stringify(incoming) } })
  fireEvent.click(screen.getByRole("button", { name: "Review import" }))
  const choice = await screen.findByRole("combobox", { name: "Import dashboard Imported overview" })
  await waitFor(() => expect(choice).toBeEnabled())
  fireEvent.click(choice)
  fireEvent.click(screen.getByRole("option", { name: /^Replace existing/ }))
}
it("loads a saved comparison and updates the clean active canvas after conditional replacement", async () => {
  const api = fixture()
  render(<InsightsApp client={api} />)
  await screen.findByRole("heading", { name: saved.title })
  await reviewReplacement()
  fireEvent.click(screen.getByRole("button", { name: /^Compare changes for Imported overview/ }))
  expect(screen.getByLabelText("Current value")).toHaveTextContent(saved.title)
  expect(screen.getByLabelText("Incoming value")).toHaveTextContent(incoming.title)
  fireEvent.click(screen.getByRole("button", { name: "Apply import choices" }))
  await screen.findByRole("heading", { name: incoming.title })
  expect(api.save).toHaveBeenCalledWith(incoming, "reviewed-version")
  fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
  fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: "After import" } })
  fireEvent.click(screen.getByRole("button", { name: "Save dashboard" }))
  await waitFor(() => expect(api.save).toHaveBeenLastCalledWith({ ...incoming, title: "After import" }, "imported-version"))
})
it("compares against saved state and preserves an unsaved active draft instead of replacing it", async () => {
  const api = fixture()
  render(<InsightsApp client={api} />)
  await screen.findByRole("heading", { name: saved.title })
  fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
  fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: "Unsaved local work" } })
  await reviewReplacement()
  fireEvent.click(screen.getByRole("button", { name: /^Compare changes for Imported overview/ }))
  expect(screen.getByLabelText("Current value")).toHaveTextContent(saved.title)
  fireEvent.click(screen.getByRole("button", { name: "Apply import choices" }))
  await screen.findByText(/This dashboard has unsaved edits/)
  expect(api.save).not.toHaveBeenCalled()
  expect(screen.getByLabelText("Dashboard title")).toHaveValue("Unsaved local work")
})
it("retains edits made while a replacement write is pending and does not advance their save revision", async () => {
  const api = fixture()
  let finish!: (etag: string) => void
  vi.mocked(api.save).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  render(<InsightsApp client={api} />)
  await screen.findByRole("heading", { name: saved.title })
  fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
  await reviewReplacement()
  fireEvent.click(screen.getByRole("button", { name: "Apply import choices" }))
  await waitFor(() => expect(api.save).toHaveBeenCalledOnce())
  fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: "Newer local edit" } })
  await act(async () => finish("imported-version"))
  expect(screen.getByLabelText("Dashboard title")).toHaveValue("Newer local edit")
  expect(screen.getByText(/Your newer local edits are retained/)).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Save dashboard" }))
  await waitFor(() => expect(api.save).toHaveBeenLastCalledWith({ ...saved, title: "Newer local edit" }, "reviewed-version"))
})

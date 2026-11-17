import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import InsightsApp from "./insights-app"
import type { InsightsClient } from "./client"
import type { Dashboard, SavedQueryEntry, Widget } from "./schema"
import type { QueryFetcher } from "./query"

vi.mock("./canvas", async () => {
  const { useWidgetQuery } = await import("./query")
  function QueryPreview({ widget, fetcher }: { widget: Widget; fetcher: QueryFetcher }) {
    const { data } = useWidgetQuery(widget, { fetcher, start: 1000, end: 1100, step: 10 })
    return <output aria-label="Resolved widget value">{data?.series?.[0]?.points[0]?.value}</output>
  }
  return { DashboardCanvas: ({ dashboard, fetcher }: { dashboard: Dashboard; fetcher: QueryFetcher }) =>
    <>{dashboard.widgets.map(widget => <QueryPreview key={widget.id} widget={widget} fetcher={fetcher} />)}</> }
})
const initial: Dashboard = { schemaVersion: 1, id: "first", title: "Original dashboard", timeRange: "1h", refreshInterval: 0, widgets: [] }
const signal: SavedQueryEntry = { schemaVersion: 1, id: "signal", name: "Signal", providerId: "metrics", kind: "metrics", query: "up", etag: '\"q1\"' }
function fixture(dashboard = initial, queries: SavedQueryEntry[] = []) {
  const store = { dashboards: [dashboard], queries, etag: '\"d1\"' }
  const api: InsightsClient = {
    providers: vi.fn().mockResolvedValue([{ id: "metrics", name: "Metrics", type: "prometheus", capabilities: ["metrics"] }]),
    list: vi.fn(async () => structuredClone(store.dashboards)),
    get: vi.fn(async id => ({ dashboard: structuredClone(store.dashboards.find(item => item.id === id)!), etag: store.etag })),
    save: vi.fn().mockResolvedValue('\"d3\"'), remove: vi.fn(),
    listSavedQueries: vi.fn(async () => structuredClone(store.queries)),
    getSavedQuery: vi.fn(), saveSavedQuery: vi.fn(), removeSavedQuery: vi.fn(),
    query: vi.fn(async request => ({ series: [{ name: "value", labels: {}, points: [{ timestamp: 1000000, value: request.query === "up" ? 1 : 2 }] }] })),
    providerConfigs: vi.fn().mockResolvedValue([]), saveProvider: vi.fn(), removeProvider: vi.fn(), testProvider: vi.fn(), metadata: vi.fn().mockResolvedValue({ values: [] }),
  }
  return { store, api }
}
async function open(api: InsightsClient) {
  render(<InsightsApp client={api} />)
  await screen.findByRole("heading", { name: "Original dashboard" })
  await waitFor(() => expect(api.listSavedQueries).toHaveBeenCalled())
}
async function explorerReady() {
  // Provider changes remount the lazy Explorer; wait for its visible workspace.
  expect(await screen.findByRole("region", { name: "Query workbench" }, { timeout: 5000 })).toBeVisible()
}
beforeEach(() => {
  window.history.replaceState(null, "", "/dashboard/insights/")
  vi.spyOn(document, "hidden", "get").mockReturnValue(false)
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false, media: "", onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() })
})
afterEach(() => { vi.restoreAllMocks() })

it("opens the selected MCP provider from Data sources and preserves an existing query draft until discard is confirmed", async () => {
  const { api } = fixture()
  vi.mocked(api.providers).mockResolvedValue([
    { id: "metrics", name: "Metrics", type: "prometheus", capabilities: ["metrics"], transport: "mcp", source: "observability" },
    { id: "traces", name: "Traces", type: "tempo", capabilities: ["traces"], transport: "mcp", source: "observability" },
  ])
  await open(api)
  fireEvent.click(screen.getByRole("button", { name: "Data sources 2" }))
  fireEvent.click(screen.getByRole("button", { name: "Explore Traces" }))
  await explorerReady()
  expect(await screen.findByRole("combobox", { name: "Explore data source" })).toHaveTextContent("Traces")
  expect(screen.getByText("query_traces")).toBeVisible()
  fireEvent.change(screen.getByLabelText("Query name"), { target: { value: "My trace draft" } })
  fireEvent.click(screen.getByRole("button", { name: "Data sources 2" }))
  fireEvent.click(screen.getByRole("button", { name: "Explore Metrics" }))
  expect(await screen.findByRole("alertdialog")).toHaveTextContent("Discard query changes?")
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  fireEvent.click(screen.getByRole("button", { name: "Explore 0" }))
  await explorerReady()
  expect(screen.getByLabelText("Query name")).toHaveValue("My trace draft")
  expect(screen.getByRole("combobox", { name: "Explore data source" })).toHaveTextContent("Traces")
  fireEvent.click(screen.getByRole("button", { name: "Data sources 2" }))
  fireEvent.click(screen.getByRole("button", { name: "Explore Metrics" }))
  fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }))
  await explorerReady()
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Explore data source" })).toHaveTextContent("Metrics"))
  expect(screen.getByLabelText("Query name")).toHaveValue("")
  expect(screen.getByText("query_metrics")).toBeVisible()
  expect(api.query).not.toHaveBeenCalled()
}, 10000) // Three workspace transitions plus both confirmation paths exceed five seconds on CI.

it("shows externally created library documents and adopts a changed clean dashboard without reload", async () => {
  const { store, api } = fixture()
  await open(api)
  store.dashboards = [{ ...initial, title: "Updated by MCP" }, { ...initial, id: "new", title: "Created by MCP" }]
  store.queries = [signal]
  store.etag = '\"d2\"'
  fireEvent.focus(window)
  await screen.findByRole("heading", { name: "Updated by MCP" })
  expect(screen.getByRole("button", { name: "Created by MCP" })).toBeVisible()
  expect(screen.getByRole("button", { name: /^Explore 1$/ })).toBeVisible()
  expect(api.save).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
  fireEvent.click(screen.getByRole("button", { name: "Save dashboard" }))
  await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ title: "Updated by MCP" }), '\"d2\"'))
})

it("adopts a same-content rewrite's ETag only while the dashboard is clean", async () => {
  const { store, api } = fixture()
  await open(api)
  store.etag = '\"d2\"'
  await act(async () => fireEvent.focus(window))
  fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
  fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: "My draft" } })
  store.etag = '\"d3\"'
  fireEvent.focus(window)
  await screen.findByText("The saved dashboard changed elsewhere. Your draft is preserved.")
  expect(screen.getByLabelText("Dashboard title")).toHaveValue("My draft")
  fireEvent.click(screen.getByRole("button", { name: "Save dashboard" }))
  await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ title: "My draft" }), '\"d2\"'))
})

it("preserves an unsaved dashboard and its original ETag when another editor writes", async () => {
  const { store, api } = fixture()
  await open(api)
  fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
  fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: "My local draft" } })
  store.dashboards = [{ ...initial, title: "Remote update" }]
  store.etag = '\"d2\"'
  fireEvent.focus(window)
  await screen.findByText("The saved dashboard changed elsewhere. Your draft is preserved.")
  expect(screen.getByLabelText("Dashboard title")).toHaveValue("My local draft")
  vi.mocked(api.save).mockRejectedValueOnce(new Error("This dashboard changed on the server. Reload before saving."))
  fireEvent.click(screen.getByRole("button", { name: "Save dashboard" }))
  await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ title: "My local draft" }), '\"d1\"'))
  await screen.findByText(/This dashboard changed on the server/)
  expect(screen.getByLabelText("Dashboard title")).toHaveValue("My local draft")
  fireEvent.click(screen.getByRole("button", { name: "Load latest dashboard" }))
  await screen.findByRole("alertdialog")
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  expect(screen.getByLabelText("Dashboard title")).toHaveValue("My local draft")
  fireEvent.click(screen.getByRole("button", { name: "Load latest dashboard" }))
  fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }))
  await screen.findByRole("heading", { name: "Remote update" })
  expect(screen.queryByText("The saved dashboard changed elsewhere. Your draft is preserved.")).not.toBeInTheDocument()
})

it("discards a list snapshot that started before a local save completed", async () => {
  const { api } = fixture()
  await open(api)
  let finish!: (documents: Dashboard[]) => void
  vi.mocked(api.list).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  fireEvent.focus(window)
  fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
  fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: "Saved locally" } })
  fireEvent.click(screen.getByRole("button", { name: "Save dashboard" }))
  await screen.findByRole("heading", { name: "Saved locally" })
  await act(async () => finish([initial]))
  expect(screen.getByRole("heading", { name: "Saved locally" })).toBeVisible()
  expect(screen.getByRole("button", { name: "Saved locally" })).toBeVisible()
  expect(screen.queryByRole("button", { name: "Original dashboard" })).not.toBeInTheDocument()
})

it("reexecutes a visible saved-query reference when its remote definition changes", async () => {
  const widget: Widget = { id: "value", title: "Signal", type: "stat", providerId: "metrics", query: "dormant", queryRef: { id: signal.id }, unit: "", layout: { x: 0, y: 0, w: 6, h: 4 } }
  const { store, api } = fixture({ ...initial, widgets: [widget] }, [signal])
  await open(api)
  await waitFor(() => expect(screen.getByLabelText("Resolved widget value")).toHaveTextContent("1"))
  store.queries = [{ ...signal, query: "up * 2", etag: '\"q2\"' }]
  fireEvent.focus(window)
  await waitFor(() => expect(screen.getByLabelText("Resolved widget value")).toHaveTextContent("2"))
  expect(api.query).toHaveBeenLastCalledWith(expect.objectContaining({ query: "up * 2", providerId: "metrics" }), expect.any(AbortSignal))
  expect(api.save).not.toHaveBeenCalled()
})

it("does not refetch visible widgets when the library snapshot has not changed", async () => {
  const widget: Widget = { id: "value", title: "Signal", type: "stat", providerId: "metrics", query: "dormant", queryRef: { id: signal.id }, unit: "", layout: { x: 0, y: 0, w: 6, h: 4 } }
  const { api } = fixture({ ...initial, widgets: [widget] }, [signal])
  await open(api)
  await waitFor(() => expect(screen.getByLabelText("Resolved widget value")).toHaveTextContent("1"))
  const calls = vi.mocked(api.query).mock.calls.length
  await act(async () => fireEvent.focus(window))
  expect(api.query).toHaveBeenCalledTimes(calls)
})

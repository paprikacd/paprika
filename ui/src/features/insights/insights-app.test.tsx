import { changeQueryEditor } from "./query-code-editor.test-utils";
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import InsightsApp from "./insights-app"
import type { InsightsClient } from "./client"
import { InsightsHTTPError } from "./client"
import { CheckFinding, CheckReport, Severity, Source } from "@/gen/paprika/insights/v1/checks_pb"
import type { Dashboard, SavedQuery } from "./schema"
import { readExampleWorkspace, writeExampleWorkspace } from "./example-storage"
import { EXAMPLE_SAVED_QUERIES_KEY } from "./saved-query-storage"
import { parseDashboardBundle, serializeDashboardLibrary } from "./workspace-transfer"

vi.mock("./canvas", () => ({
  DashboardCanvas: ({ focus, dashboard, editing, onSelect }: {
    focus?: { render: (preview: ReactNode) => ReactNode }
    dashboard: Dashboard
    editing: boolean
    onSelect: (id: string) => void
  }) => focus ? focus.render(<div data-testid="mock-canvas" />) : <div data-testid="mock-canvas">
    {editing && dashboard.widgets.map(widget => (
      <article key={widget.id} data-widget-id={widget.id} tabIndex={0}>
        <button data-widget-edit={widget.id} onClick={() => onSelect(widget.id)}>Edit {widget.title}</button>
      </article>
    ))}
  </div>,
}))

// Deliberately use a different object-key order from the canonical Zod output.
const first: Dashboard = {
  widgets: [],
  refreshInterval: 0,
  timeRange: "1h",
  title: "Dashboard A",
  id: "a",
  schemaVersion: 1,
}
const second: Dashboard = { ...first, id: "b", title: "Dashboard B" }
function client(): InsightsClient {
  return {
    providers: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([first, second]),
    get: vi.fn(async (id: string) => ({
      dashboard: id === "a" ? first : second,
      etag: '"v1"',
    })),
    save: vi.fn().mockResolvedValue('"v2"'),
    remove: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ series: [] }),
    listSavedQueries: vi.fn().mockResolvedValue([]), getSavedQuery: vi.fn(), saveSavedQuery: vi.fn(), removeSavedQuery: vi.fn(),
    providerConfigs: vi.fn().mockResolvedValue([]),
    saveProvider: vi.fn().mockResolvedValue(undefined),
    removeProvider: vi.fn().mockResolvedValue(undefined),
    testProvider: vi
      .fn()
      .mockResolvedValue({ ok: true, durationMs: 1, message: "Connected" }),
    metadata: vi.fn().mockResolvedValue({ values: [] }),
  }
}
async function importCopies(count = 1) {
  const button = await screen.findByRole("button", { name: `Import ${count} as new` })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
}
async function queryWorkbench() {
  // Explorer is lazy-loaded. Wait for the rendered workspace, not a cold
  // module import to finish within Testing Library's default one second.
  const workbench = await screen.findByRole("region", { name: "Query workbench" }, { timeout: 5000 })
  expect(workbench).toBeVisible()
  return workbench
}
async function chartDraftInExplorer(api = client(), dashboardDirty = false) {
  const dashboard: Dashboard = {
    ...first,
    widgets: [{ id: "latency", title: "Request latency", type: "timeseries", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 } }],
  }
  vi.mocked(api.providers).mockResolvedValue([{ id: "metrics", name: "Metrics", type: "prometheus", capabilities: ["metrics"] }])
  vi.mocked(api.list).mockResolvedValue([dashboard, second])
  vi.mocked(api.get).mockImplementation(async id => ({ dashboard: id === dashboard.id ? dashboard : second, etag: '"v1"' }))
  render(<InsightsApp client={api} />)
  await screen.findByRole("heading", { name: "Dashboard A" })
  fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
  if (dashboardDirty) fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: "Unsaved dashboard title" } })
  fireEvent.click(screen.getByRole("button", { name: "Edit Request latency" }))
  const title = await screen.findByRole("textbox", { name: "Title", exact: true }, { timeout: 5000 })
  fireEvent.change(title, { target: { value: "Unapplied latency title" } })
  fireEvent.click(screen.getByRole("tab", { name: "Tooltips" }))
  fireEvent.click(screen.getByRole("button", { name: "Use saved query" }))
  fireEvent.click(await screen.findByRole("button", { name: /^(Create saved query|Manage saved queries)$/ }))
  await queryWorkbench()
  return { api, title }
}
// Only the tablet breakpoint matches here. The phone shell (600px) has its own suite in phone-shell.test.tsx.
function viewport(mobile: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({
    matches: mobile && query === "(max-width: 950px)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}
beforeEach(() => {
  window.history.replaceState(null, "", "/dashboard/insights/")
  viewport(false)
  vi.stubGlobal("confirm", vi.fn().mockReturnValue(true))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Insights application state", () => {
  it("preserves an explorer draft across closing and a library refresh", async () => {
    const api = client()
    vi.mocked(api.providers).mockResolvedValue([{ id: "metrics", name: "Metrics", type: "prometheus", capabilities: ["metrics"] }])
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: /^Explore \d+$/ }))
    await queryWorkbench()
    const name = screen.getByLabelText("Query name")
    fireEvent.change(name, { target: { value: "A retained draft" } })
    fireEvent.click(screen.getByRole("button", { name: "Dashboard" }))
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: /^Explore \d+$/ }))
    await queryWorkbench()
    await waitFor(() => expect(api.listSavedQueries).toHaveBeenCalledTimes(3))
    expect(await screen.findByLabelText("Query name")).toHaveValue("A retained draft")
    expect(api.query).not.toHaveBeenCalled()
  }, 10000) // Includes a cold lazy import and two complete workspace transitions.

  it("preserves a focused widget draft when returning from query creation through sidebar Dashboards", async () => {
    const api=client();
    vi.mocked(api.providers).mockResolvedValue([{id:"metrics",name:"Metrics",type:"prometheus",capabilities:["metrics"]}]);
    render(<InsightsApp client={api}/>);
    await screen.findByRole("heading",{name:"Dashboard A"});
    fireEvent.click(screen.getByRole("button",{name:"Edit dashboard"}));
    fireEvent.click(screen.getByRole("button",{name:"Add your first widget"}));
    fireEvent.click(screen.getByRole("button",{name:/^Time series/}));
    fireEvent.change(await screen.findByLabelText("Title", {}, { timeout: 5000 }),{target:{value:"Retained unapplied widget draft"}});
    expect(screen.queryByRole("complementary", { name: "Insights navigation" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Tooltips" }));
    fireEvent.click(screen.getByRole("button", { name: "Use saved query" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create saved query" }));
    await screen.findByLabelText("Query name");
    fireEvent.click(screen.getByRole("button",{name:/^Dashboards \d+$/}));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Retained unapplied widget draft");
    expect(screen.getByRole("button",{name:"Apply changes"})).toBeVisible();
    expect(screen.getByRole("heading", { name: "Retained unapplied widget draft" })).toHaveFocus();
  }, 15000);

  it.each([
    { name: /^Examples \d+$/, region: "Repository examples", close: "Close examples" },
    { name: /^Data sources \d+$/, region: "Data sources", close: "Close data sources" },
    { name: "Dashboard as code", region: "Dashboard source editor", close: "Close source editor" },
    { name: "About data sources", region: "Data sources", close: "Close data sources" },
  ])("protects the chart draft before opening $region from Explore ($name)", async ({ name, region, close }) => {
    const { api, title } = await chartDraftInExplorer()
    fireEvent.click(screen.getByRole("button", { name }))
    const confirmation = await screen.findByRole("alertdialog", { name: "Discard chart changes?" })
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(screen.getByLabelText("Query name")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Dashboard", exact: true }))
    expect(title).toHaveValue("Unapplied latency title")
    expect(screen.getByRole("button", { name: "Undo chart change", exact: true })).toBeEnabled()

    fireEvent.click(screen.getByRole("button", { name: "Create saved query" }))
    await queryWorkbench()
    fireEvent.click(screen.getByRole("button", { name }))
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Discard chart changes?" })).getByRole("button", { name: "Discard changes" }))
    expect(await screen.findByRole("region", { name: region }, { timeout: 10000 })).toBeVisible()
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Widget editor" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: close }))
    fireEvent.click(screen.getByRole("button", { name: "Edit Request latency" }))
    expect(await screen.findByRole("textbox", { name: "Title", exact: true }, { timeout: 5000 })).toHaveValue("Request latency")
    expect(api.save).not.toHaveBeenCalled()
  }, 15000) // Chart-draft tests open Explore and the lazy widget editor; they exceed the default five seconds under a parallel run.

  it.each([false, true])("asks once before creating a dashboard with an unapplied chart (dashboard dirty: %s)", async dashboardDirty => {
    const { api, title } = await chartDraftInExplorer(client(), dashboardDirty)
    fireEvent.click(screen.getByRole("button", { name: "New dashboard" }))
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" })).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(screen.getByLabelText("Query name")).toBeVisible()
    expect(title).toBeInTheDocument()
    expect(title).toHaveValue("Unapplied latency title")
    fireEvent.click(screen.getByRole("button", { name: "New dashboard" }))
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" })).getByRole("button", { name: "Discard changes" }))
    await waitFor(() => expect(screen.getByLabelText("Dashboard title")).toHaveValue("Untitled dashboard"))
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Widget editor" })).not.toBeInTheDocument()
    expect(api.save).not.toHaveBeenCalled()
  }, 15000) // Chart-draft tests open Explore and the lazy widget editor; they exceed the default five seconds under a parallel run.

  it("keeps Explore and the chart draft intact when cancelling dashboard navigation", async () => {
    const { title } = await chartDraftInExplorer()
    fireEvent.click(screen.getByRole("button", { name: "Dashboard B" }))
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" })).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(screen.getByLabelText("Query name")).toBeVisible()
    expect(title).toBeInTheDocument()
    expect(title).toHaveValue("Unapplied latency title")
    fireEvent.click(screen.getByRole("button", { name: "Dashboard B" }))
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" })).getByRole("button", { name: "Discard changes" }))
    expect(await screen.findByRole("heading", { name: "Dashboard B" })).toBeVisible()
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  }, 15000) // Chart-draft tests open Explore and the lazy widget editor; they exceed the default five seconds under a parallel run.

  it("waits for chart discard before adding a saved query from Explore", async () => {
    const api = client()
    const saved: SavedQuery = { schemaVersion: 1, id: "saved", name: "Saved signal", providerId: "metrics", kind: "metrics", query: "up" }
    vi.mocked(api.listSavedQueries).mockResolvedValue([{ ...saved, etag: '"q1"' }])
    const { title } = await chartDraftInExplorer(api)
    fireEvent.click(screen.getByRole("combobox", { name: "Open saved query" }))
    fireEvent.click(await screen.findByRole("option", { name: /Saved signal/ }))
    const useQuery = screen.getByRole("button", { name: "Use in dashboard" })
    await waitFor(() => expect(useQuery).toBeEnabled())
    fireEvent.click(useQuery)
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Discard chart changes?" })).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(screen.getByLabelText("Query name")).toBeVisible()
    expect(title).toBeInTheDocument()
    expect(title).toHaveValue("Unapplied latency title")
    fireEvent.click(useQuery)
    fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Discard chart changes?" })).getByRole("button", { name: "Discard changes" }))
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Saved signal"))
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Back to dashboard" }))
    const save = await screen.findByRole("button", { name: "Save dashboard" })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    await waitFor(() => {
      expect(screen.queryByRole("alert")?.textContent).toBeUndefined()
      expect(api.save).toHaveBeenCalledOnce()
    })
    expect(vi.mocked(api.save).mock.calls[0][0].widgets.map(widget => widget.title)).toEqual(["Request latency", "Saved signal"])
  }, 15000) // Chart-draft tests open Explore and the lazy widget editor; they exceed the default five seconds under a parallel run.

  it("creates a saved query from a fresh tooltip and returns to the same unapplied tooltip draft", async () => {
    const api = client()
    let savedQuery: SavedQuery | undefined
    vi.mocked(api.providers).mockResolvedValue([{ id: "metrics", name: "Metrics", type: "prometheus", capabilities: ["metrics"] }])
    vi.mocked(api.listSavedQueries).mockImplementation(async () => savedQuery ? [{ ...savedQuery, etag: '"q1"' }] : [])
    vi.mocked(api.saveSavedQuery).mockImplementation(async query => {
      savedQuery = query
      return '"q1"'
    })
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    fireEvent.click(screen.getByRole("button", { name: "Add your first widget" }))
    fireEvent.click(screen.getByRole("button", { name: /^Time series/ }))
    fireEvent.change(await screen.findByLabelText("Title", {}, { timeout: 5000 }), { target: { value: "Unapplied source widget" } })
    fireEvent.click(screen.getByRole("tab", { name: "Tooltips" }))
    fireEvent.click(screen.getByRole("button", { name: "Use saved query" }))
    fireEvent.change(screen.getByLabelText("Tooltip title"), { target: { value: "Retained tooltip draft" } })
    fireEvent.click(await screen.findByRole("button", { name: "Create saved query" }))

    const workbench = await queryWorkbench()
    fireEvent.change(screen.getByLabelText("Query name"), { target: { value: "Created from tooltip" } })
    fireEvent.click(within(workbench).getByRole("tab", { name: "Code" }))
    changeQueryEditor(within(workbench).getByRole("textbox", { name: /PromQL query/ }), "sum(rate(http_requests_total[5m]))")
    fireEvent.click(screen.getByRole("button", { name: "Save query" }))
    await waitFor(() => expect(api.saveSavedQuery).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Open saved query" })).toHaveTextContent("Created from tooltip"))
    expect(api.query).not.toHaveBeenCalled()
    expect(api.save).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Dashboard" }))
    await waitFor(() => expect(screen.getByRole("tab", { name: "Tooltips" })).toHaveAttribute("aria-selected", "true"))
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Unapplied source widget")
    expect(screen.getByLabelText("Tooltip title")).toHaveValue("Retained tooltip draft")
    expect(screen.getByRole("combobox", { name: "Tooltip data source" })).toHaveTextContent("Saved query")
    fireEvent.click(screen.getByRole("combobox", { name: "Tooltip saved query" }))
    fireEvent.click(await screen.findByRole("option", { name: /Created from tooltip/ }))
    expect(screen.getByLabelText("Tooltip saved query template")).toHaveValue("sum(rate(http_requests_total[5m]))")
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }))
    fireEvent.click(screen.getByRole("button", { name: "Save dashboard" }))
    await waitFor(() => expect(api.save).toHaveBeenCalledOnce())
    const persisted = vi.mocked(api.save).mock.calls[0][0]
    expect(persisted.widgets[0].title).toBe("Unapplied source widget")
    expect(persisted.widgets[0].options?.tooltipView).toMatchObject({
      type: "timeseries", title: "Retained tooltip draft",
      source: { type: "saved", ref: { id: savedQuery!.id } },
    })
    expect(api.query).not.toHaveBeenCalled()
  }, 10000) // The full edit/save/return workflow exceeds five seconds on contended CI.

  it("protects unsaved explorer changes when leaving Insights or the browser page", async () => {
    const api = client(), onBack = vi.fn()
    render(<InsightsApp client={api} onBack={onBack} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: /^Explore \d+$/ }))
    fireEvent.change(await screen.findByLabelText("Query name"), { target: { value: "Unsaved query" } })
    const unload = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Back to Paprika" }))
    await screen.findByRole("alertdialog")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onBack).not.toHaveBeenCalled()
    expect(screen.getByLabelText("Query name")).toHaveValue("Unsaved query")
    fireEvent.click(screen.getByRole("button", { name: "Back to Paprika" }))
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }))
    await waitFor(() => expect(onBack).toHaveBeenCalledOnce())
  })

  it("does not let an earlier library snapshot replace a just-saved definition", async () => {
    const api = client()
    const saved = { schemaVersion: 1 as const, id: "saved", name: "Saved signal", providerId: "metrics", kind: "metrics" as const, query: "up" }
    vi.mocked(api.providers).mockResolvedValue([{ id: "metrics", name: "Metrics", type: "prometheus", capabilities: ["metrics"] }])
    vi.mocked(api.listSavedQueries).mockResolvedValue([{ ...saved, etag: '\"v1\"' }])
    vi.mocked(api.saveSavedQuery).mockResolvedValue('\"v2\"')
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: /^Explore \d+$/ }))
    fireEvent.click(await screen.findByRole("combobox", { name: "Open saved query" }))
    fireEvent.click(await screen.findByRole("option", { name: /Saved signal/ }))
    await waitFor(() => expect(screen.getByLabelText("Query name")).toHaveValue("Saved signal"))
    fireEvent.change(screen.getByLabelText("Query name"), { target: { value: "Changed signal" } })
    fireEvent.click(screen.getByRole("button", { name: "Dashboard" }))
    let finish!: (entries: []) => void
    vi.mocked(api.listSavedQueries).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByRole("button", { name: /^Explore \d+$/ }))
    await screen.findByText("Loading saved queries…")
    fireEvent.click(screen.getByRole("button", { name: "Save query" }))
    await waitFor(() => expect(api.saveSavedQuery).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Open saved query" })).toHaveTextContent("Changed signal"))
    await act(async () => finish([]))
    expect(screen.getByRole("combobox", { name: "Open saved query" })).toHaveTextContent("Changed signal")
    expect(screen.getByRole("button", { name: /^Explore 1$/ })).toBeInTheDocument()
  })

  it("opens a new dashboard from Explore without retaining the hidden explorer view", async () => {
    const api = client()
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: /^Explore \d+$/ }))
    await screen.findByLabelText("Query name")
    fireEvent.click(screen.getByRole("button", { name: "New dashboard" }))
    await waitFor(() => expect(screen.getByLabelText("Dashboard title")).toBeVisible())
    expect(screen.getByLabelText("Dashboard title")).toHaveValue("Untitled dashboard")
    expect(screen.getByLabelText("Query name")).not.toBeVisible()
  })

  it("marks a validated save clean despite reordered object keys and trimmed form values", async () => {
    const api = client()
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    fireEvent.change(screen.getByLabelText("Dashboard title"), {
      target: { value: "Renamed dashboard  " },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save dashboard" }))
    await screen.findByRole("heading", { name: "Renamed dashboard" })
    expect(screen.getByText("All changes saved")).toBeInTheDocument()
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Dashboard B" }))
    await screen.findByRole("heading", { name: "Dashboard B" })
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it("undoes a burst of dashboard title typing in one step", async () => {
    const api = client()
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    const original = (screen.getByLabelText("Dashboard title") as HTMLInputElement).value
    fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: `${original} a` } })
    fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: `${original} ab` } })
    fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: `${original} abc` } })
    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    expect(screen.getByLabelText("Dashboard title")).toHaveValue(original)
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled()
  })

  it("undoes a burst of dashboard title typing with Control+Z outside any field", async () => {
    const api = client()
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    const title = screen.getByLabelText("Dashboard title") as HTMLInputElement
    const original = title.value
    fireEvent.change(title, { target: { value: `${original} a` } })
    fireEvent.change(title, { target: { value: `${original} ab` } })
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true })
    expect(screen.getByLabelText("Dashboard title")).toHaveValue(original)
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true, shiftKey: true })
    expect(screen.getByLabelText("Dashboard title")).toHaveValue(`${original} ab`)
  })

  it("leaves Control+Z inside the title field to the browser", async () => {
    const api = client()
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    const title = screen.getByLabelText("Dashboard title") as HTMLInputElement
    const original = title.value
    fireEvent.change(title, { target: { value: `${original} typed` } })
    expect(fireEvent.keyDown(title, { key: "z", ctrlKey: true })).toBe(true)
    expect(screen.getByLabelText("Dashboard title")).toHaveValue(`${original} typed`)
  })

  it("saves with Control+S exactly once, prevents the browser save, and keeps the document saved", async () => {
    const api = client()
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: "Keyboard saved" } })
    expect(fireEvent.keyDown(document.body, { key: "s", ctrlKey: true })).toBe(false)
    await screen.findByRole("heading", { name: "Keyboard saved" })
    expect(api.save).toHaveBeenCalledTimes(1)
    expect(screen.getByText("All changes saved")).toBeInTheDocument()
  })

  it("does not intercept Control+S in view mode", async () => {
    const api = client()
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    expect(fireEvent.keyDown(document.body, { key: "s", ctrlKey: true })).toBe(true)
    expect(api.save).not.toHaveBeenCalled()
  })

  it("does not run Control+S or undo while a confirmation is open", async () => {
    const api = client()
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: "Pending title" } })
    fireEvent.click(screen.getByRole("button", { name: "Dashboard B" }))
    await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" })
    expect(fireEvent.keyDown(document.body, { key: "s", ctrlKey: true })).toBe(true)
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true })
    expect(api.save).not.toHaveBeenCalled()
    expect(screen.getByLabelText("Dashboard title")).toHaveValue("Pending title")
  })

  it("saves with Control+S but keeps an unapplied chart draft and its editor open", async () => {
    const api = client()
    const dashboard: Dashboard = {
      ...first,
      widgets: [{ id: "latency", title: "Request latency", type: "timeseries", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 } }],
    }
    vi.mocked(api.providers).mockResolvedValue([{ id: "metrics", name: "Metrics", type: "prometheus", capabilities: ["metrics"] }])
    vi.mocked(api.list).mockResolvedValue([dashboard, second])
    vi.mocked(api.get).mockImplementation(async id => ({ dashboard: id === dashboard.id ? dashboard : second, etag: '"v1"' }))
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    fireEvent.click(screen.getByRole("button", { name: "Edit Request latency" }))
    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }, { timeout: 5000 }), { target: { value: "Unapplied latency title" } })
    expect(fireEvent.keyDown(document.body, { key: "s", ctrlKey: true })).toBe(false)
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1))
    expect(await screen.findByText("Saved. Chart changes are still unapplied.")).toBeInTheDocument()
    expect(screen.queryByText("Dashboard saved.")).not.toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Unapplied latency title")
  })

  it("uses the Command modifier on Apple platforms", async () => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true })
    try {
      const api = client()
      render(<InsightsApp client={api} />)
      await screen.findByRole("heading", { name: "Dashboard A" })
      fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
      const title = screen.getByLabelText("Dashboard title") as HTMLInputElement
      const original = title.value
      fireEvent.change(title, { target: { value: `${original} mac` } })
      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true })
      expect(screen.getByLabelText("Dashboard title")).toHaveValue(`${original} mac`)
      fireEvent.keyDown(document.body, { key: "z", metaKey: true })
      expect(screen.getByLabelText("Dashboard title")).toHaveValue(original)
      expect(screen.getByRole("button", { name: "Undo" })).toHaveAttribute("title", "Undo (⌘Z)")
    } finally {
      delete (navigator as unknown as Record<string, unknown>).platform
    }
  })

  it("names the undo, redo and save shortcuts on their buttons", async () => {
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    expect(screen.getByRole("button", { name: "Undo" })).toHaveAttribute("aria-keyshortcuts", "Control+Z Meta+Z")
    expect(screen.getByRole("button", { name: "Undo" })).toHaveAttribute("title", "Undo (Ctrl+Z)")
    expect(screen.getByRole("button", { name: "Redo" })).toHaveAttribute("aria-keyshortcuts", "Control+Shift+Z Meta+Shift+Z Control+Y")
    expect(screen.getByRole("button", { name: "Save dashboard" })).toHaveAttribute("aria-keyshortcuts", "Control+S Meta+S")
    expect(screen.getByRole("button", { name: "Save dashboard" })).toHaveAttribute("title", "Save dashboard (Ctrl+S)")
  })

  describe("keyboard shortcuts with a chart open", () => {
    const latency = { id: "latency", title: "Request latency", type: "timeseries", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 } } as const
    async function openChart() {
      const api = client()
      const dashboard: Dashboard = { ...first, widgets: [{ ...latency }] }
      vi.mocked(api.providers).mockResolvedValue([{ id: "metrics", name: "Metrics", type: "prometheus", capabilities: ["metrics"] }])
      vi.mocked(api.list).mockResolvedValue([dashboard, second])
      vi.mocked(api.get).mockImplementation(async id => ({ dashboard: id === dashboard.id ? dashboard : second, etag: '"v1"' }))
      render(<InsightsApp client={api} />)
      await screen.findByRole("heading", { name: "Dashboard A" })
      fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
      fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: "Dashboard renamed" } })
      fireEvent.click(screen.getByRole("button", { name: "Edit Request latency" }))
      await screen.findByRole("textbox", { name: /^Title$/ }, { timeout: 5000 })
      return api
    }
    const chartTitle = () => screen.getByRole("textbox", { name: /^Title$/ }) as HTMLInputElement

    it("undoes the chart change with Control+Z and leaves the dashboard alone", async () => {
      await openChart()
      fireEvent.change(chartTitle(), { target: { value: "Chart renamed" } })
      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true })
      expect(chartTitle()).toHaveValue("Request latency")
      expect(screen.getByLabelText("Dashboard title")).toHaveValue("Dashboard renamed")
    })

    it("applies the chart draft with Control+Enter outside the query text", async () => {
      await openChart()
      fireEvent.change(chartTitle(), { target: { value: "Chart applied" } })
      expect(fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true })).toBe(false)
      expect(await screen.findByRole("button", { name: "Edit Chart applied" })).toBeInTheDocument()
    })

    it("applies once when Control+Enter is held", async () => {
      await openChart()
      fireEvent.change(chartTitle(), { target: { value: "Chart held" } })
      // A held key sends repeats; only the first press applies.
      expect(fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true, repeat: true })).toBe(false)
      expect(screen.queryByRole("button", { name: "Edit Chart held" })).not.toBeInTheDocument()
      fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true })
      expect(await screen.findByRole("button", { name: "Edit Chart held" })).toBeInTheDocument()
    })

    it("ignores Control+Enter while the chart draft is invalid", async () => {
      await openChart()
      fireEvent.change(chartTitle(), { target: { value: "Chart invalid" } })
      fireEvent.change(screen.getByLabelText("Left inset (px)"), { target: { value: "1" } })
      const apply = screen.getByRole("button", { name: "Apply changes" })
      await waitFor(() => expect(apply).toBeDisabled())
      expect(fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true })).toBe(true)
      expect(screen.queryByRole("button", { name: "Edit Chart invalid" })).not.toBeInTheDocument()
    })

    it("does not change the dashboard with Control+Z while the chart has no history", async () => {
      await openChart()
      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true })
      expect(screen.getByLabelText("Dashboard title")).toHaveValue("Dashboard renamed")
      expect(chartTitle()).toHaveValue("Request latency")
    })

    it("names apply and the chart undo and redo shortcuts on their buttons", async () => {
      await openChart()
      expect(screen.getByRole("button", { name: "Apply changes" })).toHaveAttribute("aria-keyshortcuts", "Control+Enter Meta+Enter")
      expect(screen.getByRole("button", { name: "Apply changes" })).toHaveAttribute("title", "Apply changes (Ctrl+Enter)")
      expect(screen.getByRole("button", { name: "Undo chart change" })).toHaveAttribute("title", "Undo (Ctrl+Z)")
      expect(screen.getByRole("button", { name: "Redo chart change" })).toHaveAttribute("aria-keyshortcuts", "Control+Shift+Z Meta+Shift+Z Control+Y")
    })
  })

  describe("removing a focused tile", () => {
    const latency = { id: "latency", title: "Request latency", type: "timeseries", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 } } as const
    const signal = { id: "signal", title: "Signal", type: "timeseries", providerId: "metrics", query: "down", unit: "", layout: { x: 6, y: 0, w: 6, h: 4 } } as const
    function tilesClient(widgets: Dashboard["widgets"] = [{ ...latency }, { ...signal }]) {
      const api = client()
      const dashboard: Dashboard = { ...first, widgets }
      vi.mocked(api.list).mockResolvedValue([dashboard, second])
      vi.mocked(api.get).mockImplementation(async id => ({ dashboard: id === dashboard.id ? dashboard : second, etag: '"v1"' }))
      return api
    }
    async function editTiles(api: InsightsClient) {
      render(<InsightsApp client={api} />)
      await screen.findByRole("heading", { name: "Dashboard A" })
      fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    }

    it("removes the focused tile on Delete, moves focus to the next tile and offers Undo", async () => {
      await editTiles(tilesClient())
      const chip = screen.getByRole("button", { name: "Edit Request latency" })
      chip.focus()
      fireEvent.keyDown(chip, { key: "Delete" })
      expect(screen.queryByRole("button", { name: "Edit Request latency" })).toBeNull()
      expect(screen.getByText("Removed Request latency.")).toBeInTheDocument()
      expect(document.activeElement).toHaveAttribute("data-widget-id", "signal")
    })

    it("restores the tile with the notice's Undo action, and Control+Z also restores it", async () => {
      await editTiles(tilesClient())
      const chip = screen.getByRole("button", { name: "Edit Request latency" })
      fireEvent.keyDown(chip, { key: "Backspace" })
      const notice = screen.getByText("Removed Request latency.").parentElement!
      fireEvent.click(within(notice).getByRole("button", { name: "Undo remove Request latency" }))
      expect(screen.getByRole("button", { name: "Edit Request latency" })).toBeInTheDocument()
      expect(screen.getByText("Restored Request latency.")).toBeInTheDocument()
      expect(document.activeElement).toHaveAttribute("data-widget-id", "latency")
      expect(screen.queryByText("Removed Request latency.")).toBeNull()
      fireEvent.keyDown(screen.getByRole("button", { name: "Edit Request latency" }), { key: "Delete" })
      expect(screen.queryByRole("button", { name: "Edit Request latency" })).toBeNull()
      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true })
      expect(screen.getByRole("button", { name: "Edit Request latency" })).toBeInTheDocument()
    })

    it("moves focus to the title when the last tile is removed", async () => {
      await editTiles(tilesClient([{ ...latency }]))
      fireEvent.keyDown(screen.getByRole("button", { name: "Edit Request latency" }), { key: "Delete" })
      expect(document.activeElement).toBe(screen.getByLabelText("Dashboard title"))
    })

    it("never removes a tile from a text field", async () => {
      await editTiles(tilesClient())
      const title = screen.getByLabelText("Dashboard title")
      title.focus()
      fireEvent.keyDown(title, { key: "Backspace" })
      fireEvent.keyDown(title, { key: "Delete" })
      expect(screen.getByRole("button", { name: "Edit Request latency" })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Edit Signal" })).toBeInTheDocument()
    })

    it("ignores Delete outside a tile, and keeps the tile when the key is held", async () => {
      await editTiles(tilesClient())
      fireEvent.keyDown(document.body, { key: "Delete" })
      const chip = screen.getByRole("button", { name: "Edit Request latency" })
      fireEvent.keyDown(chip, { key: "Delete", repeat: true })
      expect(screen.getByRole("button", { name: "Edit Request latency" })).toBeInTheDocument()
    })

    it("withdraws the removal notice and its Undo once a later edit changes the dashboard", async () => {
      await editTiles(tilesClient())
      fireEvent.keyDown(screen.getByRole("button", { name: "Edit Request latency" }), { key: "Delete" })
      expect(screen.getByRole("button", { name: "Undo remove Request latency" })).toBeInTheDocument()
      fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: "Edited after removal" } })
      // The notice's Undo could only revert the later edit now, so it is gone with the notice.
      expect(screen.queryByText("Removed Request latency.")).toBeNull()
      expect(screen.queryByRole("button", { name: /^Undo remove/ })).toBeNull()
      expect(screen.getByLabelText("Dashboard title")).toHaveValue("Edited after removal")
    })

    it("withdraws the removal notice when Control+Z restores the tile", async () => {
      await editTiles(tilesClient())
      fireEvent.keyDown(screen.getByRole("button", { name: "Edit Request latency" }), { key: "Delete" })
      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true })
      expect(screen.getByRole("button", { name: "Edit Request latency" })).toBeInTheDocument()
      expect(screen.queryByText("Removed Request latency.")).toBeNull()
      expect(screen.queryByRole("button", { name: /^Undo remove/ })).toBeNull()
    })
  })

  describe("the keyboard shortcut list", () => {
    it("renders inside the Insights theme scope, so its tokens resolve", async () => {
      render(<InsightsApp client={client()} />)
      await screen.findByRole("heading", { name: "Dashboard A" })
      fireEvent.keyDown(document.body, { key: "?" })
      const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" })
      const scope = dialog.closest("[data-insights-theme]")
      expect(scope).not.toBeNull()
      expect(scope).toBe(document.querySelector("[data-insights-theme]"))
    })

    it("opens with ? outside text fields and closes on cancel", async () => {
      render(<InsightsApp client={client()} />)
      await screen.findByRole("heading", { name: "Dashboard A" })
      fireEvent.keyDown(document.body, { key: "?", shiftKey: true })
      const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" })
      expect(within(dialog).getByText("Save dashboard (while editing)")).toBeInTheDocument()
      fireEvent(dialog, new Event("cancel", { cancelable: true }))
      expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull()
    })

    it("does not open for ? typed into the title field", async () => {
      render(<InsightsApp client={client()} />)
      await screen.findByRole("heading", { name: "Dashboard A" })
      fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
      const title = screen.getByLabelText("Dashboard title")
      expect(fireEvent.keyDown(title, { key: "?", shiftKey: true })).toBe(true)
      expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull()
    })

    it("opens from the Editing canvas hint and names the platform keys", async () => {
      Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true })
      try {
        render(<InsightsApp client={client()} />)
        await screen.findByRole("heading", { name: "Dashboard A" })
        fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
        fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }))
        const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" })
        expect(within(dialog).getByText("⌘Z")).toBeInTheDocument()
        fireEvent.click(within(dialog).getByRole("button", { name: "Close keyboard shortcuts" }))
        expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull()
      } finally {
        delete (navigator as unknown as Record<string, unknown>).platform
      }
    })
  })

  it("does not close a new dashboard draft when an older save finishes", async () => {
    const api = client()
    let finishSave!: (etag: string) => void
    vi.mocked(api.save).mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve
      }),
    )
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    fireEvent.change(screen.getByLabelText("Dashboard title"), {
      target: { value: "Saved A" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save dashboard" }))
    fireEvent.click(screen.getByRole("button", { name: "New dashboard" }))
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }))
    await waitFor(() => expect(screen.getByLabelText("Dashboard title")).toHaveValue(
      "Untitled dashboard",
    ))
    await act(async () => finishSave('"v2"'))
    expect(screen.getByLabelText("Dashboard title")).toHaveValue(
      "Untitled dashboard",
    )
    expect(
      screen.getByRole("heading", { name: "Find your perspective" }),
    ).toBeInTheDocument()
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument()
    expect(screen.queryByText("Dashboard saved.")).not.toBeInTheDocument()
  })

  it("keeps the mobile primary action visible and secondary actions keyboard accessible", async () => {
    viewport(true)
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    expect(screen.getByRole("button", { name: "Edit dashboard" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Manage dashboards" })).not.toBeInTheDocument()
    const actions = screen.getByRole("button", { name: "Dashboard actions" })
    fireEvent.keyDown(actions, { key: "ArrowDown" })
    const manage = await screen.findByRole("menuitem", { name: "Manage dashboards" })
    expect(manage).toHaveFocus()
    fireEvent.keyDown(manage, { key: "Escape" })
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(actions).toHaveFocus()
    fireEvent.click(actions)
    fireEvent.click(await screen.findByRole("menuitem", { name: "Build with AI" }))
    expect(screen.getByRole("button", { name: "Save dashboard" })).toBeVisible()
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  })

  it("exposes mobile navigation state, traps focus, and restores it on Escape", async () => {
    viewport(true)
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    const toggle = screen.getByRole("button", { name: "Toggle sidebar" })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    toggle.focus()
    fireEvent.click(toggle)
    const drawer = screen.getByRole("dialog", { name: "Insights navigation" })
    const close = screen.getByRole("button", { name: "Close navigation" })
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(drawer).toHaveAttribute("aria-modal", "true")
    expect(close).toHaveFocus()
    expect(toggle.closest("[inert]")).not.toBeNull()
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true })
    expect(
      screen.getByRole("button", { name: "Dashboard as code" }),
    ).toHaveFocus()
    fireEvent.keyDown(document, { key: "Tab" })
    expect(close).toHaveFocus()
    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Insights navigation" }),
      ).not.toBeInTheDocument(),
    )
    expect(toggle).toHaveFocus()
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(toggle.closest("[inert]")).toBeNull()
    expect(document.body.style.overflow).not.toBe("hidden")
  })
  it("yields drawer keyboard handling to a confirmation without losing the draft", async () => {
    viewport(true)
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: "Unsaved A" } })
    fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }))
    const destination = screen.getByRole("button", { name: "Dashboard B" })
    destination.focus()
    fireEvent.click(destination)
    const confirmation = await screen.findByRole("alertdialog")
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus()
    for (const key of ["Tab", "Escape"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
      fireEvent(document, event)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(screen.getByRole("dialog", { name: "Insights navigation" })).toBeInTheDocument()
    // jsdom has no native modal close watcher; real Escape is exercised in E2E.
    fireEvent(confirmation, new Event("cancel", { cancelable: true }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(destination).toHaveFocus()
    expect(screen.getByLabelText("Dashboard title")).toHaveValue("Unsaved A")
    expect(document.body.style.overflow).toBe("hidden")
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("dialog", { name: "Insights navigation" })).not.toBeInTheDocument()
    expect(document.body.style.overflow).not.toBe("hidden")
  })
  it("recovers a committed import after a lost response and retains its confirmed ETag", async () => {
    const api = client()
    const stored = new Map<string, Dashboard>([
      [first.id, first],
      [second.id, second],
    ])
    let importedReads = 0
    vi.mocked(api.get).mockImplementation(async (id) => {
      const document = stored.get(id)
      if (!document) throw new Error("Not found")
      if (id === "a" || id === "b") return { dashboard: document, etag: '"v1"' }
      importedReads++
      // Only the recovery read returns an ETag. Opening the imported dashboard
      // subsequently must preserve that confirmed version for its next update.
      return {
        dashboard: document,
        etag: importedReads === 1 ? '"confirmed-import"' : undefined,
      }
    })
    vi.mocked(api.save).mockImplementationOnce(async (document) => {
      stored.set(document.id, document)
      throw new Error("Response lost after commit")
    })
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: "Manage dashboards" }))
    fireEvent.click(screen.getByRole("combobox", { name: "Library import format" }))
    fireEvent.click(screen.getByRole("option", { name: "JSON" }))
    fireEvent.change(screen.getByLabelText("Library import source"), {
      target: {
        value: JSON.stringify({
          ...first,
          id: "portable",
          title: "Recovered import",
        }),
      },
    })
    fireEvent.click(screen.getByRole("button", { name: "Review import" }))
    await importCopies()
    await screen.findByText(/^1 dashboard decisions? completed\./)
    expect(api.save).toHaveBeenCalledTimes(1)
    const importedId = vi.mocked(api.save).mock.calls[0][0].id
    expect(importedId).not.toBe("portable")
    expect(api.get).toHaveBeenCalledWith(importedId)
    expect(stored.size).toBe(3)
    expect(
      screen.getAllByRole("button", { name: "Recovered import" }),
    ).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "Recovered import" }))
    await screen.findByRole("heading", { name: "Recovered import" })
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    fireEvent.change(screen.getByLabelText("Dashboard title"), {
      target: { value: "Updated recovered import" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save dashboard" }))
    await waitFor(() =>
      expect(api.save).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          id: importedId,
          title: "Updated recovered import",
        }),
        '"confirmed-import"',
      ),
    )
  })

  it("reuses an unresolved import ID when retrying an ambiguous save", async () => {
    const api = client()
    const stored = new Map<string, Dashboard>([
      [first.id, first],
      [second.id, second],
    ])
    let recoveryReads = 0
    vi.mocked(api.get).mockImplementation(async (id) => {
      const document = stored.get(id)
      if (!document) throw new Error("Not found")
      if (id !== "a" && id !== "b" && ++recoveryReads === 1)
        throw new Error("Connection still unavailable")
      return { dashboard: document, etag: '"confirmed-import"' }
    })
    vi.mocked(api.save).mockImplementation(async (document) => {
      if (stored.has(document.id)) throw new Error("Already exists")
      stored.set(document.id, document)
      throw new Error("Response lost after commit")
    })
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: "Manage dashboards" }))
    fireEvent.click(screen.getByRole("combobox", { name: "Library import format" }))
    fireEvent.click(screen.getByRole("option", { name: "JSON" }))
    fireEvent.change(screen.getByLabelText("Library import source"), {
      target: {
        value: JSON.stringify({
          ...first,
          id: "portable",
          title: "Retried import",
        }),
      },
    })
    fireEvent.click(screen.getByRole("button", { name: "Review import" }))
    await importCopies()
    await screen.findByText(/^0 dashboard decisions? completed\./)
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Response lost after commit",
    )
    await importCopies()
    await screen.findByText(/^1 dashboard decisions? completed\./)
    expect(api.save).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.save).mock.calls[1][0].id).toBe(
      vi.mocked(api.save).mock.calls[0][0].id,
    )
    expect(stored.size).toBe(3)
    expect(
      screen.getAllByRole("button", { name: "Retried import" }),
    ).toHaveLength(1)
  })
  it("keeps an in-flight import mounted and protects leaving after an earlier navigation resolves", async () => {
    const api = client(), onBack = vi.fn()
    let finishNavigation!: (result: { dashboard: Dashboard; etag: string }) => void
    let finishImport!: (etag: string) => void
    vi.mocked(api.get).mockImplementation(id => id === "a"
      ? Promise.resolve({ dashboard: first, etag: '"v1"' })
      : new Promise(resolve => { finishNavigation = resolve }))
    vi.mocked(api.save).mockReturnValue(new Promise(resolve => { finishImport = resolve }))
    render(<InsightsApp client={api} onBack={onBack} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: "Manage dashboards" }))
    fireEvent.click(screen.getByRole("combobox", { name: "Library import format" }))
    fireEvent.click(screen.getByRole("option", { name: "JSON" }))
    fireEvent.change(screen.getByLabelText("Library import source"), { target: { value: JSON.stringify({ ...first, id: "portable", title: "Guarded import" }) } })
    fireEvent.click(screen.getByRole("button", { name: "Review import" }))
    fireEvent.click(screen.getByRole("button", { name: "Dashboard B" }))
    expect(api.get).toHaveBeenCalledWith(second.id)
    await importCopies()
    await waitFor(() => expect(api.save).toHaveBeenCalledOnce())
    expect(screen.getByRole("button", { name: "Back to Paprika" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "New dashboard" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Close dashboard manager" })).toBeDisabled()
    const unload = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Back to Paprika" }))
    expect(onBack).not.toHaveBeenCalled()
    await act(async () => finishNavigation({ dashboard: second, etag: '"v1"' }))
    expect(screen.getByRole("heading", { name: "Dashboard A" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Importing…" })).toBeInTheDocument()
    await act(async () => finishImport('"imported"'))
    await screen.findByText(/^1 dashboard decisions? completed\./)
    expect(screen.getByRole("button", { name: "Back to Paprika" })).toBeEnabled()
    const completedUnload = new Event("beforeunload", { cancelable: true })
    window.dispatchEvent(completedUnload)
    expect(completedUnload.defaultPrevented).toBe(false)
  })

  it("imports and reloads a portable dashboard and its saved query entirely inside the example workspace", async () => {
    localStorage.clear()
    writeExampleWorkspace(localStorage, [first], first.id)
    const query: SavedQuery = {
      schemaVersion: 1, id: "portable-query", name: "Portable signal", providerId: "source-prom", kind: "metrics",
      query: "up{service={{service}}}", parameters: [{ name: "service", type: "string", defaultValue: 'checkout"blue\\west\n{{text}}' }],
    }
    const document: Dashboard = {
      ...first, id: "portable", title: "Portable example", variables: [{ name: "service", defaultValue: "api" }],
      widgets: [{ id: "signal", title: "Signal", type: "heatmap", providerId: "dormant-source", query: "retained_custom_query", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 },
        queryRef: { id: query.id, bindings: [{ parameter: "service", source: "variable", variable: "service" }] },
        options: { tooltipView: { type: "stat", source: { type: "saved", ref: { id: query.id, bindings: [{ parameter: "service", source: "label", label: "service" }] } } } },
      }],
    }
    const api = client()
    const view = render(<InsightsApp client={api} initialExample />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: "Manage dashboards" }))
    fireEvent.click(screen.getByRole("combobox", { name: "Library import format" }))
    fireEvent.click(screen.getByRole("option", { name: "JSON" }))
    fireEvent.change(screen.getByLabelText("Library import source"), { target: { value: serializeDashboardLibrary([document], "json", [query]) } })
    fireEvent.click(screen.getByRole("button", { name: "Review import" }))
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Connect source-prom" })).toBeEnabled())
    fireEvent.click(screen.getByRole("combobox", { name: "Connect source-prom" }))
    fireEvent.click(screen.getByRole("option", { name: "Prometheus · example" }))
    await importCopies()
    await screen.findByText(/^1 dashboard decisions? completed\./)
    const workspace = readExampleWorkspace(localStorage)
    expect(workspace.activeId).toBe(first.id)
    expect(workspace.dashboards).toHaveLength(2)
    const imported = workspace.dashboards.find(item => item.title === document.title)!
    expect(imported.id).not.toBe(document.id)
    expect(imported.widgets).toEqual(document.widgets)
    const stored = JSON.parse(localStorage.getItem(EXAMPLE_SAVED_QUERIES_KEY)!)
    expect(stored).toEqual([{ ...query, providerId: "example-prometheus", etag: expect.any(String) }])
    fireEvent.click(screen.getByRole("button", { name: "Portable example" }))
    await screen.findByRole("heading", { name: "Portable example" })
    view.unmount()
    render(<InsightsApp client={api} initialExample />)
    await screen.findByRole("heading", { name: "Portable example" })
    await waitFor(() => expect(screen.getByRole("button", { name: /^Explore 1$/ })).toBeInTheDocument())
    for (const method of [api.providers, api.list, api.get, api.save, api.query, api.listSavedQueries, api.getSavedQuery, api.saveSavedQuery])
      expect(method).not.toHaveBeenCalled()
    localStorage.clear()
  })

  it("focuses an opened builder panel without stealing input focus and restores its toolbar opener", async () => {
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    const opener = screen.getByRole("button", { name: "Manage dashboards" })
    opener.focus()
    fireEvent.click(opener)
    expect(
      screen.getByRole("heading", { name: "Manage dashboards" }),
    ).toHaveFocus()
    const input = screen.getByLabelText("Name")
    input.focus()
    fireEvent.change(input, { target: { value: "My new name" } })
    expect(input).toHaveFocus()
    fireEvent.click(
      screen.getByRole("button", { name: "Close dashboard manager" }),
    )
    expect(opener).toHaveFocus()
  })
})

describe("Insights findings wiring", () => {
  const latency: Dashboard = {
    ...first,
    widgets: [{ id: "latency", title: "Request latency", type: "timeseries", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 } }],
  }
  function finding(overrides: Partial<ConstructorParameters<typeof CheckFinding>[0]> = {}) {
    return new CheckFinding({ ruleId: "schema.widget.layout", severity: Severity.WARNING, source: Source.SCHEMA, widgetId: "latency", pointer: "/widgets/0/layout/w", message: "Widget is narrower than its legend.", fix: "Widen it to 6 columns.", ...overrides })
  }
  function report(issues: CheckFinding[]) {
    return new CheckReport({
      issues, total: issues.length,
      errorCount: issues.filter(issue => issue.severity === Severity.ERROR).length,
      warningCount: issues.filter(issue => issue.severity === Severity.WARNING).length,
      infoCount: 0,
    })
  }
  function clientWithLatency() {
    const api = { ...client(), validate: vi.fn().mockResolvedValue(report([finding()])) }
    vi.mocked(api.providers).mockResolvedValue([{ id: "metrics", name: "Metrics", type: "prometheus", capabilities: ["metrics"] }])
    vi.mocked(api.list).mockResolvedValue([latency, second])
    vi.mocked(api.get).mockImplementation(async id => ({ dashboard: id === latency.id ? latency : second, etag: '"v1"' }))
    return api
  }
  async function renderLatency(api: InsightsClient) {
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
  }
  async function openCode() {
    fireEvent.click(screen.getByRole("button", { name: "Code" }))
    return screen.findByRole("region", { name: "Dashboard source editor" })
  }

  it("runs the document validator from the Code panel and Show widget opens that widget", async () => {
    const api = clientWithLatency()
    await renderLatency(api)
    const editor = await openCode()
    fireEvent.click(within(editor).getByRole("button", { name: "Check" }))
    await waitFor(() => expect(api.validate).toHaveBeenCalledWith(expect.objectContaining({ id: latency.id }), expect.any(AbortSignal)))
    const checks = await within(editor).findByRole("region", { name: "Dashboard checks" })
    expect(within(checks).getByText("Widget is narrower than its legend.")).toBeInTheDocument()
    fireEvent.click(within(checks).getByRole("button", { name: "Show widget Request latency" }))
    expect(await screen.findByRole("textbox", { name: "Title" })).toHaveValue("Request latency")
  })

  it("keeps the save error text and lists a rejected save's findings, errors first, beneath it", async () => {
    const api = clientWithLatency()
    vi.mocked(api.save).mockRejectedValue(new InsightsHTTPError("Dashboard rejected by checks", 400, null, report([
      finding({ message: "Only a warning here.", severity: Severity.WARNING, ruleId: "stat.density" }),
      finding({ message: "Layout overlaps another widget.", severity: Severity.ERROR }),
    ])))
    await renderLatency(api)
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: "Renamed dashboard" } })
    fireEvent.click(screen.getByRole("button", { name: "Save dashboard" }))
    expect(await screen.findByText("Dashboard rejected by checks")).toBeInTheDocument()
    const checks = await screen.findByRole("region", { name: "Save checks" })
    const [errorItem, warningItem] = within(checks).getAllByRole("listitem")
    expect(errorItem).toHaveTextContent("Layout overlaps another widget.")
    expect(warningItem).toHaveTextContent("Only a warning here.")
    fireEvent.click(within(errorItem).getByRole("button", { name: "Show widget Request latency" }))
    expect(await screen.findByRole("textbox", { name: "Title" })).toHaveValue("Request latency")
  })

  async function reviewLibrary(api: InsightsClient, incoming: Dashboard) {
    fireEvent.click(screen.getByRole("button", { name: "Manage dashboards" }))
    fireEvent.click(screen.getByRole("combobox", { name: "Library import format" }))
    fireEvent.click(screen.getByRole("option", { name: "JSON" }))
    fireEvent.change(screen.getByLabelText("Library import source"), { target: { value: serializeDashboardLibrary([incoming], "json") } })
    fireEvent.click(screen.getByRole("button", { name: "Review import" }))
    await screen.findByRole("region", { name: "Portable dashboard import" })
    return api
  }

  it("validates each dashboard in a library import from Manage dashboards before it is written", async () => {
    const api = clientWithLatency()
    await renderLatency(api)
    const incoming: Dashboard = { ...first, id: "incoming", title: "Library dashboard to check", widgets: [] }
    await reviewLibrary(api, incoming)
    await waitFor(() => expect(api.validate).toHaveBeenCalledWith(expect.objectContaining({ title: "Library dashboard to check" }), expect.any(AbortSignal)))
    expect(api.save).not.toHaveBeenCalled()
  })

  it("shows the findings of a failed library import save beside its dashboard", async () => {
    const api = clientWithLatency()
    const incoming: Dashboard = { ...first, id: "incoming", title: "Library dashboard that fails", widgets: [] }
    vi.mocked(api.validate).mockResolvedValue(report([]))
    vi.mocked(api.save).mockRejectedValue(new InsightsHTTPError("Dashboard rejected by checks", 400, null, report([
      finding({ widgetId: "", pointer: "", ruleId: "doc.title", message: "Title is reserved by the workspace.", fix: "Rename the dashboard." }),
    ])))
    await renderLatency(api)
    await reviewLibrary(api, incoming)
    await importCopies()
    expect(await screen.findByText(/^0 dashboard decisions? completed\./)).toBeInTheDocument()
    const checks = await screen.findByRole("region", { name: "Save checks for Library dashboard that fails" })
    expect(within(checks).getByText("Title is reserved by the workspace.")).toBeInTheDocument()
    expect(within(checks).getByText("Whole dashboard")).toBeInTheDocument()
  })

  it("validates the dashboards in an imported library before they are written", async () => {
    const api = clientWithLatency()
    await renderLatency(api)
    const incoming: Dashboard = { ...first, id: "incoming", title: "Incoming library dashboard", widgets: [] }
    const text = serializeDashboardLibrary([incoming], "json")
    const editor = await openCode()
    fireEvent.change(within(editor).getByLabelText("Import dashboard document"), { target: { files: [new File([text], "library.json", { type: "application/json" })] } })
    await waitFor(() => expect(api.validate).toHaveBeenCalledWith(expect.objectContaining({ title: "Incoming library dashboard" }), expect.any(AbortSignal)))
  })
})

describe("Insights template picker", () => {
  const template: Dashboard = { ...first, id: "service-overview", title: "Service overview template", widgets: [] }
  function templateClient(): InsightsClient {
    return {
      ...client(),
      providers: vi.fn().mockResolvedValue([{ id: "metrics", name: "Metrics", type: "prometheus", capabilities: ["metrics"] }]),
      validate: vi.fn().mockResolvedValue(new CheckReport({ issues: [], total: 0, errorCount: 0, warningCount: 0, infoCount: 0 })),
      listStarters: vi.fn().mockResolvedValue([{ id: "service-overview", title: "Service overview", description: "Golden signals for one service.", widgetCount: 0, variables: [], providers: [], tiles: [] }]),
      getStarter: vi.fn(async () => parseDashboardBundle(serializeDashboardLibrary([template], "json"), "json")),
    }
  }

  it("offers a template from the empty canvas and loads the picker only when it is opened", async () => {
    const api = templateClient()
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    const opener = await screen.findByRole("button", { name: "Start from a template" })
    expect(api.listStarters).not.toHaveBeenCalled()
    opener.focus()
    fireEvent.click(opener)
    expect(await screen.findByRole("region", { name: "Start from a template" })).toBeInTheDocument()
    expect(await screen.findByRole("button", { name: "Service overview" })).toBeInTheDocument()
    expect(api.listStarters).toHaveBeenCalledTimes(1)
  })

  it("opens the import review with the chosen template's bundle", async () => {
    const api = templateClient()
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(await screen.findByRole("button", { name: "Start from a template" }))
    fireEvent.click(await screen.findByRole("button", { name: "Service overview" }))
    await waitFor(() => expect(api.getStarter).toHaveBeenCalledWith("service-overview"))
    expect(await screen.findByRole("region", { name: "Portable dashboard import" })).toBeInTheDocument()
    expect(await screen.findByText("Service overview template")).toBeInTheDocument()
    expect(api.save).not.toHaveBeenCalled()
  })

  it("restores focus to the opener when the picker closes", async () => {
    render(<InsightsApp client={templateClient()} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    const opener = await screen.findByRole("button", { name: "Start from a template" })
    opener.focus()
    fireEvent.click(opener)
    await screen.findByRole("region", { name: "Start from a template" })
    fireEvent.click(screen.getByRole("button", { name: "Close templates" }))
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it("does not offer templates when the client has no starter methods", async () => {
    render(<InsightsApp client={{ ...templateClient(), listStarters: undefined, getStarter: undefined }} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    expect(screen.queryByRole("button", { name: "Start from a template" })).not.toBeInTheDocument()
  })
})

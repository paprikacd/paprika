import { changeQueryEditor } from "./query-code-editor.test-utils";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import InsightsApp from "./insights-app"
import type { InsightsClient } from "./client"
import type { Dashboard, SavedQuery } from "./schema"
import { readExampleWorkspace, writeExampleWorkspace } from "./example-storage"
import { EXAMPLE_SAVED_QUERIES_KEY } from "./saved-query-storage"
import { serializeDashboardLibrary } from "./workspace-transfer"

vi.mock("./canvas", () => ({
  DashboardCanvas: () => <div data-testid="mock-canvas" />,
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
function viewport(mobile: boolean) {
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: mobile,
    media: "(max-width: 950px)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })
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

  it("preserves an unapplied widget editor draft when returning from Explore through sidebar Dashboards", async () => {
    const api=client();
    vi.mocked(api.providers).mockResolvedValue([{id:"metrics",name:"Metrics",type:"prometheus",capabilities:["metrics"]}]);
    render(<InsightsApp client={api}/>);
    await screen.findByRole("heading",{name:"Dashboard A"});
    fireEvent.click(screen.getByRole("button",{name:"Edit dashboard"}));
    fireEvent.click(screen.getByRole("button",{name:"Add your first widget"}));
    fireEvent.click(screen.getByRole("button",{name:/^Time series/}));
    fireEvent.change(screen.getByLabelText("Title"),{target:{value:"Retained unapplied widget draft"}});
    fireEvent.click(screen.getByRole("button",{name:/^Explore \d+$/}));
    await screen.findByLabelText("Query name");
    fireEvent.click(screen.getByRole("button",{name:/^Dashboards \d+$/}));
    expect(screen.getByLabelText("Title")).toHaveValue("Retained unapplied widget draft");
    expect(screen.getByRole("button",{name:"Apply widget"})).toBeVisible();
  });

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
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Unapplied source widget" } })
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
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }))
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

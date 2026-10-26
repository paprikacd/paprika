import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import InsightsApp from "./insights-app"
import type { InsightsClient } from "./client"
import type { Dashboard, Drilldown } from "./schema"
import type { DrilldownContext } from "./drilldown"
import type { QueryFetcher } from "./query"
import { parseDashboardURL } from "./drilldown"

vi.mock("./canvas", () => ({
  DashboardCanvas: ({ dashboard, fetcher, tooltipFetcher, onDrilldown }: {
    dashboard: Dashboard; fetcher: QueryFetcher; tooltipFetcher: QueryFetcher;
    onDrilldown: (link: Drilldown, context: DrilldownContext) => void;
  }) => <div>
    <output data-testid="view-range">{JSON.stringify(dashboard.customTimeRange)}</output>
    <button onClick={() => onDrilldown(dashboard.widgets[0].drilldowns![0], {
      labels: { service: 'checkout"api' }, value: 42, series: "checkout",
    })}>Follow signal</button>
    <button onClick={() => void fetcher({ providerId: "metrics", kind: "metrics", query: dashboard.widgets[0].query, start: 1, end: 2, step: 1 }, new AbortController().signal)}>Run query</button>
    <button onClick={() => void tooltipFetcher({ providerId: "metrics", kind: "metrics", query: `up{service=${JSON.stringify('checkout"\\{{literal}}')}}`, start: 1, end: 2, step: 1 }, new AbortController().signal)}>Run resolved tooltip query</button>
  </div>,
}))
const range = { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T01:00:00.000Z" }
const source: Dashboard = {
  schemaVersion: 1, id: "source", title: "Source", timeRange: "1h", refreshInterval: 0,
  customTimeRange: range,
  widgets: [{ id: "signal", title: "Signal", type: "stat", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 0, w: 4, h: 2 },
    drilldowns: [{ id: "details", title: "Details", dashboardId: "target", bindings: [{ variable: "service", source: "label", value: "service" }] }],
  }],
}
const target: Dashboard = { ...source, id: "target", title: "Target", customTimeRange: undefined,
  variables: [{ name: "service", label: "Service", defaultValue: "default" }],
  widgets: [{ ...source.widgets[0], drilldowns: undefined, query: "up{service={{service}}}" }],
}
function client(): InsightsClient {
  const documents = [source, target]
  return {
    list: vi.fn().mockResolvedValue(documents), providers: vi.fn().mockResolvedValue([{ id: "metrics", name: "Metrics", type: "prometheus", capabilities: ["metrics"] }]),
    get: vi.fn(async id => ({ dashboard: documents.find(item => item.id === id)!, etag: '"v1"' })),
    save: vi.fn().mockResolvedValue('"v2"'), remove: vi.fn(),
    query: vi.fn().mockResolvedValue({ series: [] }), metadata: vi.fn().mockResolvedValue({ values: [] }),
    listSavedQueries: vi.fn().mockResolvedValue([]), getSavedQuery: vi.fn(), saveSavedQuery: vi.fn(), removeSavedQuery: vi.fn(),
    providerConfigs: vi.fn().mockResolvedValue([]), saveProvider: vi.fn(), removeProvider: vi.fn(), testProvider: vi.fn(),
  }
}
beforeEach(() => {
  window.history.replaceState(null, "", "/dashboard/insights/")
  vi.stubGlobal("confirm", vi.fn().mockReturnValue(true))
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe("dashboard navigation", () => {
  it("sends resolved tooltip literals through the shared scheduler without interpreting them again", async () => {
    const api = client()
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Source" })
    fireEvent.click(screen.getByText("Run resolved tooltip query"))
    await waitFor(() => expect(api.query).toHaveBeenCalledWith(expect.objectContaining({
      query: `up{service=${JSON.stringify('checkout"\\{{literal}}')}}`,
    }), expect.any(AbortSignal)))
  })
  it("carries signal context and fixed time, safely interpolates queries, and preserves the saved target", async () => {
    const api = client()
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Source" })
    fireEvent.click(screen.getByText("Follow signal"))
    await screen.findByRole("heading", { name: "Target" })
    expect(parseDashboardURL(location.search)).toEqual({ dashboardId: "target", variables: { service: 'checkout"api' }, customTimeRange: range })
    expect(screen.getByTestId("view-range")).toHaveTextContent(JSON.stringify(range))
    expect(screen.getByText("All changes saved")).toBeInTheDocument()
    fireEvent.click(screen.getByText("Run query"))
    await waitFor(() => expect(api.query).toHaveBeenCalledWith(expect.objectContaining({ query: 'up{service="checkout\\"api"}' }), expect.any(AbortSignal)))
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: "Target saved" } })
    fireEvent.click(screen.getByRole("button", { name: "Save dashboard" }))
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ customTimeRange: undefined, variables: target.variables }), '"v1"'))
  })

  it("restores a shared destination URL and handles browser back without losing context", async () => {
    window.history.replaceState(null, "", "/dashboard/insights/?dashboard=target&vars=%7B%22service%22%3A%22worker%22%7D")
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Target" })
    expect(screen.getByDisplayValue("worker")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Source" }))
    await screen.findByRole("heading", { name: "Source" })
    await act(async () => {
      window.history.replaceState(null, "", "/dashboard/insights/?dashboard=target&vars=%7B%22service%22%3A%22worker%22%7D")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await screen.findByRole("heading", { name: "Target" })
    expect(screen.getByDisplayValue("worker")).toBeInTheDocument()
  })

  it("keeps the current document and URL when a dirty drilldown is cancelled", async () => {
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Source" })
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: "Draft source" } })
    fireEvent.click(screen.getByText("Follow signal"))
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Discard unsaved changes?")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.getByLabelText("Dashboard title")).toHaveValue("Draft source")
    expect(parseDashboardURL(location.search)?.dashboardId).toBe("source")
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it("reports missing destinations without breaking the library or starting a request", async () => {
    const api = client()
    vi.mocked(api.list).mockResolvedValue([source])
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Source" })
    fireEvent.click(screen.getByText("Follow signal"))
    expect(screen.getByRole("alert")).toHaveTextContent("drilldown’s dashboard is unavailable")
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(parseDashboardURL(location.search)?.dashboardId).toBe("source")
  })

  it("remaps library links to imported identities and retains successful targets during a partial retry", async () => {
    const api = client()
    vi.mocked(api.providers).mockResolvedValue([
      { id: "metrics", name: "Metrics", type: "prometheus", capabilities: ["metrics"] },
      { id: "corrected", name: "Corrected provider", type: "prometheus", capabilities: ["metrics"] },
    ])
    const imports: Dashboard[] = []
    let failSource = true
    vi.mocked(api.save).mockImplementation(async document => {
      if (document.title === "Source" && failSource) { failSource = false; throw new Error("Transient write failure") }
      imports.push(document)
      return '"imported"'
    })
    vi.mocked(api.get).mockImplementation(async id => {
      const document = [source, target, ...imports].find(item => item.id === id)
      if (!document) throw new Error("Not found")
      return { dashboard: document, etag: '"v1"' }
    })
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Source" })
    fireEvent.click(screen.getByRole("button", { name: "Manage dashboards" }))
    fireEvent.click(screen.getByRole("combobox", { name: "Library import format" }))
    fireEvent.click(screen.getByRole("option", { name: "JSON" }))
    const importedSource: Dashboard = { ...source, widgets: [{ ...source.widgets[0], options: {
      tooltipView: { type: "stat", source: { type: "query", providerId: "metrics", query: "up" } },
    } }] }
    fireEvent.change(screen.getByLabelText("Library import source"), { target: { value: JSON.stringify({ kind: "PaprikaDashboardLibrary", schemaVersion: 1, dashboards: [target, importedSource] }) } })
    fireEvent.click(screen.getByText("Review import"))
    await waitFor(() => expect(screen.getByRole("button", { name: "Import 2 as new" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "Import 2 as new" }))
    await screen.findByText(/^1 dashboard decisions? completed\./)
    fireEvent.click(screen.getByRole("combobox", { name: "Connect metrics" }))
    fireEvent.click(screen.getByRole("option", { name: "Corrected provider" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Import 1 as new" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "Import 1 as new" }))
    await waitFor(() => expect(imports).toHaveLength(2))
    expect(imports[0].id).not.toBe("target")
    expect(imports[1].widgets[0].drilldowns![0].dashboardId).toBe(imports[0].id)
    expect(imports[1].widgets[0].providerId).toBe("corrected")
    expect(imports[1].widgets[0].options?.tooltipView?.source).toMatchObject({ providerId: "corrected" })
    expect(vi.mocked(api.save).mock.calls[1][0].id).toBe(imports[1].id)
  })

  it("preserves edits made while a destination request is in flight", async () => {
    const api = client()
    let finish!: (value: { dashboard: Dashboard; etag: string }) => void
    vi.mocked(api.get).mockImplementation(id => id === "source"
      ? Promise.resolve({ dashboard: source, etag: '"v1"' })
      : new Promise(resolve => { finish = resolve }))
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Source" })
    fireEvent.click(screen.getByText("Follow signal"))
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: "New draft during load" } })
    await act(async () => finish({ dashboard: target, etag: '"v1"' }))
    expect(screen.getByLabelText("Dashboard title")).toHaveValue("New draft during load")
    expect(screen.getByRole("alert")).toHaveTextContent("changed while the destination was loading")
    expect(parseDashboardURL(location.search)?.dashboardId).toBe("source")
  })

  it("resolves bindings and defaults against the freshly loaded destination", async () => {
    const api = client()
    vi.mocked(api.get).mockImplementation(async id => ({ dashboard: id === "source" ? source : {
      ...target, variables: [...target.variables!, { name: "environment", defaultValue: "production" }],
    }, etag: '"fresh"' }))
    render(<InsightsApp client={api} />)
    await screen.findByRole("heading", { name: "Source" })
    fireEvent.click(screen.getByText("Follow signal"))
    await screen.findByRole("heading", { name: "Target" })
    expect(parseDashboardURL(location.search)?.variables).toEqual({ service: 'checkout"api', environment: "production" })
  })

  it("prunes view overrides when undo removes their declarations", async () => {
    render(<InsightsApp client={client()} />)
    await screen.findByRole("heading", { name: "Source" })
    fireEvent.click(screen.getByRole("button", { name: "Manage dashboards" }))
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply variables" }))
    fireEvent.change(screen.getByLabelText("variable_1"), { target: { value: "active value" } })
    fireEvent.click(screen.getByRole("button", { name: "Apply values" }))
    expect(parseDashboardURL(location.search)?.variables).toEqual({ variable_1: "active value" })
    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    await waitFor(() => expect(parseDashboardURL(location.search)?.variables).toBeUndefined())
    expect(screen.queryByRole("form", { name: "Dashboard variables" })).not.toBeInTheDocument()
  })
})

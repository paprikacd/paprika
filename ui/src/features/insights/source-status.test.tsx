import { createElement } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import InsightsApp from "./insights-app"
import { createInsightsClient, InsightsHTTPError, type InsightsClient } from "./client"
import type { Dashboard, Provider } from "./schema"

// Real canvas and tiles, unlike insights-app.test.tsx: these assertions read
// what a viewer actually sees while the shared source list is busy.
const shared = "observe-" + "a".repeat(64)
const sharedProvider: Provider = { id: shared, name: "Shared metrics", type: "prometheus", capabilities: ["metrics"], source: "observability", providerRef: "prod/prom", transport: "mcp" } as Provider
const dashboard: Dashboard = {
  schemaVersion: 1, id: "a", title: "Dashboard A", timeRange: "1h", refreshInterval: 0,
  widgets: [
    { id: "inline", title: "Inline latency", type: "timeseries", providerId: shared, query: "up", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 } },
    { id: "saved", title: "Saved latency", type: "timeseries", providerId: shared, query: "up", unit: "", queryRef: { id: "requests" }, layout: { x: 6, y: 0, w: 6, h: 4 } },
  ],
}
const busy = () => new InsightsHTTPError("too many active observability requests; retry shortly", 429, "1")

function api(providers: InsightsClient["providers"]): InsightsClient {
  return {
    providers: vi.fn(providers),
    list: vi.fn().mockResolvedValue([dashboard]),
    get: vi.fn().mockResolvedValue({ dashboard, etag: '"v1"' }),
    save: vi.fn(), remove: vi.fn(),
    query: vi.fn().mockResolvedValue({ series: [] }),
    listSavedQueries: vi.fn().mockResolvedValue([{ schemaVersion: 1, id: "requests", name: "Requests", providerId: shared, kind: "metrics", query: "up", etag: '"q1"' }]),
    getSavedQuery: vi.fn(), saveSavedQuery: vi.fn(), removeSavedQuery: vi.fn(),
    providerConfigs: vi.fn().mockResolvedValue([]), saveProvider: vi.fn(), removeProvider: vi.fn(),
    testProvider: vi.fn(), metadata: vi.fn().mockResolvedValue({ values: [] }),
  }
}
function bodyText() {
  return document.body.textContent ?? ""
}
function queriedShared(client: InsightsClient) {
  return vi.mocked(client.query).mock.calls.some(([request]) => request?.providerId === shared)
}
function expectNoMissingSourceCopy() {
  expect(bodyText()).not.toContain("is not configured")
  expect(bodyText()).not.toContain("Choose a connected source")
}

beforeEach(() => {
  window.history.replaceState(null, "", "/dashboard/insights/")
  // Every tile is on screen, so tiles engage and query as they would for a viewer.
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) { this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
    unobserve() {}
    disconnect() {}
  })
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("tiles and banner while shared sources are busy", () => {
  it("shows waiting tiles, never a missing source, while the first load is pending", async () => {
    const api = api_(() => new Promise<Provider[]>(() => undefined))
    render(createElement(InsightsApp, { client: api }))
    await screen.findByRole("heading", { name: "Dashboard A" })
    expect((await screen.findAllByText("Waiting for data sources…")).length).toBeGreaterThanOrEqual(1)
    expectNoMissingSourceCopy()
    expect(api.query).not.toHaveBeenCalled()
    expect(screen.queryByText("Data sources are busy.")).not.toBeInTheDocument()
  })

  it("queries waiting tiles once the list arrives", async () => {
    let finish: (providers: Provider[]) => void = () => undefined
    const api = api_(() => new Promise<Provider[]>(resolve => { finish = resolve }))
    render(createElement(InsightsApp, { client: api }))
    await screen.findAllByText("Waiting for data sources…")
    await act(async () => finish([sharedProvider]))
    await waitFor(() => expect(queriedShared(api)).toBe(true))
    expect(screen.queryByText("Waiting for data sources…")).not.toBeInTheDocument()
    expectNoMissingSourceCopy()
  })

  it("a busy spell is one banner with a manual retry and no automatic loop", async () => {
    const api = api_(vi.fn().mockRejectedValueOnce(busy()).mockResolvedValue([sharedProvider]))
    render(createElement(InsightsApp, { client: api }))
    await screen.findByRole("heading", { name: "Dashboard A" })
    expect(await screen.findByText("Data sources are busy.")).toBeInTheDocument()
    expect(screen.getByText("Data sources are busy.").closest("[role=status]")).not.toBeNull()
    expect(screen.getAllByText("Data sources are unavailable. Retry data sources to load this tile.").length).toBeGreaterThanOrEqual(1)
    expectNoMissingSourceCopy()
    expect(api.providers).toHaveBeenCalledTimes(1)
    await new Promise(resolve => setTimeout(resolve, 1300))
    expect(api.providers).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "Retry data sources" }))
    await waitFor(() => expect(screen.queryByText("Data sources are busy.")).not.toBeInTheDocument())
    await waitFor(() => expect(queriedShared(api)).toBe(true))
    expect(api.providers).toHaveBeenCalledTimes(2)
  })

  it("a permanent 502 is a banner that keeps the workspace and shows the server's safe message", async () => {
    const api = api_(() => Promise.reject(new InsightsHTTPError("observability gateway is unavailable", 502, null)))
    render(createElement(InsightsApp, { client: api }))
    await screen.findByRole("heading", { name: "Dashboard A" })
    expect(await screen.findByText("Data sources did not load: observability gateway is unavailable")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "A clearer view of your stack." })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Retry data sources" })).toBeInTheDocument()
    expectNoMissingSourceCopy()
  })

  it("counts one background load per busy spell through the client's bounded replay", async () => {
    let providerFetches = 0
    let spellBusy = true
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = String(input)
      const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } })
      if (path.endsWith("/providers")) {
        providerFetches++
        return spellBusy
          ? json({ error: "too many active observability requests; retry shortly" }, 429, { "Retry-After": "0" })
          : json({ providers: [] })
      }
      if (path.endsWith("/dashboards/a")) return json({ ...dashboard, widgets: [] }, 200, { ETag: '"v1"' })
      if (path.endsWith("/dashboards")) return json({ dashboards: [{ ...dashboard, widgets: [] }] })
      if (path.includes("/saved-queries")) return json({ queries: [] })
      return json({})
    }))
    render(createElement(InsightsApp, { client: createInsightsClient() }))
    await screen.findByRole("heading", { name: "Dashboard A" })
    expect(await screen.findByText("Data sources are busy.", undefined, { timeout: 5000 })).toBeInTheDocument()
    // One load is one attempt plus the client's three Retry-After replays.
    expect(providerFetches).toBe(4)
    spellBusy = false
    fireEvent.click(screen.getByRole("button", { name: "Retry data sources" }))
    await waitFor(() => expect(screen.queryByText("Data sources are busy.")).not.toBeInTheDocument(), { timeout: 5000 })
    expect(providerFetches).toBe(5)
  })
})

describe("setup landing", () => {
  it("keeps the landing for a 403 and makes Retry connection the primary action", async () => {
    const api = api_(() => Promise.reject(new InsightsHTTPError("Your account does not have access to Insights.", 403, null)))
    render(createElement(InsightsApp, { client: api }))
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Your account does not have access to Insights.")
    expect(screen.getByRole("button", { name: "Retry connection" })).toHaveAttribute("data-variant", "primary")
    expect(screen.getByRole("button", { name: /Explore the example/ })).toHaveAttribute("data-variant", "secondary")
    expect(screen.queryByRole("heading", { name: "Dashboard A" })).not.toBeInTheDocument()
  })

  it("keeps the landing when the dashboard list fails", async () => {
    const client = api_(() => Promise.resolve([]))
    vi.mocked(client.list).mockRejectedValue(new InsightsHTTPError("dashboard storage operation failed", 500, null))
    render(createElement(InsightsApp, { client }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Dashboard storage operation failed")
    expect(screen.getByRole("button", { name: "Retry connection" })).toHaveAttribute("data-variant", "primary")
  })
})

// Builds a mock client whose providers call is the given behaviour.
function api_(providers: InsightsClient["providers"] | ReturnType<typeof vi.fn>): InsightsClient & { providers: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> } {
  return api(providers as InsightsClient["providers"]) as InsightsClient & { providers: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> }
}

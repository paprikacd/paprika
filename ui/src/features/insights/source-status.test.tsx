import { createElement } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import InsightsApp from "./insights-app"
import { createInsightsClient, InsightsHTTPError, type InsightsClient, type ProviderCatalog } from "./client"
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
    { id: "localtile", title: "Local requests", type: "timeseries", providerId: "local", query: "up", unit: "", layout: { x: 0, y: 4, w: 6, h: 4 } },
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
    signIn: vi.fn(),
  }
}
function bodyText() {
  return document.body.textContent ?? ""
}
// A mock whose listing is the full ProviderCatalog, so the shared status can be exercised.
function catalogApi(catalog: { providers: Provider[]; sharedCatalog?: { status: "busy" | "forbidden" | "unavailable"; code: number; message: string } }) {
  const client = api(() => Promise.resolve(catalog.providers))
  return Object.assign(client, { providerCatalog: vi.fn().mockResolvedValue(catalog) })
}
function queriedWith(client: InsightsClient, providerId: string) {
  return vi.mocked(client.query).mock.calls.some(([request]) => request?.providerId === providerId)
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
    await act(async () => finish([sharedProvider, { id: "local", name: "Local metrics", type: "prometheus", capabilities: ["metrics"] } as Provider]))
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

describe("a shared catalog failure keeps local sources working", () => {
  const localProvider: Provider = { id: "local", name: "Local metrics", type: "prometheus", capabilities: ["metrics"] } as Provider
  const busyCatalog = { providers: [localProvider], sharedCatalog: { status: "busy" as const, code: 429, message: "too many active observability requests; retry shortly" } }

  it("local tiles query at once while the banner covers the shared tiles", async () => {
    const client = catalogApi(busyCatalog)
    render(createElement(InsightsApp, { client }))
    await screen.findByText("Data sources are busy.")
    await waitFor(() => expect(queriedWith(client, "local")).toBe(true))
    const local = document.querySelector<HTMLElement>('[data-widget-id="localtile"]')!
    expect(local.querySelector('[data-widget-state="waiting-for-sources"], [data-widget-state="source-unavailable"]')).toBeNull()
    expect(queriedShared(client)).toBe(false)
    expect(document.querySelector('[data-widget-id="inline"] [data-widget-state="source-unavailable"]')).not.toBeNull()
    expect(client.providers).not.toHaveBeenCalled()
  })

  it("a forbidden shared catalog is an access banner, not a whole-workspace failure", async () => {
    const client = catalogApi({ providers: [localProvider], sharedCatalog: { status: "forbidden", code: 403, message: "shared observability provider access denied" } })
    render(createElement(InsightsApp, { client }))
    expect(await screen.findByText("Your account cannot load data sources. Check its Observability permissions.")).toBeInTheDocument()
    await waitFor(() => expect(queriedWith(client, "local")).toBe(true))
    expect(screen.getByRole("heading", { name: "Dashboard A" })).toBeInTheDocument()
  })
})

describe("live region, focus, and waiting markup", () => {
  it("keeps focus on the banner's live region when a retry starts", async () => {
    let calls = 0
    const client = api(() => { calls++; return calls === 1 ? Promise.reject(busy()) : new Promise<Provider[]>(() => undefined) })
    render(createElement(InsightsApp, { client }))
    const retry = await screen.findByRole("button", { name: "Retry data sources" })
    const region = document.querySelector<HTMLElement>('[role="status"][tabindex="-1"]')!
    expect(region).toContainElement(retry)
    fireEvent.click(retry)
    expect(document.activeElement).toBe(region)
    expect(region.isConnected).toBe(true)
  })

  it("has one persistent live region for the banner and none inside any tile", async () => {
    const client = api(() => new Promise<Provider[]>(() => undefined))
    render(createElement(InsightsApp, { client }))
    await screen.findAllByText("Waiting for data sources…")
    expect(document.querySelectorAll('[role="status"][tabindex="-1"]')).toHaveLength(1)
    // Waiting and unavailable tiles carry data state and busy markers, never a status of their own.
    // The only status a source-state tile may contain is its existing loading status.
    const inState = [...document.querySelectorAll('[data-widget-state="waiting-for-sources"] [role="status"], [data-widget-state="source-unavailable"] [role="status"]')]
    expect(inState.every(node => node.getAttribute("aria-label") === "Loading widget")).toBe(true)
  })

  it("marks a waiting tile busy and an unavailable tile final, with neither an alert nor a status", async () => {
    const pending = api(() => new Promise<Provider[]>(() => undefined))
    const view = render(createElement(InsightsApp, { client: pending }))
    await screen.findAllByText("Waiting for data sources…")
    const waiting = document.querySelector<HTMLElement>('[data-widget-id="inline"]')!
    expect(waiting.querySelector('[data-widget-state="waiting-for-sources"][aria-busy="true"]')).not.toBeNull()
    expect(waiting.querySelector('[role="alert"], [role="status"]')).toBeNull()
    view.unmount()
    render(createElement(InsightsApp, { client: api(() => Promise.reject(busy())) }))
    await screen.findByText("Data sources are busy.")
    const unavailable = document.querySelector<HTMLElement>('[data-widget-id="inline"]')!
    expect(unavailable.querySelector('[data-widget-state="source-unavailable"]')).not.toBeNull()
    expect(unavailable.querySelector('[aria-busy="true"]')).toBeNull()
  })

  it("copy names the action that exists: sign-in tiles say sign in, not retry", async () => {
    const client = api(() => Promise.reject(new InsightsHTTPError("Sign in to access your dashboards.", 401, null)))
    render(createElement(InsightsApp, { client }))
    await screen.findByText("Your session has expired. Sign in again to load data sources.")
    expect(screen.getAllByText("Sign in again to load this tile.").length).toBeGreaterThan(0)
    expect(screen.queryByText("Data sources are unavailable. Retry data sources to load this tile.")).not.toBeInTheDocument()
  })
})

describe("session expiry and access after render", () => {
  it("a 401 keeps the workspace and an unsaved draft mounted and offers sign-in", async () => {
    let reject: (error: unknown) => void = () => undefined
    const api = api_(() => new Promise<Provider[]>((_, no) => { reject = no }))
    render(createElement(InsightsApp, { client: api }))
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: "Unsaved title" } })
    await act(async () => reject(new InsightsHTTPError("Sign in to access your dashboards.", 401, null)))
    expect(await screen.findByText("Your session has expired. Sign in again to load data sources.")).toBeInTheDocument()
    expect(screen.getByText("Your session has expired. Sign in again to load data sources.").closest("[role=status]")).not.toBeNull()
    expect(screen.queryByRole("heading", { name: "A clearer view of your stack." })).not.toBeInTheDocument()
    expect(screen.getByLabelText("Dashboard title")).toHaveValue("Unsaved title")
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }))
    expect(api.signIn).toHaveBeenCalledOnce()
    expect(screen.getByLabelText("Dashboard title")).toHaveValue("Unsaved title")
  })

  it("a 401 without a host sign-in offers a retry instead", async () => {
    const api = api_(() => Promise.reject(new InsightsHTTPError("Sign in to access your dashboards.", 401, null)))
    delete api.signIn
    render(createElement(InsightsApp, { client: api }))
    expect(await screen.findByText("Your session has expired. Sign in again to load data sources.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Sign in again" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Retry data sources" }))
    expect(api.providers).toHaveBeenCalledTimes(2)
  })

  it("a 403 after render is an access banner that keeps the workspace", async () => {
    const api = api_(() => Promise.reject(new InsightsHTTPError("Your account does not have access to Insights.", 403, null)))
    render(createElement(InsightsApp, { client: api }))
    await screen.findByRole("heading", { name: "Dashboard A" })
    expect(await screen.findByText("Your account cannot load data sources. Check its Observability permissions.")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Sign in again" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Retry data sources" })).toBeInTheDocument()
  })

  it("keeps the setup landing for a failed boot with Retry connection as the primary action", async () => {
    const client = api_(() => Promise.resolve([]))
    vi.mocked(client.list).mockRejectedValue(new InsightsHTTPError("dashboard storage operation failed", 500, null))
    render(createElement(InsightsApp, { client }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Dashboard storage operation failed")
    expect(screen.getByRole("button", { name: "Retry connection" })).toHaveAttribute("data-variant", "primary")
    expect(screen.getByRole("button", { name: /Explore the example/ })).toHaveAttribute("data-variant", "secondary")
  })
})

// Builds a mock client whose providers call is the given behaviour.
function api_(providers: InsightsClient["providers"] | ReturnType<typeof vi.fn>): InsightsClient & { providers: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> } {
  return api(providers as InsightsClient["providers"]) as InsightsClient & { providers: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> }
}

// A listing sequence on the mock client: each providerCatalog call takes the next answer.
function catalogClient(answers: Array<() => Promise<ProviderCatalog>>) {
  let call = 0
  const client = api(() => Promise.reject(new Error("unused")))
  return Object.assign(client, { providerCatalog: vi.fn(() => answers[Math.min(call++, answers.length - 1)]()) })
}
const localProvider = { id: "local", name: "Local metrics", type: "prometheus", capabilities: ["metrics"] } as Provider
const readyCatalog = (): Promise<ProviderCatalog> => Promise.resolve({ providers: [localProvider, sharedProvider] })
const busyCatalog = (retryAfter = 1): Promise<ProviderCatalog> => Promise.resolve({
  providers: [localProvider],
  sharedCatalog: { status: "busy", code: 429, message: "too many active observability requests; retry shortly", retryAfter },
})

describe("a shared catalog that is busy after the workspace renders", () => {
  it("a refresh that is still busy keeps the banner and the shared tiles waiting, never 'not configured'", async () => {
    let answerRefresh: (catalog: ProviderCatalog) => void = () => undefined
    const client = Object.assign(catalogClient([readyCatalog, () => new Promise<ProviderCatalog>(resolve => { answerRefresh = resolve })]), {
      observeConnection: vi.fn().mockResolvedValue({ configured: true, connected: true, providerCount: 1, tools: [], transport: "mcp" }),
    })
    render(createElement(InsightsApp, { client }))
    await screen.findByRole("heading", { name: "Dashboard A" })
    await waitFor(() => expect(queriedShared(client)).toBe(true))
    fireEvent.click(screen.getAllByRole("button", { name: /Data sources/ })[0])
    fireEvent.click(await screen.findByRole("button", { name: "Refresh connection and providers" }))
    // While the refresh is in flight, the shared tiles are busy, not stale-and-clean.
    await waitFor(() => expect(document.querySelector('[data-widget-id="inline"] [aria-busy="true"]')).not.toBeNull())
    await act(async () => answerRefresh(await busyCatalog(1)))
    expect(await screen.findByText("Data sources are busy.")).toBeInTheDocument()
    expectNoMissingSourceCopy()
    // The tile keeps the result it already had, without an alert, under the banner.
    expect(document.querySelector('[data-widget-id="inline"] [role="alert"]')).toBeNull()
  })

  it("a busy listing is replayed by the client and recovers without a click, with its tiles busy meanwhile", async () => {
    const listingAnswers = [
      { providers: [localProvider], sharedCatalog: { status: "busy", code: 429, message: "busy", retryAfter: 1 } },
      { providers: [localProvider, sharedProvider] },
    ]
    let listings = 0
    const queriedProviders: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://console.test")
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
      if (url.pathname === "/api/insights/dashboards") return json({ dashboards: [dashboard] })
      if (url.pathname === "/api/insights/dashboards/a") return new Response(JSON.stringify(dashboard), { status: 200, headers: { "Content-Type": "application/json", ETag: '"v1"' } })
      if (url.pathname === "/api/insights/saved-queries") return json({ queries: [] })
      if (url.pathname === "/api/insights/providers") return json(listingAnswers[Math.min(listings++, listingAnswers.length - 1)])
      if (url.pathname === "/api/insights/query") queriedProviders.push(JSON.parse(String(init?.body)).providerId)
      return json({ series: [] })
    }))
    render(createElement(InsightsApp, { client: createInsightsClient("/api/insights", () => "tok") }))
    expect((await screen.findAllByText("Waiting for data sources…")).length).toBeGreaterThan(0)
    expect(document.querySelector('[data-widget-id="inline"] [aria-busy="true"]')).not.toBeNull()
    await waitFor(() => expect(queriedProviders).toContain(shared), { timeout: 4000 })
    expect(screen.queryByText("Data sources are busy.")).not.toBeInTheDocument()
    expect(listings).toBe(2)
  })

  it("a busy spell that outlasts the client's replays shows the banner with a manual retry", async () => {
    const client = catalogClient([() => busyCatalog(1)])
    render(createElement(InsightsApp, { client }))
    expect(await screen.findByText("Data sources are busy.", undefined, { timeout: 6000 })).toBeInTheDocument()
    expect(client.providerCatalog).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Retry data sources" })).toBeInTheDocument()
  }, 10000)

  it("after a successful retry, focus moves to the named Data sources control", async () => {
    const client = catalogClient([() => busyCatalog(1), readyCatalog])
    render(createElement(InsightsApp, { client }))
    fireEvent.click(await screen.findByRole("button", { name: "Retry data sources" }, { timeout: 6000 }))
    await waitFor(() => expect(screen.queryByText("Data sources are busy.")).not.toBeInTheDocument())
    expect(document.activeElement?.tagName).toBe("BUTTON")
    expect(document.activeElement).toHaveTextContent("Data sources")
  }, 10000)

  it("a renewed session reloads a sign-in banner's sources, which clears the banner and its tile copy", async () => {
    const client = catalogClient([
      () => Promise.reject(new InsightsHTTPError("Sign in to access your dashboards.", 401, null)),
      readyCatalog,
    ])
    const view = render(createElement(InsightsApp, { client, sessionRevision: 1 }))
    await screen.findByText("Your session has expired. Sign in again to load data sources.")
    expect(screen.getAllByText("Sign in again to load this tile.").length).toBeGreaterThan(0)
    view.rerender(createElement(InsightsApp, { client, sessionRevision: 2 }))
    await waitFor(() => expect(screen.queryByText("Your session has expired. Sign in again to load data sources.")).not.toBeInTheDocument())
    expect(screen.queryByText("Sign in again to load this tile.")).not.toBeInTheDocument()
    await waitFor(() => expect(queriedShared(client)).toBe(true))
    expect(client.providerCatalog).toHaveBeenCalledTimes(2)
  })
})

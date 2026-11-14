import { createElement } from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readAuthReturnTo } from "@/lib/auth-return-to"
import { getSessionSnapshot } from "@/lib/browser-session"

// The real console host: page.tsx, the real browser-session module and the real
// client. Only fetch, Next's routing and Next's dynamic import are replaced.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock("next/dynamic", async () => {
  const mod = await import("@/features/insights/insights-app")
  return { default: () => mod.default }
})

const dashboard = {
  schemaVersion: 1, id: "a", title: "Dashboard A", timeRange: "1h", refreshInterval: 0,
  widgets: [{ id: "inline", title: "Inline latency", type: "timeseries", providerId: "observe-" + "a".repeat(64), query: "up", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 } }],
}

function b64url(value: unknown) {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
const now = Math.floor(Date.now() / 1000)
const token = `${b64url({ alg: "none" })}.${b64url({ sub: "alice", email: "alice@example.test", iat: now, exp: now + 3600 })}.sig`

let href = ""
let releaseProviders: () => void = () => undefined
let requests: string[] = []

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem("paprika_id_token", token)
  localStorage.setItem("paprika_auth_user", JSON.stringify({ sub: "alice", email: "alice@example.test", name: "" }))
  localStorage.setItem("paprika_session_state", JSON.stringify({ loggedOut: false, refreshAvailable: true, revision: "r1" }))
  href = ""
  requests = []
  const real = window.location
  Object.defineProperty(window, "location", {
    configurable: true, writable: true,
    value: {
      get pathname() { return real.pathname }, get search() { return real.search }, get hash() { return real.hash },
      get origin() { return real.origin }, get host() { return real.host }, get protocol() { return real.protocol },
      get href() { return href || real.href }, set href(value: string) { href = value },
      assign(value: string) { href = value }, replace(value: string) { href = value }, reload() {},
      toString() { return real.href },
    },
  })
  window.history.replaceState(null, "", "/dashboard/insights/?dashboard=a")
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) { this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
    unobserve() {}
    disconnect() {}
  })
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })))
  const gate = new Promise<void>(resolve => { releaseProviders = resolve })
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://console.test")
    const auth = new Headers(init?.headers).get("Authorization")
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`)
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } })
    if (url.pathname === "/auth/config") return json({ oidc: { enabled: true, provider: "oidc", label: "SSO" }, basic: { enabled: false }, session: { refreshEnabled: true } })
    // A refresh that fails would clear the session and remount the workspace.
    if (url.pathname === "/auth/refresh") return json({ error: "revoked" }, 401)
    if (url.pathname.startsWith("/api/insights/") && auth !== `Bearer ${token}`) return json({ error: "authentication required" }, 401)
    if (url.pathname === "/api/insights/dashboards") return json({ dashboards: [dashboard] })
    if (url.pathname === "/api/insights/dashboards/a") return json(dashboard, 200, { ETag: '"v1"' })
    if (url.pathname === "/api/insights/saved-queries") return json({ queries: [] })
    if (url.pathname === "/api/insights/providers") { await gate; return json({ error: "authentication required" }, 401) }
    return json({})
  }))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("a catalog 401 in the real console host", () => {
  it("keeps the workspace and its unsaved draft mounted, with no navigation, and signs in only on request", async () => {
    const { default: InsightsPage } = await import("@/app/dashboard/insights/page")
    const addListener = vi.spyOn(window, "addEventListener")
    render(createElement(InsightsPage))
    await screen.findByRole("heading", { name: "Dashboard A" }, { timeout: 10000 })
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    const titleInput = screen.getByLabelText("Dashboard title")
    fireEvent.change(titleInput, { target: { value: "Unsaved title" } })
    expect(addListener.mock.calls.some(([type]) => type === "beforeunload")).toBe(true)
    const epoch = getSessionSnapshot().identityEpoch
    const before = requests.length

    await act(async () => releaseProviders())

    expect(await screen.findByText("Your session has expired. Sign in again to load data sources.", undefined, { timeout: 10000 })).toBeInTheDocument()
    // The catalog 401 neither renews nor clears the session, so nothing remounts.
    expect(requests.slice(before).some(request => request.includes("/auth/refresh"))).toBe(false)
    expect(getSessionSnapshot().identityEpoch).toBe(epoch)
    expect(href).toBe("")
    // The very input that holds the draft is still mounted: no remount happened.
    expect(titleInput.isConnected).toBe(true)
    expect(titleInput).toHaveValue("Unsaved title")

    // Only the explicit action leaves the page, through the console's return-to flow.
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }))
    await waitFor(() => expect(href).toBe("/login/"))
    expect(readAuthReturnTo()).toContain("/dashboard/insights/")
  })
})

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AUTH_TOKEN_KEY, AUTH_USER_KEY, AuthProvider, consumeReturnTo, persistAuth, useAuth } from "./auth-context"
import { resetBrowserSessionForTests } from "./browser-session"

function token(exp = Math.floor(Date.now() / 1000) + 3600) {
  return `e30.${btoa(JSON.stringify({ sub: "u1", email: "ada@example.test", name: "Ada", exp }))}.sig`
}
const originalLocation = window.location
const config = { oidc: { enabled: true, provider: "google", label: "Google" }, basic: { enabled: true }, session: { refreshEnabled: false } }
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  resetBrowserSessionForTests(); localStorage.clear(); sessionStorage.clear()
  Object.defineProperty(window, "location", { value: { origin: "https://console.example", href: "", pathname: "/login/", search: "", hash: "" }, configurable: true, writable: true })
  fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => url === "/auth/config" ? config : { url: "https://accounts.example/authorize", codeVerifier: "verifier", state: "state123" } }))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  // Remove focus/reconnect handlers before restoring the real browser globals.
  cleanup()
  resetBrowserSessionForTests(); localStorage.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  Object.defineProperty(window, "location", { value: originalLocation, configurable: true, writable: true })
})
function Probe() {
  const { user, idToken, isLoading, login, logout } = useAuth()
  return <div><span data-testid="loading">{String(isLoading)}</span><span data-testid="user">{user?.email ?? "none"}</span><span data-testid="token">{idToken ?? "none"}</span><button onClick={() => void login()}>login</button><button onClick={() => void login({ switchAccount: true })}>switch</button><button onClick={() => void logout()}>logout</button></div>
}
describe("authentication context", () => {
  it("persists credentials and derives the display profile from the token", () => {
    const value = token(); expect(persistAuth(value)).toBe(true)
    expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBe(value)
    expect(JSON.parse(localStorage.getItem(AUTH_USER_KEY) ?? "{}")).toEqual({ sub: "u1", email: "ada@example.test", name: "Ada" })
  })
  it("ignores malformed and expired tokens", () => {
    expect(persistAuth("not-a-jwt")).toBe(false)
    expect(persistAuth(token(1))).toBe(false)
    expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBeNull()
  })
  it("consumes return-to once", () => {
    localStorage.setItem("paprika_return_to", "/dashboard/pipelines")
    expect(consumeReturnTo()).toBe("/dashboard/pipelines")
    expect(consumeReturnTo()).toBeNull()
  })
  it("restores a valid bearer without waiting for login configuration", async () => {
    localStorage.setItem(AUTH_TOKEN_KEY, token())
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"))
    expect(screen.getByTestId("user")).toHaveTextContent("ada@example.test")
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each(["missing", "expired"])("finishes with an anonymous session when the token is %s and refresh is disabled", async (kind) => {
    if (kind === "expired") localStorage.setItem(AUTH_TOKEN_KEY, token(1))
    render(<AuthProvider><Probe /></AuthProvider>)
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"))
    expect(screen.getByTestId("user")).toHaveTextContent("none")
    expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBeNull()
  })
  it("saves PKCE and the full current route before OIDC navigation", async () => {
    window.location.pathname = "/mcp/consent"; window.location.search = "?rid=opaque"; window.location.hash = "#grant"
    render(<AuthProvider><Probe /></AuthProvider>); fireEvent.click(screen.getByText("login"))
    await waitFor(() => expect(window.location.href).toBe("https://accounts.example/authorize"))
    expect(sessionStorage.getItem("paprika_code_verifier")).toBe("verifier")
    expect(sessionStorage.getItem("paprika_expected_state")).toBe("state123")
    expect(sessionStorage.getItem("paprika_login_provider")).toBe("google")
    expect(localStorage.getItem("paprika_return_to")).toBe("/mcp/consent/?rid=opaque#grant")
  })
  it("preserves a pending Observe request through account switching", async () => {
    localStorage.setItem("paprika_return_to", "/observe/consent?rid=opaque")
    render(<AuthProvider><Probe /></AuthProvider>); fireEvent.click(screen.getByText("switch"))
    await waitFor(() => expect(window.location.href).toBe("https://accounts.example/authorize"))
    expect(localStorage.getItem("paprika_return_to")).toBe("/observe/consent?rid=opaque")
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("switchAccount=true"))).toBe(true)
  })
  it("uses the last successful account as a login hint", async () => {
    persistAuth(token(), { method: "oidc", provider: "google" })
    render(<AuthProvider><Probe /></AuthProvider>); fireEvent.click(screen.getByText("login"))
    await waitFor(() => expect(window.location.href).toBe("https://accounts.example/authorize"))
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("login_hint=ada%40example.test"))).toBe(true)
  })
  it("logs out locally even when cookie cleanup is temporarily unavailable", async () => {
    persistAuth(token(), { method: "oidc", provider: "google", sessionRefreshAvailable: true })
    fetchMock.mockImplementation(async (url: string) => url === "/auth/config" ? { ok: true, json: async () => ({ ...config, session: { refreshEnabled: true } }) } : { ok: false })
    render(<AuthProvider><Probe /></AuthProvider>); fireEvent.click(screen.getByText("logout"))
    await waitFor(() => expect(window.location.href).toBe("/login/"))
    expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBeNull()
  })
  it("does not bootstrap or refresh on focus while the callback owns the exchange", async () => {
    window.location.pathname = "/auth/callback/"
    render(<AuthProvider><Probe /></AuthProvider>)
    fireEvent.focus(window)
    window.dispatchEvent(new Event("online"))
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

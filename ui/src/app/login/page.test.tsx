import { StrictMode } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const auth = vi.hoisted(() => ({ user: null as null | { email: string }, isLoading: false, status: "anonymous", error: null as string | null, login: vi.fn(), persistAuth: vi.fn(), retry: vi.fn() }))
const navigation = vi.hoisted(() => ({ router: { replace: vi.fn() } }))
const configuration = vi.hoisted(() => ({ get: vi.fn(), password: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => navigation.router }))
vi.mock("@/lib/auth-context", async (original) => ({ ...await original<typeof import("@/lib/auth-context")>(), useAuth: () => auth, persistAuth: auth.persistAuth }))
vi.mock("@/lib/browser-session", async (original) => ({ ...await original<typeof import("@/lib/browser-session")>(), getAuthConfiguration: configuration.get, exchangePasswordForSession: configuration.password }))
import { completeSession, resetBrowserSessionForTests } from "@/lib/browser-session"
import LoginPage from "./page"
const originalLocation = window.location
const config = { oidc: { enabled: true, provider: "google", label: "Google" }, basic: { enabled: true }, session: { refreshEnabled: true } }
beforeEach(() => {
  resetBrowserSessionForTests(); localStorage.clear(); auth.user = null; auth.isLoading = false; auth.status = "anonymous"; auth.error = null
  auth.persistAuth.mockReset().mockReturnValue(true); auth.login.mockReset().mockResolvedValue(undefined); auth.retry.mockReset().mockResolvedValue(undefined); navigation.router.replace.mockReset(); configuration.get.mockReset().mockResolvedValue(config)
  configuration.password.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(window, "location", { value: { href: "", pathname: "/login/", assign: (path: string) => { window.location.href = path } }, configurable: true, writable: true })
})
afterEach(() => { resetBrowserSessionForTests(); Object.defineProperty(window, "location", { value: originalLocation, configurable: true, writable: true }); vi.unstubAllGlobals(); localStorage.clear() })
async function submitLogin() {
  fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "fixture" } })
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "fixture-password" } })
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }))
}
function remember() {
  const value = `e30.${btoa(JSON.stringify({ sub: "ada", name: "Ada", email: "ada@example.test", exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`
  completeSession(value, { method: "oidc", provider: "google", sessionRefreshAvailable: true })
}
describe("entry page", () => {
  it("renders its branded frame immediately while restoring a session", () => {
    auth.isLoading = true; render(<LoginPage />)
    expect(screen.getByRole("heading", { name: "Welcome to Paprika" })).toBeVisible()
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting")
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument()
  })
  it("makes Google primary and hides disabled password login", async () => {
    configuration.get.mockResolvedValue({ ...config, basic: { enabled: false } })
    render(<LoginPage />)
    expect(await screen.findByRole("button", { name: "Continue with Google" })).toBeVisible()
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument()
  })
  it("uses the configured generic OIDC label", async () => {
    configuration.get.mockResolvedValue({ ...config, oidc: { enabled: true, provider: "oidc", label: "Single sign-on" } })
    render(<LoginPage />)
    expect(await screen.findByRole("button", { name: "Continue with Single sign-on" })).toBeVisible()
  })
  it("shows the last used account and forgets only its display hint", async () => {
    remember(); render(<LoginPage />)
    expect(await screen.findByRole("button", { name: "Continue as Ada" })).toBeVisible()
    expect(screen.getByText("Last used · Google")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: "Use another account" }))
    expect(auth.login).toHaveBeenCalledWith({ switchAccount: true, loginHint: undefined })
  })
  it("removes remembered account details when asked to forget", async () => {
    remember(); render(<LoginPage />)
    await screen.findByRole("button", { name: "Continue as Ada" })
    fireEvent.click(screen.getByRole("button", { name: "Forget this account" }))
    expect(screen.queryByText("ada@example.test")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeVisible()
  })
  it("offers an accessible retry when sign-in initialization fails", async () => {
    auth.login.mockRejectedValue(new Error("Couldn’t start sign-in. Please try again."))
    render(<LoginPage />); fireEvent.click(await screen.findByRole("button", { name: "Continue with Google" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t start sign-in")
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeEnabled()
  })
  it.each(["/observe/consent?rid=opaque", "/mcp/consent/?rid=fleet"])("resumes successful basic sign-in at %s", async (destination) => {
    localStorage.setItem("paprika_return_to", destination)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ idToken: "fixture-token" }) }))
    render(<LoginPage />); await submitLogin()
    await waitFor(() => expect(window.location.href).toBe(destination))
    expect(configuration.password).toHaveBeenCalledWith({ username: "fixture", password: "fixture-password" })
    expect(localStorage.getItem("paprika_return_to")).toBeNull()
  })
  it("preserves the destination and does not remember failed basic login", async () => {
    localStorage.setItem("paprika_return_to", "/observe/consent?rid=opaque")
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, text: async () => "Invalid credentials" }))
    configuration.password.mockRejectedValue(new Error("Invalid credentials"))
    render(<LoginPage />); await submitLogin()
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid credentials")
    expect(auth.persistAuth).not.toHaveBeenCalled()
    expect(localStorage.getItem("paprika_return_to")).toBe("/observe/consent?rid=opaque")
  })
  it("consumes an authenticated user's pending destination once in StrictMode", async () => {
    auth.user = { email: "ada@example.test" }; auth.status = "authenticated"
    localStorage.setItem("paprika_return_to", "/observe/consent?rid=opaque")
    render(<StrictMode><LoginPage /></StrictMode>)
    await waitFor(() => expect(window.location.href).toBe("/observe/consent?rid=opaque"))
    expect(navigation.router.replace).not.toHaveBeenCalled()
  })
  it("uses client-side replacement to open the dashboard", async () => {
    auth.user = { email: "ada@example.test" }; auth.status = "authenticated"
    render(<LoginPage />)
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/dashboard/"))
  })
  it("keeps the entry page actionable while offline instead of redirecting a cached profile", async () => {
    auth.user = { email: "ada@example.test" }; auth.status = "unavailable"; auth.error = "Connection interrupted"
    render(<LoginPage />)
    fireEvent.click(await screen.findByRole("button", { name: "Retry connection" }))
    expect(auth.retry).toHaveBeenCalledOnce()
    expect(navigation.router.replace).not.toHaveBeenCalled()
  })
})

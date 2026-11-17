import { render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const navigation = vi.hoisted(() => ({ search: "", router: { replace: vi.fn() } }))
const auth = vi.hoisted(() => ({ consumeReturnTo: vi.fn<() => string | null>(), exchange: vi.fn() }))
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(navigation.search), useRouter: () => navigation.router }))
vi.mock("@/lib/auth-context", () => ({ consumeReturnTo: auth.consumeReturnTo }))
vi.mock("@/lib/browser-session", () => ({ exchangeAuthorizationCode: auth.exchange }))
import CallbackPage from "./page"
const originalLocation = window.location
beforeEach(() => {
  navigation.search = "code=auth-code&state=expected-state"; navigation.router.replace.mockReset()
  sessionStorage.setItem("paprika_expected_state", "expected-state"); sessionStorage.setItem("paprika_code_verifier", "verifier"); sessionStorage.setItem("paprika_redirect_uri", "https://console.example/auth/callback"); sessionStorage.setItem("paprika_login_provider", "google")
  auth.consumeReturnTo.mockReset().mockReturnValue(null); auth.exchange.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(window, "location", { value: { href: "" }, configurable: true, writable: true })
})
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); Object.defineProperty(window, "location", { value: originalLocation, configurable: true, writable: true }) })
describe("callback", () => {
  it("hands PKCE to the serialized browser session exchange and replaces the route", async () => {
    render(<CallbackPage />)
    await waitFor(() => expect(auth.exchange).toHaveBeenCalledWith({ code: "auth-code", codeVerifier: "verifier", redirectUri: "https://console.example/auth/callback" }, "google"))
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/dashboard/"))
    expect(sessionStorage.getItem("paprika_code_verifier")).toBeNull()
  })
  it.each([
    ["/dashboard/search?q=a?b=c", "/dashboard/search/?q=a?b=c"],
    ["/dashboard/pipelines", "/dashboard/pipelines/"],
    ["//evil.example/x", "/dashboard/"], ["/login?x=1", "/dashboard/"],
  ])("safely restores return destination %s", async (saved, expected) => {
    auth.consumeReturnTo.mockReturnValue(saved); render(<CallbackPage />)
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith(expected))
  })
  it("preserves Go-served Observe consent exactly", async () => {
    auth.consumeReturnTo.mockReturnValue("/observe/consent?rid=opaque"); render(<CallbackPage />)
    await waitFor(() => expect(window.location.href).toBe("/observe/consent?rid=opaque"))
  })
  it("rejects a callback missing its code", async () => {
    navigation.search = "state=expected-state"; render(<CallbackPage />)
    expect(await screen.findByRole("alert")).toHaveTextContent(/missing authorization code or state/i)
    expect(auth.exchange).not.toHaveBeenCalled()
    expect(screen.getByRole("link", { name: "Back to sign in" })).toBeVisible()
  })
  it("rejects a state mismatch without exchanging credentials", async () => {
    navigation.search = "code=code&state=wrong"; render(<CallbackPage />)
    expect(await screen.findByRole("alert")).toHaveTextContent(/state mismatch/i)
    expect(auth.exchange).not.toHaveBeenCalled()
  })
  it("rejects a callback without its browser PKCE session", async () => {
    sessionStorage.clear(); render(<CallbackPage />)
    expect(await screen.findByRole("alert")).toHaveTextContent(/login session not found/i)
    expect(auth.exchange).not.toHaveBeenCalled()
  })
  it("keeps the return destination and provides recovery on exchange failure", async () => {
    auth.exchange.mockRejectedValue(new Error("Token exchange failed. Please sign in again.")); render(<CallbackPage />)
    expect(await screen.findByRole("alert")).toHaveTextContent(/token exchange failed/i)
    expect(auth.consumeReturnTo).not.toHaveBeenCalled()
    expect(navigation.router.replace).not.toHaveBeenCalled()
  })
})

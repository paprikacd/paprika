import { render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const navigation = vi.hoisted(() => ({ search: "" }))

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
}))

const authMock = vi.hoisted(() => ({
  persistAuth: vi.fn(),
  consumeReturnTo: vi.fn<() => string | null>(),
}))

vi.mock("@/lib/auth-context", () => ({
  persistAuth: authMock.persistAuth,
  consumeReturnTo: authMock.consumeReturnTo,
}))

import CallbackPage from "./page"

function stubLocation() {
  const location = { href: "" }
  Object.defineProperty(window, "location", {
    value: location,
    writable: true,
    configurable: true,
  })
  return location
}

beforeEach(() => {
  navigation.search = "code=auth-code&state=expected-state"
  sessionStorage.setItem("paprika_expected_state", "expected-state")
  sessionStorage.setItem("paprika_code_verifier", "verifier")
  sessionStorage.setItem("paprika_redirect_uri", "https://console.example/auth/callback")
  authMock.persistAuth.mockReset()
  authMock.consumeReturnTo.mockReset().mockReturnValue(null)
  stubLocation()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

describe("auth callback page", () => {
  it("exchanges the code, persists the token, and redirects to /dashboard/ by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ idToken: "id-token" }),
    })
    vi.stubGlobal("fetch", fetchMock)

    render(<CallbackPage />)

    await waitFor(() => expect(authMock.persistAuth).toHaveBeenCalledWith("id-token"))
    await waitFor(() => expect(window.location.href).toBe("/dashboard/"))

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/auth/token")
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      code: "auth-code",
      codeVerifier: "verifier",
      redirectUri: "https://console.example/auth/callback",
    })
  })

  // Fix round 1, Finding 4: returnTo used to be parsed with
  // returnTo.split("?"), which silently drops everything after a second
  // literal "?" in the query component (legal in a query string). This
  // asserts the indexOf-based rewrite preserves it intact.
  it("preserves a literal second '?' inside the return-to query string", async () => {
    authMock.consumeReturnTo.mockReturnValue("/dashboard/search?q=a?b=c")
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ idToken: "id-token" }) })
    )

    render(<CallbackPage />)

    await waitFor(() =>
      expect(window.location.href).toBe("/dashboard/search/?q=a?b=c")
    )
  })

  it("redirects to a return-to path with no query untouched other than a trailing slash", async () => {
    authMock.consumeReturnTo.mockReturnValue("/dashboard/pipelines")
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ idToken: "id-token" }) })
    )

    render(<CallbackPage />)

    await waitFor(() => expect(window.location.href).toBe("/dashboard/pipelines/"))
  })

  // Fix round 2, Fold-in 3: a protocol-relative return-to
  // ("//evil.example/x") does not start with "/login", so the pre-fix guard
  // would have let it through — a browser resolves a leading "//" as
  // same-scheme navigation to a different host. Not reachable via the only
  // real writer of this value today, but the guard must reject it
  // structurally rather than rely on that caller's discipline.
  it("falls back to /dashboard/ when the stored return-to is protocol-relative", async () => {
    authMock.consumeReturnTo.mockReturnValue("//evil.example/x")
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ idToken: "id-token" }) })
    )

    render(<CallbackPage />)

    await waitFor(() => expect(window.location.href).toBe("/dashboard/"))
  })

  it("falls back to /dashboard/ when the stored return-to points at /login", async () => {
    authMock.consumeReturnTo.mockReturnValue("/login?x=1")
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ idToken: "id-token" }) })
    )

    render(<CallbackPage />)

    await waitFor(() => expect(window.location.href).toBe("/dashboard/"))
  })

  it("shows an error and never calls fetch when code or state is missing", async () => {
    navigation.search = "state=expected-state"
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    render(<CallbackPage />)

    expect(
      await screen.findByText(/missing authorization code or state/i)
    ).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("shows a CSRF error and never calls fetch on state mismatch", async () => {
    navigation.search = "code=auth-code&state=wrong-state"
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    render(<CallbackPage />)

    expect(await screen.findByText(/state mismatch/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("shows an error when the login session was never started", async () => {
    sessionStorage.clear()
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    render(<CallbackPage />)

    expect(
      await screen.findByText(/login session not found/i)
    ).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("shows an error and never redirects when the token exchange fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))

    render(<CallbackPage />)

    expect(await screen.findByText(/token exchange failed/i)).toBeInTheDocument()
    expect(window.location.href).toBe("")
    expect(authMock.persistAuth).not.toHaveBeenCalled()
  })
})

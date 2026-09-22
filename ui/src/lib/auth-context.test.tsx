import { render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  AUTH_TOKEN_KEY,
  AUTH_USER_KEY,
  AuthProvider,
  consumeReturnTo,
  persistAuth,
  useAuth,
} from "@/lib/auth-context"

// base64url-encodes a JWT payload object into a minimally-shaped
// header.payload.signature string — enough for parseJWT (auth-context.tsx's
// internal decoder) to read, without needing a real signing key.
function makeToken(payload: Record<string, unknown>): string {
  const encode = (obj: Record<string, unknown>) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`
}

function AuthProbe() {
  const { user, idToken, isLoading } = useAuth()
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="user">{user ? user.email : "none"}</span>
      <span data-testid="token">{idToken ?? "none"}</span>
    </div>
  )
}

describe("persistAuth", () => {
  afterEach(() => {
    localStorage.clear()
  })

  it("stores the token and the decoded user payload", () => {
    const token = makeToken({
      sub: "u1",
      email: "ben@shorted.com.au",
      name: "Ben",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    persistAuth(token)

    expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBe(token)
    expect(JSON.parse(localStorage.getItem(AUTH_USER_KEY) as string)).toEqual({
      sub: "u1",
      email: "ben@shorted.com.au",
      name: "Ben",
      picture: undefined,
    })
  })

  it("stores nothing for a token that doesn't decode as a JWT", () => {
    persistAuth("not-a-jwt")

    expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBeNull()
    expect(localStorage.getItem(AUTH_USER_KEY)).toBeNull()
  })
})

describe("consumeReturnTo", () => {
  afterEach(() => {
    localStorage.clear()
  })

  it("returns and removes the stored return-to path", () => {
    localStorage.setItem("paprika_return_to", "/dashboard/pipelines")

    expect(consumeReturnTo()).toBe("/dashboard/pipelines")
    expect(consumeReturnTo()).toBeNull()
  })

  it("returns null when nothing was stored", () => {
    expect(consumeReturnTo()).toBeNull()
  })
})

describe("AuthProvider", () => {
  afterEach(() => {
    localStorage.clear()
  })

  it("restores a valid, non-expired token from localStorage", async () => {
    const token = makeToken({
      sub: "u1",
      email: "ben@shorted.com.au",
      name: "Ben",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    persistAuth(token)

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    )

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"))
    expect(screen.getByTestId("user").textContent).toBe("ben@shorted.com.au")
    expect(screen.getByTestId("token").textContent).toBe(token)
  })

  it("discards an expired token rather than restoring it", async () => {
    const token = makeToken({
      sub: "u1",
      email: "ben@shorted.com.au",
      name: "Ben",
      exp: Math.floor(Date.now() / 1000) - 3600,
    })
    persistAuth(token)

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    )

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"))
    expect(screen.getByTestId("user").textContent).toBe("none")
    expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBeNull()
  })

  it("starts with no session when localStorage is empty", async () => {
    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    )

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"))
    expect(screen.getByTestId("user").textContent).toBe("none")
    expect(screen.getByTestId("token").textContent).toBe("none")
  })
})

describe("login", () => {
  const originalLocation = window.location

  beforeEach(() => {
    Object.defineProperty(window, "location", {
      value: { origin: "https://console.example", href: "", pathname: "/mcp/consent", search: "?x=1" },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    Object.defineProperty(window, "location", {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
    vi.unstubAllGlobals()
    sessionStorage.clear()
    localStorage.clear()
  })

  function LoginProbe() {
    const { login } = useAuth()
    return (
      <button type="button" onClick={() => void login()}>
        login
      </button>
    )
  }

  it("saves PKCE state and the current path, then navigates to the login URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        url: "https://accounts.example/authorize",
        codeVerifier: "verifier",
        state: "state123",
      }),
    })
    vi.stubGlobal("fetch", fetchMock)

    render(
      <AuthProvider>
        <LoginProbe />
      </AuthProvider>
    )

    screen.getByText("login").click()

    await waitFor(() =>
      expect(window.location.href).toBe("https://accounts.example/authorize")
    )
    expect(sessionStorage.getItem("paprika_code_verifier")).toBe("verifier")
    expect(sessionStorage.getItem("paprika_expected_state")).toBe("state123")
    expect(localStorage.getItem("paprika_return_to")).toBe("/mcp/consent?x=1")
  })
})

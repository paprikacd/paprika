import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const navigation = vi.hoisted(() => ({ search: "" }))

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
}))

const authState = vi.hoisted(() => ({
  user: null as null | { email: string; name: string },
  idToken: null as string | null,
  isLoading: false,
  login: vi.fn(),
}))

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => authState,
}))

import ConsentPage from "../page"

const REDIRECT_URI = "https://claude.ai/callback"
const VALID_QS =
  `client_id=claude-desktop&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  "&code_challenge=abc123&code_challenge_method=S256&state=xyz123"

function stubLocation() {
  const location = { href: "" }
  Object.defineProperty(window, "location", {
    value: location,
    writable: true,
    configurable: true,
  })
  return location
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  navigation.search = VALID_QS
  authState.user = { email: "ben@shorted.com.au", name: "Ben" }
  authState.idToken = "console-token"
  authState.isLoading = false
  authState.login.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("MCP consent page", () => {
  it("defaults to read-only: write is unticked and approving sends only paprika:read", async () => {
    navigation.search = `${VALID_QS}&scope=${encodeURIComponent("paprika:read paprika:write")}`
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ redirectTo: "https://server.example/done" }),
    })
    vi.stubGlobal("fetch", fetchMock)
    stubLocation()

    render(<ConsentPage />)

    const readCheckbox = await screen.findByRole("checkbox", {
      name: /read fleet data/i,
    })
    expect(readCheckbox).toBeChecked()
    expect(readCheckbox).toHaveAttribute("aria-disabled", "true")

    const writeCheckbox = screen.getByRole("checkbox", {
      name: /make changes to the fleet/i,
    })
    expect(writeCheckbox).not.toBeChecked()

    await userEvent.click(screen.getByRole("button", { name: /allow access/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init.body as string)
    expect(body.scopes).toEqual(["paprika:read"])
    expect(init.headers.Authorization).toBe("Bearer console-token")
  })

  it("ticking write includes it in the request and shows a warning; unticking removes both", async () => {
    navigation.search = `${VALID_QS}&scope=${encodeURIComponent("paprika:write")}`
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ redirectTo: "https://server.example/done" }),
    })
    vi.stubGlobal("fetch", fetchMock)
    stubLocation()

    render(<ConsentPage />)

    const writeCheckbox = await screen.findByRole("checkbox", {
      name: /make changes to the fleet/i,
    })
    expect(writeCheckbox).not.toBeChecked()
    expect(screen.queryByText(/approve or reject.*deployment gates/i)).not.toBeInTheDocument()

    await userEvent.click(writeCheckbox)
    expect(writeCheckbox).toBeChecked()
    expect(screen.getByText(/approve or reject.*deployment gates/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /allow access/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const bodyWithWrite = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(bodyWithWrite.scopes).toEqual(["paprika:read", "paprika:write"])

    await userEvent.click(writeCheckbox)
    expect(writeCheckbox).not.toBeChecked()
    expect(screen.queryByText(/approve or reject.*deployment gates/i)).not.toBeInTheDocument()
  })

  // Fix round 1, Finding 1(a): Deny is now a POST to the server, exactly
  // like Allow, and the page navigates only to the redirectTo the server
  // returns — it must never build that URL itself from the raw
  // redirect_uri, which is what let a crafted javascript:-scheme
  // redirect_uri execute script on this origin before this fix.
  it("deny posts decision=deny to the server and navigates only to its server-validated redirectTo", async () => {
    const location = stubLocation()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        redirectTo: `${REDIRECT_URI}?error=access_denied&state=xyz123`,
      }),
    })
    vi.stubGlobal("fetch", fetchMock)

    render(<ConsentPage />)

    await userEvent.click(await screen.findByRole("button", { name: /deny/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/mcp/authorize/consent")
    const body = JSON.parse(init.body as string)
    expect(body.decision).toBe("deny")
    expect(body.client_id).toBe("claude-desktop")
    expect(body.redirect_uri).toBe(REDIRECT_URI)
    expect(body.state).toBe("xyz123")

    await waitFor(() => expect(location.href).not.toBe(""))
    const parsed = new URL(location.href)
    expect(parsed.origin + parsed.pathname).toBe(REDIRECT_URI)
    expect(parsed.searchParams.get("error")).toBe("access_denied")
    expect(parsed.searchParams.get("state")).toBe("xyz123")
  })

  it("shows an error and never navigates when the server rejects a deny", async () => {
    stubLocation()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "invalid_request" }),
    })
    vi.stubGlobal("fetch", fetchMock)

    render(<ConsentPage />)

    await userEvent.click(await screen.findByRole("button", { name: /deny/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/invalid_request/i)).toBeInTheDocument()
  })

  it("shows a clear error and never calls fetch when required params are missing", async () => {
    navigation.search = "client_id=claude-desktop"
    authState.user = null
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    render(<ConsentPage />)

    expect(
      await screen.findByText(/can't show this request/i)
    ).toBeInTheDocument()
    expect(screen.getByText(/redirect_uri/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /allow access/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /deny/i })).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
    // An unauthenticated visitor with a broken request should not be bounced
    // through login for a request that can never succeed.
    expect(authState.login).not.toHaveBeenCalled()
  })

  it("redirects to the existing login flow when not signed in, and returns nothing to approve until then", async () => {
    authState.user = null

    render(<ConsentPage />)

    await waitFor(() => expect(authState.login).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole("button", { name: /allow access/i })).not.toBeInTheDocument()
  })

  it("guards against double submission: clicking Allow access twice only posts once", async () => {
    const pending = deferred<{ ok: boolean; json: () => Promise<unknown> }>()
    const fetchMock = vi.fn().mockReturnValue(pending.promise)
    vi.stubGlobal("fetch", fetchMock)
    stubLocation()

    render(<ConsentPage />)

    const approveButton = await screen.findByRole("button", {
      name: /allow access/i,
    })
    fireEvent.click(approveButton)
    fireEvent.click(approveButton)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    pending.resolve({
      ok: true,
      json: async () => ({ redirectTo: "https://server.example/done" }),
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })
})

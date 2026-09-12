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
const RID = "test-rid"

// Fix round 2, Finding 1: the page no longer reads client_id/redirect_uri/
// etc from the URL — it only reads `rid`, then fetches the actual request
// from GET /mcp/authorize/pending. This is the body that endpoint returns
// for a valid rid (see pendingAuthzResponse in internal/api/mcp/oauth.go).
const DEFAULT_PENDING = {
  client_id: "claude-desktop",
  redirect_uri: REDIRECT_URI,
  code_challenge: "abc123",
  code_challenge_method: "S256",
  state: "xyz123",
}

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

/**
 * Installs a fetch mock that branches on URL: GET /mcp/authorize/pending
 * (the rid lookup) resolves immediately from `pendingBody`/`pendingOk`;
 * POST /mcp/authorize/consent is handled by `consent`, defaulting to a
 * successful approval response.
 */
function installFetch({
  pendingOk = true,
  pendingBody = DEFAULT_PENDING,
  consent,
}: {
  pendingOk?: boolean
  pendingBody?: unknown
  consent?: () => { ok: boolean; json: () => Promise<unknown> }
} = {}) {
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith("/mcp/authorize/pending")) {
      return Promise.resolve({ ok: pendingOk, json: async () => pendingBody })
    }
    if (url === "/mcp/authorize/consent") {
      return Promise.resolve(
        consent
          ? consent()
          : { ok: true, json: async () => ({ redirectTo: "https://server.example/done" }) }
      )
    }
    throw new Error(`unexpected fetch to ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

/** The POST /mcp/authorize/consent call, once the mock has recorded it. */
function consentCall(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls.find(([url]) => url === "/mcp/authorize/consent")
  if (!call) throw new Error("consent endpoint was never called")
  return call
}

beforeEach(() => {
  navigation.search = `rid=${RID}`
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
    const fetchMock = installFetch({
      pendingBody: { ...DEFAULT_PENDING, scope: "paprika:read paprika:write" },
    })
    stubLocation()

    render(<ConsentPage />)

    await screen.findByText(/read fleet data/i)
    // Defect 2: the read grant must not be communicated via a disabled
    // checkbox — it should read as something granted, not as inert chrome.
    expect(
      screen.queryByRole("checkbox", { name: /read fleet data/i })
    ).not.toBeInTheDocument()
    expect(screen.getByText(/granted/i)).toBeInTheDocument()

    const writeCheckbox = screen.getByRole("checkbox", {
      name: /make changes to the fleet/i,
    })
    expect(writeCheckbox).not.toBeChecked()

    await userEvent.click(screen.getByRole("button", { name: /allow access/i }))

    await waitFor(() => consentCall(fetchMock))
    const [, init] = consentCall(fetchMock)
    const body = JSON.parse(init.body as string)
    expect(body.scopes).toEqual(["paprika:read"])
    expect(init.headers.Authorization).toBe("Bearer console-token")
  })

  // Defect 1: real clients have been observed sending no `scope` param at
  // all on the authorize URL. Before the fix, requestedScopes came back `[]`
  // in that case, `writeRequested` was `false`, and the write control never
  // rendered — making all 11 write tools permanently unreachable through
  // this flow. Absent a request there is no ceiling, so the full supported
  // set (write included, off by default) must be offered.
  it("no scope requested: write control IS offered, unticked; approving without ticking sends only paprika:read", async () => {
    const fetchMock = installFetch({
      pendingBody: { ...DEFAULT_PENDING, scope: undefined },
    })
    stubLocation()

    render(<ConsentPage />)

    const writeCheckbox = await screen.findByRole("checkbox", {
      name: /make changes to the fleet/i,
    })
    expect(writeCheckbox).not.toBeChecked()

    await userEvent.click(screen.getByRole("button", { name: /allow access/i }))

    await waitFor(() => consentCall(fetchMock))
    const body = JSON.parse(consentCall(fetchMock)[1].body as string)
    expect(body.scopes).toEqual(["paprika:read"])
  })

  it("no scope requested, write ticked: submits both scopes", async () => {
    const fetchMock = installFetch({
      pendingBody: { ...DEFAULT_PENDING, scope: undefined },
    })
    stubLocation()

    render(<ConsentPage />)

    const writeCheckbox = await screen.findByRole("checkbox", {
      name: /make changes to the fleet/i,
    })
    await userEvent.click(writeCheckbox)
    expect(writeCheckbox).toBeChecked()

    await userEvent.click(screen.getByRole("button", { name: /allow access/i }))

    await waitFor(() => consentCall(fetchMock))
    const body = JSON.parse(consentCall(fetchMock)[1].body as string)
    expect(body.scopes).toEqual(["paprika:read", "paprika:write"])
  })

  it("scope=paprika:read only: the requested scope is a ceiling, so write is NOT offered and only read is submitted", async () => {
    const fetchMock = installFetch({
      pendingBody: { ...DEFAULT_PENDING, scope: "paprika:read" },
    })
    stubLocation()

    render(<ConsentPage />)

    await screen.findByText(/read fleet data/i)
    expect(
      screen.queryByRole("checkbox", { name: /make changes to the fleet/i })
    ).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /allow access/i }))

    await waitFor(() => consentCall(fetchMock))
    const body = JSON.parse(consentCall(fetchMock)[1].body as string)
    expect(body.scopes).toEqual(["paprika:read"])
  })

  it("scope=paprika:read paprika:write: write is offered, unticked by default", async () => {
    installFetch({
      pendingBody: { ...DEFAULT_PENDING, scope: "paprika:read paprika:write" },
    })
    stubLocation()

    render(<ConsentPage />)

    const writeCheckbox = await screen.findByRole("checkbox", {
      name: /make changes to the fleet/i,
    })
    expect(writeCheckbox).not.toBeChecked()
  })

  it("ticking write includes it in the request and shows a warning; unticking removes both", async () => {
    const fetchMock = installFetch({
      pendingBody: { ...DEFAULT_PENDING, scope: "paprika:write" },
    })
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
    await waitFor(() => consentCall(fetchMock))
    const bodyWithWrite = JSON.parse(consentCall(fetchMock)[1].body as string)
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
    const fetchMock = installFetch({
      consent: () => ({
        ok: true,
        json: async () => ({
          redirectTo: `${REDIRECT_URI}?error=access_denied&state=xyz123`,
        }),
      }),
    })

    render(<ConsentPage />)

    await userEvent.click(await screen.findByRole("button", { name: /deny/i }))

    await waitFor(() => consentCall(fetchMock))
    const [url, init] = consentCall(fetchMock)
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
    const location = stubLocation()
    const fetchMock = installFetch({
      consent: () => ({ ok: false, json: async () => ({ error: "invalid_request" }) }),
    })

    render(<ConsentPage />)

    await userEvent.click(await screen.findByRole("button", { name: /deny/i }))

    await waitFor(() => consentCall(fetchMock))
    expect(await screen.findByText(/invalid_request/i)).toBeInTheDocument()
    // Fix round 2, Fold-in 2: a rejected decision must never navigate
    // anywhere — the previous test only checked that a *rejected deny*
    // showed an error, not that location.href was left untouched.
    expect(location.href).toBe("")
  })

  it("shows a clear error and never calls fetch when rid is missing", async () => {
    navigation.search = ""
    authState.user = null
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    render(<ConsentPage />)

    expect(
      await screen.findByText(/can't show this request/i)
    ).toBeInTheDocument()
    expect(screen.getByText(/rid/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /allow access/i })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /deny/i })).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
    // An unauthenticated visitor with no rid at all should not be bounced
    // through login for a request that can never succeed.
    expect(authState.login).not.toHaveBeenCalled()
  })

  it("shows a clear error and stops when the pending request can't be resolved", async () => {
    installFetch({ pendingOk: false })

    render(<ConsentPage />)

    expect(
      await screen.findByText(/can't show this request/i)
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /allow access/i })).not.toBeInTheDocument()
  })

  it("redirects to the existing login flow when not signed in, and returns nothing to approve until then", async () => {
    authState.user = null

    render(<ConsentPage />)

    await waitFor(() => expect(authState.login).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole("button", { name: /allow access/i })).not.toBeInTheDocument()
  })

  it("guards against double submission: clicking Allow access twice only posts once", async () => {
    const pending = deferred<{ ok: boolean; json: () => Promise<unknown> }>()
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith("/mcp/authorize/pending")) {
        return Promise.resolve({ ok: true, json: async () => DEFAULT_PENDING })
      }
      return pending.promise
    })
    vi.stubGlobal("fetch", fetchMock)
    stubLocation()

    render(<ConsentPage />)

    const approveButton = await screen.findByRole("button", {
      name: /allow access/i,
    })
    fireEvent.click(approveButton)
    fireEvent.click(approveButton)

    // One GET for the pending lookup plus exactly one POST for the (still
    // in-flight) consent decision, even though Allow was clicked twice.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    pending.resolve({
      ok: true,
      json: async () => ({ redirectTo: "https://server.example/done" }),
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })
})

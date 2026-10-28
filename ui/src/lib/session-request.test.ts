import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { redirectToLogin, sessionFetch } from "./session-request"
import { isRenewableRead } from "./transport"

const session = vi.hoisted(() => ({
  token: "old" as string | null, identityKey: "user", identityEpoch: 1, logoutPending: false,
  ensure: vi.fn(), recover: vi.fn(), clear: vi.fn(),
}))
vi.mock("./browser-session", () => ({
  ensureValidSession: session.ensure,
  recoverUnauthorized: session.recover,
  clearRejectedSession: session.clear,
  getSessionSnapshot: () => ({ idToken: session.token, identityKey: session.identityKey, identityEpoch: session.identityEpoch, logoutPending: session.logoutPending }),
}))
const originalLocation = window.location
beforeEach(() => {
  vi.resetAllMocks()
  session.token = "old"; session.identityKey = "user"; session.identityEpoch = 1; session.logoutPending = false
  session.ensure.mockImplementation(async () => session.token)
  session.recover.mockImplementation(async () => { session.token = "new"; return "new" })
  Object.defineProperty(window, "location", { configurable: true, value: { pathname: "/dashboard/insights/", search: "?dashboard=service&var.service=uptime-api", hash: "#traces", href: "" } })
})
afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
})
function mockResponses(...statuses: number[]) {
  const fetcher = vi.fn()
  statuses.forEach(status => fetcher.mockResolvedValueOnce(new Response(null, { status })))
  vi.stubGlobal("fetch", fetcher)
  return fetcher
}

describe("authenticated requests", () => {
  it("does not cancel a pending cookie logout by navigating away", () => {
    session.logoutPending = true
    redirectToLogin()
    expect(window.location.href).toBe("")
    expect(localStorage.getItem("paprika_return_to")).toBeNull()
  })
  it("waits for session bootstrap before requesting protected data", async () => {
    let resolve!: (token: string) => void
    session.ensure.mockReturnValue(new Promise<string>(done => { resolve = done }))
    const fetcher = mockResponses(200)
    const pending = sessionFetch("/read", {}, true)
    expect(fetcher).not.toHaveBeenCalled()
    resolve("restored")
    await pending
    expect(fetcher.mock.calls[0][1].headers.get("Authorization")).toBe("Bearer restored")
  })
  it("retries an authorized read once after renewal", async () => {
    const fetcher = mockResponses(401, 200)
    const signal = new AbortController().signal
    expect((await sessionFetch("/read", { signal }, true)).status).toBe(200)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][1].headers.get("Authorization")).toBe("Bearer new")
    expect(fetcher.mock.calls[1][1].signal).toBe(signal)
    expect(session.clear).not.toHaveBeenCalled()
  })
  it("renews but never automatically repeats a mutation", async () => {
    const fetcher = mockResponses(401)
    await expect(sessionFetch("/write", { method: "POST", body: "mutation" })).rejects.toThrow(/renewed.*retry/)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(session.recover).toHaveBeenCalledWith("old")
  })
  it("retains the destination when a session is definitively expired", async () => {
    session.recover.mockResolvedValue(null)
    mockResponses(401)
    await sessionFetch("/read", {}, true)
    expect(window.location.href).toBe("/login/")
    expect(localStorage.getItem("paprika_return_to")).toBe("/dashboard/insights/?dashboard=service&var.service=uptime-api#traces")
  })
  it("does not sign out or navigate on a transient renewal failure", async () => {
    session.recover.mockRejectedValue(new Error("Temporary network failure"))
    mockResponses(401)
    await expect(sessionFetch("/read", {}, true)).rejects.toThrow(/network/)
    expect(window.location.href).toBe("")
    expect(session.clear).not.toHaveBeenCalled()
  })
  it("rejects a response from an account signed out while the request was in flight", async () => {
    let finish!: (response: Response) => void
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { finish = done })))
    const pending = sessionFetch("/read", {}, true)
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
    session.identityEpoch++
    finish(new Response(null, { status: 200 }))
    await expect(pending).rejects.toThrow(/session changed/)
  })
  it("stops after a second rejected token", async () => {
    const fetcher = mockResponses(401, 401)
    await sessionFetch("/read", {}, true)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(session.clear).toHaveBeenCalledWith("new")
  })
  it("does not replay an aborted read after renewal", async () => {
    const controller = new AbortController()
    session.recover.mockImplementation(async () => { controller.abort(); return "new" })
    const fetcher = mockResponses(401)
    await expect(sessionFetch("/read", { signal: controller.signal }, true)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it("allows only explicitly reviewed read RPCs to be replayed", () => {
    expect(isRenewableRead("/paprika.v1.PaprikaService/ListApplications")).toBe(true)
    expect(isRenewableRead("/paprika.v1.PaprikaService/QueryFleetMap")).toBe(true)
    for (const method of ["SyncApplication", "CreateObservabilityProvider", "GetOrCreateThing", "StreamResourceLogs"]) {
      expect(isRenewableRead(`/paprika.v1.PaprikaService/${method}`)).toBe(false)
    }
    expect(isRenewableRead("/another.Service/ListApplications")).toBe(false)
  })
})

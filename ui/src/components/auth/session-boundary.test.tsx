import { act, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SessionBoundary } from "./session-boundary"

const state = vi.hoisted(() => ({
  snapshot: { status: "anonymous", identityKey: null as string | null, identityEpoch: 0, logoutPending: false },
  pathname: "/dashboard/", listeners: new Set<() => void>(), config: vi.fn(), redirect: vi.fn(), mounts: 0,
}))
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }))
vi.mock("@/lib/session-request", () => ({ redirectToLogin: state.redirect }))
vi.mock("@/lib/browser-session", () => ({
  getSessionSnapshot: () => state.snapshot,
  getServerSessionSnapshot: () => state.snapshot,
  subscribeSession: (listener: () => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener) },
  getAuthConfiguration: state.config,
}))
function LocalView() { const [mount] = useState(() => ++state.mounts); return <p>View {mount}</p> }
function publish(next: Partial<typeof state.snapshot>) {
  act(() => { state.snapshot = { ...state.snapshot, ...next }; state.listeners.forEach(listener => listener()) })
}
beforeEach(() => {
  vi.resetAllMocks()
  state.snapshot = { status: "anonymous", identityKey: null, identityEpoch: 0, logoutPending: false }; state.pathname = "/dashboard/"; state.mounts = 0
  state.config.mockResolvedValue({ oidc: { enabled: true }, basic: { enabled: false } })
  window.history.replaceState(null, "", "/dashboard/")
})
afterEach(() => { state.listeners.clear(); window.history.replaceState(null, "", "/") })
describe("dashboard session boundary", () => {
  it("redirects a definitively anonymous session even when no RPC is pending", async () => {
    render(<SessionBoundary><LocalView /></SessionBoundary>)
    await waitFor(() => expect(state.redirect).toHaveBeenCalledOnce())
  })
  it("keeps public examples accessible without sign-in", async () => {
    state.pathname = "/dashboard/insights/"
    window.history.replaceState(null, "", "/dashboard/insights/?example=1")
    render(<SessionBoundary><LocalView /></SessionBoundary>)
    await screen.findByText("View 1")
    expect(state.config).not.toHaveBeenCalled()
    expect(state.redirect).not.toHaveBeenCalled()
  })
  it("permits deployments with no interactive auth configured", async () => {
    state.config.mockResolvedValue({ oidc: { enabled: false }, basic: { enabled: false } })
    render(<SessionBoundary><LocalView /></SessionBoundary>)
    await waitFor(() => expect(state.config).toHaveBeenCalledOnce())
    expect(state.redirect).not.toHaveBeenCalled()
  })
  it("does not redirect an account that signed in while configuration loaded", async () => {
    let finish!: (value: unknown) => void
    state.config.mockReturnValue(new Promise(resolve => { finish = resolve }))
    render(<SessionBoundary><LocalView /></SessionBoundary>)
    publish({ status: "authenticated", identityKey: "user-a", identityEpoch: 1 })
    await act(async () => { finish({ oidc: { enabled: true }, basic: { enabled: false } }) })
    expect(state.redirect).not.toHaveBeenCalled()
  })
  it("resets local state on account changes and keeps it during reconnection", async () => {
    state.snapshot = { status: "authenticated", identityKey: "user-a", identityEpoch: 1, logoutPending: false }
    render(<SessionBoundary><LocalView /></SessionBoundary>)
    expect(screen.getByText("View 1")).toBeInTheDocument()
    publish({ status: "unavailable" })
    expect(screen.getByText("View 1")).toBeInTheDocument()
    publish({ status: "authenticated" })
    expect(screen.getByText("View 1")).toBeInTheDocument()
    publish({ identityKey: "user-b", identityEpoch: 2 })
    expect(screen.getByText("View 2")).toBeInTheDocument()
    expect(state.redirect).not.toHaveBeenCalled()
  })
  it("hides private views but waits for cookie cleanup before leaving the initiating logout tab", async () => {
    state.snapshot = { status: "anonymous", identityKey: null, identityEpoch: 2, logoutPending: true }
    render(<SessionBoundary><LocalView /></SessionBoundary>)
    expect(screen.queryByText("View 1")).not.toBeInTheDocument()
    expect(screen.getByText("Finishing your session…")).toBeInTheDocument()
    expect(state.redirect).not.toHaveBeenCalled()
    publish({ logoutPending: false })
    await waitFor(() => expect(state.redirect).toHaveBeenCalledOnce())
  })
})

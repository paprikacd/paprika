import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import InsightsPage from "./page"

const state = vi.hoisted(() => ({
  snapshot: { identityKey: "account-a", identityEpoch: 1, idToken: "first", revision: 1 },
  listeners: new Set<() => void>(), mounts: 0,
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock("@/features/insights/client", () => ({ createInsightsClient: vi.fn(() => ({})) }))
vi.mock("@/lib/browser-session", () => ({
  getSessionSnapshot: () => state.snapshot,
  getServerSessionSnapshot: () => state.snapshot,
  subscribeSession: (listener: () => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener) },
  ensureValidSession: vi.fn(), recoverUnauthorized: vi.fn(), clearRejectedSession: vi.fn(),
}))
vi.mock("next/dynamic", async () => {
  const React = await import("react")
  return { default: () => function Workspace({ initialExample }: { initialExample: boolean }) {
    const [mount] = React.useState(() => ++state.mounts)
    return <p>Workspace {mount} {initialExample ? "example" : "live"}</p>
  } }
})
beforeEach(() => {
  state.snapshot = { identityKey: "account-a", identityEpoch: 1, idToken: "first", revision: 1 }
  state.mounts = 0
  window.history.replaceState(null, "", "/dashboard/insights/?dashboard=service")
})
afterEach(() => { state.listeners.clear(); window.history.replaceState(null, "", "/") })
function update(next: Partial<typeof state.snapshot>) {
  act(() => { state.snapshot = { ...state.snapshot, ...next }; state.listeners.forEach(listener => listener()) })
}
describe("Insights workspace identity boundary", () => {
  it("preserves edits and local query cache on token renewal but remounts on account changes", async () => {
    render(<InsightsPage />)
    await screen.findByText("Workspace 1 live")
    update({ idToken: "renewed", revision: 2 })
    expect(screen.getByText("Workspace 1 live")).toBeInTheDocument()
    update({ identityKey: "account-b", identityEpoch: 2, idToken: "other", revision: 3 })
    await screen.findByText("Workspace 2 live")
    update({ identityEpoch: 3, revision: 4 })
    await screen.findByText("Workspace 3 live")
  })
  it("keeps anonymous example dashboards available", async () => {
    window.history.replaceState(null, "", "/dashboard/insights/?example=1")
    render(<InsightsPage />)
    await waitFor(() => expect(screen.getByText("Workspace 1 example")).toBeInTheDocument())
  })
})

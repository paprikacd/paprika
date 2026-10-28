import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const auth = vi.hoisted(() => ({ status: "unavailable", retry: vi.fn() }))
vi.mock("@/lib/auth-context", () => ({ useAuth: () => auth }))
vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}))
import { SessionNotice } from "./session-notice"
const originalLocation = window.location
beforeEach(() => {
  auth.status = "unavailable"; auth.retry.mockReset().mockResolvedValue(undefined); localStorage.clear()
  Object.defineProperty(window, "location", { value: { href: "", pathname: "/dashboard/insights/", search: "?dashboard=service-overview&var-service=uptime-api", hash: "#signals" }, configurable: true, writable: true })
})
afterEach(() => { Object.defineProperty(window, "location", { value: originalLocation, configurable: true, writable: true }); localStorage.clear() })
describe("dashboard session recovery", () => {
  it("retries in place and reports a temporary outage without destroying the workspace", async () => {
    auth.retry.mockRejectedValue(new Error("offline")); render(<SessionNotice />)
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Still unable to reconnect"))
    expect(window.location.href).toBe("")
    expect(screen.getByRole("button", { name: "Retry connection" })).toBeEnabled()
  })
  it("preserves dashboard and service filter when starting sign-in again", () => {
    render(<SessionNotice />)
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }))
    expect(localStorage.getItem("paprika_return_to")).toBe("/dashboard/insights/?dashboard=service-overview&var-service=uptime-api#signals")
    expect(window.location.href).toBe("/login/")
  })
  it("stays out of the way for a healthy session", () => {
    auth.status = "authenticated"; render(<SessionNotice />)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
  it("keeps local examples usable without an auth server, restoring the notice for live data", () => {
    window.location.search = "?dashboard=service-overview&example=1"
    const { rerender } = render(<SessionNotice />)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(auth.retry).not.toHaveBeenCalled()
    window.location.search = "?dashboard=service-overview"
    rerender(<SessionNotice />)
    expect(screen.getByRole("alert")).toHaveTextContent("Connection interrupted")
  })
  it("does not hide session errors outside the public Insights example route", () => {
    window.location.pathname = "/dashboard/"
    window.location.search = "?example=1"
    render(<SessionNotice />)
    expect(screen.getByRole("alert")).toHaveTextContent("Connection interrupted")
  })
})

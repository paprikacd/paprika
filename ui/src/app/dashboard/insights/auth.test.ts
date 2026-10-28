import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { redirectInsightsToLogin } from "./auth"
import { consumeReturnTo } from "@/lib/auth-context"
import { authReturnDestination } from "@/lib/auth-return-to"
import { buildDashboardURL, parseDashboardURL } from "@/features/insights/drilldown"

const originalLocation = window.location
beforeEach(() => localStorage.clear())
afterEach(() => {
  Object.defineProperty(window, "location", { value: originalLocation, configurable: true, writable: true })
  localStorage.clear()
  vi.restoreAllMocks()
})

function location(pathname: string, search = "", hash = "") {
  Object.defineProperty(window, "location", {
    value: { pathname, search, hash, href: "" }, configurable: true, writable: true,
  })
}

describe("Insights login handoff", () => {
  it("resumes the exact shared dashboard, service filter and time range after sign-in", () => {
    const navigation = {
      dashboardId: "service-overview", variables: { service: "brandbrain-api" },
      customTimeRange: { from: "2026-10-26T10:00:00Z", to: "2026-10-26T11:00:00Z" },
    }
    const destination = buildDashboardURL(navigation) + "#traces"
    const url = new URL(destination, "https://paprika.example.test")
    location(url.pathname, url.search, url.hash)
    localStorage.setItem("paprika_id_token", "expired-or-revoked-token")
    localStorage.setItem("paprika_auth_user", JSON.stringify({ sub: "previous-user" }))
    redirectInsightsToLogin()
    expect(window.location.href).toBe("/login/")
    // Navigation is independent of session invalidation, which is conditional
    // on the rejected bearer in the shared session manager.
    expect(localStorage.getItem("paprika_id_token")).toBe("expired-or-revoked-token")
    const resumed = authReturnDestination(consumeReturnTo())
    expect(resumed).toBe(destination)
    expect(parseDashboardURL(new URL(resumed, "https://paprika.example.test").search)).toEqual(navigation)
    expect(localStorage.getItem("paprika_return_to")).toBeNull()
  })

  it.each(["//external.example/", "/login/", "/auth/callback/"])("does not retain unsafe or recursive destination %s", pathname => {
    location(pathname)
    localStorage.setItem("paprika_return_to", "//stale.example/")
    redirectInsightsToLogin()
    expect(localStorage.getItem("paprika_return_to")).toBeNull()
    expect(window.location.href).toBe(pathname === "/login/" ? "" : "/login/")
  })
})

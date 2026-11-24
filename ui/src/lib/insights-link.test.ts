import { describe, expect, it } from "vitest"
import { parseDashboardLink } from "@/features/insights/drilldown"
import { insightsDashboardHref } from "./insights-link"

describe("insightsDashboardHref", () => {
  it("links to the dashboard with no variables when none are given", () => {
    expect(insightsDashboardHref("service-overview", {})).toBe("/dashboard/insights/?dashboard=service-overview")
  })

  it("sorts the variables and round-trips through the Insights link parser", () => {
    const variables = { service: "checkout-api", namespace: "payments" }
    const href = insightsDashboardHref("service-overview", variables)
    expect(href).toBe(`/dashboard/insights/?dashboard=service-overview&vars=${encodeURIComponent('{"namespace":"payments","service":"checkout-api"}')}`)
    const parsed = parseDashboardLink(new URL(href, "http://console.test").search)
    expect(parsed.navigation?.dashboardId).toBe("service-overview")
    expect(parsed.navigation?.variables).toEqual({ namespace: "payments", service: "checkout-api" })
  })
})

import { describe, expect, it } from "vitest"
import { parseDashboardLink } from "@/features/insights/drilldown"
import { readEmbedRequest } from "@/features/insights/embed-request"
import { dashboardSchema, variableNameSchema } from "@/features/insights/schema"
import { insightsDashboardHref, insightsEmbedHref } from "./insights-link"

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


describe("insightsEmbedHref", () => {
  it("builds the same-origin embed address that the Insights page reads back", () => {
    const href = insightsEmbedHref("service-overview", "request-rate", { service: "checkout", namespace: "payments" }, "light")!
    const url = new URL(href, "http://console.test")
    expect(url.origin).toBe("http://console.test")
    expect(url.pathname).toBe("/dashboard/insights/")
    expect(readEmbedRequest(url.search)).toEqual({ widgetId: "request-rate", theme: "light" })
    const parsed = parseDashboardLink(url.search)
    expect(parsed.navigation).toEqual({ dashboardId: "service-overview", variables: { namespace: "payments", service: "checkout" } })
    expect(parsed.rejected).toEqual([])
  })

  it("refuses ids and variables the Insights schema would refuse, so no value can point the frame elsewhere", () => {
    for (const id of ["", "//evil.example", "https://evil.example", "../admin", "a b", "-x", "x".repeat(81)]) {
      expect(insightsEmbedHref(id, "w", {}, "light")).toBeUndefined()
      expect(insightsEmbedHref("d", id, {}, "light")).toBeUndefined()
      expect(dashboardSchema.shape.id.safeParse(id).success).toBe(false)
    }
    for (const name of ["1x", "a-b", "__proto__", "x".repeat(65)]) {
      expect(insightsEmbedHref("d", "w", { [name]: "v" }, "light")).toBeUndefined()
      expect(variableNameSchema.safeParse(name).success).toBe(false)
    }
    expect(insightsEmbedHref("d", "w", { service: "x".repeat(1025) }, "light")).toBeUndefined()
    expect(insightsEmbedHref("d", "w", Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`v${i}`, "x"])), "light")).toBeUndefined()
    // The longest valid parts still pass.
    expect(insightsEmbedHref("d".repeat(80), "w".repeat(80), { [`v${"x".repeat(63)}`]: "y".repeat(1024) }, "dark")).toMatch(/^\/dashboard\/insights\/\?/)
  })
})

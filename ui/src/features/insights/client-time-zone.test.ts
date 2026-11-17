import { afterEach, describe, expect, it, vi } from "vitest"
import { createInsightsClient } from "./client"
import { browserTimeZone, resolveDashboardTimeZone } from "./dashboard-time-zone"
import { newDashboard, type Dashboard } from "./schema"

const dashboard = (id: string, timeZone?: string): Dashboard => ({
  ...newDashboard(),
  id,
  title: id,
  ...(timeZone === undefined ? {} : { timeZone }),
})
const json = (value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json", ...headers } })

afterEach(() => vi.unstubAllGlobals())

describe("reading dashboards whose stored time zone is not canonical", () => {
  it("loads every dashboard in a list when one stored zone is not canonical", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ dashboards: [dashboard("a", "Europe/London"), dashboard("bad", "Factory"), dashboard("c")] }, { ETag: '"list"' })))
    const dashboards = await createInsightsClient("/api/insights").list()
    expect(dashboards.map((item) => item.id)).toEqual(["a", "bad", "c"])
    expect(dashboards[0].timeZone).toBe("Europe/London")
    expect(dashboards[1].timeZone).toBe("Factory")
    // Rendering falls back to the viewer's zone for the stale value, so no chart formats with it.
    expect(resolveDashboardTimeZone(dashboards[1].timeZone)).toBe(browserTimeZone())
  })

  it("opens a single dashboard with a stored zone it cannot format, and keeps its ETag", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(dashboard("bad", "+05:30"), { ETag: '"one"' })))
    const { dashboard: opened, etag } = await createInsightsClient("/api/insights").get("bad")
    expect(opened.timeZone).toBe("+05:30")
    expect(etag).toBe('"one"')
  })

  it("refuses to save that dashboard back without a request, so the zone is corrected first", async () => {
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    await expect(createInsightsClient("/api/insights").save(dashboard("bad", "Factory"), '"one"')).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
})

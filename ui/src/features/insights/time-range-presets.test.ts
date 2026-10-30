import { describe, expect, it } from "vitest"
import { dashboardSchema } from "./schema"
import { dashboardRange } from "./time-range"

describe("dashboard range presets", () => {
  it.each([["30m", 1800], ["30d", 2592000]] as const)("resolves and persists %s", (timeRange, seconds) => {
    const dashboard = dashboardSchema.parse({ schemaVersion: 1, id: "range", title: "Range", timeRange, refreshInterval: 0, widgets: [] })
    expect(dashboardRange(dashboard, 2_000_000_000)).toEqual({ start: 2_000_000_000 - seconds, end: 2_000_000_000 })
  })
})

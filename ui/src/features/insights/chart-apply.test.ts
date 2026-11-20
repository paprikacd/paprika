import { describe, expect, it } from "vitest"
import { applyChartToDashboard } from "./chart-apply"
import type { Dashboard, Widget } from "./schema"

function widget(id: string, title: string, x: number): Widget {
  return { id, title, type: "stat", providerId: "metrics", query: "up", unit: "", layout: { x, y: 0, w: 3, h: 2 } }
}
const base: Dashboard = {
  schemaVersion: 1,
  id: "dash",
  title: "Dashboard",
  timeRange: "1h",
  refreshInterval: 0,
  widgets: [widget("a", "Alpha", 0), widget("b", "Beta", 3)],
}

describe("applyChartToDashboard", () => {
  it("replaces the chart's tile with the applied draft", () => {
    const next = applyChartToDashboard(base, widget("a", "Alpha renamed", 0))
    expect(next.widgets[0].title).toBe("Alpha renamed")
    expect(next.widgets[1]).toBe(base.widgets[1])
  })

  it("moves a neighbour to the placement the editor staged and keeps its size", () => {
    const next = applyChartToDashboard(base, widget("a", "Alpha", 0), [{ i: "b", x: 6, y: 1, w: 4, h: 3 }])
    expect(next.widgets[1].layout).toEqual({ x: 6, y: 1, w: 4, h: 3 })
    expect(next.widgets[1].title).toBe("Beta")
  })

  it("leaves neighbours alone when no placement was staged", () => {
    const next = applyChartToDashboard(base, widget("a", "Alpha", 0))
    expect(next.widgets[1]).toBe(base.widgets[1])
  })

  it("does not mutate the dashboard it was given", () => {
    const before = JSON.stringify(base)
    applyChartToDashboard(base, widget("a", "Changed", 0), [{ i: "b", x: 9, y: 9, w: 1, h: 1 }])
    expect(JSON.stringify(base)).toBe(before)
  })
})

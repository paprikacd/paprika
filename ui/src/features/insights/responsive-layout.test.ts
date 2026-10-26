import { describe, expect, it } from "vitest"
import { canvasLayout, canvasMode } from "./responsive-layout"
import { exampleDashboard } from "./example"
import type { Widget } from "./schema"

describe("responsive canvas projection", () => {
  it("reflows by available canvas width, including space taken by the inspector", () => {
    expect([320, 599, 600, 959, 960, 2400].map(canvasMode)).toEqual([
      "stacked", "stacked", "compact", "compact", "wide", "wide",
    ])
  })

  it("preserves the saved arrangement after shrinking and growing", () => {
    const widgets = structuredClone(exampleDashboard.widgets)
    const before = JSON.stringify(widgets)
    for (const mode of ["compact", "stacked", "wide"] as const) {
      const layout = canvasLayout(widgets, mode)
      expect(JSON.stringify(widgets)).toBe(before)
      if (mode === "wide") {
        for (const item of layout) {
          const { x, y, w, h } = item
          expect({ x, y, w, h }).toEqual(widgets.find((widget) => widget.id === item.i)!.layout)
        }
      }
    }
  })

  it("pairs compact metrics, gives plots a full row, and avoids overlap with uneven heights", () => {
    const widgets = structuredClone(exampleDashboard.widgets)
    widgets[0].layout.h = 3
    const layout = canvasLayout(widgets, "compact")
    expect(layout.slice(0, 3).map(({ x, y, w, h }) => ({ x, y, w, h }))).toEqual([
      { x: 0, y: 0, w: 6, h: 3 },
      { x: 6, y: 0, w: 6, h: 2 },
      { x: 0, y: 3, w: 6, h: 2 },
    ])
    expect(layout.find((item) => item.i === "traffic")).toMatchObject({ x: 0, y: 5, w: 12, h: 4 })
    for (const [index, a] of layout.entries()) {
      for (const b of layout.slice(index + 1)) {
        expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false)
      }
    }
  })

  it("keeps visual reading order on phones even when the document array differs", () => {
    const widgets = [...exampleDashboard.widgets].reverse()
    const layout = canvasLayout(widgets, "stacked")
    expect(layout.map((item) => item.i)).toEqual(exampleDashboard.widgets.map((widget) => widget.id))
    expect(layout.every((item) => item.x === 0 && item.w === 12)).toBe(true)
  })

  it("preserves tall widgets and gives short plots usable height in adaptive views", () => {
    const widgets: Widget[] = [
      { ...exampleDashboard.widgets[3], layout: { x: 0, y: 0, w: 12, h: 2 } },
      { ...exampleDashboard.widgets[6], layout: { x: 0, y: 2, w: 12, h: 9 } },
    ]
    expect(canvasLayout(widgets, "stacked").map((item) => item.h)).toEqual([4, 9])
  })

  it("allows labeled heatmap rows room on small screens while color-only grids stay compact", () => {
    const heatmap = structuredClone(exampleDashboard.widgets.find((widget) => widget.type === "heatmap")!)
    expect(canvasLayout([heatmap], "compact")[0].h).toBe(5)
    expect(canvasLayout([heatmap], "stacked")[0].h).toBe(6)
    heatmap.options = { showLabels: false, showValues: false }
    expect(canvasLayout([heatmap], "stacked")[0].h).toBe(4)
    expect(heatmap.layout.h).toBe(4)
  })
})

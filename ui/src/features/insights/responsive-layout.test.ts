import { describe, expect, it } from "vitest"
import { canvasLayout, canvasMode, denseCanvasLayout, intrinsicStat } from "./responsive-layout"
import { exampleDashboard } from "./example"
import type { Widget } from "./schema"

describe("responsive canvas projection", () => {
  it("starts balanced metric groups after an occupied plugin half-row", () => {
    const base = exampleDashboard.widgets[0]
    const widgets: Widget[] = [{ ...base, id: "plugin", type: "plugin", layout: { x: 0, y: 0, w: 4, h: 2 } },
      ...Array.from({ length: 3 }, (_, i) => ({ ...base, id: `stat-${i}`, layout: { x: i * 4, y: 2, w: 4, h: 2 } }))]
    const before = JSON.stringify(widgets)
    expect(canvasLayout(widgets, "compact", 840).slice(1).map(item => [item.x, item.y, item.w])).toEqual([[0, 4, 4], [4, 4, 4], [8, 4, 4]])
    expect(JSON.stringify(widgets)).toBe(before)
  })
  it("only gives ordinary short stats intrinsic mobile reading height", () => {
    const base = exampleDashboard.widgets[0]
    expect(intrinsicStat(base)).toBe(true)
    for (const widget of [
      { ...base, description: "Context" },
      { ...base, layout: { ...base.layout, h: 3 } },
      { ...base, options: { showSparkline: true } },
      { ...base, options: { showStatBar: true } },
      { ...base, type: "timeseries" as const },
    ]) expect(intrinsicStat(widget)).toBe(false)
  })

  it("balances metric groups at the measured three-column threshold without editing documents", () => {
    const base = exampleDashboard.widgets[0]
    for (const count of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const widgets = Array.from({ length: count }, (_, i) => ({ ...base, id: `metric-${i}`, layout: { x: i % 3 * 4, y: Math.floor(i / 3) * 2, w: 4, h: 2 } }))
      const original = JSON.stringify(widgets)
      for (const width of [839, 840, 841]) {
        const layout = canvasLayout(widgets, "compact", width)
        expect(layout.every(item => item.x >= 0 && item.x + item.w <= 12)).toBe(true)
        if (width < 840) expect(layout.every(item => item.w === 6)).toBe(true)
        else if (count > 1) {
          for (const y of new Set(layout.map(item => item.y))) expect(layout.filter(item => item.y === y).length).toBeGreaterThan(1)
        }
        for (const [i, a] of layout.entries()) for (const b of layout.slice(i + 1))
          expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false)
      }
      expect(JSON.stringify(widgets)).toBe(original)
      expect(canvasLayout(widgets, "stacked", 390).every(item => item.w === 12)).toBe(true)
    }
    const layout = canvasLayout(exampleDashboard.widgets, "compact", 840)
    expect(layout.slice(0, 3).map(item => [item.x, item.y, item.w])).toEqual([[0, 0, 4], [4, 0, 4], [8, 0, 4]])
    expect(layout.find(item => item.i === "traffic")).toMatchObject({ x: 0, y: 2, w: 12 })
  })

  it("leaves room for sparkline rows and horizontal-scroll guidance in narrow record tables", () => {
    const widget: Widget = { ...exampleDashboard.widgets[3], id: "risk-table", type: "plugin", pluginId: "record-table", dataKind: "records", config: { cellStyles: [{ column: "trend", display: "sparkline" }] }, layout: { x: 0, y: 0, w: 4, h: 4 } }
    const before = JSON.stringify(widget)
    expect(canvasLayout([widget], "wide")[0].h).toBe(4)
    expect(canvasLayout([widget], "compact")[0].h).toBe(5)
    expect(canvasLayout([widget], "stacked")[0].h).toBe(5)
    expect(canvasLayout([{ ...widget, config: { cellStyles: [{ column: "risk", display: "bar" }] } }], "stacked")[0].h).toBe(4)
    expect(JSON.stringify(widget)).toBe(before)
  })
  it("reserves chart and table-legend space on narrow canvases without changing the saved layout", () => {
    const widget: Widget = { ...exampleDashboard.widgets[3], id: "statistics", type: "plugin", pluginId: "stacked-timeseries", dataKind: "metrics", config: { legendDisplay: "table" }, layout: { x: 0, y: 0, w: 8, h: 4 } }
    const before = JSON.stringify(widget)
    expect(canvasLayout([widget], "wide")[0].h).toBe(4)
    expect(canvasLayout([widget], "compact")[0].h).toBe(5)
    expect(canvasLayout([widget], "stacked")[0].h).toBe(5)
    expect(JSON.stringify(widget)).toBe(before)
    expect(canvasLayout([{ ...widget, config: { legendDisplay: "list" } }], "stacked")[0].h).toBe(4)
  })
  it("projects dense wide views without overlaps or changing saved positions", () => {
    const widgets = structuredClone(exampleDashboard.widgets)
    const before = JSON.stringify(widgets)
    const standard = canvasLayout(widgets, "wide")
    const compact = denseCanvasLayout(widgets, "wide")
    expect(JSON.stringify(widgets)).toBe(before)
    expect(compact.map(item => [item.i, item.x, item.w])).toEqual(standard.map(item => [item.i, item.x, item.w]))
    expect(Math.max(...compact.map(item => item.y + item.h)) * 33).toBeLessThan(Math.max(...standard.map(item => item.y + item.h)) * 74)
    for (const [index, a] of compact.entries()) for (const b of compact.slice(index + 1)) {
      expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false)
    }
    expect(denseCanvasLayout(widgets, "compact")).toEqual(canvasLayout(widgets, "compact"))
    expect(denseCanvasLayout(widgets, "stacked")).toEqual(canvasLayout(widgets, "stacked"))
  })

  it("keeps equally sized neighboring panels aligned in compact view", () => {
    const a = { ...exampleDashboard.widgets[3], id: "chart", type: "timeseries" as const, layout: { x: 0, y: 0, w: 6, h: 5 } }
    const b = { ...exampleDashboard.widgets[3], id: "map", type: "plugin" as const, pluginId: "connection-map", dataKind: "records" as const, layout: { x: 6, y: 0, w: 6, h: 5 } }
    const layout = denseCanvasLayout([a, b], "wide")
    // The dense plot floor is eight fine tracks; neighboring panels inherit
    // that reading room even when their own content can use fewer tracks.
    expect(layout.map(item => [item.y, item.h])).toEqual([[0, 8], [0, 8]])
    expect(denseCanvasLayout([b, a], "wide")).toEqual(layout)
    expect(canvasLayout([a, b], "wide").map(item => [item.y, item.h])).toEqual([[0, 5], [0, 5]])
  })

  it("reserves enough compact tracks for calendars, status lanes and paged tables", () => {
    const base = exampleDashboard.widgets[3]
    const plugin = (id: string, pluginId: string, config: NonNullable<Widget["config"]>, x: number, h: number): Widget => ({
      ...base, id, type: "plugin", pluginId, dataKind: "records", config, layout: { x, y: 0, w: 3, h },
    })
    const widgets = [plugin("calendar", "incident-calendar", {}, 0, 5), plugin("lanes", "status-history", { maxSeries: 6 }, 3, 5), plugin("table", "record-table", { pageSize: 10 }, 6, 6), plugin("small", "record-table", { pageSize: 5 }, 9, 5)]
    const layout = denseCanvasLayout(widgets, "wide")
    expect(layout.map(item => item.h)).toEqual([15, 15, 11, 15])
    expect(layout.every(item => item.maxH !== undefined && item.h <= item.maxH)).toBe(true)
    expect(layout.map(item => item.y)).toEqual([0, 0, 0, 0])
    // Very short saved widgets remain intentionally short and scrollable.
    expect(denseCanvasLayout([plugin("small-calendar", "incident-calendar", {}, 0, 3)], "wide")[0].h).toBe(7)
  })

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

  it("preserves a single-row stat in every layout without relaxing non-stat resize bounds", () => {
    const stat = { ...exampleDashboard.widgets[0], type: "stat" as const, layout: { x: 0, y: 0, w: 4, h: 1 } }
    const graph = { ...exampleDashboard.widgets[3], layout: { x: 4, y: 0, w: 8, h: 2 } }
    for (const mode of ["wide", "compact", "stacked"] as const) {
      const [kpi, chart] = canvasLayout([stat, graph], mode)
      expect(kpi).toMatchObject({ h: mode === "stacked" ? 2 : 1, minH: 1 })
      expect(chart.minH).toBe(2)
    }
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

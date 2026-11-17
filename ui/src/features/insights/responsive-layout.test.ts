import { describe, expect, it } from "vitest"
import { builderPanelPlan, canvasLayout, canvasMode, denseCanvasLayout, intrinsicStat } from "./responsive-layout"
import { exampleDashboard } from "./example"
import type { Widget } from "./schema"

describe("responsive canvas projection", () => {
  it("honours registered reading heights in compact projections without editing saved placement", () => {
    const base = exampleDashboard.widgets[0]
    const widgets: Widget[] = [
      { ...base, id: "map", type: "plugin", pluginId: "geo-heatmap", layout: { x: 0, y: 0, w: 6, h: 4 } },
      { ...base, id: "table", type: "plugin", pluginId: "record-table", layout: { x: 6, y: 0, w: 6, h: 4 } },
      { ...base, id: "below", type: "timeseries", layout: { x: 0, y: 4, w: 12, h: 4 } },
    ]
    const before = JSON.stringify(widgets), heights = new Map([["map", 320], ["table", 240]])
    const dense = denseCanvasLayout(widgets, "wide", 1200, true, heights)
    expect(dense[0].h * 29 - 4).toBeGreaterThanOrEqual(320)
    expect(dense[1].h).toBe(dense[0].h)
    expect(dense[2].y).toBeGreaterThanOrEqual(dense[0].y + dense[0].h)
    expect(canvasLayout(widgets, "stacked", 390, heights)[0].h * 74 - 16).toBeGreaterThanOrEqual(320)
    expect(canvasLayout(widgets, "wide", 1200, heights)[0].h).toBe(4)
    expect(JSON.stringify(widgets)).toBe(before)
  })
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
    expect(intrinsicStat({ ...base, options: { showSparkline: true } })).toBe(true)
    for (const widget of [
      { ...base, description: "Context" },
      { ...base, layout: { ...base.layout, h: 3 } },
      { ...base, layout: { ...base.layout, h: 3 }, options: { showSparkline: true } },
      { ...base, drilldowns: [{ id: "details", title: "Details", dashboardId: "target" }] },
      { ...base, selectionBindings: [{ variable: "service", source: "label" as const, value: "service" }] },
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

  it("bounds reference-only month and six-lane density without changing ordinary or narrow layouts", () => {
    const base = exampleDashboard.widgets[3]
    const month: Widget = { ...base, id: "month", type: "plugin", pluginId: "incident-calendar", config: { months: 1 }, layout: { x: 8, y: 6, w: 4, h: 4 } }
    const lanes: Widget = { ...base, id: "lanes", type: "plugin", pluginId: "status-history", config: { maxSeries: 6 }, layout: { x: 0, y: 6, w: 8, h: 4 } }
    const records: Widget = { ...base, id: "records", type: "plugin", pluginId: "record-table", config: { pageSize: 5 }, layout: { x: 0, y: 10, w: 12, h: 4 } }
    const widgets = [month, lanes, records]
    const before = structuredClone(widgets)
    const ordinary = denseCanvasLayout(widgets, "wide", 1100)
    const reference = denseCanvasLayout(widgets, "wide", 1100, true)
    expect(reference.filter(item => item.i !== "records").map(item => item.h)).toEqual([11, 11])
    expect(ordinary.filter(item => item.i !== "records").every(item => item.h >= 14)).toBe(true)
    expect(reference.find(item => item.i === "records")!.y).toBeLessThan(ordinary.find(item => item.i === "records")!.y)
    expect(denseCanvasLayout(widgets, "wide", 1100, false)).toEqual(ordinary)
    expect(denseCanvasLayout(widgets, "compact", 800, true)).toEqual(canvasLayout(widgets, "compact", 800))
    expect(widgets).toEqual(before)
    for (const [index, a] of reference.entries()) for (const b of reference.slice(index + 1)) {
      expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false)
    }
    // Larger inventories keep the ordinary tall-content protection.
    const manyMonths = { ...month, config: { months: 3 } }
    const manyLanes = { ...lanes, config: { maxSeries: 20 } }
    expect(denseCanvasLayout([manyMonths, manyLanes], "wide", 1100, true)).toEqual(denseCanvasLayout([manyMonths, manyLanes], "wide", 1100))
  })

  it("reflows by available canvas width, including space taken by the inspector", () => {
    expect([320, 599, 600, 959, 960, 2400].map(width => canvasMode(width))).toEqual([
      "stacked", "stacked", "compact", "compact", "wide", "wide",
    ])
  })

  it("keeps the wide grid between 880 and 960px once it is shown, so a narrowing panel cannot flip it", () => {
    // Entering the wide grid needs the return threshold; leaving it happens only below the lower one.
    expect([879, 880, 900, 959, 960].map(width => canvasMode(width, "compact"))).toEqual(["compact", "compact", "compact", "compact", "wide"])
    expect([879, 880, 900, 959, 960].map(width => canvasMode(width, "wide"))).toEqual(["compact", "wide", "wide", "wide", "wide"])
    // Narrow widths keep their own boundary whichever mode came before.
    expect([599, 600].map(width => canvasMode(width, "stacked"))).toEqual(["stacked", "compact"])
    expect([599, 600].map(width => canvasMode(width, "wide"))).toEqual(["stacked", "compact"])
  })

  it("does not oscillate when widths hover across the band", () => {
    const seen = (widths: number[], start: "wide" | "compact") => widths.reduce<string[]>((modes, width) => {
      modes.push(canvasMode(width, (modes.at(-1) as "wide" | "compact" | undefined) ?? start))
      return modes
    }, [])
    // A panel that toggles the canvas between 930 and 880 px keeps whichever mode it started in.
    expect(seen([930, 880, 930, 878, 930], "wide")).toEqual(["wide", "wide", "wide", "compact", "compact"])
    expect(seen([930, 960, 930, 880], "compact")).toEqual(["compact", "wide", "wide", "wide"])
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

describe("builder panels beside the canvas", () => {
  // Measured the way the app sees it: the canvas, the open panel and the sidebar as currently rendered.
  // Viewport 1512 with the sidebar open and no panel: canvas 1272 (192 sidebar and 48 gutters).
  const sidebarOpen = { sidebarWidth: 192, openSidebarWidth: 192 }
  const request = (wide: boolean) => ({ wide, sidebarCollapsible: true, sidebarPreferred: true })

  it("keeps the sidebar for a standard panel while the canvas stays wide", () => {
    // Manage at 1512 leaves a 930px canvas beside the open sidebar, which is above the leave threshold.
    expect(builderPanelPlan({ canvasWidth: 1272, panelWidth: 0, ...sidebarOpen }, request(false))).toEqual({ collapsed: false, widePanel: false })
  })

  it("collapses the sidebar for the wide Code panel at 1512 and keeps the wide Code panel", () => {
    // Canvas 1272 at 1512 with the sidebar open and no panel: 832px with the sidebar and a 440px panel, 1024px without the sidebar.
    expect(builderPanelPlan({ canvasWidth: 1272, panelWidth: 0, ...sidebarOpen }, request(true))).toEqual({ collapsed: true, widePanel: true })
  })

  it("narrows the Code panel to the standard width at 1280, collapsing the sidebar to fit", () => {
    // Canvas 1040 at 1280 with the sidebar open and no panel. A 440px panel leaves 792px even with the sidebar collapsed,
    // short of 880px, so the standard panel is used and the sidebar collapses to keep the wide grid.
    expect(builderPanelPlan({ canvasWidth: 1040, panelWidth: 0, ...sidebarOpen }, request(true))).toEqual({ collapsed: true, widePanel: false })
  })

  it("restores the sidebar when a hidden sidebar can be shown again without leaving the wide grid", () => {
    // Switching from a collapsed Code panel at 1512 to Manage: 1024px canvas with a 440px panel, no sidebar.
    const fromCode = { canvasWidth: 1024, panelWidth: 440, sidebarWidth: 0, openSidebarWidth: 192 }
    expect(builderPanelPlan(fromCode, request(false))).toEqual({ collapsed: false, widePanel: false })
  })

  it("never reopens a sidebar the user closed, and never reports it as collapsed for the panel", () => {
    // Manage at 1512 would keep the wide grid with the sidebar open, but the user closed it, so it stays closed.
    const closed = { canvasWidth: 1464, panelWidth: 0, sidebarWidth: 0, openSidebarWidth: 192 }
    expect(builderPanelPlan(closed, { wide: false, sidebarCollapsible: true, sidebarPreferred: false })).toEqual({ collapsed: false, widePanel: false })
  })

  it("leaves a non-collapsible sidebar alone and still chooses the panel width from the room", () => {
    // 1500px with the 60px rail and no panel: the canvas is 1392px, and the Code panel leaves 952px beside the rail.
    const rail = { canvasWidth: 1500 - 60 - 48, panelWidth: 0, sidebarWidth: 60, openSidebarWidth: 60 }
    expect(builderPanelPlan(rail, { wide: true, sidebarCollapsible: false, sidebarPreferred: true })).toEqual({ collapsed: false, widePanel: true })
  })

  it("falls back to the user's sidebar and the standard panel when no layout keeps the wide grid", () => {
    // 1269px: the Code panel would leave 589px, the standard one 687px. The sidebar is not collapsed for a compact canvas.
    expect(builderPanelPlan({ canvasWidth: 1269 - 240, panelWidth: 0, ...sidebarOpen }, request(true))).toEqual({ collapsed: false, widePanel: false })
  })

  it("places the wide-grid thresholds at the viewports the panels need", () => {
    // Viewport with the sidebar open and no panel, as the app measures it: canvas = viewport - 192 - 48.
    const plan = (viewport: number, wide: boolean) => builderPanelPlan({ canvasWidth: viewport - 240, panelWidth: 0, ...sidebarOpen }, request(wide))
    // The canvas after the plan, at its real panel width. The panel is 440px only when that width fits.
    const outcome = (viewport: number, wide: boolean) => {
      const { collapsed, widePanel } = plan(viewport, wide)
      const panel = widePanel ? 440 : 342
      return { panel, canvas: viewport - 48 - panel - (collapsed ? 0 : 192) }
    }
    const firstWide = (wide: boolean, panel?: number) => {
      for (let viewport = 1000; viewport <= 1700; viewport++) {
        const result = outcome(viewport, wide)
        if (result.canvas >= 880 && (panel === undefined || result.panel === panel)) return viewport
      }
      return undefined
    }
    // Manage and AI: the standard panel keeps the wide grid from 1270px, with the sidebar collapsed.
    expect(firstWide(false)).toBe(1270)
    expect(outcome(1269, false).canvas).toBeLessThan(880)
    // Code: the wide panel needs 1368px. Between 1270 and 1367 it narrows to the standard width and stays wide.
    expect(firstWide(true, 440)).toBe(1368)
    expect(firstWide(true)).toBe(1270)
    expect(outcome(1280, true)).toEqual({ panel: 342, canvas: 890 })
    expect(outcome(1512, true)).toEqual({ panel: 440, canvas: 1024 })
  })
})

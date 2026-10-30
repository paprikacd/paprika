import type { Layout } from "react-grid-layout"
import type { Widget } from "./schema"

export type CanvasMode = "wide" | "compact" | "stacked"

export function canvasMode(width: number): CanvasMode {
  return width >= 960 ? "wide" : width >= 600 ? "compact" : "stacked"
}

/** Only ordinary short statistics use intrinsic reading height on phones.
 * Extra result series and freshness notices expand naturally; richer authored
 * presentations retain their original space. */
export function intrinsicStat(widget: Widget): boolean {
  return widget.type === "stat" && widget.layout.h <= 2 && !widget.description &&
    !widget.options?.showSparkline && !widget.options?.showStatBar &&
    !widget.drilldowns?.length && !widget.selectionBindings?.length
}

/** Responsive views are projections of the saved layout, never document edits. */
export function canvasLayout(widgets: readonly Widget[], mode: CanvasMode, width?: number): Layout {
  const ordered = [...widgets].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
  // Fit a contiguous metric group into balanced rows when every card has
  // at least ~270px. Do not leave one metric stranded after a three-up row.
  // This is measured canvas width, not viewport width or saved geometry.
  const metricWidths = new Map<string, number>()
  if (mode === "compact" && width !== undefined && width >= 840) {
    for (let start = 0; start < ordered.length;) {
      if (ordered[start].type !== "stat") { start++; continue }
      let end = start
      while (end < ordered.length && ordered[end].type === "stat") end++
      let remaining = end - start
      let rows = Math.ceil(remaining / 3)
      let cursor = start
      while (rows > 0) {
        const columns = Math.ceil(remaining / rows)
        for (let column = 0; column < columns; column++) metricWidths.set(ordered[cursor++].id, 12 / columns)
        remaining -= columns
        rows--
      }
      start = end
    }
  }
  let x = 0
  let y = 0
  let rowHeight = 0
  return ordered.map((widget) => {
    let position = { ...widget.layout }
    if (mode !== "wide") {
      const small = widget.type === "stat" || (widget.type === "plugin" && widget.layout.w <= 4)
      const w = metricWidths.get(widget.id) ?? (mode === "compact" && small ? 6 : 12)
      const heatmapText = widget.type === "heatmap" &&
        (widget.options?.showLabels !== false || widget.options?.showValues !== false)
      // On narrow canvases a statistics table sits below the plot. Reserve a
      // fifth track so ordinary four-series legends and the chart both remain
      // legible; this is a view projection and never changes the saved layout.
      const statisticsLegend = widget.type === "plugin" &&
        ["stacked-timeseries", "directional-traffic"].includes(widget.pluginId ?? "") &&
        widget.config?.legendDisplay === "table"
      // Sparkline rows are taller than text rows and narrow tables also need
      // space for a horizontal-scroll hint. Keep their contents reachable
      // without changing the authored desktop layout.
      const sparklineTable = widget.type === "plugin" && widget.pluginId === "record-table" &&
        Array.isArray(widget.config?.cellStyles) && widget.config.cellStyles.some(style =>
          typeof style === "object" && style !== null && "display" in style && style.display === "sparkline")
      const minimumHeight = widget.type === "stat" ? mode === "stacked" ? 2 : 1 : heatmapText ? mode === "compact" ? 5 : 6 : statisticsLegend || sparklineTable ? 5 : 4
      const h = Math.max(minimumHeight, widget.layout.h)
      if (x + w > 12 || (metricWidths.has(widget.id) && x > 0 && x % w !== 0)) {
        y += rowHeight
        x = 0
        rowHeight = 0
      }
      position = { x, y, w, h }
      x += w
      rowHeight = Math.max(rowHeight, h)
    }
    return { i: widget.id, ...position, minW: 1, maxW: 12, minH: widget.type === "stat" ? 1 : 2, maxH: 12 }
  })
}

/** A viewing-only projection for dense operational boards. Horizontal
 * placement and reading order stay intact; earlier overlapping columns always
 * finish before later rows. Saved layouts and the editor are never mutated. */
export function denseCanvasLayout(widgets: readonly Widget[], mode: CanvasMode, width?: number): Layout {
  const standard = canvasLayout(widgets, mode, width)
  if (mode !== "wide") return standard
  const byId = new Map(widgets.map(widget => [widget.id, widget]))
  const heightFor = (item: Layout[number]) => {
    const widget = byId.get(item.i)!
    // Plots and record tables need room for axes, legends and rows. Never
    // shrink them below four tracks when their saved size allows it.
    const needsReadingRoom = widget.type === "timeseries" || widget.type === "bar" || widget.type === "table" ||
      (widget.type === "plugin" && ["stacked-timeseries", "directional-traffic", "record-table"].includes(widget.pluginId ?? ""))
    // Dense calendar grids and status lanes have their own intrinsic height;
    // compressing them to a few tracks hides observations behind the footer.
    const calendar = widget.type === "plugin" && ["incident-calendar", "uptime-calendar"].includes(widget.pluginId ?? "")
    const needsTallContent = calendar || (widget.type === "plugin" && widget.pluginId === "status-history")
    const pageSize = widget.type === "plugin" && widget.pluginId === "record-table" &&
      typeof widget.config?.pageSize === "number" ? widget.config.pageSize : 5
    const minimum = needsTallContent || (widget.type === "plugin" && widget.pluginId === "record-table" && pageSize > 7) ? 5 : needsReadingRoom ? 4 : 2
    if (widget.type === "stat") return item.h
    // Five-row calendar panels need one extra compact track for a six-week
    // month. This is a temporary view projection, not a document edit.
    if (calendar && item.h >= 5) return Math.max(6, Math.round(item.h * 2 / 3))
    return Math.min(item.h, Math.max(minimum, Math.round(item.h * 2 / 3)))
  }
  // Panels deliberately aligned in the saved grid remain aligned in compact
  // mode, even when one type needs more room for its legend or table rows.
  const groupHeights = new Map<string, number>()
  for (const item of standard) {
    const group = `${item.y}:${item.h}`
    groupHeights.set(group, Math.max(groupHeights.get(group) ?? 0, heightFor(item)))
  }
  const placed: Layout[number][] = []
  for (const item of standard) {
    const h = groupHeights.get(`${item.y}:${item.h}`)!
    let y = Math.round(item.y * 2 / 3)
    for (const earlier of placed) {
      if (earlier.x < item.x + item.w && earlier.x + earlier.w > item.x)
        y = Math.max(y, earlier.y + earlier.h)
    }
    placed.push({ ...item, y, h })
  }
  // A finer grid keeps single-row statistics at their original readable
  // height while allowing plots to use intermediate heights. Tall calendars
  // and ten-row tables retain their previous physical reading room.
  const needsPlotRoom = (widget: Widget) => widget.type === "timeseries" || widget.type === "bar" ||
    (widget.type === "plugin" && ["stacked-timeseries", "directional-traffic"].includes(widget.pluginId ?? ""))
  const fineHeight = (item: Layout[number]) => {
    const widget = byId.get(item.i)!
    const tall = widget.type === "plugin" && (["incident-calendar", "uptime-calendar", "status-history"].includes(widget.pluginId ?? "") ||
      (widget.pluginId === "record-table" && typeof widget.config?.pageSize === "number" && widget.config.pageSize > 7))
    const calendar = widget.type === "plugin" && ["incident-calendar", "uptime-calendar"].includes(widget.pluginId ?? "")
    // Preserve the physical space for multi-week calendars and status lanes
    // on the finer compact grid; ordinary plots and tables can be denser.
    const protectedTall = tall && !(widget.pluginId === "record-table")
    return widget.type === "stat" ? item.h * 2 : Math.max(calendar && item.h >= 6 ? 15 : needsPlotRoom(widget) ? 8 : 0, Math.ceil(item.h * (protectedTall ? 2.3 : tall ? 2.2 : 1.55)))
  }
  const fineGroups = new Map<string, number>()
  for (const item of placed) {
    const group = `${item.y}:${item.h}`
    fineGroups.set(group, Math.max(fineGroups.get(group) ?? 0, fineHeight(item)))
  }
  const fine: Layout[number][] = []
  for (const item of placed) {
    const h = fineGroups.get(`${item.y}:${item.h}`)!
    let y = Math.round(item.y * 1.7)
    for (const earlier of fine) {
      if (earlier.x < item.x + item.w && earlier.x + earlier.w > item.x)
        y = Math.max(y, earlier.y + earlier.h)
    }
    fine.push({ ...item, y, h, maxH: Math.max(item.maxH ?? 0, h) })
  }
  return fine
}

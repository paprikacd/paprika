import type { Layout } from "react-grid-layout"
import type { Widget } from "./schema"

export type CanvasMode = "wide" | "compact" | "stacked"

/** A canvas enters the wide grid at 960px and keeps it down to 880px. The gap stops a panel or a scrollbar that
 * narrows the canvas by a few pixels from flipping the projection back and forth. */
export const WIDE_RETURN_WIDTH = 960
export const WIDE_LEAVE_WIDTH = 880

/** Side panels as laid out at widths above 1200px: the standard builder panel and the wide Code or Examples panel. */
export const STANDARD_PANEL_WIDTH = 342
export const WIDE_PANEL_WIDTH = 440

/** `previous` is the mode the canvas already shows. Without it, the wide grid starts at the return threshold. */
export function canvasMode(width: number, previous?: CanvasMode): CanvasMode {
  const wide = previous === "wide" ? width >= WIDE_LEAVE_WIDTH : width >= WIDE_RETURN_WIDTH
  return wide ? "wide" : width >= 600 ? "compact" : "stacked"
}

export interface BuilderPanelMeasure {
  /** The canvas as it is now, with the sidebar and any open panel as currently rendered. */
  canvasWidth: number
  /** The rendered panel, or 0 when none is open. */
  panelWidth: number
  /** The rendered sidebar, or 0 when it is hidden. */
  sidebarWidth: number
  /** The width the sidebar takes when it is open, for a sidebar that is hidden now. */
  openSidebarWidth: number
}

export interface BuilderPanelRequest {
  /** The panel wants the wide variant (Code and Examples). */
  wide: boolean
  /** Whether the sidebar can collapse. The mobile drawer and the compact rail cannot. */
  sidebarCollapsible: boolean
  /** The user's sidebar preference. A hidden sidebar is restored only when this is true. */
  sidebarPreferred: boolean
}

export interface BuilderPanelPlan {
  /** The sidebar is hidden for this panel only, and comes back when the panel closes. */
  collapsed: boolean
  /** Use the wide Code or Examples width. */
  widePanel: boolean
}

/**
 * Chooses the sidebar and panel width that keep the canvas wide, if any combination does. The space the canvas and
 * its neighbours share is measured, so the gutters need no constants. Candidates are tried widest panel first, and
 * an open sidebar is kept before it is collapsed. When nothing keeps the wide grid, the sidebar keeps the user's
 * preference and the standard panel gives the canvas the most room; collapsing for a compact canvas is not needed.
 */
export function builderPanelPlan(measure: BuilderPanelMeasure, request: BuilderPanelRequest): BuilderPanelPlan {
  const room = measure.canvasWidth + measure.panelWidth + measure.sidebarWidth
  const sidebar: Array<{ collapsed: boolean; width: number }> = !request.sidebarCollapsible
    ? [{ collapsed: false, width: measure.sidebarWidth }]
    : request.sidebarPreferred
      ? [{ collapsed: false, width: measure.sidebarWidth || measure.openSidebarWidth }, { collapsed: true, width: 0 }]
      : [{ collapsed: true, width: 0 }]
  const panels = request.wide ? [WIDE_PANEL_WIDTH, STANDARD_PANEL_WIDTH] : [STANDARD_PANEL_WIDTH]
  for (const panel of panels) {
    for (const option of sidebar) {
      if (room - option.width - panel >= WIDE_LEAVE_WIDTH) return { collapsed: option.collapsed && request.sidebarPreferred, widePanel: panel === WIDE_PANEL_WIDTH }
    }
  }
  return { collapsed: false, widePanel: false }
}

/** Only ordinary short statistics use intrinsic reading height on phones.
 * Extra result series and freshness notices expand naturally; richer authored
 * presentations retain their original space. */
export function intrinsicStat(widget: Widget): boolean {
  return widget.type === "stat" && widget.layout.h <= 2 && !widget.description &&
    !widget.options?.showStatBar &&
    !widget.drilldowns?.length && !widget.selectionBindings?.length
}

/** Responsive views are projections of the saved layout, never document edits. */
export function canvasLayout(widgets: readonly Widget[], mode: CanvasMode, width?: number, minimumHeights?: ReadonlyMap<string, number>): Layout {
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
      const h = Math.max(minimumHeight, widget.layout.h, Math.ceil(((minimumHeights?.get(widget.id) ?? 0) + 16) / 74))
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
export function denseCanvasLayout(widgets: readonly Widget[], mode: CanvasMode, width?: number, referenceCompact = false, minimumHeights?: ReadonlyMap<string, number>): Layout {
  const standard = canvasLayout(widgets, mode, width, minimumHeights)
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
    // Fine-pointer dark reference view has 24px calendar targets and lanes.
    // Reserve a complete six-week month, but never compress multi-month views
    // or long state inventories using this bounded one-month/six-lane rule.
    if (referenceCompact && widget.type === "plugin") {
      if (widget.pluginId === "incident-calendar" && widget.config?.months === 1) return 11
      if (widget.pluginId === "status-history" && typeof widget.config?.maxSeries === "number" && widget.config.maxSeries <= 6) return 8
    }
    const tall = widget.type === "plugin" && (["incident-calendar", "uptime-calendar", "status-history"].includes(widget.pluginId ?? "") ||
      (widget.pluginId === "record-table" && typeof widget.config?.pageSize === "number" && widget.config.pageSize > 7))
    const calendar = widget.type === "plugin" && ["incident-calendar", "uptime-calendar"].includes(widget.pluginId ?? "")
    // Preserve the physical space for multi-week calendars and status lanes
    // on the finer compact grid; ordinary plots and tables can be denser.
    const protectedTall = tall && !(widget.pluginId === "record-table")
    return widget.type === "stat" ? item.h * 2 : Math.max(calendar && item.h >= 4 ? item.h >= 6 ? 15 : 14 : needsPlotRoom(widget) ? 8 : 0, Math.ceil(item.h * (protectedTall ? 2.3 : tall ? 2.2 : 1.55)))
  }
  const fineGroups = new Map<string, number>()
  for (const item of placed) {
    const group = `${item.y}:${item.h}`
    // The renderer declares its useful card height once. Compact viewing must
    // not silently compress a map or readable table beneath that contract.
    const minimum = Math.ceil(((minimumHeights?.get(item.i) ?? 0) + 4) / 29)
    fineGroups.set(group, Math.max(fineGroups.get(group) ?? 0, fineHeight(item), minimum))
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

import type { Layout } from "react-grid-layout"
import type { Widget } from "./schema"
import { columnWidth, gridOf, pixelsToRows, rowsToPixels } from "./grid-geometry"
import type { DenseRoom } from "./widget-registry"

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

/**
 * What a plugin tells the projections about its rows. Built-in widgets are decided by type; plugins declare these
 * through their sizing contract, and the host resolves them with layoutHintsOf. This module never reads a plugin id.
 */
export interface LayoutHints {
  room?: DenseRoom
  narrowMinRows?: number
  referenceFineRows?: number
}

/** Responsive views are projections of the saved layout, never document edits. */
export function canvasLayout(widgets: readonly Widget[], mode: CanvasMode, width?: number, minimumHeights?: ReadonlyMap<string, number>, hints?: ReadonlyMap<string, LayoutHints>): Layout {
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
  // Half-width cards in a compact projection are stats outside the balanced
  // metric groups and short plugin cards (saved w <= 4). Consecutive half-width
  // cards in reading order share a row, so a stat and a gauge pair the way two
  // stats do. A short plugin with no half-width card after it takes the full
  // width rather than leaving blank space beside it. An unpaired stat keeps its
  // half-width rule. Cards that are not half-width break the run.
  const halfWidths = new Map<string, number>()
  if (mode === "compact") {
    const half = (widget: Widget | undefined) => widget !== undefined && !metricWidths.has(widget.id) &&
      (widget.type === "stat" || (widget.type === "plugin" && widget.layout.w <= 4))
    for (let i = 0; i < ordered.length; i++) {
      const widget = ordered[i]
      if (!half(widget)) continue
      if (half(ordered[i + 1])) {
        halfWidths.set(widget.id, 6)
        halfWidths.set(ordered[++i].id, 6)
      } else {
        halfWidths.set(widget.id, widget.type === "stat" ? 6 : 12)
      }
    }
  }
  let x = 0
  let y = 0
  let rowHeight = 0
  return ordered.map((widget) => {
    let position = { ...widget.layout }
    if (mode !== "wide") {
      const w = metricWidths.get(widget.id) ?? halfWidths.get(widget.id) ?? 12
      const heatmapText = widget.type === "heatmap" &&
        (widget.options?.showLabels !== false || widget.options?.showValues !== false)
      // A plugin's narrow minimum (a statistics table under a plot, a sparkline table) reserves a fifth track. This is a
      // view projection and never changes the saved layout.
      const minimumHeight = widget.type === "stat" ? mode === "stacked" ? 2 : 1 : heatmapText ? mode === "compact" ? 5 : 6 : hints?.get(widget.id)?.narrowMinRows ?? 4
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
/** The rule each dense room applies. `minimum` is the fewest tracks a coarse projection keeps; `fine` and `floor` shape
 * the finer grid. Plots keep a floor of eight tracks there; calendars keep their six-week months. */
interface RoomRule {
  minimum: number
  fine: number
  floor(rows: number): number
  coarse?(rows: number): number
}
const ROOMS: Record<DenseRoom | "none", RoomRule> = {
  none: { minimum: 2, fine: 1.55, floor: () => 0 },
  plot: { minimum: 4, fine: 1.55, floor: () => 8 },
  reading: { minimum: 4, fine: 1.55, floor: () => 0 },
  tall: { minimum: 5, fine: 2.3, floor: () => 0 },
  "tall-table": { minimum: 5, fine: 2.2, floor: () => 0 },
  // Five-row calendar panels need one extra compact track for a six-week month. This is a view projection, not an edit.
  calendar: {
    minimum: 5,
    fine: 2.3,
    floor: rows => rows >= 6 ? 15 : rows >= 4 ? 14 : 0,
    coarse: rows => rows >= 5 ? Math.max(6, Math.round(rows * 2 / 3)) : Math.min(rows, Math.max(5, Math.round(rows * 2 / 3))),
  },
}

/** The room a widget projects into. Built-in types are decided here; plugins name theirs through the host hints. */
function roomOf(widget: Widget, hints: ReadonlyMap<string, LayoutHints> | undefined): DenseRoom | "none" {
  if (widget.type === "timeseries" || widget.type === "bar") return "plot"
  if (widget.type === "table") return "reading"
  return hints?.get(widget.id)?.room ?? "none"
}

/** A viewing-only projection for dense operational boards. Horizontal
 * placement and reading order stay intact; earlier overlapping columns always
 * finish before later rows. Saved layouts and the editor are never mutated. */
export function denseCanvasLayout(widgets: readonly Widget[], mode: CanvasMode, width?: number, referenceCompact = false, minimumHeights?: ReadonlyMap<string, number>, hints?: ReadonlyMap<string, LayoutHints>): Layout {
  const standard = canvasLayout(widgets, mode, width, minimumHeights, hints)
  if (mode !== "wide") return standard
  const byId = new Map(widgets.map(widget => [widget.id, widget]))
  const heightFor = (item: Layout[number]) => {
    const widget = byId.get(item.i)!
    if (widget.type === "stat") return item.h
    const rule = ROOMS[roomOf(widget, hints)]
    return rule.coarse ? rule.coarse(item.h) : Math.min(item.h, Math.max(rule.minimum, Math.round(item.h * 2 / 3)))
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
  const fineHeight = (item: Layout[number]) => {
    const widget = byId.get(item.i)!
    // The reference compact view reserves a fixed track count for a few bounded configurations, such as one month of
    // calendar or a short status list. The room's rule still applies everywhere else.
    if (referenceCompact) {
      const fixed = hints?.get(widget.id)?.referenceFineRows
      if (fixed !== undefined) return fixed
    }
    if (widget.type === "stat") return item.h * 2
    const rule = ROOMS[roomOf(widget, hints)]
    return Math.max(rule.floor(item.h), Math.ceil(item.h * rule.fine))
  }
  const fineGroups = new Map<string, number>()
  for (const item of placed) {
    const group = `${item.y}:${item.h}`
    // The renderer declares its useful card height once. Compact viewing must
    // not silently compress a map or readable table beneath that contract.
    const minimum = pixelsToRows(minimumHeights?.get(item.i) ?? 0, true)
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

/** The pixel size one tile takes on the canvas it was measured for. */
export interface TileFootprint {
  width: number
  height: number
}

export interface TileFootprintOptions {
  mode: CanvasMode
  /** The canvas width the projection was computed for, in pixels. Zero or less has no footprint. */
  width: number
  /** The dense viewing projection (25px rows, 8 by 4 gaps), which applies only in the wide grid. */
  dense?: boolean
  referenceCompact?: boolean
  minimumHeights?: ReadonlyMap<string, number>
  /** The plugin hints for the widgets, from layoutHintsOf. Without them plugin widgets take the default room. */
  hints?: ReadonlyMap<string, LayoutHints>
}

/**
 * The pixel box a tile occupies on a canvas of the given width and projection, from the same layout the canvas renders.
 * It takes the grid's column width and row pitch as react-grid-layout computes them, so a footprint matches the tile on
 * screen. Undefined when the width is unknown or the widget is not in the projection.
 */
export function tileFootprint(widgets: readonly Widget[], id: string, options: TileFootprintOptions): TileFootprint | undefined {
  if (!(options.width > 0)) return undefined
  const dense = !!options.dense && options.mode === "wide"
  const layout = dense
    ? denseCanvasLayout(widgets, options.mode, options.width, options.referenceCompact, options.minimumHeights, options.hints)
    : canvasLayout(widgets, options.mode, options.width, options.minimumHeights, options.hints)
  const item = layout.find(entry => entry.i === id)
  if (!item) return undefined
  const { gapX } = gridOf(dense)
  const span = rowsToPixels(item.h, dense)
  // The wide grid draws the saved height as it is, so the footprint does too. The compact projection already counts a
  // renderer's minimum in its rows; the guard keeps that minimum for any caller that passes one without those rows.
  const height = options.mode === "wide" ? span : Math.max(span, options.minimumHeights?.get(id) ?? 0)
  return {
    width: item.w * columnWidth(options.width, dense) + (item.w - 1) * gapX,
    height,
  }
}


import { verticalCompactor } from "react-grid-layout"

import { dashboardSchema, type Dashboard } from "./schema"

/** The desktop canvas's column count. Saved layouts are authored on this grid. */
export const CANVAS_COLUMNS = 12

export type GridBox = { x: number; y: number; w: number; h: number }
export type CompactItem = GridBox & { i: string }

/**
 * The positions the desktop canvas draws for stored boxes. The canvas settles every render through react-grid-layout's
 * vertical compactor: an item rises as far as it can, and an item that collides with one above is pushed below it.
 * This is that compactor, so the result is the layout as drawn. The Go lint has a port of the same algorithm, and the
 * parity fixtures in docs/design/insights/conformance/layout-compaction.json keep the two equal.
 */
export function compactBoxes(items: readonly CompactItem[]): CompactItem[] {
  return verticalCompactor.compact(items.map(item => ({ ...item })), CANVAS_COLUMNS).map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))
}

/**
 * The dashboard exactly as a save writes it: parsed against the schema, with each widget at the position the canvas
 * draws. Every place that stores a dashboard after a save uses this, so the document kept in memory and the one on the
 * server are the same, and a re-review of the same layout compares equal.
 */
export function dashboardAsSent(input: unknown): Dashboard {
  return compactDashboardLayout(dashboardSchema.parse(input))
}

/**
 * A dashboard whose widget positions are the ones the canvas draws. Everything except each widget's layout is returned
 * unchanged, so a save sends the drawn geometry and the same document otherwise. A dashboard with no overlap and no
 * gap that the canvas would close comes back with the same positions.
 */
export function compactDashboardLayout<T extends { widgets: readonly { id: string; layout: GridBox }[] }>(dashboard: T): T {
  const drawn = new Map(compactBoxes(dashboard.widgets.map(widget => ({ i: widget.id, ...widget.layout }))).map(item => [item.i, item]))
  return {
    ...dashboard,
    widgets: dashboard.widgets.map(widget => {
      const item = drawn.get(widget.id)
      return item ? { ...widget, layout: { x: item.x, y: item.y, w: item.w, h: item.h } } : widget
    }),
  }
}

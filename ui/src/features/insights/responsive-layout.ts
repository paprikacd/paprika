import type { Layout } from "react-grid-layout"
import type { Widget } from "./schema"

export type CanvasMode = "wide" | "compact" | "stacked"

export function canvasMode(width: number): CanvasMode {
  return width >= 960 ? "wide" : width >= 600 ? "compact" : "stacked"
}

/** Responsive views are projections of the saved layout, never document edits. */
export function canvasLayout(widgets: readonly Widget[], mode: CanvasMode): Layout {
  const ordered = [...widgets].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
  let x = 0
  let y = 0
  let rowHeight = 0
  return ordered.map((widget) => {
    let position = { ...widget.layout }
    if (mode !== "wide") {
      const small = widget.type === "stat" || (widget.type === "plugin" && widget.layout.w <= 4)
      const w = mode === "compact" && small ? 6 : 12
      const heatmapText = widget.type === "heatmap" &&
        (widget.options?.showLabels !== false || widget.options?.showValues !== false)
      const minimumHeight = widget.type === "stat" ? 2 : heatmapText ? mode === "compact" ? 5 : 6 : 4
      const h = Math.max(minimumHeight, widget.layout.h)
      if (x + w > 12) {
        y += rowHeight
        x = 0
        rowHeight = 0
      }
      position = { x, y, w, h }
      x += w
      rowHeight = Math.max(rowHeight, h)
    }
    return { i: widget.id, ...position, minW: 1, maxW: 12, minH: 2, maxH: 12 }
  })
}

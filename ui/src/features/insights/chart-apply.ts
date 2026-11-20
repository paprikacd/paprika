import type { Dashboard, Widget } from "./schema"

/** A placement the chart editor staged for another tile, as the grid reports it. */
export type StagedPlacement = { i: string; x: number; y: number; w: number; h: number }

/**
 * The dashboard after a chart's draft is applied. The chart replaces its own tile, and the placements the editor
 * staged move the neighbours it pushed. Nothing is saved here, so a caller can save exactly the document it applied.
 */
export function applyChartToDashboard(
  dashboard: Dashboard,
  widget: Widget,
  layout?: readonly StagedPlacement[],
): Dashboard {
  return {
    ...dashboard,
    widgets: dashboard.widgets.map((item) => {
      if (item.id === widget.id) return widget
      const placed = layout?.find((entry) => entry.i === item.id)
      return placed
        ? { ...item, layout: { ...item.layout, x: placed.x, y: placed.y, w: placed.w, h: placed.h } }
        : item
    }),
  }
}

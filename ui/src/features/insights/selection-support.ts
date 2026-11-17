import type { Widget } from "./schema"

// These renderers emit a deliberate activation with an observation context.
// Keep the canvas and authoring control on the same capability boundary: a
// focus or hover callback from an arbitrary plugin must not change filters.
const selectablePlugins = new Set([
  "record-treemap", "record-table", "record-list", "record-matrix",
  "records-line", "records-bar", "pie", "status-history", "geo-heatmap", "connection-map",
])

export function supportsDashboardSelection(widget: Pick<Widget, "type" | "pluginId">) {
  return widget.type === "plugin" && selectablePlugins.has(widget.pluginId ?? "")
}

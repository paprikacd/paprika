import type { Widget } from "./schema"
import { pluginSupports } from "./plugins/plugin-capabilities"

// Built-in tables, heatmaps and traces activate only through onActivate, so focus never changes filters.
const selectableBuiltins = new Set<Widget["type"]>(["timeseries", "bar", "table", "heatmap", "traces"]);

// Plugins that emit a deliberate activation with an observation context are listed in the capability table. A focus or
// hover callback from any other plugin must not change filters.
export function supportsDashboardSelection(widget: Pick<Widget, "type" | "pluginId">) {
  if (widget.type !== "plugin") return selectableBuiltins.has(widget.type);
  return pluginSupports(widget.pluginId, "selection");
}

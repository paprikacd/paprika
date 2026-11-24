import type { LayoutHints } from "./responsive-layout";
import type { Widget } from "./schema";
import { getWidgetDefinition } from "./widget-registry";

/**
 * The layout hints each widget's plugin declares, keyed by widget id. Responsive projections stay pure: the canvas
 * resolves the hints once, memoised beside the minimum heights, and passes them in.
 */
export function layoutHintsOf(widgets: readonly Widget[]): Map<string, LayoutHints> {
  return new Map(widgets.map(widget => {
    const sizing = getWidgetDefinition(widget)?.sizing;
    const hints: LayoutHints = {};
    const room = sizing?.denseRoom?.(widget.config);
    if (room !== undefined) hints.room = room;
    const narrowMinRows = sizing?.narrowMinRows?.(widget.config);
    if (narrowMinRows !== undefined) hints.narrowMinRows = narrowMinRows;
    const referenceFineRows = sizing?.referenceFineRows?.(widget.config);
    if (referenceFineRows !== undefined) hints.referenceFineRows = referenceFineRows;
    return [widget.id, hints];
  }));
}

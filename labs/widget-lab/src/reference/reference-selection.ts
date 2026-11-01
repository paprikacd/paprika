/**
 * Inspection state for the authored reference charts. A selection is keyed by the
 * observation's exact timestamp and the source it describes, never by array position.
 */

export type ReferencePoint = { readonly timestamp: number };
/** The points a chart is showing, and the identity of the source they describe. */
export type ReferenceObservations = { readonly points: readonly ReferencePoint[]; readonly source: string };
export type ReferenceSelection = { readonly timestamp: number; readonly pinned: boolean; readonly source: string } | null;

/** Stable identity of a result's source. Labels such as the gateway or service change it. */
export function referenceSource(labels: Readonly<Record<string, string>> | undefined) {
  return Object.entries(labels ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('|');
}

/**
 * Applied when a result replaces the one on screen. Transient inspection and dismissals
 * are cleared, and nothing is re-pinned. An explicit pin survives only while its exact
 * timestamp still exists and it still describes the same source (UX-CONTRACT: resource
 * changes clear pins).
 */
export function selectionAfterResultChange(previous: ReferenceSelection, next: ReferenceObservations): ReferenceSelection {
  if (!previous?.pinned || previous.source !== next.source) return null;
  return next.points.some(point => point.timestamp === previous.timestamp) ? previous : null;
}

/** Index of the selected observation in the current points, or null when it is absent or outside the visible window. */
export function selectedObservationIndex(points: readonly ReferencePoint[], selection: ReferenceSelection, window: { readonly start: number; readonly end: number }): number | null {
  if (!selection) return null;
  const index = points.findIndex(point => point.timestamp === selection.timestamp);
  if (index < 0) return null;
  const timestamp = points[index].timestamp;
  return timestamp < window.start || timestamp > window.end ? null : index;
}

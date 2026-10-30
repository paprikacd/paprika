import type { Point } from "./chart-data";
import { validTimestamp } from "./widget-context";

/** Index actual observations, never the decimated drawing. Last input wins ties. */
export function statHistoryObservations(points: readonly Point[]): Point[] {
  const byTime = new Map<number, Point>();
  for (const point of points) {
    if (!validTimestamp(point.timestamp)) continue;
    byTime.set(point.timestamp, { timestamp: point.timestamp, value: typeof point.value === "number" && Number.isFinite(point.value) ? point.value : null });
  }
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** Ties prefer the later observation, matching latest-value duplicate semantics. */
export function nearestStatHistoryIndex(points: readonly Point[], timestamp: number): number {
  if (!points.length) return -1;
  let low = 0, high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low > 0 && timestamp - points[low - 1].timestamp < points[low].timestamp - timestamp ? low - 1 : low;
}

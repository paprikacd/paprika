/** A chart window is a local view over immutable observations, not a query range. */
export interface ChartTimeWindow { start: number; end: number }
export interface TimedObservation { timestamp: number; value: number | null }

export function timeWindowExtent(series: readonly { points: readonly TimedObservation[] }[]): ChartTimeWindow | null {
  let start = Infinity, end = -Infinity;
  for (const entry of series) for (const point of entry.points) {
    if (!Number.isFinite(point.timestamp)) continue;
    start = Math.min(start, point.timestamp); end = Math.max(end, point.timestamp);
  }
  return Number.isFinite(start) && end > start ? { start, end } : null;
}

/** Two source intervals, with a finite precision floor for exceptionally dense data. */
export function minimumTimeWindow(series: readonly { points: readonly TimedObservation[] }[], extent: ChartTimeWindow) {
  let cadence = Infinity;
  for (const entry of series) {
    const timestamps = [...new Set(entry.points.map(point => point.timestamp).filter(Number.isFinite))].sort((a, b) => a - b);
    for (let i = 1; i < timestamps.length; i++) cadence = Math.min(cadence, timestamps[i] - timestamps[i - 1]);
  }
  const span = extent.end - extent.start;
  return Math.min(span, Math.max(1, span / 10000, Number.isFinite(cadence) ? cadence * 2 : span));
}

export function normalizeTimeWindow(candidate: ChartTimeWindow, extent: ChartTimeWindow, minimumSpan = 1): ChartTimeWindow | null {
  if (![candidate.start, candidate.end, extent.start, extent.end, minimumSpan].every(Number.isFinite) || extent.end <= extent.start || minimumSpan <= 0) return null;
  const start = Math.max(extent.start, Math.min(extent.end, Math.round(Math.min(candidate.start, candidate.end))));
  const end = Math.max(extent.start, Math.min(extent.end, Math.round(Math.max(candidate.start, candidate.end))));
  return end - start >= minimumSpan ? { start, end } : null;
}

export function sameTimeWindow(a: ChartTimeWindow, b: ChartTimeWindow) { return a.start === b.start && a.end === b.end; }

export function timeWindowFromPixels(start: number, end: number, left: number, width: number, domain: ChartTimeWindow, minimumSpan = 1) {
  if (![start, end, left, width].every(Number.isFinite) || width <= 0) return null;
  const timeAt = (pixel: number) => domain.start + Math.max(0, Math.min(1, (pixel - left) / width)) * (domain.end - domain.start);
  return normalizeTimeWindow({ start: timeAt(start), end: timeAt(end) }, domain, minimumSpan);
}

/** Preserve exact source values and null gaps; optional neighbours only paint clipped edges. */
export function observationsInWindow<T extends TimedObservation>(points: readonly T[], window: ChartTimeWindow, includeNeighbours = false): T[] {
  const sorted = points.filter(point => Number.isFinite(point.timestamp)).slice().sort((a, b) => a.timestamp - b.timestamp);
  const inside = sorted.filter(point => point.timestamp >= window.start && point.timestamp <= window.end);
  if (!includeNeighbours) return inside;
  const before = sorted.findLast(point => point.timestamp < window.start);
  const after = sorted.find(point => point.timestamp > window.end);
  return [...(before ? [before] : []), ...inside, ...(after ? [after] : [])];
}

export function nearestTimeIndex(points: readonly TimedObservation[], timestamp: number, window?: ChartTimeWindow): number | null {
  let nearest: number | null = null, distance = Infinity;
  points.forEach((point, index) => {
    if (!Number.isFinite(point.timestamp) || (window && (point.timestamp < window.start || point.timestamp > window.end))) return;
    const next = Math.abs(point.timestamp - timestamp);
    if (next < distance) { nearest = index; distance = next; }
  });
  return nearest;
}

export function formatWindowDuration(milliseconds: number) {
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${Number(seconds.toFixed(2))}s`;
  if (seconds < 3600) return `${Number((seconds / 60).toFixed(1))}m`;
  if (seconds < 86400) return `${Number((seconds / 3600).toFixed(1))}h`;
  return `${Number((seconds / 86400).toFixed(1))}d`;
}

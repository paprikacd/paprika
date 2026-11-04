import type { Series } from "./chart-data"
import { validTimestamp } from "./widget-context"

export type ObservationWindow = { start: number; end: number }
/** A chart-local window: the same shape as a dashboard window, but it never changes a query. */
export type ChartTimeWindow = ObservationWindow
export interface TimedObservation { timestamp: number; value: number | null }
const seriesKey = (entry: Series) => JSON.stringify([entry.name ?? "", Object.entries(entry.labels ?? {}).sort(([a], [b]) => a.localeCompare(b))])

/** Times are selected only from actual returned samples, including missing samples. */
export function observationTimes(series: Series[]): number[] {
  return [...new Set(series.flatMap(entry => entry.points.map(point => point.timestamp)).filter(validTimestamp))].sort((a, b) => a - b)
}

export function seriesInWindow(series: Series[], window: ObservationWindow): Series[] {
  return series.map(entry => ({ ...entry, points: entry.points.filter(point => point.timestamp >= window.start && point.timestamp <= window.end) }))
}

/** The endpoints are each series' first and last valid samples inside the interval. */
export function compareWindow(series: Series[], window: ObservationWindow) {
  return series.map(entry => {
    const points = entry.points.filter(point => point.timestamp >= window.start && point.timestamp <= window.end && validTimestamp(point.timestamp) && typeof point.value === "number" && Number.isFinite(point.value)).sort((a, b) => a.timestamp - b.timestamp)
    const start = points[0], end = points.at(-1)
    const difference = points.length > 1 && start.timestamp !== end?.timestamp ? end!.value! - start.value! : undefined
    const delta = difference !== undefined && Number.isFinite(difference) ? difference : undefined
    const ratio = delta !== undefined && start.value !== 0 ? delta / Math.abs(start.value!) * 100 : undefined
    const percent = ratio !== undefined && Number.isFinite(ratio) ? ratio : undefined
    return { entry, start, end, delta, percent }
  })
}

/** Compare latest finite recorded samples, never matching an ambiguous series. */
export function comparePriorPeriod(current: Series[], previous: Series[], window: ObservationWindow) {
  const counts = new Map<string, number>()
  for (const entry of current) counts.set(seriesKey(entry), (counts.get(seriesKey(entry)) ?? 0) + 1)
  const lookup = new Map<string, Series[]>()
  for (const entry of previous) lookup.set(seriesKey(entry), [...(lookup.get(seriesKey(entry)) ?? []), entry])
  const latest = (entry: Series | undefined, from: number, to: number, includeEnd: boolean) => entry?.points.filter(point => validTimestamp(point.timestamp) && point.timestamp >= from && (includeEnd ? point.timestamp <= to : point.timestamp < to) && typeof point.value === "number" && Number.isFinite(point.value)).sort((a, b) => a.timestamp - b.timestamp).at(-1)
  const length = window.end - window.start
  return current.map(entry => {
    const candidates = lookup.get(seriesKey(entry)) ?? []
    const actual = latest(entry, window.start, window.end, true)
    const prior = counts.get(seriesKey(entry)) === 1 && candidates.length === 1 ? latest(candidates[0], window.start - length, window.start, false) : undefined
    const diff = actual && prior ? actual.value! - prior.value! : undefined
    const delta = diff !== undefined && Number.isFinite(diff) ? diff : undefined
    const ratio = delta !== undefined && prior?.value !== 0 ? delta / Math.abs(prior!.value!) * 100 : undefined
    return { entry, actual, prior, delta, percent: ratio !== undefined && Number.isFinite(ratio) ? ratio : undefined }
  })
}

/** Shift actual previous samples by one selected-window duration for display.
 * The originals are retained for labels; ambiguous series are never paired. */
export function alignPriorPeriod(current: Series[], previous: Series[], window: ObservationWindow) {
  const length = window.end - window.start
  if (!Number.isFinite(length) || length <= 0) return []
  const counts = new Map<string, number>()
  for (const entry of current) counts.set(seriesKey(entry), (counts.get(seriesKey(entry)) ?? 0) + 1)
  const lookup = new Map<string, Series[]>()
  for (const entry of previous) lookup.set(seriesKey(entry), [...(lookup.get(seriesKey(entry)) ?? []), entry])
  return current.flatMap((entry, index) => {
    const candidates = lookup.get(seriesKey(entry)) ?? []
    if (counts.get(seriesKey(entry)) !== 1 || candidates.length !== 1) return []
    const original = { ...candidates[0], points: candidates[0].points.filter(point => validTimestamp(point.timestamp) && point.timestamp >= window.start - length && point.timestamp < window.start).sort((a, b) => a.timestamp - b.timestamp) }
    if (!original.points.some(point => typeof point.value === "number" && Number.isFinite(point.value))) return []
    return [{ index, original, shifted: { ...original, points: original.points.map(point => ({ ...point, timestamp: point.timestamp + length })) } }]
  })
}

/** The earliest and latest valid timestamps across every series, or null when there is no span to zoom into. */
export function timeWindowExtent(series: readonly { points: readonly TimedObservation[] }[]): ChartTimeWindow | null {
  let start = Infinity, end = -Infinity
  for (const entry of series) for (const point of entry.points) {
    if (!validTimestamp(point.timestamp)) continue
    start = Math.min(start, point.timestamp)
    end = Math.max(end, point.timestamp)
  }
  return Number.isFinite(start) && end > start ? { start, end } : null
}

/** Two of the densest series' source intervals, bounded below by a ten-thousandth of the extent and one millisecond. */
export function minimumTimeWindow(series: readonly { points: readonly TimedObservation[] }[], extent: ChartTimeWindow): number {
  let cadence = Infinity
  for (const entry of series) {
    const timestamps = [...new Set(entry.points.map(point => point.timestamp).filter(value => validTimestamp(value)))].sort((a, b) => a - b)
    for (let index = 1; index < timestamps.length; index++) cadence = Math.min(cadence, timestamps[index] - timestamps[index - 1])
  }
  const span = extent.end - extent.start
  return Math.min(span, Math.max(1, span / 10000, Number.isFinite(cadence) ? cadence * 2 : span))
}

/** Clamps a candidate into the extent, rounds it to whole milliseconds and rejects a span narrower than the minimum. */
export function normalizeTimeWindow(candidate: ChartTimeWindow, extent: ChartTimeWindow, minimumSpan = 1): ChartTimeWindow | null {
  if (![candidate.start, candidate.end, extent.start, extent.end, minimumSpan].every(value => Number.isFinite(value)) || extent.end <= extent.start || minimumSpan <= 0) return null
  const start = Math.max(extent.start, Math.min(extent.end, Math.round(Math.min(candidate.start, candidate.end))))
  const end = Math.max(extent.start, Math.min(extent.end, Math.round(Math.max(candidate.start, candidate.end))))
  return end - start >= minimumSpan ? { start, end } : null
}

export function sameTimeWindow(a: ChartTimeWindow, b: ChartTimeWindow): boolean {
  return a.start === b.start && a.end === b.end
}

/** Converts pointer positions (pixels inside a plot that starts at `left`) into a normalized time window. */
export function timeWindowFromPixels(start: number, end: number, left: number, width: number, domain: ChartTimeWindow, minimumSpan = 1): ChartTimeWindow | null {
  if (![start, end, left, width].every(value => Number.isFinite(value)) || width <= 0) return null
  const timeAt = (pixel: number) => domain.start + Math.max(0, Math.min(1, (pixel - left) / width)) * (domain.end - domain.start)
  return normalizeTimeWindow({ start: timeAt(start), end: timeAt(end) }, domain, minimumSpan)
}

/** Keeps exact values and null gaps. Neighbours outside the window are returned only when asked, to draw clipped edges. */
export function observationsInWindow<T extends TimedObservation>(points: readonly T[], window: ChartTimeWindow, includeNeighbours = false): T[] {
  const sorted = points.filter(point => validTimestamp(point.timestamp)).slice().sort((a, b) => a.timestamp - b.timestamp)
  const inside = sorted.filter(point => point.timestamp >= window.start && point.timestamp <= window.end)
  if (!includeNeighbours) return inside
  let before: T | undefined
  for (const point of sorted) if (point.timestamp < window.start) before = point
  const after = sorted.find(point => point.timestamp > window.end)
  return [...(before ? [before] : []), ...inside, ...(after ? [after] : [])]
}

/** Index of the valid point nearest a timestamp, optionally restricted to a window. Ties keep the earlier point. */
export function nearestTimeIndex(points: readonly TimedObservation[], timestamp: number, window?: ChartTimeWindow): number | null {
  let nearest: number | null = null, distance = Infinity
  for (let index = 0; index < points.length; index++) {
    const point = points[index]
    if (!validTimestamp(point.timestamp) || (window && (point.timestamp < window.start || point.timestamp > window.end))) continue
    const next = Math.abs(point.timestamp - timestamp)
    if (next < distance) { nearest = index; distance = next }
  }
  return nearest
}

export function formatWindowDuration(milliseconds: number): string {
  const seconds = milliseconds / 1000
  if (seconds < 60) return `${Number(seconds.toFixed(2))}s`
  if (seconds < 3600) return `${Number((seconds / 60).toFixed(1))}m`
  if (seconds < 86400) return `${Number((seconds / 3600).toFixed(1))}h`
  return `${Number((seconds / 86400).toFixed(1))}d`
}

/** Keyboard step for a window edge: one percent of the extent, never below the minimum span. */
export function timeWindowStep(extent: ChartTimeWindow, minimumSpan: number): number {
  return Math.max(minimumSpan, (extent.end - extent.start) / 100)
}

/** Moves one edge to a target time. The opposite edge stays fixed, and the moving edge stops a minimum span short of it. */
export function moveTimeWindowEdge(window: ChartTimeWindow, extent: ChartTimeWindow, edge: "start" | "end", target: number, minimumSpan = 1): ChartTimeWindow | null {
  if (!validTimestamp(target)) return null
  const candidate = edge === "start"
    ? { start: Math.min(target, window.end - minimumSpan), end: window.end }
    : { start: window.start, end: Math.max(target, window.start + minimumSpan) }
  return normalizeTimeWindow(candidate, extent, minimumSpan)
}

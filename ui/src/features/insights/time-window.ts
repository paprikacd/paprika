import type { Series } from "./chart-data"
import { validTimestamp } from "./widget-context"

export type ObservationWindow = { start: number; end: number }
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

import { exactMetric, formatMetricDetails, latestPoint, type Series } from "./chart-data"
import { validTimestamp } from "./widget-context"
import { DEFAULT_TARGET_POINTS, queryStep } from "./query-step"

export type ObservationWindow = { start: number; end: number }
/** A chart-local window: the same shape as a dashboard window, but it never changes a query. */
export type ChartTimeWindow = ObservationWindow
export interface TimedObservation { timestamp: number; value: number | null }
/** Name and labels: the key that pairs a refined series with the dashboard series it refines. */
export const seriesKey = (entry: Series) => JSON.stringify([entry.name ?? "", Object.entries(entry.labels ?? {}).sort(([a], [b]) => a.localeCompare(b))])

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

/** Which earlier window a stat compares with: the equal window before the range, or the same window one day or seven days earlier. */
export type ComparisonWindow = "previous" | "1d" | "7d";
const COMPARISON_OFFSET_MS: Record<Exclude<ComparisonWindow, "previous">, number> = { "1d": 86_400_000, "7d": 604_800_000 };
const MAX_WINDOW_MS = 31 * 86_400_000;

/** How far back the earlier window sits: the range length for "previous", a fixed day count otherwise. */
export function comparisonOffset(window: ObservationWindow, compare: ComparisonWindow): number {
  return compare === "previous" ? window.end - window.start : COMPARISON_OFFSET_MS[compare];
}

/**
 * The earlier window as a query: seconds for the provider, the same bounds the time-series lens asks for, and the
 * primary query's step rule for the provider's minimum step. The end is exclusive by one millisecond. A range from one second to 31 days with room
 * before it has a previous window; anything else is unavailable.
 */
export function priorWindowQuery(window: ObservationWindow, compare: ComparisonWindow, minStepSeconds = 0): { start: number; end: number; step: number } | { unavailable: "no_previous_range" } {
  const span = window.end - window.start;
  const offset = comparisonOffset(window, compare);
  if (![window.start, window.end, offset].every(Number.isFinite) || span < 1000 || span > MAX_WINDOW_MS || offset <= 0 || window.start - offset <= 0)
    return { unavailable: "no_previous_range" };
  return { start: (window.start - offset) / 1000, end: (window.end - offset - 1) / 1000, step: queryStep(span / 1000, DEFAULT_TARGET_POINTS, minStepSeconds) };
}

export type ComparisonReason = "no_previous_range" | "no_current_sample" | "no_prior_sample" | "ambiguous_series";
export type StatComparison =
  | { state: "unavailable"; reason: ComparisonReason }
  | { state: "ok" | "partial"; current: { timestamp: number; value: number }; baseline: { timestamp: number; value: number }; delta: number; percent?: number; direction: "up" | "down" | "flat" };

/**
 * A stat's point-to-point change: its displayed sample now against the latest valid sample of the same series in the
 * earlier window. Only the first series with a latest sample is compared, as the stat shows it. A series key that is not
 * unique in the current result, or that matches more than one earlier series, is never paired. A truncated earlier
 * response is partial when its series matched, and unavailable otherwise.
 */
export function statComparison(current: Series[], earlier: Series[], window: ObservationWindow, compare: ComparisonWindow, earlierPartial = false): StatComparison {
  const range = priorWindowQuery(window, compare);
  if ("unavailable" in range) return { state: "unavailable", reason: "no_previous_range" };
  const shown = current.find(entry => latestPoint(entry));
  const now = shown ? latestPoint(shown) : undefined;
  if (!shown || !now) return { state: "unavailable", reason: "no_current_sample" };
  const key = seriesKey(shown);
  if (current.filter(entry => seriesKey(entry) === key).length > 1) return { state: "unavailable", reason: "ambiguous_series" };
  const matches = earlier.filter(entry => seriesKey(entry) === key);
  if (matches.length > 1) return { state: "unavailable", reason: "ambiguous_series" };
  const offset = comparisonOffset(window, compare);
  const from = window.start - offset, to = window.end - offset;
  const sample = matches[0]?.points
    .filter(point => validTimestamp(point.timestamp) && point.timestamp >= from && point.timestamp < to && typeof point.value === "number" && Number.isFinite(point.value))
    .sort((a, b) => a.timestamp - b.timestamp).at(-1);
  if (!sample) return { state: "unavailable", reason: "no_prior_sample" };
  const difference = now.value - sample.value!;
  if (!Number.isFinite(difference)) return { state: "unavailable", reason: "no_prior_sample" };
  const ratio = sample.value !== 0 ? difference / Math.abs(sample.value!) * 100 : undefined;
  const percent = ratio !== undefined && Number.isFinite(ratio) ? ratio : undefined;
  return {
    state: earlierPartial ? "partial" : "ok",
    current: { timestamp: now.timestamp, value: now.value },
    baseline: { timestamp: sample.timestamp, value: sample.value! },
    delta: difference,
    percent,
    direction: difference > 0 ? "up" : difference < 0 ? "down" : "flat",
  };
}

/** The change as a reader sees it, and whether it rounds to nothing at the widget's decimals. */
export interface ChangeText { text: string; exactTitle: string; direction: "up" | "down" | "flat"; form: "relative" | "points" | "absolute" }

/** A relative change as a percent. The percent sign always comes from the "%" unit path, so decimals pad whole percents too. */
export function formatRelativeChange(percent: number, decimals?: number): string {
  return formatMetricDetails(percent, "%", decimals);
}

/**
 * Whether a change is float noise in Auto, so it reads as "≈0" with no direction. A relative change below 0.005% of its
 * earlier value is noise. An absolute or point change is noise below the current reading's precision (three significant
 * figures, so one part in two thousand of it), or below one trillionth when the current reading is unknown or zero.
 * Explicit decimals decide their own rounding and never use this.
 */
export function isChangeNoise(delta: number, form: ChangeText["form"], percent: number | undefined, decimals?: number, current?: number): boolean {
  if (decimals !== undefined) return false;
  if (form === "relative" && percent !== undefined) return Math.abs(percent) < .005;
  const reading = Math.abs(current ?? 0);
  return Math.abs(delta) < (reading > 0 ? reading * 5e-4 : 1e-12);
}

/** A relative change in parentheses beside the absolute one: signed, padded to the decimals, and "≈0%" when it is noise. */
export function formatRelativePercentText(percent: number, decimals?: number, current?: number | null): string {
  // A relative change is noise by its percent alone, so the absolute change is not needed to decide it.
  if (isChangeNoise(0, "relative", percent, decimals, current ?? undefined)) return `≈${formatRelativeChange(0, decimals)}`;
  return `${percent > 0 ? "+" : ""}${formatRelativeChange(percent, decimals)}`;
}

/**
 * Text for a change. A percentage unit reports percentage points, never a relative percent of a percent. Other units
 * report the relative change, or the absolute change in the widget unit when the earlier value is zero. The number follows the
 * widget's decimals, and a change that rounds to zero reads as "≈0" with no direction. In Auto, float noise reads as "≈0"
 * too, so a stat that moved by 1e-14 never prints an arrow and an exponent.
 */
export function formatChange(delta: number, percent: number | undefined, unit: string, decimals?: number, current?: number): ChangeText {
  const form: ChangeText["form"] = unit === "%" ? "points" : percent !== undefined ? "relative" : "absolute";
  const magnitude = form === "relative" ? percent! : delta;
  // Relative changes print their own percent sign; points and absolute changes take the unit that formatMetricDetails prints.
  const measure = (value: number) => form === "relative" ? formatRelativeChange(value, decimals) : formatMetricDetails(value, form === "points" ? "pp" : unit, decimals);
  const body = measure(magnitude);
  const numeric = Number.parseFloat(body.replace(/,/g, ""));
  const exact = `${delta > 0 ? "+" : ""}${exactMetric(delta, form === "points" ? "pp" : unit)}`;
  const exactTitle = `Exact change ${exact}${form === "relative" && percent !== undefined ? ` (${percent > 0 ? "+" : ""}${exactMetric(percent, "%")})` : ""}`;
  if (delta === 0) return { text: measure(0), exactTitle, direction: "flat", form };
  // A change that rounds to zero at the widget's decimals is "≈0" with no direction, so a flat-looking value never shows an arrow.
  if (numeric === 0 || isChangeNoise(delta, form, percent, decimals, current)) return { text: `≈${measure(0)}`, exactTitle, direction: "flat", form };
  return { text: `${magnitude > 0 ? "+" : ""}${body}`, exactTitle, direction: delta > 0 ? "up" : "down", form };
}

/** Compare latest finite recorded samples, never matching an ambiguous series. */
export function comparePriorPeriod(current: Series[], previous: Series[], window: ObservationWindow, offset = window.end - window.start) {
  const counts = new Map<string, number>()
  for (const entry of current) counts.set(seriesKey(entry), (counts.get(seriesKey(entry)) ?? 0) + 1)
  const lookup = new Map<string, Series[]>()
  for (const entry of previous) lookup.set(seriesKey(entry), [...(lookup.get(seriesKey(entry)) ?? []), entry])
  const latest = (entry: Series | undefined, from: number, to: number, includeEnd: boolean) => entry?.points.filter(point => validTimestamp(point.timestamp) && point.timestamp >= from && (includeEnd ? point.timestamp <= to : point.timestamp < to) && typeof point.value === "number" && Number.isFinite(point.value)).sort((a, b) => a.timestamp - b.timestamp).at(-1)
  return current.map(entry => {
    const candidates = lookup.get(seriesKey(entry)) ?? []
    const actual = latest(entry, window.start, window.end, true)
    const prior = counts.get(seriesKey(entry)) === 1 && candidates.length === 1 ? latest(candidates[0], window.start - offset, window.end - offset, false) : undefined
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

/**
 * The narrowest zoom when a chart can refine it: two of the provider's steps, never below a ten-thousandth of the extent
 * and one millisecond. A refined zoom samples at its own step, so it need not stay as wide as the observed cadence.
 */
export function refinedMinimumSpan(extent: ChartTimeWindow, minStepSeconds = 0): number {
  const span = extent.end - extent.start
  return Math.min(span, Math.max(1, span / 10000, 2 * minStepSeconds * 1000))
}

/**
 * A zoom's re-query in seconds: the policy step for its own span at the provider's minimum, over exactly the zoomed
 * bounds. The chart crops the result to the window, so no padding is requested.
 */
export function refineWindowQuery(window: ObservationWindow, minStepSeconds = 0): { start: number; end: number; step: number } {
  const step = queryStep((window.end - window.start) / 1000, DEFAULT_TARGET_POINTS, minStepSeconds)
  return { start: window.start / 1000, end: window.end / 1000, step }
}

/**
 * A refined result paired with the dashboard series it refines, by name and labels. The dashboard order and count are
 * kept, so each position keeps its colour: a series the refine did not return keeps its dashboard samples, and a
 * series that only the refine returned is dropped.
 */
export function pairRefinedSeries(original: Series[], refined: Series[] | undefined): Series[] {
  if (!refined) return original
  const byKey = new Map<string, Series>()
  for (const entry of refined) if (!byKey.has(seriesKey(entry))) byKey.set(seriesKey(entry), entry)
  return original.map(entry => byKey.get(seriesKey(entry)) ?? entry)
}

/**
 * The narrowest zoom a chart commits. A zoom that re-queries may go as narrow as two provider steps, but only when the
 * provider honours its step (it publishes minStepSeconds); otherwise the samples cannot get finer than the cadence.
 */
export function chartMinimumSpan(extent: ChartTimeWindow, series: readonly { points: readonly TimedObservation[] }[], refinable: boolean, minStepSeconds?: number): number {
  return refinable && minStepSeconds !== undefined ? refinedMinimumSpan(extent, minStepSeconds) : minimumTimeWindow(series, extent)
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

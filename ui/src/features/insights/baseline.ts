import type { Series } from "./chart-data"
import { seriesKey } from "./time-window"
import { validTimestamp } from "./widget-context"

// The pure baseline band. internal/insights/baseline.go ports this file, and both run the shared cases in
// docs/design/insights/conformance/baseline.json, so they cannot silently diverge. Times are Unix milliseconds.

export type BaselineWindow = "previous" | "1d" | "7d" | "rolling"
export type BaselineBand = "range" | "p10p90"

export interface BaselinePoint { timestamp: number; lower: number; upper: number; outside: boolean }
export interface BaselineRun { start: number; end: number; samples: number }
export interface SeriesBaseline {
  index: number
  points: BaselinePoint[]
  /** Samples that had a band. Samples without one are never judged. */
  evaluated: number
  outside: number
  /** Runs of two or more consecutive outside samples. A single outside sample is never a run. */
  runs: BaselineRun[]
  reason?: "ambiguous_series" | "no_prior_sample"
}
export interface BaselineOptions {
  window: BaselineWindow
  band: BaselineBand
  /** How far back the earlier window sits, from comparisonOffset. Unused for rolling. */
  offsetMs: number
  /** The query step: neighbours lie within two steps of the sample. */
  stepMs: number
}

/**
 * The rolling baseline is lagged: a sample is judged against the 12 finite samples that end 6 samples before it, and needs
 * at least 6 of them. Without the gap a shift enters its own band within a sample or two, so a step change never forms a
 * run; with it, a shift stays outside for the 6 samples of the gap and the one after, then becomes the new normal.
 */
export const ROLLING_SAMPLES = 12
export const ROLLING_GUARD = 6
export const ROLLING_MIN = 6
/** A prior window contributes at most its 5 nearest samples to a sample's neighbourhood. */
export const PRIOR_NEIGHBOURS = 5
/** Percentile bands need at least 5 neighbours; a range band needs one. */
export const P10P90_MIN = 5
const SIGMA_BAND = 3
const MAD_SCALE = 1.4826
const RELATIVE_FLOOR = 0.01
const TINY = 1e-12

interface Sample { timestamp: number; value: number }

function samplesOf(entry: Series): Sample[] {
  return entry.points
    .filter(point => validTimestamp(point.timestamp) && typeof point.value === "number" && Number.isFinite(point.value))
    .map(point => ({ timestamp: point.timestamp, value: point.value as number }))
    .sort((a, b) => a.timestamp - b.timestamp)
}

/** Linear interpolation between the closest ranks; the 0.5 quantile is the usual median. Input must be sorted. */
function quantile(sorted: number[], p: number): number {
  const position = p * (sorted.length - 1)
  const low = Math.floor(position), high = Math.ceil(position)
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low)
}

function median(values: number[]): number {
  return quantile([...values].sort((a, b) => a - b), 0.5)
}

/**
 * The neighbourhood of a rolling sample, given how many samples come strictly before it: the 12 samples that end 6 samples
 * earlier, or none when fewer than 6 exist. Samples at the same time are never each other's neighbours.
 */
function rollingNeighbours(current: Sample[], before: number): number[] {
  const end = Math.max(0, before - ROLLING_GUARD)
  const window = current.slice(Math.max(0, end - ROLLING_SAMPLES), end).map(sample => sample.value)
  return window.length >= ROLLING_MIN ? window : []
}

/** The prior samples within two steps of the sample, shifted by the offset: the 5 nearest, nearest first, ties by time. */
function priorNeighbours(prior: Sample[], offsetMs: number, stepMs: number, timestamp: number): number[] {
  const tolerance = 2 * stepMs
  return prior
    .map(sample => ({ distance: Math.abs(sample.timestamp + offsetMs - timestamp), shifted: sample.timestamp + offsetMs, value: sample.value }))
    .filter(candidate => candidate.distance <= tolerance)
    .sort((a, b) => a.distance - b.distance || a.shifted - b.shifted)
    .slice(0, PRIOR_NEIGHBOURS)
    .map(candidate => candidate.value)
}

function bandOf(values: number[], band: BaselineBand): { lower: number; upper: number } | undefined {
  const sorted = [...values].sort((a, b) => a - b)
  if (band === "p10p90") {
    if (sorted.length < P10P90_MIN) return undefined
    return { lower: quantile(sorted, 0.1), upper: quantile(sorted, 0.9) }
  }
  return sorted.length ? { lower: sorted[0], upper: sorted[sorted.length - 1] } : undefined
}

/** A sample is outside when it is more than three robust sigmas beyond the band. The sigma never falls below 1% of the median. */
function isOutside(value: number, values: number[], lower: number, upper: number): boolean {
  const m = median(values)
  const mad = median(values.map(neighbour => Math.abs(neighbour - m)))
  const sigma = Math.max(MAD_SCALE * mad, RELATIVE_FLOOR * Math.abs(m), TINY)
  return value > upper + SIGMA_BAND * sigma || value < lower - SIGMA_BAND * sigma
}

function evaluate(index: number, current: Sample[], prior: Sample[] | undefined, options: BaselineOptions): SeriesBaseline {
  const points: BaselinePoint[] = []
  const runs: BaselineRun[] = []
  let open: BaselineRun | undefined
  const close = () => {
    if (open && open.samples >= 2) runs.push(open)
    open = undefined
  }
  // current is sorted by time, so the count of strictly earlier samples only grows.
  let before = 0
  for (const sample of current) {
    while (current[before].timestamp < sample.timestamp) before++
    const neighbours = options.window === "rolling"
      ? rollingNeighbours(current, before)
      : priorNeighbours(prior ?? [], options.offsetMs, options.stepMs, sample.timestamp)
    const band = neighbours.length ? bandOf(neighbours, options.band) : undefined
    if (!band) {
      close()
      continue
    }
    const outside = isOutside(sample.value, neighbours, band.lower, band.upper)
    points.push({ timestamp: sample.timestamp, lower: band.lower, upper: band.upper, outside })
    if (!outside) {
      close()
      continue
    }
    if (open) {
      open.end = sample.timestamp
      open.samples += 1
    } else open = { start: sample.timestamp, end: sample.timestamp, samples: 1 }
  }
  close()
  const outside = points.filter(point => point.outside).length
  const reason = options.window !== "rolling" && points.length === 0 && prior?.length ? "no_prior_sample" : undefined
  return { index, points, evaluated: points.length, outside, runs, ...(reason ? { reason } : {}) }
}

function unevaluated(index: number, reason?: SeriesBaseline["reason"]): SeriesBaseline {
  return { index, points: [], evaluated: 0, outside: 0, runs: [], ...(reason ? { reason } : {}) }
}

/**
 * Each current series' baseline. A series key that appears twice in the current result, or more than once in the
 * prior result, is ambiguous and is never paired. A prior window with no matching series, or none with a neighbour
 * for any sample, reports no_prior_sample. Rolling baselines ignore the prior result entirely.
 */
export function seriesBaselines(current: Series[], prior: Series[] | undefined, options: BaselineOptions): SeriesBaseline[] {
  const keys = current.map(seriesKey)
  return current.map((entry, index) => {
    const key = keys[index]
    if (keys.filter(other => other === key).length > 1) return unevaluated(index, "ambiguous_series")
    if (options.window === "rolling") return evaluate(index, samplesOf(entry), undefined, options)
    if (!prior) return unevaluated(index, "no_prior_sample")
    const matches = prior.filter(other => seriesKey(other) === key)
    if (matches.length > 1) return unevaluated(index, "ambiguous_series")
    if (matches.length === 0) return unevaluated(index, "no_prior_sample")
    return evaluate(index, samplesOf(entry), samplesOf(matches[0]), options)
  })
}

/** Band areas are drawn per contiguous stretch: a gap of more than two steps (or a sample without a band) ends one. */
export function bandSegments(points: BaselinePoint[], stepMs: number): BaselinePoint[][] {
  const segments: BaselinePoint[][] = [];
  for (const point of points) {
    const last = segments.at(-1);
    if (last && point.timestamp - last[last.length - 1].timestamp <= 2 * stepMs) last.push(point);
    else segments.push([point]);
  }
  return segments;
}

/** The latest three runs in time order, then how many earlier runs are not listed. The clock formats a timestamp. */
export function baselineRunsText(runs: BaselineRun[], clock: (timestamp: number) => string): string {
  if (!runs.length) return ""
  const shown = runs.slice(-3)
  const earlier = runs.length - shown.length
  const list = shown.map(run => `${clock(run.start)}–${clock(run.end)}`).join(", ")
  return earlier ? `${list} and ${earlier} earlier` : list
}

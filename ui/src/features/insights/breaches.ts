// Breach intervals of a time series: the stretches where a sample sits in a band whose author-set status is warning or
// critical. The rules are shared with the Go port through docs/design/insights/conformance/breaches.json.
import type { Point } from "./chart-data";
import type { Threshold } from "./schema";
import { validTimestamp } from "./widget-context";

export type BreachLevel = "warning" | "critical";

/**
 * One contiguous stretch of breaching samples. `start` is the first breaching sample. `end` is the last breaching sample,
 * extended toward the next sample only when that sample is observed and contiguous (see seriesBreaches). `duration` is
 * `end - start` in milliseconds. A zero duration marks a single breaching sample with no observed time after it.
 */
export type BreachInterval = { start: number; end: number; level: BreachLevel; duration: number };

/** The breach intervals of one series in a widget, with the series index that identifies it. */
export type SeriesBreachInterval = BreachInterval & { series: number };

/** The series input: its points and its sampling step in milliseconds (null when the step is unknown). */
export type BreachSeries = { points: readonly Point[]; step: number | null };

/**
 * Per level: `intervals` counts the merged spans with positive duration, across every series (overlapping spans of different
 * series are one interval). `samples` counts single breaching samples outside those spans. `duration` is the merged time.
 */
export type BreachLevelSummary = { level: BreachLevel; intervals: number; samples: number; duration: number };

/** Worst level first, as the footer reads. */
const LEVELS_WORST_FIRST: readonly BreachLevel[] = ["critical", "warning"];

const isObserved = (point: Point) => typeof point.value === "number" && Number.isFinite(point.value);

/** Only author-set warning and critical statuses breach. A colour-only threshold has no status, so it never does. */
function breachLevel(threshold: Threshold): BreachLevel | undefined {
  return threshold.status === "warning" || threshold.status === "critical" ? threshold.status : undefined;
}

/**
 * Thresholds must be strictly increasing, as the schema requires. Unordered or repeated values are rejected, so they
 * produce no breaches rather than a band chosen by accident.
 */
export function thresholdsAreOrdered(thresholds: readonly Threshold[]): boolean {
  return thresholds.every((threshold, index) =>
    Number.isFinite(threshold.value) && (index === 0 || threshold.value > thresholds[index - 1].value));
}

/** The index of a value's band: the highest threshold at or below it, or the first threshold below them all. */
function bandIndex(value: number, thresholds: readonly Threshold[]): number {
  let index = 0;
  for (let position = 1; position < thresholds.length; position++) {
    if (thresholds[position].value > value) break;
    index = position;
  }
  return index;
}

/**
 * The breach intervals of one series. A sample breaches when its band has a warning or critical status. A run ends at the
 * first sample that does not continue it. It extends to that sample, or one step past the last breaching sample if that is
 * earlier, only when the sample is observed and not separated by a timing gap. Otherwise it ends at its last breaching
 * sample: the time after that point is unobserved, and shading there would cover the no-sample hatch. Without a known step,
 * timing never ends a run, and nothing extends past the last breaching sample.
 */
export function seriesBreaches(points: readonly Point[], thresholds: readonly Threshold[] | undefined, step: number | null): BreachInterval[] {
  if (!thresholds?.length || !thresholdsAreOrdered(thresholds)) return [];
  const samples = points
    .filter((point) => validTimestamp(point.timestamp))
    .toSorted((a, b) => a.timestamp - b.timestamp)
    .map((point) => ({
      timestamp: point.timestamp,
      observed: isObserved(point),
      level: isObserved(point) ? breachLevel(thresholds[bandIndex(point.value as number, thresholds)]) : undefined,
    }));
  const stepMs = step !== null && step > 0 ? step : 0;
  const intervals: BreachInterval[] = [];
  let run: { start: number; last: number; level: BreachLevel } | undefined;
  for (const sample of samples) {
    const gap = run !== undefined && stepMs > 0 && sample.timestamp - run.last > stepMs * 1.5;
    if (run && (sample.level !== run.level || gap)) {
      // Only an observed, contiguous next sample lets the run extend, and then at most to that sample or one step on.
      const extendTo = sample.observed && !gap ? sample.timestamp : undefined;
      const end = extendTo === undefined ? run.last : Math.min(run.last + stepMs, extendTo);
      intervals.push({ start: run.start, end, level: run.level, duration: end - run.start });
      run = undefined;
    }
    if (sample.level === undefined) continue;
    if (run) run.last = sample.timestamp;
    else run = { start: sample.timestamp, last: sample.timestamp, level: sample.level };
  }
  if (run) intervals.push({ start: run.start, end: run.last, level: run.level, duration: run.last - run.start });
  return intervals;
}

/**
 * The shaded bands for a plot. Instants (single samples) get no band, since they have no width. Spans closer than one
 * pixel (`msPerPixel`) merge into one band. Each level keeps its most recent `limit` bands, so a flapping series shows its
 * latest breaches at both levels rather than only the first level's earliest ones. Warning comes first, so critical paints
 * over any overlap. `unshaded` counts the bands that were merged or dropped by the cap, not the intervals.
 */
export function breachBands(intervals: readonly BreachInterval[], msPerPixel: number, limit: number): { spans: { start: number; end: number; level: BreachLevel }[]; unshaded: number } {
  let unshaded = 0;
  const spans = (["warning", "critical"] as const).flatMap((level) => {
    const merged = unionSpans(intervals.filter((interval) => interval.level === level && interval.duration > 0), msPerPixel);
    unshaded += Math.max(0, merged.length - limit);
    return merged.slice(-limit).map((span) => ({ ...span, level }));
  });
  return { spans, unshaded };
}

/** The breach intervals of every series, ordered by start, then by series index. */
export function timeSeriesBreaches(series: readonly BreachSeries[], thresholds: readonly Threshold[] | undefined): SeriesBreachInterval[] {
  return series
    .flatMap((entry, index) => seriesBreaches(entry.points, thresholds, entry.step).map((interval) => ({ ...interval, series: index })))
    .sort((a, b) => a.start - b.start || a.series - b.series);
}

/** Clips intervals to a window, such as the plotted time domain. Intervals wholly outside it are dropped. */
export function clampBreaches<T extends BreachInterval>(intervals: readonly T[], [from, to]: readonly [number, number]): T[] {
  return intervals.flatMap((interval) => {
    const start = Math.max(interval.start, from), end = Math.min(interval.end, to);
    if (end < start) return [];
    return [{ ...interval, start, end, duration: end - start }];
  });
}

/**
 * Merges spans that overlap or lie within `gap` of each other, into disjoint spans ordered by start. A gap of 0 merges only
 * spans that touch or overlap. The chart passes one pixel's worth of time, so near neighbours become one visible band.
 */
export function unionSpans(spans: readonly { start: number; end: number }[], gap = 0): { start: number; end: number }[] {
  const merged: { start: number; end: number }[] = [];
  for (const span of spans.toSorted((a, b) => a.start - b.start || a.end - b.end)) {
    const last = merged.at(-1);
    if (last && span.start <= last.end + gap) last.end = Math.max(last.end, span.end);
    else merged.push({ start: span.start, end: span.end });
  }
  return merged;
}

/**
 * The footer's figures, worst level first. Intervals are merged across series, so one incident seen by two series counts
 * once. A single breaching sample outside every merged span is reported as a sample, not as a zero-length interval.
 */
export function breachSummary(intervals: readonly BreachInterval[]): BreachLevelSummary[] {
  return LEVELS_WORST_FIRST.flatMap((level) => {
    const own = intervals.filter((interval) => interval.level === level);
    const spans = unionSpans(own.filter((interval) => interval.duration > 0));
    const instants = new Set(own
      .filter((interval) => interval.duration === 0 && !spans.some((span) => interval.start >= span.start && interval.start <= span.end))
      .map((interval) => interval.start));
    if (!spans.length && !instants.size) return [];
    const duration = spans.reduce((total, span) => total + span.end - span.start, 0);
    return [{ level, intervals: spans.length, samples: instants.size, duration }];
  });
}

/**
 * The emphasised stroke of one plotted series, derived from the points the line is drawn through. Each segment with a
 * breaching end is kept. Where a segment crosses from a band that does not breach into a breaching one, the stroke starts
 * at the threshold crossing, interpolated along that segment. The exit is treated the same way, so entry and exit are
 * symmetric. Missing values break the output, so no stroke joins two separate stretches.
 */
export function breachEmphasisPoints(points: readonly Point[], thresholds: readonly Threshold[] | undefined): Point[] {
  if (!thresholds?.length || !thresholdsAreOrdered(thresholds)) return [];
  const levelAt = (index: number) => breachLevel(thresholds[index]);
  // The crossing into breaching band `inside` from the outside point: at the boundary between the two bands, which is
  // the lower edge of the breaching band when the outside point is below it, otherwise its upper edge.
  const crossing = (outside: Point, inside: Point, insideIndex: number): Point => {
    const boundary = outside.value! > inside.value! ? thresholds[insideIndex + 1].value : thresholds[insideIndex].value;
    const fraction = (boundary - outside.value!) / (inside.value! - outside.value!);
    return { timestamp: outside.timestamp + fraction * (inside.timestamp - outside.timestamp), value: boundary };
  };
  const result: Point[] = [];
  let last: Point | undefined;
  const emit = (from: Point, to: Point) => {
    if (last !== from) {
      if (last) result.push({ timestamp: from.timestamp, value: null });
      result.push(from);
    }
    result.push(to);
    last = to;
  };
  for (let index = 0; index + 1 < points.length; index++) {
    const a = points[index], b = points[index + 1];
    if (!isObserved(a) || !isObserved(b)) continue;
    const ia = bandIndex(a.value!, thresholds), ib = bandIndex(b.value!, thresholds);
    const breachA = levelAt(ia), breachB = levelAt(ib);
    if (!breachA && !breachB) continue;
    if (breachA && breachB) emit(a, b);
    else if (breachB) emit(crossing(a, b, ib), b);
    else emit(a, crossing(b, a, ia));
  }
  return result;
}

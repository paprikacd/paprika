// Breach intervals of a time series: the stretches where a sample sits in a band whose author-set status is warning or
// critical. The rules are shared with the Go port through docs/design/insights/conformance/breaches.json.
import { thresholdForValue } from "./chart-renderer-shared";
import type { Point } from "./chart-data";
import type { Threshold } from "./schema";
import { validTimestamp } from "./widget-context";

export type BreachLevel = "warning" | "critical";

/** One contiguous stretch of breaching samples. `start` is the first breaching sample; `end` is one step after the last
 * one, or the next sample when that comes first. `duration` is `end - start`, in milliseconds. */
export type BreachInterval = { start: number; end: number; level: BreachLevel; duration: number };

/** The breach intervals of one series in a widget, with the series index that identifies it. */
export type SeriesBreachInterval = BreachInterval & { series: number };

/** The series input: its points and its sampling step in milliseconds (null when the step is unknown). */
export type BreachSeries = { points: readonly Point[]; step: number | null };

export type BreachLevelSummary = { level: BreachLevel; intervals: number; duration: number };

/** Worst level first, as the footer reads. */
const LEVELS_WORST_FIRST: readonly BreachLevel[] = ["critical", "warning"];

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

/**
 * The breach intervals of one series. A sample breaches when its band (the highest threshold at or below it, or the first
 * threshold for a value below all of them) has a warning or critical status. A missing sample, an invalid timestamp or a
 * non-finite value never breaches and ends any run. Two consecutive samples further apart than 1.5 steps also end a run,
 * as the chart's gap rule does. Without a known step, an interval ends at its last breaching sample (or the next sample,
 * if that is earlier), and timing alone never ends a run.
 */
export function seriesBreaches(points: readonly Point[], thresholds: readonly Threshold[] | undefined, step: number | null): BreachInterval[] {
  if (!thresholds?.length || !thresholdsAreOrdered(thresholds)) return [];
  const samples = points
    .filter((point) => validTimestamp(point.timestamp))
    .toSorted((a, b) => a.timestamp - b.timestamp)
    .map((point) => {
      const observed = typeof point.value === "number" && Number.isFinite(point.value);
      const level = observed ? breachLevel(thresholdForValue(point.value as number, thresholds)!) : undefined;
      return { timestamp: point.timestamp, level };
    });
  const stepMs = step !== null && step > 0 ? step : 0;
  const intervals: BreachInterval[] = [];
  let run: { start: number; last: number; level: BreachLevel } | undefined;
  const close = (next: number | undefined) => {
    if (!run) return;
    const reach = run.last + stepMs;
    const end = next === undefined ? reach : Math.min(reach, next);
    intervals.push({ start: run.start, end, level: run.level, duration: end - run.start });
    run = undefined;
  };
  for (const sample of samples) {
    if (sample.level === undefined) {
      close(sample.timestamp);
      continue;
    }
    if (run && (sample.level !== run.level || (step !== null && stepMs > 0 && sample.timestamp - run.last > stepMs * 1.5)))
      close(sample.timestamp);
    if (run) run.last = sample.timestamp;
    else run = { start: sample.timestamp, last: sample.timestamp, level: sample.level };
  }
  close(undefined);
  return intervals;
}

/** The breach intervals of every series, ordered by start, then by series index. */
export function timeSeriesBreaches(series: readonly BreachSeries[], thresholds: readonly Threshold[] | undefined): SeriesBreachInterval[] {
  return series
    .flatMap((entry, index) => seriesBreaches(entry.points, thresholds, entry.step).map((interval) => ({ ...interval, series: index })))
    .sort((a, b) => a.start - b.start || a.series - b.series);
}

/** Merges overlapping or touching spans into disjoint ones, ordered by start. */
export function unionSpans(spans: readonly { start: number; end: number }[]): { start: number; end: number }[] {
  const merged: { start: number; end: number }[] = [];
  for (const span of spans.toSorted((a, b) => a.start - b.start || a.end - b.end)) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ start: span.start, end: span.end });
  }
  return merged;
}

/**
 * The footer's figures: per level, the number of intervals and the time that level spent in breach. Time is the union of
 * the spans, so two series breaching at once count their shared time once. Levels with no intervals are omitted.
 */
export function breachSummary(intervals: readonly BreachInterval[]): BreachLevelSummary[] {
  return LEVELS_WORST_FIRST.flatMap((level) => {
    const own = intervals.filter((interval) => interval.level === level);
    if (!own.length) return [];
    const duration = unionSpans(own).reduce((total, span) => total + span.end - span.start, 0);
    return [{ level, intervals: own.length, duration }];
  });
}

/**
 * The samples from each interval's start to its end, for the emphasised stroke. The end sample is the crossing out of the band. Each interval's samples form one run, and a null break
 * separates runs so no segment joins two of them. Only the chart's raw points are used, so the caller downsamples them.
 */
export function breachingPoints(points: readonly Point[], intervals: readonly BreachInterval[]): Point[] {
  if (!intervals.length) return [];
  const ordered = points.filter((point) => validTimestamp(point.timestamp)).toSorted((a, b) => a.timestamp - b.timestamp);
  const result: Point[] = [];
  for (const interval of intervals) {
    // The first sample at or after the start, by binary search, so each interval costs its own length, not the series'.
    let low = 0, high = ordered.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (ordered[middle].timestamp < interval.start) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < ordered.length && ordered[index].timestamp <= interval.end; index++) result.push(ordered[index]);
    result.push({ timestamp: interval.end, value: null });
  }
  return result;
}

import type { QueryResult } from "./schema";
import { validTimestamp } from "./widget-context";

export type Series = NonNullable<QueryResult["series"]>[number];
export type Point = Series["points"][number];
const MAX_POINTS = 480;

const numberFormat = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
const smallNumberFormat = new Intl.NumberFormat("en", {
  maximumSignificantDigits: 3,
});
const compactFormat = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
export const timeFormat = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
export const dateTimeFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const dateTickFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
export function formatTimeTick(timestamp: number, span: number) {
  if (!validTimestamp(timestamp)) return "—";
  return (span >= 86_400_000 ? dateTickFormat : timeFormat).format(
    new Date(timestamp),
  );
}
export const fullDateTimeFormat = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
  fractionalSecondDigits: 3,
  hour12: false,
});

const decimalFormats = new Map<string, Intl.NumberFormat>();
export function formatMetric(
  value: number,
  unit = "",
  compact = false,
  decimals?: number,
): string {
  if (!Number.isFinite(value)) return "—";
  let formatter =
    value !== 0 && Math.abs(value) < 1
      ? smallNumberFormat
      : compact
        ? compactFormat
        : numberFormat;
  if (decimals !== undefined && Number.isFinite(decimals)) {
    const places = Math.max(0, Math.min(8, Math.floor(decimals)));
    const key = `${compact}-${places}`;
    if (!decimalFormats.has(key))
      decimalFormats.set(
        key,
        new Intl.NumberFormat("en", {
          notation: compact ? "compact" : "standard",
          minimumFractionDigits: places,
          maximumFractionDigits: places,
        }),
      );
    formatter = decimalFormats.get(key)!;
  }
  const formatted = formatter.format(value);
  return `${formatted}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`;
}

/**
 * Min/max buckets preserve short incidents that stride sampling would miss.
 * Endpoint preservation keeps the visible time range stable during resizing.
 * An isolated observation (no observed neighbour) is kept too, because its dot is the only thing that draws it.
 * Input arrays are never mutated. Non-finite values become gaps, so a missing
 * scrape is never painted as a continuous successful measurement.
 */
export function downsamplePoints(
  input: readonly Point[],
  maximum = MAX_POINTS,
): Point[] {
  const points = input
    .filter((point) => validTimestamp(point.timestamp))
    .map((point) => ({
      ...point,
      value:
        typeof point.value === "number" && Number.isFinite(point.value)
          ? point.value
          : null,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
  const limit = Number.isFinite(maximum)
    ? Math.max(2, Math.floor(maximum))
    : MAX_POINTS;
  if (points.length <= limit) return points;
  const hasGaps = points.some((point) => point.value === null);
  // Reserve enough room to separate every retained pair that crosses a missing
  // scrape. Keeping only the first null in each min/max bucket can reconnect a
  // later outage in that same bucket and falsely imply uninterrupted data.
  const budget = hasGaps ? Math.max(2, Math.floor((limit + 1) / 2)) : limit;
  const last = points.length - 1;
  const selected = new Set([0, last]);
  // An isolated observation has no observed neighbour, so no segment draws it and only its dot can. Keep each one
  // before any bucket extreme, within the budget. Past the budget, an evenly spaced subset keeps the dots spread out.
  const observedAt = (index: number) =>
    index >= 0 && index <= last && points[index].value !== null;
  const isolated: number[] = [];
  for (let index = 0; index <= last; index++)
    if (points[index].value !== null && !observedAt(index - 1) && !observedAt(index + 1))
      isolated.push(index);
  const room = Math.max(0, budget - selected.size);
  if (isolated.length <= room) isolated.forEach((index) => selected.add(index));
  else
    for (let slot = 0; slot < room; slot++)
      selected.add(isolated[Math.floor((slot * isolated.length) / room)]);
  // What is left feeds the extremes: one slot takes the largest interior magnitude, and each pair of slots takes the
  // minimum and maximum of one bucket.
  const remaining = budget - selected.size;
  if (remaining === 1) {
    let extreme = -1;
    for (let index = 1; index < last; index++) {
      const value = points[index].value;
      if (value === null || selected.has(index)) continue;
      if (extreme < 0 || Math.abs(value) > Math.abs(points[extreme].value!))
        extreme = index;
    }
    if (extreme >= 0) selected.add(extreme);
  } else {
    const buckets = Math.floor(remaining / 2);
    for (let bucket = 0; bucket < buckets; bucket++) {
      const start = 1 + Math.floor((bucket * (points.length - 2)) / buckets);
      const end =
        1 + Math.floor(((bucket + 1) * (points.length - 2)) / buckets);
      let min = -1,
        max = -1;
      for (let index = start; index < end; index++) {
        const value = points[index].value;
        if (value === null) continue;
        if (min < 0 || value < points[min].value!) min = index;
        if (max < 0 || value > points[max].value!) max = index;
      }
      if (min >= 0) selected.add(min);
      if (max >= 0) selected.add(max);
    }
  }
  const indexes = [...selected].sort((a, b) => a - b);
  const result = [points[indexes[0]]];
  for (let position = 1; position < indexes.length; position++) {
    const previous = indexes[position - 1],
      current = indexes[position];
    if (points[previous].value !== null && points[current].value !== null) {
      for (let index = previous + 1; index < current; index++) {
        if (points[index].value !== null) continue;
        result.push(points[index]);
        break;
      }
    }
    if (result.length < limit) result.push(points[current]);
  }
  return result;
}

export function latestPoint(
  series: Series,
): (Point & { value: number }) | undefined {
  let latest: (Point & { value: number }) | undefined;
  for (const point of series.points) {
    if (
      typeof point.value === "number" &&
      Number.isFinite(point.value) &&
      validTimestamp(point.timestamp) &&
      (!latest || point.timestamp >= latest.timestamp)
    )
      latest = { ...point, value: point.value };
  }
  return latest;
}

/** Bound history while retaining the latest-valid value and a missing tail. */
export function boundHistoryPoints(
  input: readonly Point[],
  maximum = 240,
): Point[] {
  const normalized = downsamplePoints(input, Number.MAX_SAFE_INTEGER);
  let latestValid = normalized.length - 1;
  while (latestValid >= 0 && normalized[latestValid].value === null)
    latestValid--;
  const points =
    latestValid >= 0 && latestValid < normalized.length - 1
      ? [
          ...downsamplePoints(
            normalized.slice(0, latestValid + 1),
            maximum - 1,
          ),
          normalized[normalized.length - 1],
        ]
      : downsamplePoints(normalized, maximum);
  // Callers may freeze bounded results; never freeze shared provider objects.
  return points.map((point) => ({ ...point }));
}

export function seriesName(series: Series, index: number) {
  return (
    series.name ||
    Object.entries(series.labels || {})
      .map(([key, value]) => `${key}=${value}`)
      .join(", ") ||
    `Series ${index + 1}`
  );
}

export function exactMetric(value: number, unit = "") {
  if (!Number.isFinite(value)) return "—";
  return `${String(value)}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`;
}

/** Detail views stay exact in Auto mode; explicit precision only rounds the label. */
export function formatMetricDetails(value: number, unit = "", decimals?: number) {
  return decimals === undefined || !Number.isFinite(decimals)
    ? exactMetric(value, unit)
    : formatMetric(value, unit, false, decimals);
}

/** A time interval in Unix milliseconds. */
export type TimeInterval = { from: number; to: number };

const observed = (point: Point) =>
  typeof point.value === "number" && Number.isFinite(point.value);
const inTimeOrder = (points: readonly Point[]) =>
  points
    .filter((point) => validTimestamp(point.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
const isGapStep = (step: number, cadence: number | null) =>
  cadence !== null && step > cadence * 1.5;

/**
 * Typical spacing of one series: the lower median of the positive steps between observed samples. This is the
 * rule `heatmapGaps` uses. It needs three observed samples, so sparser series have no cadence (null).
 */
export function sampleCadence(points: readonly Point[]): number | null {
  const times = inTimeOrder(points)
    .filter(observed)
    .map((point) => point.timestamp);
  if (times.length < 3) return null;
  const steps = times
    .slice(1)
    .map((time, index) => time - times[index])
    .filter((step) => step > 0)
    .sort((a, b) => a - b);
  return steps.length ? steps[Math.floor((steps.length - 1) / 2)] : null;
}

/** Steps between consecutive observed samples. An explicit missing sample between them is a gap even without a cadence. */
function observedSteps(points: readonly Point[], cadence: number | null) {
  const steps: (TimeInterval & { gap: boolean })[] = [];
  let previous: Point | undefined;
  let missingSince = false;
  for (const point of inTimeOrder(points)) {
    if (!observed(point)) {
      missingSince = true;
      continue;
    }
    if (previous)
      steps.push({
        from: previous.timestamp,
        to: point.timestamp,
        gap: missingSince || isGapStep(point.timestamp - previous.timestamp, cadence),
      });
    previous = point;
    missingSince = false;
  }
  return steps;
}

/**
 * Intervals one series observes: consecutive observed samples with no gap between them. An observed sample that
 * neither neighbouring step covers is still an observation, so it covers a zero-width instant. That keeps the holes
 * on either side of an isolated sample apart instead of merging them into one band.
 */
export function seriesCoverage(points: readonly Point[], cadence: number | null): TimeInterval[] {
  const steps = observedSteps(points, cadence);
  const intervals: TimeInterval[] = steps
    .filter((step) => !step.gap)
    .map(({ from, to }) => ({ from, to }));
  inTimeOrder(points)
    .filter(observed)
    .forEach((sample, index) => {
      const before = index > 0 ? steps[index - 1] : undefined;
      const after: (typeof steps)[number] | undefined = steps[index];
      const covered = (before && !before.gap) || (after && !after.gap);
      if (!covered) intervals.push({ from: sample.timestamp, to: sample.timestamp });
    });
  return intervals.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Gap intervals of one series: the steps that `seriesCoverage` leaves out. */
export function seriesGaps(points: readonly Point[], cadence: number | null): TimeInterval[] {
  return observedSteps(points, cadence)
    .filter((step) => step.gap)
    .map(({ from, to }) => ({ from, to }));
}

/**
 * Plotting points with a null break at the midpoint of every inferred gap that has no explicit null, so a line
 * ends there. Pass the unsampled points. Never use the result for values, legends or tooltips.
 */
export function withGapBreaks(points: readonly Point[], cadence: number | null): Point[] {
  const result: Point[] = [];
  let previous: Point | undefined;
  let missingSince = false;
  for (const point of inTimeOrder(points)) {
    if (!observed(point)) {
      result.push(point);
      missingSince = true;
      continue;
    }
    if (previous && !missingSince && isGapStep(point.timestamp - previous.timestamp, cadence))
      result.push({ timestamp: (previous.timestamp + point.timestamp) / 2, value: null });
    result.push(point);
    previous = point;
    missingSince = false;
  }
  return result;
}

/**
 * The plotted points that no line segment reaches: an observed point with no observed plotted neighbour. Each needs
 * its own dot. Every other point keeps its time but loses its value, so a points-only line draws one dot per isolated
 * sample and never joins two of them across a gap. Pass the plotted points, after gap breaks and downsampling.
 */
export function isolatedPlotPoints(points: readonly Point[]): Point[] {
  const seen = (index: number) => index >= 0 && index < points.length && observed(points[index]);
  return points.map((point, index) =>
    observed(point) && !seen(index - 1) && !seen(index + 1) ? point : { ...point, value: null },
  );
}

/**
 * Holes in the union of several coverages, within `domain`. A time is uncovered only when no series observes it,
 * so one series with a gap does not hide the samples another series still has.
 */
export function uncoveredIntervals(
  coverages: readonly (readonly TimeInterval[])[],
  domain: readonly [number, number],
): TimeInterval[] {
  const [start, end] = domain;
  if (!(end > start)) return [];
  // A zero-width interval is an isolated observation: it covers its instant and splits the holes around it.
  const covered = coverages
    .flat()
    .map(({ from, to }) => ({ from: Math.max(start, from), to: Math.min(end, to) }))
    .filter((interval) => interval.to >= interval.from)
    .sort((a, b) => a.from - b.from);
  const holes: TimeInterval[] = [];
  let cursor = start;
  for (const interval of covered) {
    if (interval.from > cursor) holes.push({ from: cursor, to: interval.from });
    cursor = Math.max(cursor, interval.to);
  }
  if (end > cursor) holes.push({ from: cursor, to: end });
  return holes;
}

/** A time domain whose span is never zero. A single instant is padded the way TanStack pads a single value. */
export function plotTimeDomain(start: number, end: number): [number, number] {
  if (end > start) return [start, end];
  const offset = Math.abs(start) * 0.05 || 1;
  return [start - offset, end + offset];
}

/**
 * Estimated rendered width of a 12px band label: about 6.6px per character plus 8px of padding. A label is drawn only
 * when its band is at least this wide, so the plot edge never clips it. The band's aria-label and the interval list
 * still carry the same times.
 */
export function bandLabelWidth(text: string): number {
  return text.length * 6.6 + 8;
}

import { boundHistoryPoints, seriesName, type Point, type Series } from "./chart-data";
import { validTimestamp } from "./widget-context";

/** The chart window an inspection reads from. Bounds are Unix milliseconds. */
export interface InspectionWindow { start: number; end: number }

export type ExactObservation =
  | { kind: "observed"; value: number }
  | { kind: "missing" | "absent" | "ambiguous"; value: null };

export interface InspectorSeries {
  key: string;
  name: string;
  labels: Series["labels"];
  sourceIndex: number;
  /** The source value at the inspected timestamp. A nearby sample is never presented as this time. */
  exact: ExactObservation;
  /** Every source sample at that exact timestamp: one normally, several when a source repeats a timestamp. */
  exactSamples: Point[];
  /** The bounded history drawn beside the value. */
  points: Point[];
  sampleCount: number;
  finiteCount: number;
  missingCount: number;
  min: number | null;
  max: number | null;
  /** The history was thinned for display. Statistics still use every returned sample in the window. */
  reduced: boolean;
  invalidTimestampCount: number;
}

interface PreparedInspectorSeries extends Omit<InspectorSeries, "exact" | "exactSamples"> {
  sourcePoints: Point[];
}

export interface PreparedObservationInspector {
  rows: PreparedInspectorSeries[];
  start: number | null;
  end: number | null;
  windowed: boolean;
  omittedSeries: number;
}

/** Identity follows the source name and labels, independent of the displayed row order. */
export function inspectionSeriesKey(series: Series) {
  return JSON.stringify([series.name ?? "", Object.entries(series.labels ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
}

/**
 * Prepares histories once per result and window, outside the pointer path. The selected series stays visible even in
 * a high-cardinality result, taking the last slot when the limit would otherwise hide it.
 */
export function prepareObservationInspector(
  series: readonly Series[],
  window?: InspectionWindow,
  maximumSeries = 12,
  maximumPoints = 96,
  selectedSeriesIndex = 0,
): PreparedObservationInspector {
  const windowValid = !!window && validTimestamp(window.start) && validTimestamp(window.end) && window.start <= window.end;
  const limit = Number.isFinite(maximumSeries) ? Math.max(1, Math.floor(maximumSeries)) : 12;
  const pointLimit = Number.isFinite(maximumPoints) ? Math.max(8, Math.floor(maximumPoints)) : 96;
  const indexes = Array.from({ length: Math.min(series.length, limit) }, (_, index) => index);
  if (Number.isInteger(selectedSeriesIndex) && selectedSeriesIndex >= limit && selectedSeriesIndex < series.length) indexes[indexes.length - 1] = selectedSeriesIndex;
  const occurrences = new Map<string, number>();
  const keys = series.map((entry) => {
    const identity = inspectionSeriesKey(entry);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return `${identity}:${occurrence}`;
  });
  let start: number | null = windowValid ? window!.start : null;
  let end: number | null = windowValid ? window!.end : null;
  const rows: PreparedInspectorSeries[] = indexes.map((sourceIndex) => {
    const entry = series[sourceIndex];
    const points: Point[] = [];
    let invalidTimestampCount = 0, finiteCount = 0, min: number | null = null, max: number | null = null;
    for (const point of entry.points) {
      if (!validTimestamp(point.timestamp)) {
        invalidTimestampCount++;
        continue;
      }
      if (windowValid && (point.timestamp < window!.start || point.timestamp > window!.end)) continue;
      const value = typeof point.value === "number" && Number.isFinite(point.value) ? point.value : null;
      points.push({ timestamp: point.timestamp, value });
      if (!windowValid) {
        start = start === null ? point.timestamp : Math.min(start, point.timestamp);
        end = end === null ? point.timestamp : Math.max(end, point.timestamp);
      }
      if (value !== null) {
        finiteCount++;
        min = min === null ? value : Math.min(min, value);
        max = max === null ? value : Math.max(max, value);
      }
    }
    points.sort((a, b) => a.timestamp - b.timestamp);
    const bounded = boundHistoryPoints(points, pointLimit);
    return {
      key: keys[sourceIndex],
      name: seriesName(entry, sourceIndex),
      labels: entry.labels,
      sourceIndex,
      sourcePoints: points,
      points: bounded,
      sampleCount: points.length,
      finiteCount,
      missingCount: points.length - finiteCount,
      min,
      max,
      reduced: bounded.length < points.length,
      invalidTimestampCount,
    };
  });
  return { rows, start, end, windowed: windowValid, omittedSeries: Math.max(0, series.length - rows.length) };
}

/** An exact binary lookup. A nearby scrape is never presented as the selected time. */
export function inspectPreparedObservation(prepared: PreparedObservationInspector, timestamp: number) {
  const rows: InspectorSeries[] = prepared.rows.map(({ sourcePoints, ...row }) => {
    let lower = 0, upper = sourcePoints.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (sourcePoints[middle].timestamp < timestamp) lower = middle + 1;
      else upper = middle;
    }
    const exactSamples: Point[] = [];
    for (let index = lower; index < sourcePoints.length && sourcePoints[index].timestamp === timestamp; index++) exactSamples.push(sourcePoints[index]);
    const exact: ExactObservation = exactSamples.length === 0 ? { kind: "absent", value: null }
      : exactSamples.length > 1 ? { kind: "ambiguous", value: null }
      : exactSamples[0].value === null ? { kind: "missing", value: null }
      : { kind: "observed", value: exactSamples[0].value };
    return { ...row, exact, exactSamples };
  });
  return { ...prepared, rows };
}

export function buildObservationInspector(series: readonly Series[], timestamp: number, window?: InspectionWindow, maximumSeries = 12, maximumPoints = 96, selectedSeriesIndex = 0) {
  return inspectPreparedObservation(prepareObservationInspector(series, window, maximumSeries, maximumPoints, selectedSeriesIndex), timestamp);
}

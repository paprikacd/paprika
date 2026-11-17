/** Deterministic, synthetic request telemetry for the Paprika evaluation page. */
export type Scenario = 'regression' | 'gaps' | 'quiet';
export type RegionId = 'ap-southeast-2' | 'us-west-2' | 'eu-west-1';

export const REGIONS: readonly { id: RegionId; label: string; shortLabel: string }[] = [
  { id: 'ap-southeast-2', label: 'Sydney · ap-southeast-2', shortLabel: 'Sydney' },
  { id: 'us-west-2', label: 'Oregon · us-west-2', shortLabel: 'Oregon' },
  { id: 'eu-west-1', label: 'Ireland · eu-west-1', shortLabel: 'Ireland' },
];

/** Counts are disjoint: [0,50], (50,100], …, (2500,5000] milliseconds. */
export const HISTOGRAM_BOUNDS_MS = [50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2500, 5000] as const;
export const INTERVAL_MS = 60_000;
export const BASE_END_MS = Date.parse('2026-10-30T05:00:00Z');
export const BASE_START_MS = BASE_END_MS - 60 * INTERVAL_MS;

export interface TelemetryPoint {
  /** The interval is (timestampMs - intervalMs, timestampMs]. */
  timestampMs: number;
  region: RegionId;
  requests: number | null;
  errors: number | null;
  buckets: readonly number[] | null;
  p50Ms: number | null;
  p95Ms: number | null;
  requestRate: number | null;
  /** Fraction, not percentage; multiply by 100 at a percent-valued chart boundary. */
  errorRatio: number | null;
}

export interface TelemetryDataset {
  scenario: Scenario;
  revision: number;
  startMs: number;
  endMs: number;
  intervalMs: number;
  deploymentMs: number;
  regionIds: readonly RegionId[];
  histogramBoundsMs: readonly number[];
  points: readonly TelemetryPoint[];
}

export interface AggregatePoint {
  timestampMs: number;
  requests: number | null;
  errors: number | null;
  buckets: readonly number[] | null;
  p50Ms: number | null;
  p95Ms: number | null;
  requestRate: number | null;
  errorRatio: number | null;
  observedRegions: number;
  expectedRegions: number;
  complete: boolean;
}

export interface PopulationSummary {
  startMs: number;
  endMs: number;
  durationMs: number;
  expectedIntervals: number;
  observedIntervals: number;
  completeIntervals: number;
  observedRegionIntervals: number;
  expectedRegionIntervals: number;
  coverageRatio: number;
  complete: boolean;
  /** Totals cover observed requests only; they are null when nothing was observed. */
  totalRequests: number | null;
  totalErrors: number | null;
  buckets: readonly number[] | null;
  p50Ms: number | null;
  p95Ms: number | null;
  errorRatio: number | null;
  /** Mean total throughput over fully observed intervals only. */
  meanRequestRate: number | null;
  lastObservedMs: number | null;
  lastCompleteMs: number | null;
  freshness: 'current' | 'stale' | 'no-data';
}

export interface TelemetrySummary extends PopulationSummary {
  latest: AggregatePoint | null;
  latestObserved: AggregatePoint | null;
  comparison: {
    durationMs: number;
    excludedLeadingMs: number;
    before: PopulationSummary;
    after: PopulationSummary;
    p95DeltaMs: number | null;
    p95RelativeChange: number | null;
    errorPercentagePointChange: number | null;
    requestRateRelativeChange: number | null;
  };
  perRegion: readonly (PopulationSummary & { region: RegionId; label: string; shortLabel: string })[];
}

export function secondsToMilliseconds(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) throw new RangeError('A duration must be finite.');
  return value * 1000;
}

/** Estimate a quantile by pooling disjoint counts, then interpolating inside a bin. */
export function histogramQuantile(
  q: number,
  counts: readonly number[],
  bounds: readonly number[] = HISTOGRAM_BOUNDS_MS,
): number | null {
  if (!Number.isFinite(q) || q < 0 || q > 1) throw new RangeError('Quantile must be between 0 and 1.');
  if (counts.length !== bounds.length || counts.length === 0) throw new RangeError('Each histogram bin needs a bound.');
  for (let i = 0; i < bounds.length; i += 1) {
    if (!Number.isFinite(bounds[i]) || bounds[i] <= (i === 0 ? 0 : bounds[i - 1])) throw new RangeError('Histogram bounds must be finite, positive and strictly increasing.');
    if (!Number.isFinite(counts[i]) || counts[i] < 0) throw new RangeError('Histogram counts must be finite and nonnegative.');
  }
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total === 0) return null;
  const target = q * total;
  let cumulative = 0;
  for (let i = 0; i < counts.length; i += 1) {
    const count = counts[i];
    if (count > 0 && target <= cumulative + count) {
      const lower = i === 0 ? 0 : bounds[i - 1];
      return lower + ((target - cumulative) / count) * (bounds[i] - lower);
    }
    cumulative += count;
  }
  return bounds[bounds.length - 1];
}

function apportion(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((weight) => (weight / sum) * total);
  const counts = exact.map(Math.floor);
  const order = exact.map((value, index) => ({ index, remainder: value - counts[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  let remaining = total - counts.reduce((a, b) => a + b, 0);
  for (const { index } of order) {
    if (remaining-- <= 0) break;
    counts[index] += 1;
  }
  return counts;
}

function observedPoint(timestampMs: number, region: RegionId, requests: number, errors: number, buckets: readonly number[]): TelemetryPoint {
  return {
    timestampMs, region, requests, errors, buckets,
    p50Ms: histogramQuantile(0.5, buckets),
    p95Ms: histogramQuantile(0.95, buckets),
    requestRate: requests / (INTERVAL_MS / 1000),
    errorRatio: requests > 0 ? errors / requests : null,
  };
}

function missingPoint(timestampMs: number, region: RegionId): TelemetryPoint {
  return { timestampMs, region, requests: null, errors: null, buckets: null, p50Ms: null, p95Ms: null, requestRate: null, errorRatio: null };
}

export function buildTelemetry(scenario: Scenario, revision = 0): TelemetryDataset {
  if (!['regression', 'gaps', 'quiet'].includes(scenario)) throw new RangeError('Unknown synthetic scenario.');
  if (!Number.isSafeInteger(revision) || revision < 0) throw new RangeError('Revision must be a nonnegative safe integer.');
  const endMs = BASE_END_MS + revision * INTERVAL_MS;
  if (!Number.isSafeInteger(endMs) || Number.isNaN(new Date(endMs).getTime())) throw new RangeError('Revision is outside the supported timestamp range.');
  const points: TelemetryPoint[] = [];
  const normal = [0.10, 0.24, 0.33, 0.23, 0.07, 0.022, 0.006, 0.0015, 0.0004, 0.00009, 0.00001];
  const slow = [0.02, 0.04, 0.07, 0.12, 0.21, 0.25, 0.20, 0.075, 0.012, 0.002, 0.001];
  for (let offset = 0; offset < 60; offset += 1) {
    const minute = revision + offset;
    const timestampMs = BASE_START_MS + (minute + 1) * INTERVAL_MS;
    for (let regionIndex = 0; regionIndex < REGIONS.length; regionIndex += 1) {
      const region = REGIONS[regionIndex].id;
      if (scenario === 'gaps' && ((minute >= 19 && minute <= 23) || offset >= 57)) {
        points.push(missingPoint(timestampMs, region));
        continue;
      }
      const wave = Math.sin(minute * 0.31 + regionIndex * 1.8);
      const fine = Math.cos(minute * 1.73 + regionIndex * 0.7);
      const degradation = scenario !== 'quiet' && regionIndex === 0 && minute >= 30
        ? Math.min(1, 0.45 + (minute - 30) * 0.12) * (0.94 + 0.06 * Math.sin(minute * 0.27))
        : 0;
      const requests = scenario === 'quiet'
        ? ((minute + regionIndex * 2) % 7 === 0 ? 1 + (minute + regionIndex) % 4 : 0)
        : Math.max(1, Math.round([9000, 5200, 3400][regionIndex] * (1 + 0.085 * wave + 0.022 * fine + 0.06 * degradation)));
      const weights = normal.map((weight, i) => weight * (1 - degradation) + slow[i] * degradation);
      // Shift mass between adjacent buckets to create measured, bounded variation.
      const shift = 0.006 * wave;
      weights[3] -= shift;
      weights[4] += shift;
      const buckets = apportion(requests, weights);
      const errorFraction = 0.00115 + regionIndex * 0.0002 + 0.0002 * (wave + 1) + 0.015 * degradation;
      const errors = Math.min(requests, Math.max(0, Math.round(requests * errorFraction)));
      points.push(observedPoint(timestampMs, region, requests, errors, buckets));
    }
  }
  return {
    scenario, revision, startMs: endMs - 60 * INTERVAL_MS, endMs, intervalMs: INTERVAL_MS,
    deploymentMs: BASE_START_MS + 28 * INTERVAL_MS,
    regionIds: REGIONS.map((region) => region.id), histogramBoundsMs: HISTOGRAM_BOUNDS_MS, points,
  };
}

function selectRange(dataset: TelemetryDataset, startMs: number, endMs: number, regionIds = dataset.regionIds): TelemetryDataset {
  return { ...dataset, startMs, endMs, regionIds: [...regionIds], points: dataset.points.filter((point) => point.timestampMs > startMs && point.timestampMs <= endMs && regionIds.includes(point.region)) };
}

export function selectTelemetry(dataset: TelemetryDataset, options: { region?: RegionId | 'all'; minutes?: 15 | 30 | 60 } = {}): TelemetryDataset {
  const regionIds = options.region && options.region !== 'all' ? [options.region] : dataset.regionIds;
  if (regionIds.some((region) => !dataset.regionIds.includes(region))) throw new RangeError('Selected region is outside the source population.');
  const startMs = options.minutes ? Math.max(dataset.startMs, dataset.endMs - options.minutes * INTERVAL_MS) : dataset.startMs;
  return selectRange(dataset, startMs, dataset.endMs, regionIds);
}

/** Incomplete fleet intervals remain gaps; observed subsets are not complete totals. */
export function aggregateTimeline(dataset: TelemetryDataset): AggregatePoint[] {
  const grouped = new Map<number, Map<RegionId, TelemetryPoint>>();
  for (const point of dataset.points) {
    if (point.timestampMs <= dataset.startMs || point.timestampMs > dataset.endMs || !dataset.regionIds.includes(point.region)) continue;
    const byRegion = grouped.get(point.timestampMs) ?? new Map<RegionId, TelemetryPoint>();
    if (byRegion.has(point.region)) throw new RangeError('Duplicate region and interval in telemetry.');
    byRegion.set(point.region, point);
    grouped.set(point.timestampMs, byRegion);
  }
  const result: AggregatePoint[] = [];
  for (let timestampMs = dataset.startMs + dataset.intervalMs; timestampMs <= dataset.endMs; timestampMs += dataset.intervalMs) {
    const points = [...(grouped.get(timestampMs)?.values() ?? [])].filter((point) => point.requests !== null && point.errors !== null && point.buckets !== null);
    const complete = points.length === dataset.regionIds.length && dataset.regionIds.length > 0;
    if (!complete) {
      result.push({ timestampMs, requests: null, errors: null, buckets: null, p50Ms: null, p95Ms: null, requestRate: null, errorRatio: null, observedRegions: points.length, expectedRegions: dataset.regionIds.length, complete: false });
      continue;
    }
    const requests = points.reduce((sum, point) => sum + (point.requests ?? 0), 0);
    const errors = points.reduce((sum, point) => sum + (point.errors ?? 0), 0);
    const buckets = dataset.histogramBoundsMs.map((_, index) => points.reduce((sum, point) => sum + (point.buckets?.[index] ?? 0), 0));
    result.push({ timestampMs, requests, errors, buckets, p50Ms: histogramQuantile(0.5, buckets, dataset.histogramBoundsMs), p95Ms: histogramQuantile(0.95, buckets, dataset.histogramBoundsMs), requestRate: requests / (dataset.intervalMs / 1000), errorRatio: requests > 0 ? errors / requests : null, observedRegions: points.length, expectedRegions: dataset.regionIds.length, complete: true });
  }
  return result;
}

function populationSummary(dataset: TelemetryDataset): PopulationSummary {
  const points = dataset.points.filter((point) => point.timestampMs > dataset.startMs && point.timestampMs <= dataset.endMs && dataset.regionIds.includes(point.region) && point.requests !== null && point.errors !== null && point.buckets !== null);
  const timeline = aggregateTimeline(dataset);
  const completePoints = timeline.filter((point) => point.complete);
  const expectedIntervals = Math.round((dataset.endMs - dataset.startMs) / dataset.intervalMs);
  const expectedRegionIntervals = expectedIntervals * dataset.regionIds.length;
  const totalRequests = points.length ? points.reduce((sum, point) => sum + (point.requests ?? 0), 0) : null;
  const totalErrors = points.length ? points.reduce((sum, point) => sum + (point.errors ?? 0), 0) : null;
  const buckets = points.length ? dataset.histogramBoundsMs.map((_, index) => points.reduce((sum, point) => sum + (point.buckets?.[index] ?? 0), 0)) : null;
  const lastObservedMs = points.length ? Math.max(...points.map((point) => point.timestampMs)) : null;
  const lastCompleteMs = completePoints.at(-1)?.timestampMs ?? null;
  return {
    startMs: dataset.startMs, endMs: dataset.endMs, durationMs: dataset.endMs - dataset.startMs,
    expectedIntervals, observedIntervals: timeline.filter((point) => point.observedRegions > 0).length,
    completeIntervals: completePoints.length, observedRegionIntervals: points.length, expectedRegionIntervals,
    coverageRatio: expectedRegionIntervals > 0 ? points.length / expectedRegionIntervals : 0,
    complete: expectedRegionIntervals > 0 && points.length === expectedRegionIntervals,
    totalRequests, totalErrors, buckets,
    p50Ms: buckets ? histogramQuantile(0.5, buckets, dataset.histogramBoundsMs) : null,
    p95Ms: buckets ? histogramQuantile(0.95, buckets, dataset.histogramBoundsMs) : null,
    errorRatio: totalRequests !== null && totalRequests > 0 && totalErrors !== null ? totalErrors / totalRequests : null,
    meanRequestRate: completePoints.length ? completePoints.reduce((sum, point) => sum + (point.requests ?? 0), 0) / (completePoints.length * dataset.intervalMs / 1000) : null,
    lastObservedMs, lastCompleteMs,
    freshness: lastObservedMs === null ? 'no-data' : lastCompleteMs === dataset.endMs ? 'current' : 'stale',
  };
}

function relativeChange(before: number | null, after: number | null): number | null {
  return before !== null && before !== 0 && after !== null ? (after - before) / before : null;
}

export function summarize(dataset: TelemetryDataset): TelemetrySummary {
  const overall = populationSummary(dataset);
  const timeline = aggregateTimeline(dataset);
  const halfDuration = Math.floor(overall.expectedIntervals / 2) * dataset.intervalMs;
  const after = populationSummary(selectRange(dataset, dataset.endMs - halfDuration, dataset.endMs));
  const before = populationSummary(selectRange(dataset, dataset.endMs - 2 * halfDuration, dataset.endMs - halfDuration));
  return {
    ...overall,
    latest: timeline.at(-1) ?? null,
    latestObserved: timeline.filter((point) => point.complete).at(-1) ?? null,
    comparison: {
      durationMs: halfDuration,
      excludedLeadingMs: overall.durationMs - 2 * halfDuration,
      before, after,
      p95DeltaMs: before.p95Ms !== null && after.p95Ms !== null ? after.p95Ms - before.p95Ms : null,
      p95RelativeChange: relativeChange(before.p95Ms, after.p95Ms),
      errorPercentagePointChange: before.errorRatio !== null && after.errorRatio !== null ? (after.errorRatio - before.errorRatio) * 100 : null,
      requestRateRelativeChange: relativeChange(before.meanRequestRate, after.meanRequestRate),
    },
    perRegion: dataset.regionIds.map((region) => {
      const meta = REGIONS.find((entry) => entry.id === region)!;
      return { ...populationSummary(selectRange(dataset, dataset.startMs, dataset.endMs, [region])), region, label: meta.label, shortLabel: meta.shortLabel };
    }),
  };
}

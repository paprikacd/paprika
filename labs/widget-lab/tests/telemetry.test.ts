import { describe, expect, it } from 'vitest';
import { aggregateTimeline, BASE_END_MS, buildTelemetry, HISTOGRAM_BOUNDS_MS, histogramQuantile, INTERVAL_MS, secondsToMilliseconds, selectTelemetry, summarize, type TelemetryDataset, type TelemetryPoint } from '../src/data/telemetry';

function twoRegionFixture(requests: [number, number], errors: [number, number], buckets?: [number[], number[]]): TelemetryDataset {
  const source = buildTelemetry('regression');
  const regionIds = ['ap-southeast-2', 'us-west-2'] as const;
  const points: TelemetryPoint[] = regionIds.map((region, i) => {
    const counts = buckets?.[i] ?? HISTOGRAM_BOUNDS_MS.map((_, index) => index === 0 ? requests[i] : 0);
    return { timestampMs: source.endMs, region, requests: requests[i], errors: errors[i], buckets: counts, p50Ms: histogramQuantile(0.5, counts), p95Ms: histogramQuantile(0.95, counts), requestRate: requests[i] / 60, errorRatio: requests[i] > 0 ? errors[i] / requests[i] : null };
  });
  return { ...source, startMs: source.endMs - INTERVAL_MS, regionIds, points };
}

describe('synthetic telemetry semantics', () => {
  it('is deterministic and keeps retained observations stable across rolling revisions', () => {
    const first = buildTelemetry('regression');
    expect(buildTelemetry('regression')).toEqual(first);
    const next = buildTelemetry('regression', 1);
    expect(next.endMs - first.endMs).toBe(INTERVAL_MS);
    expect(first.points.filter((point) => point.timestampMs > next.startMs)).toEqual(next.points.filter((point) => point.timestampMs <= first.endMs));
  });

  it('reconciles every histogram with integer request/error counts in each scenario', () => {
    for (const scenario of ['regression', 'gaps', 'quiet'] as const) {
      const data = buildTelemetry(scenario);
      expect(data.points).toHaveLength(180);
      for (const point of data.points) {
        if (point.requests === null) {
          expect(point.errors).toBeNull();
          expect(point.buckets).toBeNull();
          continue;
        }
        expect(Number.isInteger(point.requests)).toBe(true);
        expect(Number.isInteger(point.errors)).toBe(true);
        expect(point.errors).toBeGreaterThanOrEqual(0);
        expect(point.errors).toBeLessThanOrEqual(point.requests);
        expect(point.buckets).toHaveLength(HISTOGRAM_BOUNDS_MS.length);
        expect(point.buckets!.every((count) => Number.isInteger(count) && count >= 0)).toBe(true);
        expect(point.buckets!.reduce((sum, count) => sum + count, 0)).toBe(point.requests);
      }
    }
  });

  it('weights error ratios by the request population, not by series count', () => {
    const summary = summarize(twoRegionFixture([10, 990], [1, 9]));
    expect(summary.totalRequests).toBe(1000);
    expect(summary.totalErrors).toBe(10);
    expect(summary.errorRatio).toBe(0.01);
    expect(summary.errorRatio).not.toBeCloseTo((1 / 10 + 9 / 990) / 2, 4);
  });

  it('pools distributions before estimating the fleet percentile', () => {
    const a = [95, 5, ...Array(9).fill(0)];
    const b = [0, 10, ...Array(9).fill(0)];
    const summary = summarize(twoRegionFixture([100, 10], [0, 0], [a, b]));
    // 95 samples in [0,50], 15 in (50,100]; target rank is 104.5.
    expect(summary.p95Ms).toBeCloseTo(50 + (9.5 / 15) * 50, 10);
    const incorrectMean = (histogramQuantile(0.95, a)! + histogramQuantile(0.95, b)!) / 2;
    expect(summary.p95Ms).not.toBeCloseTo(incorrectMean, 4);
    expect(summary.latest?.p95Ms).toBe(summary.p95Ms);
  });

  it('leaves internal gaps and the stale tail absent, with coverage and latest value distinct', () => {
    const data = buildTelemetry('gaps');
    const timeline = aggregateTimeline(data);
    const summary = summarize(data);
    expect(timeline.filter((point) => !point.complete)).toHaveLength(8);
    expect(summary.coverageRatio).toBeCloseTo(52 / 60, 12);
    expect(summary.complete).toBe(false);
    expect(summary.freshness).toBe('stale');
    expect(summary.latest?.requestRate).toBeNull();
    expect(summary.latest?.p95Ms).toBeNull();
    expect(summary.lastObservedMs).toBe(BASE_END_MS - 3 * INTERVAL_MS);
    expect(summary.latestObserved?.timestampMs).toBe(summary.lastObservedMs);
    expect(summary.totalRequests).toBeGreaterThan(0);
  });

  it('distinguishes collected zero traffic from missing samples and undefined latency', () => {
    const quiet = buildTelemetry('quiet');
    const zero = quiet.points.find((point) => point.requests === 0)!;
    expect(zero.requestRate).toBe(0);
    expect(zero.errors).toBe(0);
    expect(zero.errorRatio).toBeNull();
    expect(zero.p95Ms).toBeNull();
    expect(zero.buckets!.every((count) => count === 0)).toBe(true);
    const missing = buildTelemetry('gaps').points.find((point) => point.requests === null)!;
    expect(missing.requestRate).toBeNull();
    expect(missing.buckets).toBeNull();
    expect(summarize(quiet).coverageRatio).toBe(1);
  });

  it('does not present a partial region population as a complete fleet interval', () => {
    const source = twoRegionFixture([10, 990], [1, 9]);
    const partial = { ...source, points: source.points.slice(0, 1) };
    const aggregate = aggregateTimeline(partial)[0];
    expect(aggregate.observedRegions).toBe(1);
    expect(aggregate.expectedRegions).toBe(2);
    expect(aggregate.requests).toBeNull();
    expect(aggregate.requestRate).toBeNull();
    const summary = summarize(partial);
    expect(summary.totalRequests).toBe(10);
    expect(summary.coverageRatio).toBe(0.5);
    expect(summary.meanRequestRate).toBeNull();
  });

  it('represents a fully absent result as unavailable rather than a zero total', () => {
    const source = twoRegionFixture([10, 990], [1, 9]);
    const summary = summarize({ ...source, points: [] });
    expect(summary.freshness).toBe('no-data');
    expect(summary.totalRequests).toBeNull();
    expect(summary.totalErrors).toBeNull();
    expect(summary.errorRatio).toBeNull();
    expect(summary.p95Ms).toBeNull();
    expect(summary.coverageRatio).toBe(0);
  });

  it('compares equal complete-interval windows, declaring the odd-minute exclusion', () => {
    const source = buildTelemetry('regression');
    for (const minutes of [15, 30, 60] as const) {
      const selected = selectTelemetry(source, { minutes });
      const { comparison } = summarize(selected);
      expect(comparison.before.durationMs).toBe(comparison.after.durationMs);
      expect(comparison.before.endMs).toBe(comparison.after.startMs);
      expect(comparison.after.endMs).toBe(source.endMs);
      expect(comparison.before.expectedIntervals).toBe(Math.floor(minutes / 2));
      expect(comparison.excludedLeadingMs).toBe((minutes % 2) * INTERVAL_MS);
    }
  });

  it('filters source intervals without mutating identity, source population or original summaries', () => {
    const source = buildTelemetry('regression');
    const original = summarize(source);
    const selected = selectTelemetry(source, { region: 'ap-southeast-2', minutes: 15 });
    expect(selected.points).toHaveLength(15);
    expect(selected.regionIds).toEqual(['ap-southeast-2']);
    expect(selected.points.every((point) => point.timestampMs > selected.startMs && point.timestampMs <= selected.endMs)).toBe(true);
    expect(summarize(source)).toEqual(original);
    expect(source.regionIds).toHaveLength(3);
  });

  it('produces the intended regional regression without inventing a fleet percentile average', () => {
    const source = buildTelemetry('regression');
    const sydney = summarize(selectTelemetry(source, { region: 'ap-southeast-2' }));
    expect(sydney.comparison.before.p95Ms).toBeGreaterThan(200);
    expect(sydney.comparison.before.p95Ms).toBeLessThan(300);
    expect(sydney.comparison.after.p95Ms).toBeGreaterThan(600);
    expect(sydney.comparison.after.p95Ms).toBeLessThan(900);
    const oregon = summarize(selectTelemetry(source, { region: 'us-west-2' }));
    expect(oregon.comparison.after.p95Ms).toBeLessThan(300);
    expect(source.deploymentMs).toBeLessThan(sydney.comparison.after.startMs);
  });

  it('converts numerical seconds into milliseconds exactly once', () => {
    expect(secondsToMilliseconds(0.125)).toBe(125);
    expect(secondsToMilliseconds(0.2)).toBe(200);
    expect(secondsToMilliseconds(null)).toBeNull();
    expect(() => secondsToMilliseconds(Infinity)).toThrow(RangeError);
  });

  it('rejects malformed distributions and returns no percentile for zero observations', () => {
    expect(histogramQuantile(0.95, [0, 0], [100, 200])).toBeNull();
    expect(() => histogramQuantile(1.1, [1], [100])).toThrow(RangeError);
    expect(() => histogramQuantile(0.95, [1, -1], [100, 200])).toThrow(RangeError);
    expect(() => histogramQuantile(0.95, [1, 1], [200, 100])).toThrow(RangeError);
    expect(() => histogramQuantile(0.95, [1], [100, 200])).toThrow(RangeError);
    expect(() => histogramQuantile(0.95, [NaN], [100])).toThrow(RangeError);
    expect(() => buildTelemetry('regression', -1)).toThrow(RangeError);
    expect(() => buildTelemetry('regression', 1e308)).toThrow(RangeError);
  });

  it('rejects duplicate region timestamps rather than doubling the measured population', () => {
    const source = twoRegionFixture([10, 990], [1, 9]);
    expect(() => summarize({ ...source, points: [...source.points, source.points[0]] })).toThrow(/Duplicate/);
  });
});

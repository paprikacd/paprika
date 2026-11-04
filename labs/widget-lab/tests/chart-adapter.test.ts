import { describe, expect, it } from 'vitest';
import { buildTelemetry, aggregateTimeline, HISTOGRAM_BOUNDS_MS, selectTelemetry } from '../src/data/telemetry';
import { makeChartResults, LATENCY_WIDGET, TRAFFIC_WIDGET, ERROR_WIDGET, DISTRIBUTION_WIDGET } from '../src/data/chart-adapter';
import { widgetSchema } from '@insights/schema';

describe('Paprika widget adapters', () => {
  it('uses valid production widget configurations', () => {
    for (const widget of [LATENCY_WIDGET, TRAFFIC_WIDGET, ERROR_WIDGET, DISTRIBUTION_WIDGET]) expect(widgetSchema.safeParse(widget).success).toBe(true);
  });
  it('converts ratio fractions into actual percentage values', () => {
    const dataset = buildTelemetry('regression');
    const timeline = aggregateTimeline(dataset);
    const result = makeChartResults(dataset);
    expect(result.errors.series![0].points[20].value).toBeCloseTo(timeline[19].errorRatio! * 100, 12);
  });
  it('cumulates disjoint bins exactly once and preserves the request total', () => {
    const dataset = buildTelemetry('regression');
    const timeline = aggregateTimeline(dataset);
    const result = makeChartResults(dataset).distribution;
    result.series!.forEach((series, bin) => {
      expect(series.labels.le).toBe(String(HISTOGRAM_BOUNDS_MS[bin]));
      expect(series.points[30].value).toBe(timeline[30].buckets!.slice(0, bin + 1).reduce((sum, n) => sum + n, 0));
    });
    expect(result.series!.at(-1)!.points[30].value).toBe(timeline[30].requests);
  });
  it('retains null gaps and common time-domain anchors', () => {
    const dataset = selectTelemetry(buildTelemetry('gaps'), { minutes: 30 });
    const result = makeChartResults(dataset);
    for (const chart of [result.latency, result.traffic, result.errors]) for (const series of chart.series!) {
      expect(series.points[0]).toEqual({ timestamp: dataset.startMs, value: null });
      expect(series.points.at(-1)).toEqual({ timestamp: dataset.endMs, value: null });
    }
    expect(result.distribution.series!.every(series => series.points.at(-1)!.value === null)).toBe(true);
  });
});

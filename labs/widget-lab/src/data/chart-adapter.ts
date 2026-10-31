import type { QueryResult, Widget } from '../vendor/paprika/ui/src/features/insights/schema';
import { aggregateTimeline, type TelemetryDataset } from './telemetry';

const base = { providerId: 'synthetic-fixture', query: 'deterministic_evaluation_fixture', layout: { x: 0, y: 0, w: 6, h: 4 } };
const options = { curve: 'linear' as const, showGrid: true, showLegend: true, showTooltip: true, min: 0, lineWidth: 2, decimals: 0 };
export const LATENCY_WIDGET: Widget = { ...base, id: 'latency', title: 'Request latency', type: 'timeseries', unit: 'ms', options: { ...options, display: 'line' } };
export const TRAFFIC_WIDGET: Widget = { ...base, id: 'traffic', title: 'Request volume', type: 'timeseries', unit: 'req/s', options: { ...options, display: 'area', fillOpacity: 0.11, decimals: 2 } };
export const ERROR_WIDGET: Widget = { ...base, id: 'errors', title: 'Error rate', type: 'timeseries', unit: '%', options: { ...options, display: 'line', decimals: 2 } };
export const DISTRIBUTION_WIDGET: Widget = {
  ...base, id: 'distribution', title: 'Latency distribution', type: 'plugin', pluginId: 'distribution-heatmap', dataKind: 'metrics', unit: 'ms',
  config: { bucketLabel: 'le', bucketUnit: 'ms', densityUnit: 'requests/min', aggregation: 'none', maxBuckets: 12, maxColumns: 60 },
  options: { showLegend: true, showTooltip: true, decimals: 0 },
};

export function makeChartResults(dataset: TelemetryDataset) {
  const timeline = aggregateTimeline(dataset);
  const labels = { service: 'checkout-api', population: dataset.regionIds.join(',') };
  const series = (name: string, values: (number | null)[]) => ({
    name, labels,
    // An unobserved start anchor fixes the visible domain without inventing a value.
    points: [{ timestamp: dataset.startMs, value: null }, ...timeline.map((point, index) => ({ timestamp: point.timestampMs, value: values[index] }))],
  });
  const latency: QueryResult = { series: [series('p95', timeline.map(point => point.p95Ms)), series('p50', timeline.map(point => point.p50Ms))] };
  const traffic: QueryResult = { series: [series('Requests', timeline.map(point => point.requestRate))] };
  const errors: QueryResult = { series: [series('Failed / total', timeline.map(point => point.errorRatio === null ? null : point.errorRatio * 100))] };
  const distribution: QueryResult = {
    series: dataset.histogramBoundsMs.map((upper, bin) => ({
      name: `≤ ${upper} ms`, labels: { ...labels, le: String(upper) },
      points: timeline.map(point => ({ timestamp: point.timestampMs, value: point.buckets === null ? null : point.buckets.slice(0, bin + 1).reduce((sum, count) => sum + count, 0) })),
    })),
  };
  return { latency, traffic, errors, distribution };
}

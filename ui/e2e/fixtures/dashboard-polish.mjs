// Disposable, deterministic observations for the local design loop. No live providers.
export const polishRange = { from: '2026-11-09T00:00:00.000Z', to: '2026-11-09T01:00:00.000Z' };
export const polishPods = ['checkout-api-production-europe-primary-7c9c6b8f5d-k4w2n', 'checkout-api-production-europe-secondary-6b8d49f57c-p8m3q', 'checkout-worker-production-background-5d6c87b9f4-r7v2x'];
const colours = ['#2867b9', '#7c58ad', '#bb5037'];
const percentileColours = ['p50', 'p95', 'p99'].map((value, i) => ({ label: 'quantile', value, color: colours[i] }));

export function polishDashboards(providerId) {
  const widget = (id, title, type, query, unit, layout, extra = {}) => ({ id, title, type, providerId, query, unit, layout, ...extra });
  const board = (id, title, widgets, extra = {}) => ({ schemaVersion: 1, id, title,
    description: 'Local design playground · synthetic observations, including gaps and long labels.',
    timeRange: '1h', customTimeRange: polishRange, timeZone: 'UTC', refreshInterval: 0, widgets, ...extra });
  const detail = { id: 'workload', title: 'Inspect workload', dashboardId: 'local-polish-workload', carryTimeRange: true,
    bindings: [{ variable: 'service', source: 'label', value: 'service' }, { variable: 'reading', source: 'value' }] };
  return [board('local-polish-service', 'Service investigation', [
    widget('requests', 'Request rate', 'stat', 'fixture_requests', 'req/s', { x: 0, y: 0, w: 4, h: 2 }, { color: colours[0], options: { decimals: 1, showSparkline: true, sparklinePlacement: 'side' } }),
    widget('latency', 'p95 latency', 'stat', 'fixture_p95', 'ms', { x: 4, y: 0, w: 4, h: 2 }, { color: colours[1], options: { decimals: 1, showSparkline: true, sparklinePlacement: 'side' } }),
    widget('errors', 'Server errors', 'stat', 'fixture_errors', '%', { x: 8, y: 0, w: 4, h: 2 }, { color: colours[2], options: { decimals: 2, showSparkline: true, sparklinePlacement: 'side' } }),
    widget('percentiles', 'Request latency', 'timeseries', 'fixture_percentiles', 'ms', { x: 0, y: 2, w: 6, h: 6 }, {
      options: { decimals: 1, seriesColors: percentileColours }, drilldowns: [detail] }),
    widget('cpu', 'CPU by workload', 'plugin', 'fixture_cpu', 'cores', { x: 6, y: 2, w: 6, h: 6 }, {
      pluginId: 'stacked-timeseries', dataKind: 'metrics', options: { decimals: 2 },
      config: { display: 'area', legendDisplay: 'table', legendPosition: 'bottom', seriesColors: polishPods.map((value, i) => ({ label: 'pod', value, color: colours[i] })) },
      drilldowns: [{ ...detail, bindings: [...detail.bindings, { variable: 'pod', source: 'label', value: 'pod' }] }] }),
  ]), board('local-polish-workload', 'Workload detail', [
    widget('detail-latency', 'Latency for selected service', 'timeseries', 'fixture_percentiles{service={{service}}}', 'ms', { x: 0, y: 0, w: 12, h: 6 }, { options: { decimals: 1, seriesColors: percentileColours } }),
  ], { timeRange: '6h', customTimeRange: { from: '2026-11-08T19:00:00.000Z', to: polishRange.to }, variables: [
    { name: 'service', label: 'Service', defaultValue: 'payments-worker', options: ['payments-worker', 'checkout-api'] },
    { name: 'pod', label: 'Pod', defaultValue: 'all' },
    { name: 'reading', label: 'Selected reading', defaultValue: '' },
  ] })];
}

export function polishQuery(request, reversed = false) {
  const metric = request.query.split('{')[0];
  const filter = request.query.match(/\bservice=("(?:\\.|[^"\\])*")/);
  const service = filter ? JSON.parse(filter[1]) : 'checkout-api';
  if (!['checkout-api', 'payments-worker'].includes(service)) return { series: [] };
  const start = Date.parse(polishRange.from), step = 60000;
  const points = (base, scale, gaps = []) => Array.from({ length: 61 }, (_, i) => ({ timestamp: start + i * step, value: gaps.includes(i) ? null : base + scale * Math.sin(i / 6) + i * scale / 60 }));
  let series;
  if (metric === 'fixture_cpu') series = polishPods.map((pod, i) => {
    const labels = { __name__: 'container_cpu_usage', namespace: 'production', pod, service: 'checkout-api' };
    return { name: `${labels.__name__}{namespace="production", pod=${JSON.stringify(pod)}, service="checkout-api"}`, labels, points: points((i + 1) * 0.12, 0.035, i === 1 ? [30, 31, 32, 59, 60] : []) };
  });
  else if (metric === 'fixture_percentiles') {
    const scale = service === 'payments-worker' ? 1.4 : 1;
    series = ['p50', 'p95', 'p99'].map((name, i) => ({ name, labels: { service, quantile: name }, points: points([22, 120, 240][i] * scale, [6, 22, 38][i] * scale, i === 1 ? [25, 26, 27] : []) }));
  }
  else if (metric === 'fixture_requests') series = [{ name: 'Requests', labels: { service: 'checkout-api' }, points: points(820, 110) }];
  else if (metric === 'fixture_p95') series = [{ name: 'p95', labels: { service: 'checkout-api' }, points: points(120, 22) }];
  else if (metric === 'fixture_errors') series = [{ name: 'Server errors', labels: { service: 'checkout-api' }, points: points(0.17, 0.06) }];
  else throw new Error(`Unknown local polish fixture: ${request.query}`);
  return { series: reversed ? series.reverse() : series };
}

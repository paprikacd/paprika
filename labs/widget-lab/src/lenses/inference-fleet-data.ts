import type { QueryResult, RecordColumn, Widget } from '../vendor/paprika/ui/src/features/insights/schema';
import { rackMatrixConfig, requestFlowConfig, logScatterConfig } from '../charts/inference/data';
import { normalizeTimeWindow, observationsInWindow, type ChartTimeWindow } from '../vendor/paprika/ui/src/features/insights/time-window';

export const INFERENCE_AS_OF = Date.UTC(2026, 9, 31, 16);
export const INFERENCE_SAMPLE_INTERVAL = 5 * 60_000;
export const INFERENCE_MODELS = ['llama-3-70b', 'mixtral-8x22b', 'phi-3-mini', 'gemma-7b', 'qwen-72b', 'claude-3-haiku'];
export const INFERENCE_REGIONS = ['US-EAST', 'US-WEST', 'EU-CENTRAL', 'AP-SOUTH'];
export type InferenceScope = { region: string; model: string; hours: 1 | 6 };
export type InferencePanel = { widget: Widget; result: QueryResult };
const bases = [21400, 17100, 12600, 7100], modelWeights = [.38, .21, .16, .09, .1, .06], medians = [83, 173, 24, 595, 380, 67];
export const LATENCY_BOUNDS = [10, 16, 25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, Infinity];
const round = (n: number, places = 1) => Number(n.toFixed(places));

/** Accept whole source intervals so both independent renderers infer exactly the same domain. */
export function inferenceObservationWindow(candidate: ChartTimeWindow, timestamps: readonly number[], minimumSpan = INFERENCE_SAMPLE_INTERVAL * 2): ChartTimeWindow | null {
  const source = [...new Set(timestamps.filter(Number.isFinite))].sort((a, b) => a - b);
  if (source.length < 2) return null;
  const extent = { start: source[0], end: source.at(-1)! };
  const bounded = normalizeTimeWindow(candidate, extent, minimumSpan);
  if (!bounded) return null;
  // Outward snapping retains every source observation in the requested interval.
  // It never inserts interpolated boundary values or converts a null into zero.
  const start = source.findLast(timestamp => timestamp <= bounded.start) ?? extent.start;
  const end = source.find(timestamp => timestamp >= bounded.end) ?? extent.end;
  return normalizeTimeWindow({ start, end }, extent, minimumSpan);
}

/** A paired view preserves source values, labels, nulls, and result metadata. */
export function inferenceResultInWindow(result: QueryResult, window: ChartTimeWindow): QueryResult {
  return { ...result, series: result.series?.map(series => ({ ...series, points: observationsInWindow(series.points, window) })) };
}
export function inferenceGpuRecords(scope: Pick<InferenceScope, 'region' | 'model'>) {
  const columns: RecordColumn[] = [{ key: 'id', type: 'string' }, { key: 'rack', type: 'string' }, { key: 'slot', type: 'string' }, { key: 'region', type: 'string' }, { key: 'utilization', type: 'number', unit: '%' }, { key: 'model', type: 'string' }, { key: 'memory', type: 'number', unit: 'GB' }, { key: 'temperature', type: 'number', unit: '°C' }, { key: 'queue', type: 'number', unit: 'requests' }, { key: 'memory_capacity', type: 'number', unit: 'GB' }, ...Array.from({ length: 18 }, (_, i): RecordColumn => ({ key: `history_${String(i).padStart(2, '0')}`, type: 'number', unit: '%' }))];
  const rows = Array.from({ length: 128 }, (_, i) => {
    const rack = Math.floor(i / 8), model = INFERENCE_MODELS[i % 6], region = INFERENCE_REGIONS[Math.floor(rack / 4)], missing = [13, 45, 91, 121].includes(i), utilization = i === 72 ? 94 : round(14 + ((i * 37 + i % 7 * 11) % 82));
    const history = Array.from({ length: 18 }, (_, j) => missing ? null : round(Math.max(0, Math.min(100, utilization - (17 - j) * .7 + Math.sin(j * 1.8 + i) * 3.1))));
    history[17] = missing ? null : utilization;
    return [`gpu-${String(i + 1).padStart(3, '0')}`, `R${String(rack + 1).padStart(2, '0')}`, `GPU ${i % 8}`, region, missing ? null : utilization, model, missing ? null : round(23 + utilization * .51), missing ? null : Math.round(38 + utilization * .4), missing ? null : Math.round(utilization * 2.8 + i % 9 * 12), 80, ...history];
  }).filter(row => (scope.region === 'all' || row[3] === scope.region) && (scope.model === 'all' || row[5] === scope.model));
  return { columns, rows };
}

export function inferenceRoutes(scope: Pick<InferenceScope, 'region' | 'model'>) {
  const rows: (string | number)[][] = [];
  INFERENCE_REGIONS.forEach((region, r) => INFERENCE_MODELS.forEach((model, m) => {
    if (scope.region !== 'all' && scope.region !== region || scope.model !== 'all' && scope.model !== model) return;
    const total = Math.round(bases[r] * modelWeights[m]), rejected = Math.round(total * [.007, .011, .002, .028, .019, .004][m]);
    rows.push([region, model, 'Successful', total - rejected], [region, model, 'Rejected', rejected]);
  }));
  return { columns: [{ key: 'region', type: 'string' }, { key: 'model', type: 'string' }, { key: 'outcome', type: 'string' }, { key: 'requests', type: 'number', unit: 'req/s' }] as RecordColumn[], rows };
}
/** Quantile estimate from one pooled cumulative histogram, never a mean of instance quantiles. */
export function histogramQuantile(bounds: readonly number[], cumulative: readonly number[], quantile: number) {
  const total = cumulative.at(-1) ?? 0; if (!(total > 0)) return null;
  const target = total * quantile;
  for (let i = 0; i < cumulative.length; i++) if (cumulative[i] >= target) {
    if (!Number.isFinite(bounds[i])) return bounds[Math.max(0, i - 1)];
    const lower = i ? bounds[i - 1] : 0, previous = i ? cumulative[i - 1] : 0;
    return lower + (bounds[i] - lower) * (target - previous) / Math.max(1e-12, cumulative[i] - previous);
  }
  return null;
}
function weightsAt(model: number, step: number) {
  const median = medians[model] * (1 + .12 * Math.sin(step * .24 + model) + .8 * Math.exp(-(((step - 62) / 3) ** 2)));
  const weights = LATENCY_BOUNDS.map((upper, i) => {
    const center = Number.isFinite(upper) ? Math.sqrt((i ? LATENCY_BOUNDS[i - 1] : 1) * upper) : 16000;
    return Math.exp(-.5 * (Math.log(center / median) / .55) ** 2) + .00001;
  });
  const total = weights.reduce((a, b) => a + b, 0); return weights.map(x => x / total);
}

export function buildInferenceFleet(scope: InferenceScope = { region: 'all', model: 'all', hours: 6 }) {
  const gpus = inferenceGpuRecords(scope), routes = inferenceRoutes(scope);
  const requestRate = routes.rows.reduce((sum, row) => sum + Number(row[3]), 0), rejected = routes.rows.filter(row => row[2] === 'Rejected').reduce((sum, row) => sum + Number(row[3]), 0);
  const modelRates = INFERENCE_MODELS.map(model => routes.rows.filter(row => row[1] === model).reduce((sum, row) => sum + Number(row[3]), 0));
  const allTimes = Array.from({ length: 73 }, (_, i) => INFERENCE_AS_OF - (72 - i) * INFERENCE_SAMPLE_INTERVAL), from = 73 - (scope.hours * 12 + 1), times = allTimes.slice(from);
  const cumulative = LATENCY_BOUNDS.map(() => [] as Array<number | null>);
  const queues: Array<number | null> = [];
  const latestQueue = gpus.rows.reduce((sum, row) => sum + Number(row[8] ?? 0), 0);
  const queueShape = (step: number) => 5500 + 2700 * Math.exp(-step / 10) + Math.sin(step * 1.7) * 530 + 23800 * Math.exp(-(((step - 64) / 3) ** 2));
  allTimes.forEach((_, step) => {
    const missing = step >= 40 && step <= 44;
    const counts = LATENCY_BOUNDS.map(() => 0);
    modelRates.forEach((rate, m) => { const weights = weightsAt(m, step); weights.forEach((weight, b) => counts[b] += rate * weight); });
    let sum = 0; counts.forEach((count, b) => { sum += count; cumulative[b].push(missing ? null : sum); });
    queues.push(missing ? null : Math.round(latestQueue * queueShape(step) / queueShape(72)));
  });
  const p95 = histogramQuantile(LATENCY_BOUNDS, cumulative.map(values => values[72] ?? 0), .95);
  const base = (id: string, title: string, pluginId: string, dataKind: 'metrics' | 'records' = 'records'): Widget => ({ id: `inference-${id}`, title, type: 'plugin', pluginId, dataKind, providerId: 'inference-fixture', query: 'synthetic.inference.fleet', unit: '', layout: { x: 0, y: 0, w: 6, h: 6 }, options: { showTooltip: true, showLegend: true, decimals: 1 } });
  const rack: InferencePanel = { widget: { ...base('rack', 'Rack × GPU matrix', 'rack-matrix'), unit: '%', config: rackMatrixConfig.parse({ initialSelection: scope.region === 'all' && scope.model === 'all' ? 'gpu-073' : '' }) }, result: { records: gpus } };
  const histogram: InferencePanel = { widget: { ...base('latency', 'Latency distribution', 'distribution-heatmap', 'metrics'), unit: 'ms', config: { bucketLabel: 'le', bucketUnit: 'ms', densityUnit: 'req/s', aggregation: 'none', maxBuckets: 24, maxColumns: 120 }, options: { timeAxis: 'calendar', plotInsetLeft: 110, plotInsetRight: 12, decimals: 1, showTooltip: true, showLegend: true } }, result: { series: LATENCY_BOUNDS.map((bound, b) => ({ name: `TTFT ≤ ${bound}ms`, labels: { le: Number.isFinite(bound) ? String(bound) : '+Inf', scope: 'pooled fleet', fixture: 'synthetic' }, points: times.map((timestamp, i) => ({ timestamp, value: cumulative[b][i + from] })) })) } };
  const queue: InferencePanel = { widget: { id: 'inference-queue', title: 'Queue depth', type: 'timeseries', providerId: 'inference-fixture', query: 'synthetic.inference.queue', unit: 'requests', color: '#11cde6', layout: { x: 0, y: 0, w: 6, h: 3 }, options: { display: 'area', timeAxis: 'calendar', plotInsetLeft: 110, plotInsetRight: 12, showGrid: true, showLegend: false, showTooltip: true, min: 0, fillStyle: 'gradient', fillOpacity: .12, lineWidth: 1.4, curve: 'linear', inspectorDensity: 'compact', decimals: 0 } }, result: { series: [{ name: 'Waiting requests', labels: { fixture: 'synthetic', population: 'selected model and region' }, points: times.map((timestamp, i) => ({ timestamp, value: queues[i + from] })) }] } };
  const routing: InferencePanel = { widget: { ...base('routing', 'Request routing', 'request-flow'), unit: 'req/s', config: requestFlowConfig.parse({}) }, result: { records: routes } };
  const scatterRows = INFERENCE_MODELS.flatMap((model, m) => modelRates[m] > 0 ? times.flatMap((timestamp, i) => {
    const step = i + from, throughput = [1450, 100, 4, 12, 85, 310][m] * Math.exp(Math.sin(step * 2.37 + m) * 1.03 + Math.cos(step * .31 + m) * .42), ttft = medians[m] * Math.exp(Math.sin(step * 1.71 + m) * .35 + Math.cos(step * .19) * .2);
    return step >= 40 && step <= 44 ? [] : [[`${model}-${timestamp}`, model, new Date(timestamp).toISOString(), round(throughput, 2), round(ttft, 2)]];
  }) : []);
  const scatter: InferencePanel = { widget: { ...base('scatter', 'TTFT vs output throughput', 'log-scatter'), config: logScatterConfig.parse({}), unit: 'ms' }, result: { records: { columns: [{ key: 'id', type: 'string' }, { key: 'model', type: 'string' }, { key: 'timestamp', type: 'timestamp' }, { key: 'throughput', type: 'number', unit: 'tokens/s' }, { key: 'ttft', type: 'number', unit: 'ms' }], rows: scatterRows } } };
  const workloads = INFERENCE_MODELS.flatMap((model, m) => {
    if (scope.model !== 'all' && scope.model !== model) return [];
    const devices = gpus.rows.filter(row => row[5] === model), active = devices.filter(row => row[4] !== null);
    const ownHistogram = weightsAt(m, 72).reduce<number[]>((out, value) => [...out, (out.at(-1) ?? 0) + value * modelRates[m]], []);
    const modelP95 = histogramQuantile(LATENCY_BOUNDS, ownHistogram, .95) ?? 0;
    return [{ model, pool: ['general', 'general', 'low-latency', 'cost-optimized', 'general', 'low-latency'][m], gpus: devices.length, active: active.length, queue: active.reduce((sum, row) => sum + Number(row[8]), 0), p95: modelP95, tokens: Math.round(modelRates[m] * [61, 44, 35, 39, 55, 32][m]), cost: [.7, .6, .2, .18, .28, .25][m], state: modelP95 > 350 ? '>350ms target' : 'Within 350ms', history: times.slice(-18).map((_, i) => round(medians[m] * (1 + Math.sin(i * 2 + m) * .15))) }];
  });
  const workloadPanel: InferencePanel = { widget: { ...base('workloads', 'Active workloads', 'record-table'), color: '#18cebc', config: { columns: ['model', 'pool', 'active', 'capacity', 'coverage', 'queue', 'p95', 'tokens', 'cost', 'state'], density: 'compact', showSearch: true, pageSize: 10, cellStyles: [{ column: 'coverage', display: 'bar', min: 0, max: 100 }, { column: 'p95', display: 'color-text' }] }, options: { decimals: 1, thresholds: [{ value: 0, label: 'Within synthetic 350ms target', color: '#18cebc' }, { value: 350, label: 'At or above synthetic 350ms target', color: '#efb24d' }] } }, result: { records: { columns: [{ key: 'model', label: 'Model', type: 'string' }, { key: 'pool', label: 'Pool', type: 'string' }, { key: 'active', label: 'Reporting GPUs', type: 'number' }, { key: 'capacity', label: 'Total GPUs', type: 'number' }, { key: 'coverage', label: 'Telemetry coverage', type: 'number', unit: '%' }, { key: 'queue', label: 'Queue (reqs)', type: 'number' }, { key: 'p95', label: 'p95 TTFT', type: 'number', unit: 'ms' }, { key: 'tokens', label: 'Output', type: 'number', unit: 'tokens/s' }, { key: 'cost', label: 'USD / 1M tokens', type: 'number' }, { key: 'state', label: 'Synthetic policy', type: 'string' }], rows: workloads.map(w => [w.model, w.pool, w.active, w.gpus, w.gpus ? w.active / w.gpus * 100 : null, w.queue, round(w.p95), w.tokens, w.cost, w.state]) } } };
  return { rack, histogram, queue, routing, scatter, workloadPanel, workloads, times, summary: { gpus: gpus.rows.length, online: gpus.rows.filter(row => row[4] !== null).length, requestRate, rejected, tokens: workloads.reduce((sum, model) => sum + model.tokens, 0), p95 } };
}

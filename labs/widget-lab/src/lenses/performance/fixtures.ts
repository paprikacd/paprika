import type { QueryResult, RecordFrame, Widget } from '@insights/schema';
import { profileFromStacks, type WeightedStack } from '../../charts/profiling/profile-model';
import { differentialProfile, empiricalQuantile, pairedPerformance, performanceObservations, performanceTrace, type Build } from '../../charts/performance/model';

export const PERFORMANCE_START = Date.UTC(2026, 9, 31, 12, 50);
export const PERFORMANCE_ROUTES = [
  { id: 'checkout', label: 'POST /checkout', service: 'checkout-api', handler: 'checkout.Handle', before: 402, after: 628, phasesBefore: [10, 25, 38, 26, 80, 137, 86], phasesAfter: [23, 34, 48, 34, 96, 212, 181] },
  { id: 'catalog', label: 'GET /catalog', service: 'catalog-api', handler: 'catalog.List', before: 184, after: 242, phasesBefore: [5, 14, 30, 16, 28, 55, 36], phasesAfter: [7, 16, 38, 19, 34, 62, 66] },
  { id: 'search', label: 'GET /search', service: 'search-api', handler: 'search.Query', before: 270, after: 438, phasesBefore: [8, 20, 40, 18, 42, 90, 52], phasesAfter: [12, 28, 54, 24, 50, 142, 128] },
] as const;
export type PerformanceRoute = typeof PERFORMANCE_ROUTES[number]['id'];
export const performanceFrame = (columns: RecordFrame['columns'], rows: RecordFrame['rows']): QueryResult => ({ records: { columns, rows } });
const column = (key: string, type: 'number' | 'string' | 'boolean', unit?: string) => ({ key, type, ...(unit ? { unit } : {}) });
const round = (value: number, digits = 3) => Number(value.toFixed(digits));
const pairId = (index: number) => `req-${String(index).padStart(3, '0')}`;
const definition = (id: string, title: string, pluginId: string, config: Widget['config'] = {}): Widget => ({ id, title, type: 'plugin', pluginId, dataKind: 'records', providerId: 'synthetic-performance', query: `fixture.performance.${id}`, unit: '', config, options: { showTooltip: true, showLegend: true, decimals: 1 }, layout: { x: 0, y: 0, w: 6, h: 5 } });

function workloadShape(seed: number, count = 480) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ state >>> 15, state | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
  // One jittered rank per stratum retains a known sparse tail. Shuffling breaks
  // the old cyclic rank/time relationship without creating weighted requests.
  const quantiles = Array.from({ length: count }, (_, rank) => (rank + .15 + random() * .7) / count);
  for (let i = quantiles.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [quantiles[i], quantiles[j]] = [quantiles[j], quantiles[i]];
  }
  let load = 1;
  const loads = Array.from({ length: Math.ceil(count / 20) }, () => { load = .68 * load + .32 * (.82 + random() * .36); return load; });
  // Each identity shares its workload rank, baseline floor and jitter across
  // builds. Variation belongs to the synthetic observations, not chart effects.
  return quantiles.map((quantile, index) => ({ quantile, floor: 12 + random() * 12, factor: loads[Math.floor(index / 20)] * (.94 + random() * .12) }));
}

/** 480 matched request identities × two builds: complete population remains under 1,000 rows. */
export function performanceRequestFixture(route: PerformanceRoute = 'checkout', gaps = false) {
  const scope = PERFORMANCE_ROUTES.find(item => item.id === route)!;
  const shape = workloadShape(route === 'checkout' ? 0x51ab7e21 : route === 'catalog' ? 0x82b193ad : 0xd39142c7);
  const rows: RecordFrame['rows'] = [];
  for (let i = 0; i < 480; i++) {
    const { quantile, floor, factor } = shape[i], bucket = Math.floor(i / 20), timestamp = PERFORMANCE_START + bucket * 120000 + i % 20 * 5000;
    for (const version of ['before', 'after'] as Build[]) {
      const endpoint = scope[version], exponent = version === 'before' ? 3.2 : 2.7;
      const latency = i === 217 ? endpoint : i === 83 ? endpoint * .83 : (floor + (endpoint - floor) * (quantile / .99) ** exponent) * factor;
      const cpu = (version === 'before' ? 7 : 11) + latency * (version === 'before' ? .09 : .18);
      const allocations = (version === 'before' ? 450 : 920) + latency * (version === 'before' ? .8 : 2.6);
      const bytes = (version === 'before' ? 7900 : 16800) + latency * (version === 'before' ? 14 : 36);
      const missing = gaps && i % 47 === 0 && version === 'after';
      rows.push([pairId(i), scope.label, version, timestamp, missing ? null : round(latency), missing ? null : round(cpu), missing ? null : Math.round(allocations), missing ? null : Math.round(bytes), version === 'after' ? i > 475 : i > 477]);
    }
  }
  return performanceFrame([column('pair', 'string'), column('route', 'string'), column('version', 'string'), column('timestamp', 'number', 'ms'), column('latency', 'number', 'ms'), column('cpu', 'number', 'ms'), column('allocations', 'number', 'count'), column('bytes', 'number', 'bytes'), column('error', 'boolean')], rows);
}

function traceFixture(route: PerformanceRoute, request: string, build: Build) {
  const scope = PERFORMANCE_ROUTES.find(item => item.id === route)!;
  const observation = performanceObservations(performanceRequestFixture(route).records!).find(row => row.pair === request && row.version === build);
  if (!observation) throw new Error('Choose an existing request before opening its trace.');
  const duration = observation.latency!, factor = duration / scope[build], traceId = `8f2a-${route}-${request}-${build}`;
  const rootStatus = observation.error ? 'error' : 'ok';
  // The request outcome is known; its error flag does not identify a failed child.
  const childStatus = observation.error ? 'unknown' : 'ok';
  const rows: RecordFrame['rows'] = [['request', null, scope.service, scope.label, 0, duration, rootStatus, traceId, false, scope.handler]];
  const ids = ['queue', 'validate', 'inventory', 'pricing', 'payment', 'database', 'serialize'];
  const operations = ['queue wait', 'validate request', 'inventory RPC', 'pricing RPC', 'payment RPC', 'database wait', 'serialize response'];
  const functions = [null, 'validateRequest', 'inventory.Client.Reserve', 'pricing.Client.Quote', 'payment.Client.Charge', 'database.Query', 'encoding/json.Marshal'];
  let start = 0;
  ids.forEach((id, i) => {
    const amount = i === ids.length - 1 ? duration - start : (build === 'before' ? scope.phasesBefore[i] : scope.phasesAfter[i]) * factor;
    rows.push([id, 'request', i === 5 ? 'postgres' : i > 1 && i < 5 ? `${id}-svc` : scope.service, operations[i], start, amount, childStatus, traceId, true, functions[i]]);
    if (id === 'payment') rows.push(['payment-cache', id, 'redis', 'cached authorization lookup', start + amount * .12, amount * .22, childStatus, traceId, false, null]);
    if (id === 'database') rows.push(['sql-scan', id, 'postgres', 'row scan', start + amount * .12, amount * .74, childStatus, traceId, false, 'pgconn.Exec']);
    start += amount;
  });
  return { result: performanceFrame([column('spanId', 'string'), column('parentId', 'string'), column('service', 'string'), column('operation', 'string'), column('startMs', 'number', 'ms'), column('durationMs', 'number', 'ms'), column('status', 'string'), column('traceId', 'string'), column('phase', 'boolean'), column('functionName', 'string')], rows), observation };
}

const stacks: { path: string[]; before: number; after: number }[] = [
  { path: ['processOrder', 'validateRequest', 'schema.Validate'], before: 7, after: 4 },
  { path: ['processOrder', 'inventory.Client.Reserve', 'net/http.Client.Do'], before: 5, after: 3 },
  { path: ['processOrder', 'pricing.Client.Quote', 'net/http.Client.Do'], before: 4, after: 3 },
  { path: ['processOrder', 'payment.Client.Charge', 'net/http.Client.Do', 'syscall.Write'], before: 10, after: 6 },
  { path: ['processOrder', 'payment.Client.Charge', 'crypto/tls.Handshake'], before: 7, after: 3 },
  { path: ['processOrder', 'payment.Client.Charge', 'cache.Lookup'], before: 3, after: 1 },
  { path: ['processOrder', 'database.Query', 'pgconn.Exec', 'runtime.netpoll'], before: 20, after: 13 },
  { path: ['processOrder', 'database.Query', 'pgconn.Exec', 'decode.Row'], before: 10, after: 7 },
  { path: ['processOrder', 'buildResponse', 'encoding/json.Marshal', 'reflect.Value.Marshal', 'bytes.Buffer.Write'], before: 6, after: 13 },
  { path: ['processOrder', 'buildResponse', 'encoding/json.Marshal', 'reflect.Value.Marshal', 'runtime.mallocgc'], before: 5, after: 9 },
  { path: ['processOrder', 'buildResponse', 'encoding/json.Marshal', 'mapEncoder.encode', 'sort.Strings'], before: 3, after: 8 },
  { path: ['processOrder', 'buildResponse', 'encoding/json.Marshal', 'mapEncoder.encode', 'runtime.mallocgc'], before: 5, after: 12 },
  { path: ['processOrder', 'buildResponse', 'encoding/json.Marshal', 'stringEncoder', 'bytes.Buffer.grow'], before: 4, after: 5 },
  { path: ['processOrder', 'buildResponse', 'encoding/json.Marshal', 'stringEncoder', 'utf8.EncodeRune'], before: 2, after: 4 },
  { path: ['processOrder', 'buildResponse', 'encodeMetadata'], before: 4, after: 3 },
  { path: ['middleware.Authenticate', 'token.Verify'], before: 3, after: 2 },
  { path: ['middleware.Authenticate', 'cache.Lookup'], before: 2, after: 1 },
  { path: ['middleware.Telemetry', 'trace.End'], before: 2, after: 1 },
];

/** Reuses canonical aggregate profile accounting. This is not a native differential Pyroscope import. */
export function performanceProfileFixture(route: PerformanceRoute = 'checkout') {
  const scope = PERFORMANCE_ROUTES.find(item => item.id === route)!, requests = performanceObservations(performanceRequestFixture(route).records!);
  const profiles = (['before', 'after'] as Build[]).map(build => {
    const total = requests.filter(row => row.version === build).reduce((sum, row) => sum + row.cpu!, 0), weights = stacks.reduce((sum, item) => sum + item[build], 0);
    const values: WeightedStack[] = stacks.map(item => ({ stack: [scope.handler, ...item.path], value: total * item[build] / weights }));
    return profileFromStacks(values, `${scope.service} ${build}`, 'milliseconds', 1000);
  });
  const [before, after] = profiles;
  return performanceFrame([column('id', 'string'), column('parent', 'string'), column('label', 'string'), column('depth', 'number'), column('beforeStart', 'number', 'ms'), column('beforeTotal', 'number', 'ms'), column('beforeSelf', 'number', 'ms'), column('afterStart', 'number', 'ms'), column('afterTotal', 'number', 'ms'), column('afterSelf', 'number', 'ms'), column('beforeRequests', 'number', 'count'), column('afterRequests', 'number', 'count')], before.frames.map((frame, i) => [frame.id, frame.parentId, frame.label, frame.depth, frame.start, frame.total, frame.self, after.frames[i].start, after.frames[i].total, after.frames[i].self, 480, 480]));
}

export function buildPerformanceWorkbench(route: PerformanceRoute = 'checkout', gaps = false, request = 'req-217', traceBuild: Build = 'after') {
  const scope = PERFORMANCE_ROUTES.find(item => item.id === route)!;
  if (!scope) throw new Error('Unknown performance route.');
  const requests = performanceRequestFixture(route, gaps), observations = performanceObservations(requests.records!);
  const trace = traceFixture(route, request, traceBuild), profile = performanceProfileFixture(route), profileData = differentialProfile(profile.records!);
  const selectedMetricObservation = observations.find(row => row.pair === request && row.version === traceBuild)!;
  const traceCaption = `Independent synthetic trace capture, matched by request and build. ${selectedMetricObservation.latency === null ? 'Request latency metrics are unavailable for this identity; the captured trace remains available and does not fill the metric gap.' : 'The matching request latency metric is observed.'} Nested child spans can overlap; only declared non-overlapping phases are summed.`;
  const serialize = profileData.frames.find(frame => frame.label === 'encoding/json.Marshal')!;
  const before = observations.filter(row => row.version === 'before'), after = observations.filter(row => row.version === 'after');
  return {
    scope, observations, request, traceBuild, selectedObservation: trace.observation, selectedMetricObservation, profileData, traceData: performanceTrace(trace.result.records!), evidenceData: pairedPerformance(observations), initialFunction: serialize.id,
    density: { widget: definition('performance-density', 'Latency distribution over time', 'performance-latency-density'), result: requests },
    trace: { widget: definition('performance-trace', `Trace waterfall · ${trace.observation.pair} · ${traceBuild === 'after' ? 'candidate' : 'baseline'}`, 'performance-trace-waterfall', { selectedSpan: 'serialize' }), result: trace.result, caption: traceCaption },
    profile: { widget: definition('performance-profile', `CPU profile · ${scope.service}`, 'performance-differential-flamegraph', { selectedId: serialize.id }), result: profile },
    evidence: { widget: definition('performance-evidence', 'Build comparison evidence', 'performance-paired-evidence'), result: requests },
    summary: { beforeP99: empiricalQuantile(before.flatMap(row => row.latency === null ? [] : [row.latency]), .99), afterP99: empiricalQuantile(after.flatMap(row => row.latency === null ? [] : [row.latency]), .99), requests: after.length, errors: after.filter(row => row.error).length, observed: after.filter(row => row.latency !== null).length },
  };
}

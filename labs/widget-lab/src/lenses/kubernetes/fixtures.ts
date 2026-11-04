import type { QueryResult, RecordColumn, RecordFrame, Widget } from '@insights/schema';
import { parseRecordFrame } from '@insights/record-data';
import { FLEET_KEYS, TREND_KEYS, fleetRows, fleetScope, resourceSummary, type FleetEntity } from '../../charts/kubernetes/model';

export const FLEET_START = Date.UTC(2026, 9, 29, 11);
export const FLEET_NAMESPACES = ['all', 'payments', 'risk', 'cache', 'ingress'] as const;
export type FleetNamespace = typeof FLEET_NAMESPACES[number];
export type FleetPreset = 'ready' | 'gaps';
export type KubernetesPanel = { widget: Widget; result: QueryResult; caption: string };
const round = (n: number) => Number(n.toFixed(6));
const blank = { cpuAllocatable: null, memoryAllocatable: null, cpuRequest: null, cpuLimit: null, cpuUsed: null, memoryRequest: null, memoryLimit: null, memoryUsed: null, networkRx: null, networkTx: null };
const strings = new Set(['id', 'kind', 'parentId', 'name', 'namespace', 'zone', 'nodeId', 'status', 'workload', 'reason']);
const units: Record<string, string> = { cpuAllocatable: 'cores', cpuRequest: 'cores', cpuLimit: 'cores', cpuUsed: 'cores', memoryAllocatable: 'GiB', memoryRequest: 'GiB', memoryLimit: 'GiB', memoryUsed: 'GiB', networkRx: 'Mb/s', networkTx: 'Mb/s' };
function hash(a: number, b: number) { let n = Math.imul(a + 11, 73856093) ^ Math.imul(b + 17, 19349663); n = Math.imul(n ^ n >>> 13, 2246822519); return ((n ^ n >>> 16) >>> 0) / 4294967296; }
export function createFleet(preset: FleetPreset = 'ready'): FleetEntity[] {
  const result: FleetEntity[] = [], workloads = [['payments-api', 'payments'], ['worker', 'payments'], ['fraud-detect', 'risk'], ['redis', 'cache'], ['ingress-nginx', 'ingress'], ['payments-api', 'payments']];
  for (let n = 1; n <= 48; n++) {
    const id = `node-au-${String(n).padStart(2, '0')}`, zone = `ap-southeast-2${['a', 'b', 'c'][Math.floor((n - 1) / 16)]}`, unavailable = n === 36 || preset === 'gaps' && n === 7;
    result.push({ ...blank, id, kind: 'node', name: id, parentId: null, nodeId: id, zone, namespace: null, status: unavailable ? 'Not ready' : 'Ready', workload: null, cpuAllocatable: 16, memoryAllocatable: 64, restarts: 0, reason: unavailable ? 'Node heartbeat unavailable in this snapshot' : null });
    for (let p = 0; p < 6; p++) {
      const [workload, namespace] = workloads[p], podId = `pod:${id}:${p}`, status = unavailable ? 'Unknown' as const : 'Running' as const;
      const pod: FleetEntity = { ...blank, id: podId, kind: 'pod', name: `${workload}-${String(n).padStart(2, '0')}-${p + 1}`, parentId: id, nodeId: id, zone, namespace, workload, status, restarts: 0, reason: unavailable ? 'Node observation missing' : null };
      result.push(pod);
      for (let c = 0; c < 2; c++) {
        const main = c === 0, pressure = n === 17 || n === 34, cpuRequest = main ? pressure ? 2.2 : round(1.2 + hash(n, p) * .4) : .2;
        const memoryRequest = main ? pressure ? 8 : round(4.8 + hash(n, p + 7) * 1.1) : 1;
        result.push({ ...blank, id: `${podId}:${c}`, kind: 'container', name: main ? 'api' : 'sidecar', parentId: podId, nodeId: id, zone, namespace, workload, status,
          cpuRequest, cpuLimit: main ? pressure ? 3 : 2.5 : .5, memoryRequest, memoryLimit: main ? pressure ? 12 : 8 : 2,
          cpuUsed: unavailable ? null : round(cpuRequest * (.47 + hash(n * 6 + p, c + 10) * .39)), memoryUsed: unavailable ? null : round(memoryRequest * (.55 + hash(n * 6 + p, c + 30) * .4)),
          networkRx: unavailable ? null : round((main ? 1.5 : .13) * (1 + hash(n * 6 + p, c + 23) * 12)), networkTx: unavailable ? null : round((main ? .5 : .1) * (1 + hash(n * 6 + p, c + 31) * 6)),
          restarts: main && [17, 22, 43].includes(n) && p === 0 ? 1 : 0, reason: pod.reason });
      }
    }
  }
  for (let p = 0; p < 4; p++) {
    const pod: FleetEntity = { ...blank, id: `pending:${p}`, kind: 'pod', name: `payments-api-pending-${p + 1}`, parentId: null, nodeId: null, zone: null, namespace: 'payments', workload: 'payments-api', status: 'Pending', restarts: 0, reason: p < 2 ? 'Insufficient memory in matching node pool' : 'Required pod anti-affinity not satisfied' };
    result.push(pod);
    for (let c = 0; c < 2; c++) result.push({ ...pod, id: `${pod.id}:${c}`, parentId: pod.id, kind: 'container', name: c ? 'sidecar' : 'api', cpuRequest: c ? .2 : 2.2, cpuLimit: c ? .5 : 3, memoryRequest: c ? 1 : 8, memoryLimit: c ? 2 : 12 });
  }
  return result;
}
export function fleetResult(namespace: FleetNamespace = 'all', preset: FleetPreset = 'ready'): QueryResult {
  const entities = createFleet(preset).filter(e => e.kind === 'node' || namespace === 'all' || e.namespace === namespace);
  const columns: RecordColumn[] = FLEET_KEYS.map(key => ({ key, type: strings.has(key) ? 'string' : 'number', ...(units[key] ? { unit: units[key] } : {}) }));
  return { records: parseRecordFrame({ columns, rows: entities.map(e => FLEET_KEYS.map(key => e[key])) }) };
}

/** All snapshot, heatmap and scope-trend values share these synthetic per-container observations. */
export function sampleContainer(container: FleetEntity, minute: number) {
  if (container.kind !== 'container' || container.cpuUsed === null || container.nodeId === null) return { cpuUsed: null, memoryUsed: null, networkRx: null, networkTx: null, periods: null, throttled: null };
  const n = Number(container.nodeId.slice(-2)), phase = hash(n, container.name === 'api' ? 1 : 2) * Math.PI * 2;
  const spike = (m: number) => Math.exp(-(((m - 34) / 6) ** 2)) * (n === 17 ? .65 : n === 34 ? .32 : .08);
  const cpuFactor = (m: number) => .8 + .13 * Math.sin(m / 4.8 + phase) + .0015 * m + spike(m);
  const memoryFactor = (m: number) => .77 + .0032 * m + .025 * Math.sin(m / 8 + phase);
  const networkFactor = (m: number) => .72 + .16 * Math.sin(m / 3.7 + phase) + Math.exp(-(((m - 34) / 4) ** 2)) * (n === 17 ? 2.8 : .5);
  const rate = Math.min(.65, .012 + hash(n, Math.floor(minute / 5) + 8) * .045 + spike(minute) * .7);
  return { cpuUsed: round(container.cpuUsed * cpuFactor(minute) / cpuFactor(60)), memoryUsed: round(container.memoryUsed! * memoryFactor(minute) / memoryFactor(60)),
    networkRx: round(container.networkRx! * networkFactor(minute) / networkFactor(60)), networkTx: round(container.networkTx! * (1 + .12 * Math.sin(minute / 6 + phase)) / (1 + .12 * Math.sin(10 + phase))), periods: 600, throttled: Math.round(600 * rate) };
}
export function fleetTrend(entities: readonly FleetEntity[], scopeId = ''): QueryResult {
  const summary = resourceSummary(entities, scopeId), containers = fleetScope(entities, scopeId).containers;
  const columns: RecordColumn[] = TREND_KEYS.map(key => ({ key, type: ['id', 'scopeId', 'scopeLabel'].includes(key) ? 'string' : 'number', ...((units[key] || key === 'timestamp') ? { unit: key === 'timestamp' ? 'ms' : units[key] } : {}) }));
  // The transport calls these totals Requested; source container columns use Request.
  for (const col of columns) if (col.key === 'cpuRequested') col.unit = 'cores'; else if (col.key === 'memoryRequested') col.unit = 'GiB';
  const rows: RecordFrame['rows'] = Array.from({ length: 61 }, (_, minute) => {
    const observations = containers.map(c => sampleContainer(c, minute)), observed = observations.filter(p => p.cpuUsed !== null).length;
    const sum = (key: 'cpuUsed' | 'memoryUsed' | 'networkRx' | 'networkTx') => observed ? round(observations.reduce((a, s) => a + (s[key] ?? 0), 0)) : containers.length ? null : 0;
    const timestamp = FLEET_START + minute * 60000;
    return [`${scopeId || 'cluster'}:${timestamp}`, timestamp, scopeId || 'cluster', summary.label, sum('cpuUsed'), round(summary.cpuRequested), sum('memoryUsed'), round(summary.memoryRequested), sum('networkRx'), sum('networkTx'), observed, containers.length];
  });
  return { records: parseRecordFrame({ columns, rows }) };
}
export function fleetThrottling(entities: readonly FleetEntity[]): QueryResult {
  const columns: RecordColumn[] = [{ key: 'id', type: 'string' }, { key: 'nodeId', type: 'string' }, { key: 'nodeName', type: 'string' },
    { key: 'start', type: 'number', unit: 'ms' }, { key: 'end', type: 'number', unit: 'ms' }, ...['periods', 'throttled', 'observed', 'expected'].map(key => ({ key, type: 'number' as const }))];
  const rows: RecordFrame['rows'] = entities.filter(e => e.kind === 'node').flatMap(node => {
    const containers = fleetScope(entities, node.id).containers;
    return Array.from({ length: 12 }, (_, bucket) => {
      const start = FLEET_START + bucket * 300000, end = start + 300000;
      const observations = containers.flatMap(c => Array.from({ length: 5 }, (_, m) => sampleContainer(c, bucket * 5 + m + 1)));
      const observed = containers.filter(c => c.cpuUsed !== null).length;
      return [`${node.id}:${start}`, node.id, node.name, start, end, observed ? observations.reduce((a, s) => a + (s.periods ?? 0), 0) : null, observed ? observations.reduce((a, s) => a + (s.throttled ?? 0), 0) : null, observed, containers.length];
    });
  });
  return { records: parseRecordFrame({ columns, rows }) };
}
export function kubernetesPanel(id: string, title: string, result: QueryResult, config: Widget['config'] = {}, caption = ''): KubernetesPanel {
  return { widget: { id: `fleet-${id}`, type: 'plugin', pluginId: id, title, dataKind: 'records', providerId: 'synthetic-kubernetes', query: `fixture.${id}`, layout: { x: 0, y: 0, w: 6, h: 6 }, unit: '', options: { showTooltip: true, showLegend: true, showGrid: true, decimals: 2 }, config }, result, caption };
}
export function kubernetesFixtures(namespace: FleetNamespace = 'all', preset: FleetPreset = 'ready') {
  const result = fleetResult(namespace, preset), entities = fleetRows(result.records), throttling = fleetThrottling(entities), initialId = 'node-au-17';
  return { entities, result, initialId,
    placement: kubernetesPanel('kubernetes-placement', 'Workload placement & pressure', result, { resource: 'cpu', selectedId: initialId, showPods: true, pressure: .85 }, 'Node area = allocatable capacity · inner pod area = requests · vacant area remains explicit'),
    resources: kubernetesPanel('kubernetes-resource-bars', 'Resource usage', result, { selectedId: initialId, showLimits: true, showValues: true }, 'Observed workload usage, scheduled requests and limits keep separate values'),
    throttling: kubernetesPanel('kubernetes-throttle-matrix', 'CPU throttling by node', throttling, { selectedNode: initialId, rows: 12, ceiling: 50 }, 'Throttled CFS periods / observed CFS periods · five-minute buckets'),
    trend: kubernetesPanel('kubernetes-resource-trend', 'Node resource usage · cluster total', fleetTrend(entities), { showNetwork: true, showRequested: true, fill: true }, 'Measured workloads only · missing-node coverage disclosed · 29 Oct 2026 UTC'),
  };
}

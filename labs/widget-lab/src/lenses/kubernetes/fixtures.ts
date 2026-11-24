import type { QueryResult, Widget } from '@insights/schema';
import { kubernetesFleetSeries, KUBERNETES_PLUGIN_IDS, type FleetNode, type FleetPod, type FleetResults, type KubernetesPluginId } from '@insights/plugins/kubernetes-fixtures';
import { fleetScope, type FleetEntity } from './fleet-model';

/**
 * Synthetic fleet for the Kubernetes Fleet lens. The lens's own entity hierarchy (nodes, pods, containers) is encoded
 * into the Prometheus-shaped series the production Kubernetes widgets read, so the lab renders the production code.
 * Every value is synthetic; nothing here connects to a provider.
 */

export const FLEET_START = Date.UTC(2026, 9, 29, 11);
export const FLEET_NAMESPACES = ['all', 'payments', 'risk', 'cache', 'ingress'] as const;
export type FleetNamespace = typeof FLEET_NAMESPACES[number];
export type FleetPreset = 'ready' | 'gaps';
export type KubernetesPanel = { widget: Widget; result: QueryResult; caption: string };

const GIB = 1024 ** 3;
const MB_PER_SECOND_IN_BYTES = 125000;
const MINUTES = 61;
const round = (n: number) => Number(n.toFixed(6));
const blank = { cpuAllocatable: null, memoryAllocatable: null, cpuRequest: null, cpuLimit: null, cpuUsed: null, memoryRequest: null, memoryLimit: null, memoryUsed: null, networkRx: null, networkTx: null };
function hash(a: number, b: number) { let n = Math.imul(a + 11, 73856093) ^ Math.imul(b + 17, 19349663); n = Math.imul(n ^ n >>> 13, 2246822519); return ((n ^ n >>> 16) >>> 0) / 4294967296; }

export function createFleet(preset: FleetPreset = 'ready'): FleetEntity[] {
  const result: FleetEntity[] = [], workloads = [['payments-api', 'payments'], ['worker', 'payments'], ['fraud-detect', 'risk'], ['redis', 'cache'], ['ingress-nginx', 'ingress'], ['payments-api', 'payments']];
  for (let n = 1; n <= 48; n++) {
    const id = `node-au-${String(n).padStart(2, '0')}`, zone = `ap-southeast-2${['a', 'b', 'c'][Math.floor((n - 1) / 16)]}`, unavailable = n === 36 || preset === 'gaps' && n === 7;
    result.push({ ...blank, id, kind: 'node', name: id, parentId: null, nodeId: id, zone, namespace: null, status: unavailable ? 'Not ready' : 'Ready', workload: null, cpuAllocatable: 16, memoryAllocatable: 64, restarts: 0, reason: unavailable ? 'Node heartbeat missing' : null });
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
    const pod: FleetEntity = { ...blank, id: `pending:${p}`, kind: 'pod', name: `payments-api-pending-${p + 1}`, parentId: null, nodeId: null, zone: null, namespace: 'payments', workload: 'payments-api', status: 'Pending', restarts: 0, reason: p < 2 ? 'Insufficient memory' : 'Insufficient CPU' };
    result.push(pod);
    for (let c = 0; c < 2; c++) result.push({ ...pod, id: `${pod.id}:${c}`, parentId: pod.id, kind: 'container', name: c ? 'sidecar' : 'api', cpuRequest: c ? .2 : 2.2, cpuLimit: c ? .5 : 3, memoryRequest: c ? 1 : 8, memoryLimit: c ? 2 : 12 });
  }
  return result;
}

/** Synthetic per-container observations, shared by the Fleet lens's panels, detail dock and workload history. */
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

const minuteOf = (timestamp: number) => Math.round((timestamp - FLEET_START) / 60000);
const sumOrNull = (values: (number | null)[]) => (values.length && values.every(v => v !== null) ? values.reduce<number>((total, v) => total + (v ?? 0), 0) : null);

/** Per-minute CPU (cores) and memory (GiB) of one workload for its table sparklines. Null where any container is unobserved. */
export function workloadHistory(entities: readonly FleetEntity[], workload: string): { cpu: (number | null)[]; memory: (number | null)[] } {
  const containers = entities.filter(e => e.kind === 'container' && e.workload === workload && e.nodeId !== null);
  return {
    cpu: Array.from({ length: MINUTES }, (_, minute) => sumOrNull(containers.map(c => sampleContainer(c, minute).cpuUsed))),
    memory: Array.from({ length: MINUTES }, (_, minute) => sumOrNull(containers.map(c => sampleContainer(c, minute).memoryUsed))),
  };
}

/** Groups the containers in scope into the production pod shape, one entry per pod. */
function podsIn(entities: readonly FleetEntity[], containers: readonly FleetEntity[]): FleetPod[] {
  const byPod = new Map<string, FleetEntity[]>();
  for (const container of containers) byPod.set(container.parentId!, [...(byPod.get(container.parentId!) ?? []), container]);
  return [...byPod].map(([podId, members]) => {
    const pod = entities.find(e => e.id === podId)!;
    const usage = (minute: number, key: 'cpuUsed' | 'memoryUsed', scale: number) => { const value = sumOrNull(members.map(c => sampleContainer(c, minute)[key])); return value === null ? null : value * scale; };
    const throttle = (minute: number) => {
      const counts = members.map(c => sampleContainer(c, minute));
      if (counts.some(c => c.throttled === null || c.periods === null)) return null;
      return { throttled: counts.reduce((a, c) => a + c.throttled!, 0), periods: counts.reduce((a, c) => a + c.periods!, 0) };
    };
    return {
      namespace: pod.namespace ?? '', pod: pod.name, node: pod.nodeId,
      cpuRequest: members.reduce((a, c) => a + c.cpuRequest!, 0), cpuLimit: members.reduce((a, c) => a + c.cpuLimit!, 0),
      memoryRequest: members.reduce((a, c) => a + c.memoryRequest!, 0) * GIB, memoryLimit: members.reduce((a, c) => a + c.memoryLimit!, 0) * GIB,
      cpuUsage: t => usage(minuteOf(t), 'cpuUsed', 1), memoryUsage: t => usage(minuteOf(t), 'memoryUsed', GIB),
      throttle: t => throttle(minuteOf(t)),
    };
  });
}

/**
 * One fleet encoding for the four production widgets. The scope limits the pods and containers; nodes stay whole.
 * Placement is the exception: it always shows pending pods, which have no node and so sit outside every scheduled scope.
 */
const encodings = new WeakMap<readonly FleetEntity[], Map<string, FleetResults>>();
/** Encodings are cached per entity list, because the lens asks for the same scope on every selection render. */
export function fleetEncoding(entities: readonly FleetEntity[], scopeId = '', withPending = false) {
  const key = `${scopeId}|${withPending}`;
  const cached = encodings.get(entities) ?? new Map();
  encodings.set(entities, cached);
  if (!cached.has(key)) cached.set(key, encodeFleet(entities, scopeId, withPending));
  return cached.get(key)!;
}

function encodeFleet(entities: readonly FleetEntity[], scopeId: string, withPending: boolean): FleetResults {
  const scope = fleetScope(entities, scopeId);
  const containers = withPending ? entities.filter(e => e.kind === 'container') : scope.containers;
  const nodes: FleetNode[] = entities.filter(e => e.kind === 'node').map(node => ({ node: node.id, zone: node.zone ?? '', cpu: node.cpuAllocatable!, memoryBytes: node.memoryAllocatable! * GIB, ready: node.status === 'Ready' }));
  const pods = podsIn(entities, containers);
  const networkRx = (t: number) => { const value = sumOrNull(containers.map(c => sampleContainer(c, minuteOf(t)).networkRx)); return value === null ? null : value * MB_PER_SECOND_IN_BYTES; };
  const networkTx = (t: number) => { const value = sumOrNull(containers.map(c => sampleContainer(c, minuteOf(t)).networkTx)); return value === null ? null : value * MB_PER_SECOND_IN_BYTES; };
  return kubernetesFleetSeries({ nodes, pods, networkRx, networkTx }, { start: FLEET_START, step: 60000, points: MINUTES });
}

export function kubernetesPanel(id: KubernetesPluginId, title: string, result: QueryResult, config: Widget['config'] = {}, caption = ''): KubernetesPanel {
  return { widget: { id: `fleet-${id}`, type: 'plugin', pluginId: id, title, dataKind: 'metrics', providerId: 'synthetic-kubernetes', query: `fixture.${id}`, layout: { x: 0, y: 0, w: 6, h: 6 }, unit: '', options: { showTooltip: true, showLegend: true, showGrid: true, decimals: 1 }, config } as unknown as Widget, result, caption };
}

/** The lens panels for one selection. Placement covers the namespace; the other three follow the selected scope. */
export type FleetPanels = { placement: KubernetesPanel; resources: KubernetesPanel; throttling: KubernetesPanel; trend: KubernetesPanel };
const panelCache = new WeakMap<readonly FleetEntity[], Map<string, FleetPanels>>();
export function fleetPanels(entities: readonly FleetEntity[], selectedId = '') {
  const cached = panelCache.get(entities) ?? new Map();
  panelCache.set(entities, cached);
  if (!cached.has(selectedId)) cached.set(selectedId, buildPanels(entities, selectedId));
  return cached.get(selectedId)!;
}

function buildPanels(entities: readonly FleetEntity[], selectedId: string): FleetPanels {
  const cluster = fleetEncoding(entities, '', true), scoped = fleetEncoding(entities, selectedId);
  const ids = KUBERNETES_PLUGIN_IDS;
  return {
    placement: kubernetesPanel(ids.placement, 'Workload placement & pressure', cluster.placement, { resource: 'cpu', showPods: true, pressure: .85, maxNodes: 64 }, 'Node area = allocatable capacity · inner pod area = requests · vacant area remains explicit'),
    resources: kubernetesPanel(ids.bars, 'Resource usage', scoped.bars, { groupLabel: 'pod', maxGroups: 16, showLimits: true, showValues: true }, 'Observed workload usage, scheduled requests and limits keep separate values'),
    throttling: kubernetesPanel(ids.throttle, 'CPU throttling by pod', scoped.throttle, { groupLabel: 'pod', rows: 12, ceiling: 50 }, 'Throttled CFS periods / observed CFS periods · one-minute samples'),
    trend: kubernetesPanel(ids.trend, 'Resource usage · scope total', scoped.trend, { showNetwork: true, showRequested: true, fill: true }, 'Measured workloads only · missing-node coverage disclosed · 29 Oct 2026 UTC'),
  };
}

/** The Fleet lens's fixture set, kept under the name its tests and catalogue already use. */
export function kubernetesFixtures(namespace: FleetNamespace = 'all', preset: FleetPreset = 'ready', selectedId = 'node-au-17'): { entities: FleetEntity[]; initialId: string } & FleetPanels {
  const entities = createFleet(preset).filter(e => e.kind === 'node' || namespace === 'all' || e.namespace === namespace);
  return { entities, initialId: selectedId, ...fleetPanels(entities, selectedId) };
}

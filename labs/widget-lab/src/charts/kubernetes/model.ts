import { z } from 'zod';
import type { RecordFrame } from '../../renderer-extensions/schema';
import type { DrilldownContext } from '@insights/drilldown';
import { recordObjects } from '../analytics/data';

const selection = z.string().max(160).default('');
export const placementConfig = z.strictObject({ selectedId: selection, selectionOwner: z.enum(['local', 'host']).default('local'), resource: z.enum(['cpu', 'memory']).default('cpu'), showPods: z.boolean().default(true), pressure: z.number().min(.5).max(1).default(.85) });
export const resourceBarsConfig = z.strictObject({ selectedId: selection, showLimits: z.boolean().default(true), showValues: z.boolean().default(true) });
export const throttleConfig = z.strictObject({ selectedNode: selection, rows: z.number().int().min(6).max(24).default(12), ceiling: z.number().positive().max(100).default(50) });
export const resourceTrendConfig = z.strictObject({ showNetwork: z.boolean().default(true), showRequested: z.boolean().default(true), fill: z.boolean().default(true), selectedAt: z.number().int().nonnegative().nullable().default(null) });
export type FleetKind = 'node' | 'pod' | 'container';
export type FleetStatus = 'Ready' | 'Not ready' | 'Running' | 'Pending' | 'Unknown';
export interface FleetEntity {
  id: string; kind: FleetKind; parentId: string | null; name: string; namespace: string | null;
  zone: string | null; nodeId: string | null; status: FleetStatus; workload: string | null;
  cpuAllocatable: number | null; memoryAllocatable: number | null;
  cpuRequest: number | null; cpuLimit: number | null; cpuUsed: number | null;
  memoryRequest: number | null; memoryLimit: number | null; memoryUsed: number | null;
  networkRx: number | null; networkTx: number | null; restarts: number; reason: string | null;
}
export const FLEET_KEYS = ['id', 'kind', 'parentId', 'name', 'namespace', 'zone', 'nodeId', 'status', 'workload', 'cpuAllocatable', 'memoryAllocatable', 'cpuRequest', 'cpuLimit', 'cpuUsed', 'memoryRequest', 'memoryLimit', 'memoryUsed', 'networkRx', 'networkTx', 'restarts', 'reason'] as const;
const STRING_KEYS = ['id', 'kind', 'parentId', 'name', 'namespace', 'zone', 'nodeId', 'status', 'workload', 'reason'];
const units: Record<string, string> = { cpuAllocatable: 'cores', cpuRequest: 'cores', cpuLimit: 'cores', cpuUsed: 'cores', memoryAllocatable: 'GiB', memoryRequest: 'GiB', memoryLimit: 'GiB', memoryUsed: 'GiB', networkRx: 'Mb/s', networkTx: 'Mb/s' };
const num = (v: unknown, label: string) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${label} must be a finite nonnegative number.`); return v; };
const count = (v: unknown, label: string) => { const n = num(v, label); if (!Number.isSafeInteger(n)) throw new Error(`${label} must be an integer count.`); return n; };
const identity = (v: unknown, label: string) => { if (typeof v !== 'string' || !v.trim()) throw new Error(`${label} requires an identity.`); return v; };
const nullableText = (v: unknown, label: string) => v === null ? null : identity(v, label);
const nullableNumber = (v: unknown, label: string) => v === null ? null : num(v, label);
const epoch = (v: unknown) => { const n = count(v, 'Timestamp'); if (!Number.isFinite(new Date(n).getTime())) throw new Error('Timestamp is outside the supported epoch range.'); return n; };
function metadata(frame: RecordFrame, keys: readonly string[], strings: readonly string[], expectedUnits: Record<string, string> = {}) {
  for (const key of keys) {
    const col = frame.columns.find(c => c.key === key), expected = strings.includes(key) ? 'string' : 'number';
    if (col && col.type !== expected) throw new Error(`${key} must have type ${expected}.`);
    if (col?.unit && expectedUnits[key] && col.unit !== expectedUnits[key]) throw new Error(`${key} must use ${expectedUnits[key]}; convert before charting.`);
  }
}

/** Nodes hold capacity; container leaves hold resources. Pod and cluster totals are derived once. */
export function fleetRows(frame: RecordFrame | undefined): FleetEntity[] {
  if (!frame) return [];
  metadata(frame, FLEET_KEYS, STRING_KEYS, units);
  const seen = new Set<string>();
  const entities = recordObjects(frame, [...FLEET_KEYS], 1000).map(row => {
    const id = identity(row.id, 'Entity'); if (seen.has(id)) throw new Error('Duplicate fleet entity identity.'); seen.add(id);
    const kind = row.kind as FleetKind, status = row.status as FleetStatus;
    if (!['node', 'pod', 'container'].includes(kind)) throw new Error('Unknown fleet entity kind.');
    if (!(kind === 'node' ? ['Ready', 'Not ready'] : ['Running', 'Pending', 'Unknown']).includes(status)) throw new Error('Status does not match the fleet entity kind.');
    const e: FleetEntity = { id, kind, parentId: nullableText(row.parentId, 'Parent'), name: identity(row.name, 'Entity name'), namespace: nullableText(row.namespace, 'Namespace'), zone: nullableText(row.zone, 'Zone'), nodeId: nullableText(row.nodeId, 'Node'), status, workload: nullableText(row.workload, 'Workload'), restarts: count(row.restarts, 'Restarts'), reason: nullableText(row.reason, 'Reason'),
      cpuAllocatable: nullableNumber(row.cpuAllocatable, 'CPU allocatable'), memoryAllocatable: nullableNumber(row.memoryAllocatable, 'Memory allocatable'),
      cpuRequest: nullableNumber(row.cpuRequest, 'CPU request'), cpuLimit: nullableNumber(row.cpuLimit, 'CPU limit'), cpuUsed: nullableNumber(row.cpuUsed, 'CPU usage'),
      memoryRequest: nullableNumber(row.memoryRequest, 'Memory request'), memoryLimit: nullableNumber(row.memoryLimit, 'Memory limit'), memoryUsed: nullableNumber(row.memoryUsed, 'Memory usage'),
      networkRx: nullableNumber(row.networkRx, 'Ingress'), networkTx: nullableNumber(row.networkTx, 'Egress') };
    if (kind === 'node') {
      if (e.parentId !== null || e.nodeId !== e.id || !e.zone || e.namespace !== null || !(e.cpuAllocatable! > 0) || !(e.memoryAllocatable! > 0)) throw new Error('Nodes require positive allocatable capacity and self-identifying node IDs.');
    } else if (e.cpuAllocatable !== null || e.memoryAllocatable !== null || !e.namespace || !e.workload) throw new Error('Pods and containers have workload identities, not independent node capacity.');
    if (kind !== 'container') {
      if ([e.cpuRequest, e.cpuLimit, e.cpuUsed, e.memoryRequest, e.memoryLimit, e.memoryUsed, e.networkRx, e.networkTx].some(v => v !== null)) throw new Error('Only container leaves carry resource observations; derive parent totals.');
    } else {
      if (e.parentId === null || e.cpuRequest === null || e.cpuLimit === null || e.memoryRequest === null || e.memoryLimit === null || e.cpuLimit < e.cpuRequest || e.memoryLimit < e.memoryRequest) throw new Error('Containers require ordered request and limit values.');
      if (status !== 'Running' && [e.cpuUsed, e.memoryUsed, e.networkRx, e.networkTx].some(v => v !== null)) throw new Error('Unavailable or pending containers cannot contain observed resource usage.');
      const observations = [e.cpuUsed, e.memoryUsed, e.networkRx, e.networkTx];
      if (observations.some(v => v === null) && observations.some(v => v !== null)) throw new Error('Container resource observations require one paired coverage state.');
    }
    return e;
  });
  const byId = new Map(entities.map(e => [e.id, e]));
  for (const e of entities) {
    if (e.kind === 'pod') {
      const parent = e.parentId === null ? null : byId.get(e.parentId);
      if (e.status === 'Pending') { if (e.parentId !== null || e.nodeId !== null || !e.reason) throw new Error('Pending pods need an unscheduled identity and an explicit reason.'); }
      else if (parent?.kind !== 'node' || e.nodeId !== parent.id || e.zone !== parent.zone) throw new Error('Scheduled pods must belong to an existing node.');
      if (parent?.status === 'Not ready' && e.status !== 'Unknown') throw new Error('Pod status must disclose an unavailable node.');
    }
    if (e.kind === 'container') {
      const parent = byId.get(e.parentId!);
      if (parent?.kind !== 'pod' || parent.nodeId !== e.nodeId || parent.namespace !== e.namespace || parent.workload !== e.workload || parent.status !== e.status || parent.zone !== e.zone) throw new Error('Containers must match their pod ownership and status.');
    }
  }
  for (const node of entities.filter(e => e.kind === 'node')) {
    const summary = resourceSummary(entities, node.id);
    if (summary.cpuRequested > node.cpuAllocatable! + 1e-7 || summary.memoryRequested > node.memoryAllocatable! + 1e-7) throw new Error('Scheduled requests exceed node allocatable capacity.');
  }
  return entities;
}

export function fleetScope(entities: readonly FleetEntity[], id = '') {
  const selected = entities.find(e => e.id === id);
  if (id && entities.length && !selected) throw new Error('The requested fleet entity is absent from this source scope.');
  const containers = entities.filter(e => e.kind === 'container' && (selected?.kind === 'container' ? e.id === selected.id : selected?.kind === 'pod' ? e.parentId === selected.id : selected?.kind === 'node' ? e.nodeId === selected.id : e.nodeId !== null));
  return { selected, containers };
}
export function resourceSummary(entities: readonly FleetEntity[], id = '') {
  const { selected, containers } = fleetScope(entities, id);
  const nodes = entities.filter(e => e.kind === 'node' && (!selected || selected.kind === 'node' && e.id === selected.id));
  const sum = (key: 'cpuRequest' | 'cpuLimit' | 'memoryRequest' | 'memoryLimit') => containers.reduce((a, e) => a + e[key]!, 0);
  const observed = (key: 'cpuUsed' | 'memoryUsed' | 'networkRx' | 'networkTx') => { const measured = containers.filter(c => c[key] !== null); return { value: measured.length ? measured.reduce((a, e) => a + e[key]!, 0) : containers.length ? null : 0, count: measured.length }; };
  return { selected, label: selected?.name ?? 'prod-au · scheduled workloads', containers, expected: containers.length,
    cpuUsed: observed('cpuUsed'), memoryUsed: observed('memoryUsed'), networkRx: observed('networkRx'), networkTx: observed('networkTx'),
    cpuRequested: sum('cpuRequest'), memoryRequested: sum('memoryRequest'), cpuLimit: sum('cpuLimit'), memoryLimit: sum('memoryLimit'),
    cpuAllocatable: nodes.length ? nodes.reduce((a, n) => a + n.cpuAllocatable!, 0) : null, memoryAllocatable: nodes.length ? nodes.reduce((a, n) => a + n.memoryAllocatable!, 0) : null };
}
export function fleetBreadcrumb(entities: readonly FleetEntity[], id: string): FleetEntity[] {
  const item = entities.find(e => e.id === id); if (!item) return [];
  const chain: FleetEntity[] = [item]; let parent = item.parentId;
  while (parent) { const next = entities.find(e => e.id === parent); if (!next || chain.some(e => e.id === next.id)) break; chain.unshift(next); parent = next.parentId; }
  return chain;
}
export function fleetBack(entities: readonly FleetEntity[], id: string) { return entities.find(e => e.id === id)?.parentId ?? ''; }
export function selectExisting(entities: readonly FleetEntity[], id: string) { return entities.some(e => e.id === id) ? id : ''; }
/** A linked host owns navigation; stale standalone picks must never override a breadcrumb/back action. */
export function fleetSelectionId(entities: readonly FleetEntity[], configured: string, local: string | null, linked: boolean) {
  return selectExisting(entities, linked ? configured : local ?? configured);
}
/** Context emission is independent of who owns the visible selection. */
export function fleetSelectionAction(entities: readonly FleetEntity[], id: string, owner: 'local' | 'host'): { localId: string | null; context: DrilldownContext } | null {
  const entity = entities.find(e => e.id === id);
  if (id && !entity) return null;
  return { localId: owner === 'local' ? id : null, context: { series: entity?.name ?? '', labels: { entityId: id, nodeId: entity?.nodeId ?? '', kind: entity?.kind ?? '' } } };
}
export function nodeFor(entities: readonly FleetEntity[], id: string) { return entities.find(e => e.id === id)?.nodeId ?? ''; }
export function workloadSummary(entities: readonly FleetEntity[]) {
  return [...new Set(entities.filter(e => e.kind === 'pod').map(e => e.workload!))].sort().map(id => {
    const pods = entities.filter(e => e.kind === 'pod' && e.workload === id), leaves = entities.filter(e => e.kind === 'container' && e.workload === id && e.nodeId !== null);
    const observed = (key: 'cpuUsed' | 'memoryUsed') => leaves.some(e => e[key] !== null) ? leaves.reduce((a, e) => a + (e[key] ?? 0), 0) : null;
    return { id, namespace: pods[0]?.namespace ?? '', desired: pods.length, running: pods.filter(p => p.status === 'Running').length, pending: pods.filter(p => p.status === 'Pending').length, unknown: pods.filter(p => p.status === 'Unknown').length,
      restarts: leaves.reduce((n, e) => n + e.restarts, 0), cpuUsed: observed('cpuUsed'), memoryUsed: observed('memoryUsed'), firstPod: pods.find(p => p.status === 'Running')?.id ?? pods[0]?.id ?? '' };
  });
}

export interface ThrottleCell { id: string; nodeId: string; nodeName: string; start: number; end: number; periods: number | null; throttled: number | null; percent: number | null; observed: number; expected: number }
const throttleKeys = ['id', 'nodeId', 'nodeName', 'start', 'end', 'periods', 'throttled', 'observed', 'expected'];
export function throttleRows(frame: RecordFrame | undefined): ThrottleCell[] {
  if (!frame) return []; metadata(frame, throttleKeys, ['id', 'nodeId', 'nodeName'], { start: 'ms', end: 'ms' });
  const seen = new Set<string>(), positions = new Set<string>();
  const data = recordObjects(frame, throttleKeys, 1000).map(r => {
    const id = identity(r.id, 'Throttle observation'), nodeId = identity(r.nodeId, 'Node'), nodeName = identity(r.nodeName, 'Node name'), start = epoch(r.start), end = epoch(r.end);
    if (seen.has(id) || positions.has(`${nodeId}:${start}`)) throw new Error('Duplicate throttle observation.'); seen.add(id); positions.add(`${nodeId}:${start}`);
    const periods = r.periods === null ? null : count(r.periods, 'CFS periods'), throttled = r.throttled === null ? null : count(r.throttled, 'Throttled periods'), observed = count(r.observed, 'Observed containers'), expected = count(r.expected, 'Expected containers');
    if (end <= start || observed > expected || (periods === null) !== (throttled === null) || (observed === 0 && periods !== null) || (observed > 0 && periods === null) || periods !== null && throttled! > periods) throw new Error('Throttle period counts and coverage must be ordered and complete.');
    return { id, nodeId, nodeName, start, end, periods, throttled, observed, expected, percent: periods ? throttled! / periods * 100 : null };
  }).sort((a, b) => a.nodeName.localeCompare(b.nodeName) || a.start - b.start);
  const last = new Map<string, number>();
  for (const cell of data) { if ((last.get(cell.nodeId) ?? -1) > cell.start) throw new Error('Throttle intervals for a node cannot overlap.'); last.set(cell.nodeId, cell.end); }
  return data;
}
export interface FleetTimepoint { id: string; timestamp: number; scopeId: string; scopeLabel: string; cpuUsed: number | null; cpuRequested: number; memoryUsed: number | null; memoryRequested: number; networkRx: number | null; networkTx: number | null; observed: number; expected: number }
export const TREND_KEYS = ['id', 'timestamp', 'scopeId', 'scopeLabel', 'cpuUsed', 'cpuRequested', 'memoryUsed', 'memoryRequested', 'networkRx', 'networkTx', 'observed', 'expected'] as const;
export function resourceTimepoints(frame: RecordFrame | undefined): FleetTimepoint[] {
  if (!frame) return []; metadata(frame, TREND_KEYS, ['id', 'scopeId', 'scopeLabel'], { timestamp: 'ms', cpuUsed: 'cores', cpuRequested: 'cores', memoryUsed: 'GiB', memoryRequested: 'GiB', networkRx: 'Mb/s', networkTx: 'Mb/s' });
  const seen = new Set<string>(), times = new Set<number>();
  const data = recordObjects(frame, [...TREND_KEYS], 1000).map(r => {
    const id = identity(r.id, 'Resource sample'), timestamp = epoch(r.timestamp);
    if (seen.has(id) || times.has(timestamp)) throw new Error('Duplicate resource time observation.'); seen.add(id); times.add(timestamp);
    const item: FleetTimepoint = { id, timestamp, scopeId: identity(r.scopeId, 'Scope'), scopeLabel: identity(r.scopeLabel, 'Scope label'), cpuUsed: nullableNumber(r.cpuUsed, 'CPU usage'), cpuRequested: num(r.cpuRequested, 'CPU request'), memoryUsed: nullableNumber(r.memoryUsed, 'Memory usage'), memoryRequested: num(r.memoryRequested, 'Memory request'), networkRx: nullableNumber(r.networkRx, 'Ingress'), networkTx: nullableNumber(r.networkTx, 'Egress'), observed: count(r.observed, 'Observed containers'), expected: count(r.expected, 'Expected containers') };
    if (item.observed > item.expected || item.observed === 0 && item.expected > 0 && [item.cpuUsed, item.memoryUsed, item.networkRx, item.networkTx].some(v => v !== null)) throw new Error('Unavailable containers cannot become zero-valued time observations.');
    if (item.observed > 0 && [item.cpuUsed, item.memoryUsed, item.networkRx, item.networkTx].some(v => v === null)) throw new Error('Observed resource strips require paired metric coverage.');
    return item;
  }).sort((a, b) => a.timestamp - b.timestamp);
  if (new Set(data.map(r => r.scopeId)).size > 1) throw new Error('Resource strips require one scope per result.');
  return data;
}

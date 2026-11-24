/**
 * Entity model for the Kubernetes Fleet lens. The production widgets read Prometheus-shaped series (see
 * ui/src/features/insights/plugins/kubernetes-data.ts); this model is the lens's own node → pod → container hierarchy,
 * used for breadcrumbs, the workload table and the detail dock.
 */

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

export function fleetScope(entities: readonly FleetEntity[], id = '') {
  const selected = entities.find(e => e.id === id);
  const containers = entities.filter(e => e.kind === 'container' && (selected?.kind === 'container' ? e.id === selected.id : selected?.kind === 'pod' ? e.parentId === selected.id : selected?.kind === 'node' ? e.nodeId === selected.id : e.nodeId !== null));
  return { selected, containers };
}

/** Requests, limits and observed usage for a scope. Null observations stay null: they are never summed as zero. */
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
export function nodeFor(entities: readonly FleetEntity[], id: string) { return entities.find(e => e.id === id)?.nodeId ?? ''; }
export function workloadSummary(entities: readonly FleetEntity[]) {
  return [...new Set(entities.filter(e => e.kind === 'pod').map(e => e.workload!))].sort().map(id => {
    const pods = entities.filter(e => e.kind === 'pod' && e.workload === id), leaves = entities.filter(e => e.kind === 'container' && e.workload === id && e.nodeId !== null);
    const observed = (key: 'cpuUsed' | 'memoryUsed') => leaves.some(e => e[key] !== null) ? leaves.reduce((a, e) => a + (e[key] ?? 0), 0) : null;
    return { id, namespace: pods[0]?.namespace ?? '', desired: pods.length, running: pods.filter(p => p.status === 'Running').length, pending: pods.filter(p => p.status === 'Pending').length, unknown: pods.filter(p => p.status === 'Unknown').length,
      restarts: leaves.reduce((n, e) => n + e.restarts, 0), cpuUsed: observed('cpuUsed'), memoryUsed: observed('memoryUsed'), firstPod: pods.find(p => p.status === 'Running')?.id ?? pods[0]?.id ?? '' };
  });
}

import { describe, expect, it } from 'vitest';
import { placementModel, resourceGroups, resourceStrips, throttleCells } from '@insights/plugins/kubernetes-data';
import { fleetBack, fleetBreadcrumb, nodeFor, resourceSummary, selectExisting } from '../src/lenses/kubernetes/fleet-model';
import { createFleet, fleetEncoding, fleetPanels, kubernetesFixtures, workloadHistory } from '../src/lenses/kubernetes/fixtures';

describe('Kubernetes Fleet accounting', () => {
  const entities = createFleet();

  it('keeps a coherent 48-node / pod / container hierarchy', () => {
    expect(entities).toHaveLength(924);
    expect(entities.filter(e => e.kind === 'node')).toHaveLength(48);
    expect(entities.filter(e => e.kind === 'pod')).toHaveLength(292);
    expect(entities.filter(e => e.kind === 'container')).toHaveLength(584);
    expect(entities.filter(e => e.status === 'Not ready')).toHaveLength(1);
    expect(entities.filter(e => e.kind === 'pod' && e.status === 'Pending')).toHaveLength(4);
  });

  it('aggregates resource leaves once and keeps pending requests out of scheduled node totals', () => {
    const all = resourceSummary(entities), containers = entities.filter(e => e.kind === 'container'), pending = containers.filter(e => e.nodeId === null);
    expect(all.cpuAllocatable).toBe(768);
    expect(all.memoryAllocatable).toBe(3072);
    expect(all.expected).toBe(576);
    expect(all.cpuUsed.count).toBe(564);
    expect(all.cpuRequested).toBeCloseTo(containers.reduce((s, c) => s + c.cpuRequest!, 0) - pending.reduce((s, c) => s + c.cpuRequest!, 0), 8);
    expect(pending.reduce((s, c) => s + c.cpuRequest!, 0)).toBeCloseTo(9.6, 9);
    expect(pending.reduce((s, c) => s + c.memoryRequest!, 0)).toBe(36);
  });

  it('encodes the fleet into series the production Kubernetes adapters accept without issues', () => {
    const encoded = fleetEncoding(entities, '', true);
    const placement = placementModel(encoded.placement, { resource: 'cpu', maxNodes: 64 });
    expect(placement.issues).toEqual([]);
    expect(placement.model.pending).toHaveLength(4);
    expect(placement.model.totalNodes).toBe(48);
    expect(resourceGroups(encoded.bars, { groupLabel: 'pod', maxGroups: 16 }).issues).toEqual([]);
    expect(throttleCells(encoded.throttle, { groupLabel: 'pod' }).issues).toEqual([]);
    expect(resourceStrips(encoded.trend, {}).issues).toEqual([]);
  });

  it('keeps the selected scope and the namespace filter on the lens panels', () => {
    const panels = fleetPanels(entities, 'pod:node-au-17:0');
    expect(panels.resources.widget.pluginId).toBe('kubernetes-resource-bars');
    expect(resourceGroups(panels.resources.result, panels.resources.widget.config).model.totalGroups).toBe(1);
    const payments = kubernetesFixtures('payments');
    expect(new Set(payments.entities.filter(e => e.kind === 'pod').map(e => e.namespace))).toEqual(new Set(['payments']));
  });

  it('gives one CPU and memory history value per minute for a workload', () => {
    const history = workloadHistory(entities, 'worker');
    expect(history.cpu).toHaveLength(61);
    expect(history.memory).toHaveLength(61);
  });
});

describe('Kubernetes Fleet selection', () => {
  const entities = createFleet();

  it('builds the breadcrumb and back link through node, pod and container', () => {
    const containerId = 'pod:node-au-17:0:0';
    expect(fleetBreadcrumb(entities, containerId).map(e => e.kind)).toEqual(['node', 'pod', 'container']);
    expect(fleetBack(entities, containerId)).toBe('pod:node-au-17:0');
    expect(nodeFor(entities, containerId)).toBe('node-au-17');
  });

  it('drops a stale selection', () => {
    expect(selectExisting(entities, 'node-au-99')).toBe('');
    expect(selectExisting(entities, 'node-au-01')).toBe('node-au-01');
  });
});

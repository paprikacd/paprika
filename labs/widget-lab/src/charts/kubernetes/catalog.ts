import type { CatalogFeature, CatalogPreset } from '../../catalog/chart-fixtures';
import { kubernetesFixtures } from '../../lenses/kubernetes/fixtures';

export type KubernetesCatalogId = 'kubernetes-placement' | 'kubernetes-resource-bars' | 'kubernetes-throttle-matrix' | 'kubernetes-resource-trend';
const presets = ['ready', 'gaps', 'empty', 'error'] as const;
export const kubernetesChartCatalog: readonly (Omit<CatalogFeature, 'id'> & { id: KubernetesCatalogId })[] = [
  { id: 'kubernetes-placement', label: 'Workload placement and pressure', group: 'Kubernetes Fleet', lensHref: '#kubernetes-fleet', question: 'Which nodes carry which pod requests, and where is request pressure concentrated?', contract: 'Physical node capacity and scheduled container requests are distinct. Pod areas sum container requests; unused area is retained. Pending pods have no invented node placement.', inspect: 'Select a node or pod and inspect its exact request and usage values. In Kubernetes Fleet, continue through the linked node → pod → container detail dock.', presets, owner: 'KubernetesPlacement / fleetRows + d3-hierarchy' },
  { id: 'kubernetes-resource-bars', label: 'Capacity, request, usage and limit comparison', group: 'Kubernetes Fleet', lensHref: '#kubernetes-fleet', question: 'How much workload resource is observed, reserved and limited for this exact entity?', contract: 'Container leaves own resource values. Parent totals aggregate once. Allocatable belongs to nodes; summed limits can exceed it. Partial observed coverage is explicit, and unknown stays null.', inspect: 'Inspect CPU and memory rows for exact usage, request, limits, allocatable capacity and measured container coverage.', presets, owner: 'KubernetesResourceBars / resourceSummary' },
  { id: 'kubernetes-throttle-matrix', label: 'Node CFS throttling over time', group: 'Kubernetes Fleet', lensHref: '#kubernetes-fleet', question: 'When did CPU throttling increase, and which nodes were observed?', contract: 'Each five-minute cell is throttled periods / observed CFS periods. Aggregate ratios use counts. Missing-node observations are hatched, not represented as zero.', inspect: 'Page through nodes, hover or pin an exact interval, and select its node in the detail dock. Editor controls page density and colour ceiling.', presets, owner: 'KubernetesThrottleMatrix / throttleRows' },
  { id: 'kubernetes-resource-trend', label: 'Synchronized workload resource strips', group: 'Kubernetes Fleet', lensHref: '#kubernetes-fleet', question: 'How did measured CPU, memory and network evolve for the selected cluster, node, pod or container?', contract: 'One source scope per result; UTC timestamps and explicit cores / GiB / Mb/s units. Requested capacity is a separate series. Partial measured sums disclose their observed population.', inspect: 'Pointer and keyboard inspection pins exact synchronized values. Drag, undo, reset or type a time window through the shared time-window owner.', presets, owner: 'KubernetesResourceTrend / resourceTimepoints + shared time-window controls' },
];
export const isKubernetesCatalogId = (id: string): id is KubernetesCatalogId => kubernetesChartCatalog.some(f => f.id === id);
export function makeKubernetesCatalogFixture(id: KubernetesCatalogId, preset: CatalogPreset = 'ready') {
  if (!isKubernetesCatalogId(id) || !presets.includes(preset)) throw new Error('Unsupported Kubernetes chart or fixture state.');
  const fixture = kubernetesFixtures('all', preset === 'gaps' ? 'gaps' : 'ready');
  const panel = ({ 'kubernetes-placement': fixture.placement, 'kubernetes-resource-bars': fixture.resources, 'kubernetes-throttle-matrix': fixture.throttling, 'kubernetes-resource-trend': fixture.trend })[id];
  const result = structuredClone(panel.result), widget = structuredClone(panel.widget); widget.id = `catalog-${id}`;
  if (preset === 'empty') result.records!.rows = [];
  if (preset === 'gaps' && id === 'kubernetes-resource-bars') widget.config = { ...widget.config, selectedId: 'node-au-36' };
  return { widget, result };
}

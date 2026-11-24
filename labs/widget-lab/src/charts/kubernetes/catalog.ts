import type { CatalogFeature, CatalogPreset } from '../../catalog/chart-fixtures';
import { kubernetesFixture, KUBERNETES_PLUGIN_IDS } from '@insights/plugins/kubernetes-fixtures';

export type KubernetesCatalogId = 'kubernetes-placement' | 'kubernetes-resource-bars' | 'kubernetes-throttle-matrix' | 'kubernetes-resource-trend';
const presets = ['ready', 'gaps', 'empty', 'error'] as const;
export const kubernetesChartCatalog: readonly (Omit<CatalogFeature, 'id'> & { id: KubernetesCatalogId })[] = [
  { id: 'kubernetes-placement', label: 'Workload placement and pressure', group: 'Kubernetes Fleet', lensHref: '#kubernetes-fleet', question: 'Which nodes carry which pod requests, and where is request pressure concentrated?', contract: 'Node capacity comes from node series; each pod is one series of requests on its node. Pressure is requests over allocatable. Pending pods have no node, so they are counted apart and never placed.', inspect: 'Hover or focus a pod segment to see its exact request. In Kubernetes Fleet, continue through the linked node, pod and container detail dock.', presets, owner: 'KubernetesPlacement / kubernetes-data placementModel (production)' },
  { id: 'kubernetes-resource-bars', label: 'Capacity, request, usage and limit comparison', group: 'Kubernetes Fleet', lensHref: '#kubernetes-fleet', question: 'How much workload resource is observed, reserved and limited for each pod or container group?', contract: 'Usage, request and limit come from separate series per group. A limit sum covers only the containers that declare one. Unavailable usage stays null and is hatched, never zero.', inspect: 'Hover a bar to read the exact usage, request and limit. The footer says how many groups were left out of the top of the ranking.', presets, owner: 'KubernetesResourceBars / resourceGroups (production)' },
  { id: 'kubernetes-throttle-matrix', label: 'CFS throttling by pod over time', group: 'Kubernetes Fleet', lensHref: '#kubernetes-fleet', question: 'When did CPU throttling increase, and for which pods?', contract: 'Each cell is throttled periods over CFS periods for one pod and sample. A zero-period sample is observed but neutral. A missing sample is hatched, not zero.', inspect: 'Page through the rows and hover or focus a cell to read its exact throttled share. The colour ceiling sets where the strongest colour starts.', presets, owner: 'KubernetesThrottleMatrix / throttleCells (production)' },
  { id: 'kubernetes-resource-trend', label: 'Synchronized workload resource strips', group: 'Kubernetes Fleet', lensHref: '#kubernetes-fleet', question: 'How did measured CPU, memory and network evolve for the selected scope?', contract: 'One series per signal over one scope. Requests are a dashed reference, not a measurement. Missing samples break the line rather than dropping to zero.', inspect: 'Read the latest value per strip beside its title. The strips share one time axis.', presets, owner: 'KubernetesResourceTrend / resourceStrips (production)' },
];
export const isKubernetesCatalogId = (id: string): id is KubernetesCatalogId => kubernetesChartCatalog.some(f => f.id === id);

/** The catalogue renders the production widgets on the production fixtures. The error state has no failure fixture here, so it shows the ready data. */
export function makeKubernetesCatalogFixture(id: KubernetesCatalogId, preset: CatalogPreset = 'ready') {
  if (!isKubernetesCatalogId(id) || !presets.includes(preset)) throw new Error('Unsupported Kubernetes chart or fixture state.');
  if (!Object.values(KUBERNETES_PLUGIN_IDS).includes(id)) throw new Error('Unknown Kubernetes plugin id.');
  const fixturePreset = preset === 'error' ? 'ready' : preset;
  const { widget, result } = kubernetesFixture(id, fixturePreset);
  return { widget: { ...widget, id: `catalog-${id}`, layout: { x: 0, y: 0, w: 6, h: 6 } } as typeof widget, result: structuredClone(result) };
}

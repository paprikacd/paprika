import { getWidgetDefinition, registerWidgetPlugin, type WidgetPlugin } from '../../renderer-extensions/widget-registry';
import { fleetRows, placementConfig, resourceBarsConfig, resourceSummary, resourceTimepoints, resourceTrendConfig, throttleConfig, throttleRows } from './model';
import { KubernetesPlacement } from './PlacementChart';
import { KubernetesResourceBars, KubernetesResourceTrend, KubernetesThrottleMatrix } from './KubernetesCharts';

export function registerKubernetesCharts() {
  const definitions: WidgetPlugin[] = [
    { id: 'kubernetes-placement', label: 'Kubernetes workload placement', description: 'Node capacity and nested pod requests with linked entity inspection.', dataKind: 'records', render: KubernetesPlacement,
      defaultConfig: placementConfig.parse({}), parseConfig: c => placementConfig.parse(c ?? {}), validateInput: (result, config) => { placementConfig.parse(config ?? {}); fleetRows(result.records); },
      configFields: [{ key: 'resource', label: 'Area encoding', kind: 'select', options: [{ value: 'cpu', label: 'Allocatable / requested CPU' }, { value: 'memory', label: 'Allocatable / requested memory' }] }, { key: 'showPods', label: 'Nested pod request rectangles', kind: 'boolean' }, { key: 'pressure', label: 'Request pressure threshold', kind: 'number', min: .5, max: 1, step: .05, help: 'Request / allocatable ratio. High measured usage has its own resource view.' }], styleControls: ['tooltips', 'legend'], layout: { mode: 'intrinsic', minWidth: 280, minHeight: 400 } },
    { id: 'kubernetes-resource-bars', label: 'Kubernetes resource comparison', description: 'Observed container usage, requests, limit sums and node allocatable capacity on honest numerical axes.', dataKind: 'records', render: KubernetesResourceBars,
      defaultConfig: resourceBarsConfig.parse({}), parseConfig: c => resourceBarsConfig.parse(c ?? {}), validateInput: (result, config) => { const cfg = resourceBarsConfig.parse(config ?? {}); const data = fleetRows(result.records); resourceSummary(data, cfg.selectedId); },
      configFields: [{ key: 'showLimits', label: 'Container limit sum markers', kind: 'boolean' }, { key: 'showValues', label: 'Observed and requested values', kind: 'boolean' }], styleControls: ['tooltips', 'legend'], layout: { mode: 'intrinsic', minWidth: 280, minHeight: 250 } },
    { id: 'kubernetes-throttle-matrix', label: 'Kubernetes CPU throttle matrix', description: 'Measured throttled CFS periods over observed CFS periods with explicit time intervals and coverage.', dataKind: 'records', render: KubernetesThrottleMatrix,
      defaultConfig: throttleConfig.parse({}), parseConfig: c => throttleConfig.parse(c ?? {}), validateInput: (result, config) => { throttleConfig.parse(config ?? {}); throttleRows(result.records); },
      configFields: [{ key: 'rows', label: 'Nodes per page', kind: 'number', min: 6, max: 24, step: 1 }, { key: 'ceiling', label: 'Colour ceiling · percent', kind: 'number', min: 1, max: 100, step: 5, help: 'Values beyond this ceiling retain their exact values in inspection.' }], styleControls: ['tooltips'], layout: { mode: 'intrinsic', minWidth: 280, minHeight: 330 } },
    { id: 'kubernetes-resource-trend', label: 'Kubernetes resource time strips', description: 'Synchronized CPU, memory and network strips with exact inspection and shared time-window brushing.', dataKind: 'records', render: KubernetesResourceTrend,
      defaultConfig: resourceTrendConfig.parse({}), parseConfig: c => resourceTrendConfig.parse(c ?? {}), validateInput: (result, config) => { resourceTrendConfig.parse(config ?? {}); resourceTimepoints(result.records); },
      configFields: [{ key: 'showNetwork', label: 'Network ingress / egress strip', kind: 'boolean' }, { key: 'showRequested', label: 'Requested CPU / memory reference', kind: 'boolean' }, { key: 'fill', label: 'Measured usage area fill', kind: 'boolean' }], styleControls: ['tooltips', 'legend'], layout: { mode: 'intrinsic', minWidth: 280, minHeight: 240 } },
  ];
  for (const definition of definitions) if (!getWidgetDefinition('plugin', definition.id)) registerWidgetPlugin(definition);
}

import { createElement, lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { BarChart3, Grid2X2, Layers, LineChart } from "lucide-react";
import type { Widget } from "../schema";
import { getWidgetDefinition, registerWidgetPlugin, type WidgetConfigField, type WidgetRendererProps } from "../widget-registry";
import { KUBERNETES_PLUGIN_IDS } from "./kubernetes-queries";
import {
  placementConfigSchema,
  placementModel,
  resourceBarsConfigSchema,
  resourceGroups,
  resourceStrips,
  resourceTrendConfigSchema,
  throttleCells,
  throttleConfigSchema,
} from "./kubernetes-data";

/**
 * The renderers are loaded on first use, so their code stays out of the Insights first view. The definitions, configs
 * and input checks are eager: the editor and the registry need them before anything draws.
 */
const deferred = (load: () => Promise<{ default: ComponentType<WidgetRendererProps> }>): ComponentType<WidgetRendererProps> => {
  const Component: LazyExoticComponent<ComponentType<WidgetRendererProps>> = lazy(load);
  function Deferred(props: WidgetRendererProps) {
    return createElement(Suspense, { fallback: null }, createElement(Component, props));
  }
  return Deferred;
};
const KubernetesPlacement = deferred(() => import("./kubernetes-placement").then(module => ({ default: module.KubernetesPlacement })));
const KubernetesResourceBars = deferred(() => import("./kubernetes-widgets").then(module => ({ default: module.KubernetesResourceBars })));
const KubernetesThrottleMatrix = deferred(() => import("./kubernetes-widgets").then(module => ({ default: module.KubernetesThrottleMatrix })));
const KubernetesResourceTrend = deferred(() => import("./kubernetes-widgets").then(module => ({ default: module.KubernetesResourceTrend })));

const LABEL = "Label name, such as pod or container.";
const groupLabelField: WidgetConfigField = { key: "groupLabel", label: "Group label", kind: "text", placeholder: "pod", help: LABEL };

/** Registers the four Kubernetes families as product metrics plugins. Each one reads a `signal` label; see kubernetes-queries.ts. */
export function registerKubernetesPlugins() {
  const plugins = [
    {
      id: KUBERNETES_PLUGIN_IDS.placement, label: "Workload placement", description: "Node capacity and the pod requests placed on each node.",
      icon: Layers,
      dataKind: "metrics" as const, render: KubernetesPlacement,
      defaultConfig: {} as Widget["config"],
      parseConfig: (config: Widget["config"]) => placementConfigSchema.parse(config ?? {}),
      validateInput: (result: Parameters<typeof placementModel>[0], config: Widget["config"]) => placementModel(result, config).issues,
      styleControls: ["decimals", "legend", "tooltips"] as const,
      configFields: [
        { key: "resource", label: "Resource", kind: "select", options: [{ value: "cpu", label: "CPU" }, { value: "memory", label: "Memory" }] },
        { key: "pressure", label: "Request pressure threshold", kind: "number", min: 0.5, max: 1, step: 0.05, help: "The query's pod requests over the node's allocatable. At or above this share the node is warning-coloured; above 100% it is critical. Pods the query leaves out, such as other namespaces, are not counted." },
        { key: "showPods", label: "List pods on each node", kind: "boolean" },
        { key: "maxNodes", label: "Maximum nodes", kind: "number", min: 1, max: 64, step: 1 },
      ] satisfies WidgetConfigField[],
      sizing: { mode: "intrinsic" as const, minWidth: 280, minHeight: 400 },
    },
    {
      id: KUBERNETES_PLUGIN_IDS.bars, label: "Resource comparison by group", description: "Usage, requests and limit sums for each pod or container group.",
      icon: BarChart3,
      dataKind: "metrics" as const, render: KubernetesResourceBars,
      defaultConfig: { groupLabel: "pod" } as Widget["config"],
      parseConfig: (config: Widget["config"]) => resourceBarsConfigSchema.parse(config ?? {}),
      validateInput: (result: Parameters<typeof resourceGroups>[0], config: Widget["config"]) => resourceGroups(result, config).issues,
      styleControls: ["decimals", "legend", "tooltips"] as const,
      configFields: [
        groupLabelField,
        { key: "maxGroups", label: "Maximum groups", kind: "number", min: 1, max: 16, step: 1, help: "The busiest groups are shown first. The rest are counted." },
        { key: "showLimits", label: "Limit sum markers", kind: "boolean" },
        { key: "showValues", label: "Usage and request values", kind: "boolean" },
      ] satisfies WidgetConfigField[],
      sizing: { mode: "intrinsic" as const, minWidth: 280, minHeightFor: (config: Widget["config"]) => 40 + 37 * ((config as { maxGroups?: number } | undefined)?.maxGroups ?? 8) },
    },
    {
      id: KUBERNETES_PLUGIN_IDS.throttle, label: "CPU throttling matrix", description: "Throttled CFS periods as a share of all periods, per pod over time.",
      icon: Grid2X2,
      dataKind: "metrics" as const, render: KubernetesThrottleMatrix,
      defaultConfig: {} as Widget["config"],
      parseConfig: (config: Widget["config"]) => throttleConfigSchema.parse(config ?? {}),
      validateInput: (result: Parameters<typeof throttleCells>[0], config: Widget["config"]) => throttleCells(result, config).issues,
      styleControls: ["decimals", "tooltips"] as const,
      configFields: [
        groupLabelField,
        { key: "rows", label: "Rows per page", kind: "number", min: 6, max: 24, step: 1 },
        { key: "ceiling", label: "Colour ceiling (percent)", kind: "number", min: 1, max: 100, step: 5, help: "Throttling at or above this share takes the strongest colour." },
      ] satisfies WidgetConfigField[],
      sizing: { mode: "intrinsic" as const, minWidth: 280, minHeight: 330 },
    },
    {
      id: KUBERNETES_PLUGIN_IDS.trend, label: "Namespace resource trend", description: "CPU, memory and network over time, with requests as a dashed reference.",
      icon: LineChart,
      dataKind: "metrics" as const, render: KubernetesResourceTrend,
      defaultConfig: {} as Widget["config"],
      parseConfig: (config: Widget["config"]) => resourceTrendConfigSchema.parse(config ?? {}),
      validateInput: (result: Parameters<typeof resourceStrips>[0], config: Widget["config"]) => resourceStrips(result, config).issues,
      styleControls: ["decimals", "legend", "tooltips"] as const,
      configFields: [
        { key: "showNetwork", label: "Network strip", kind: "boolean" },
        { key: "showRequested", label: "Requested reference lines", kind: "boolean" },
        { key: "fill", label: "Usage area fill", kind: "boolean" },
      ] satisfies WidgetConfigField[],
      sizing: { mode: "intrinsic" as const, minWidth: 280, minHeight: 240 },
    },
  ];
  for (const plugin of plugins) if (!getWidgetDefinition("plugin", plugin.id)) registerWidgetPlugin(plugin);
}

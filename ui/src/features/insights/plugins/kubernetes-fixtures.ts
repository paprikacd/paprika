import type { QueryResult, Widget } from "../schema";

/**
 * Synthetic fleet data for tests, the widget lab and the gallery. It encodes one fleet into the series each Kubernetes
 * query returns, so the adapters see exactly the label shapes the PromQL in kubernetes-queries.ts produces.
 * Nothing here ships to a real provider.
 */

export const KUBERNETES_PLUGIN_IDS = {
  placement: "kubernetes-placement",
  bars: "kubernetes-resource-bars",
  throttle: "kubernetes-throttle-matrix",
  trend: "kubernetes-resource-trend",
} as const;
export type KubernetesPluginId = (typeof KUBERNETES_PLUGIN_IDS)[keyof typeof KUBERNETES_PLUGIN_IDS];
export type KubernetesPreset = "ready" | "gaps" | "empty";

export interface FleetNode {
  node: string;
  zone: string;
  cpu: number;
  memoryBytes: number;
  ready: boolean;
}
export interface FleetPod {
  namespace: string;
  pod: string;
  /** The scheduled node, or null for a pending pod. */
  node: string | null;
  cpuRequest: number;
  cpuLimit: number | null;
  memoryRequest: number;
  memoryLimit: number | null;
  /** Measured usage at a timestamp. Null means the sample is unavailable, never zero. */
  cpuUsage: (timestamp: number) => number | null;
  memoryUsage: (timestamp: number) => number | null;
  /** CFS counts for one sample. Null means unavailable. Zero periods is an observed, neutral cell. */
  throttle: (timestamp: number) => { throttled: number; periods: number } | null;
}
export interface FleetSpec {
  nodes: FleetNode[];
  pods: FleetPod[];
  networkRx: (timestamp: number) => number | null;
  networkTx: (timestamp: number) => number | null;
}
export interface EncodeOptions {
  start: number;
  step: number;
  points: number;
}
export interface FleetResults {
  placement: QueryResult;
  bars: QueryResult;
  throttle: QueryResult;
  trend: QueryResult;
}

const timestamps = (options: EncodeOptions) => Array.from({ length: options.points }, (_, i) => options.start + i * options.step);
const series = (labels: Record<string, string>, times: number[], value: (time: number) => number | null) => ({
  name: labels.signal ?? "series",
  labels,
  points: times.map(timestamp => ({ timestamp, value: value(timestamp) })),
});
const sumOrNull = (values: (number | null)[]) => (values.every(v => v === null) ? null : values.reduce<number>((total, v) => total + (v ?? 0), 0));

/** Encodes a fleet into one QueryResult per Kubernetes query. */
export function kubernetesFleetSeries(spec: FleetSpec, options: EncodeOptions): FleetResults {
  const times = timestamps(options);
  const placement: NonNullable<QueryResult["series"]> = [];
  for (const node of spec.nodes) {
    const base = { node: node.node, zone: node.zone };
    placement.push(series({ ...base, signal: "cpu-allocatable" }, times, () => node.cpu));
    placement.push(series({ ...base, signal: "memory-allocatable" }, times, () => node.memoryBytes));
    placement.push(series({ ...base, signal: "node-ready" }, times, () => (node.ready ? 1 : 0)));
  }
  for (const pod of spec.pods) {
    const labels = { namespace: pod.namespace, pod: pod.pod, node: pod.node ?? "" };
    placement.push(series({ ...labels, signal: "cpu-request" }, times, () => pod.cpuRequest));
    placement.push(series({ ...labels, signal: "memory-request" }, times, () => pod.memoryRequest));
  }

  const bars: NonNullable<QueryResult["series"]> = [];
  for (const pod of spec.pods) {
    const labels = { pod: pod.pod };
    bars.push(series({ ...labels, signal: "cpu-usage" }, times, pod.cpuUsage));
    bars.push(series({ ...labels, signal: "memory-usage" }, times, pod.memoryUsage));
    bars.push(series({ ...labels, signal: "cpu-request" }, times, () => pod.cpuRequest));
    bars.push(series({ ...labels, signal: "memory-request" }, times, () => pod.memoryRequest));
    if (pod.cpuLimit !== null) bars.push(series({ ...labels, signal: "cpu-limit" }, times, () => pod.cpuLimit));
    if (pod.memoryLimit !== null) bars.push(series({ ...labels, signal: "memory-limit" }, times, () => pod.memoryLimit));
  }

  const throttle: NonNullable<QueryResult["series"]> = [];
  for (const pod of spec.pods) {
    const labels = { pod: pod.pod };
    throttle.push(series({ ...labels, signal: "throttled" }, times, t => pod.throttle(t)?.throttled ?? null));
    throttle.push(series({ ...labels, signal: "periods" }, times, t => pod.throttle(t)?.periods ?? null));
  }

  const trend: NonNullable<QueryResult["series"]> = [
    series({ signal: "cpu-usage" }, times, t => sumOrNull(spec.pods.map(p => p.cpuUsage(t)))),
    series({ signal: "cpu-request" }, times, () => sumOrNull(spec.pods.map(p => p.cpuRequest))),
    series({ signal: "memory-usage" }, times, t => sumOrNull(spec.pods.map(p => p.memoryUsage(t)))),
    series({ signal: "memory-request" }, times, () => sumOrNull(spec.pods.map(p => p.memoryRequest))),
    series({ signal: "network-rx" }, times, spec.networkRx),
    series({ signal: "network-tx" }, times, spec.networkTx),
  ];

  const wrap = (rows: NonNullable<QueryResult["series"]>): QueryResult => ({ series: rows });
  return { placement: wrap(placement), bars: wrap(bars), throttle: wrap(throttle), trend: wrap(trend) };
}

/** A small, deterministic fleet: three nodes, eight pods, one pending pod and one node that is not ready. */
function demoFleet(preset: KubernetesPreset): FleetSpec {
  const wave = (base: number, phase: number, gaps: boolean) => (t: number) => {
    if (gaps && Math.floor(t / 60000) % 5 === 2) return null;
    return base * (0.55 + 0.35 * Math.sin(t / 300000 + phase));
  };
  const throttleWave = (phase: number, gaps: boolean) => (t: number) => {
    if (gaps && Math.floor(t / 60000) % 4 === 1) return null;
    const periods = 300;
    const throttled = Math.max(0, Math.round(periods * (0.2 + 0.15 * Math.sin(t / 240000 + phase))));
    // A quiet window with no CFS periods is observed but neutral, so it is never painted as zero throttling.
    if (gaps && Math.floor(t / 60000) % 6 === 3) return { throttled: 0, periods: 0 };
    return { throttled, periods };
  };
  const gaps = preset === "gaps";
  const pods: FleetPod[] = [
    ["api", "api-7d9f-a", "node-a", 0.5, 1, 1, 2], ["api", "api-7d9f-b", "node-b", 0.5, 1, 1, 2],
    ["worker", "worker-5c1-a", "node-a", 1.5, 2, 2, 4], ["worker", "worker-5c1-b", "node-c", 1, null, 1, null],
    ["cache", "redis-0", "node-b", 0.25, 0.5, 0.5, 1], ["ingest", "ingest-1", "node-c", 2.5, 3, 3, 6],
    ["ingest", "ingest-2", "node-a", 2, 3, 4, 6], ["batch", "batch-job-pending", null, 3, 4, 4, 8],
  ].map(([namespace, pod, node, cpuRequest, cpuLimit, memoryGiB, memoryLimitGiB], index) => ({
    namespace: namespace as string,
    pod: pod as string,
    node: node as string | null,
    cpuRequest: cpuRequest as number,
    cpuLimit: cpuLimit as number | null,
    memoryRequest: (memoryGiB as number) * 1024 ** 3,
    memoryLimit: memoryLimitGiB === null ? null : (memoryLimitGiB as number) * 1024 ** 3,
    cpuUsage: wave(cpuRequest as number, index, gaps),
    memoryUsage: wave((memoryGiB as number) * 1024 ** 3, index + 1, gaps),
    throttle: throttleWave(index, gaps),
  }));
  return {
    nodes: [
      { node: "node-a", zone: "ap-southeast-2a", cpu: 8, memoryBytes: 32 * 1024 ** 3, ready: true },
      { node: "node-b", zone: "ap-southeast-2b", cpu: 8, memoryBytes: 32 * 1024 ** 3, ready: true },
      { node: "node-c", zone: "ap-southeast-2b", cpu: 4, memoryBytes: 16 * 1024 ** 3, ready: preset !== "gaps" },
    ],
    pods,
    networkRx: wave(40e6, 0.3, gaps),
    networkTx: wave(12e6, 1.2, gaps),
  };
}

export const KUBERNETES_FIXTURE_OPTIONS: EncodeOptions = { start: Date.UTC(2026, 10, 24, 0, 0, 0), step: 60000, points: 12 };

/** A widget and its result for one plugin and preset. The widget is the shape a starter stores, without a dashboard. */
export function kubernetesFixture(id: KubernetesPluginId, preset: KubernetesPreset = "ready"): { widget: Widget; result: QueryResult } {
  const family = (Object.keys(KUBERNETES_PLUGIN_IDS) as (keyof typeof KUBERNETES_PLUGIN_IDS)[]).find(key => KUBERNETES_PLUGIN_IDS[key] === id);
  if (!family) throw new Error(`Unknown Kubernetes plugin: ${id}`);
  const encoded = preset === "empty"
    ? { placement: { series: [] }, bars: { series: [] }, throttle: { series: [] }, trend: { series: [] } } as FleetResults
    : kubernetesFleetSeries(demoFleet(preset), KUBERNETES_FIXTURE_OPTIONS);
  const config = family === "bars" ? { groupLabel: "pod" } : {};
  const widget = {
    id: `${id}-${preset}`,
    title: id,
    type: "plugin",
    providerId: "fixture",
    query: "fixture",
    unit: "",
    pluginId: id,
    dataKind: "metrics",
    config,
  } as unknown as Widget;
  return { widget, result: encoded[family] };
}

/**
 * Default PromQL for the four Kubernetes widgets. Every query is one string here, so starters, the gallery and the
 * lab all read the same text. `{{namespace}}` is the dashboard variable a starter declares.
 *
 * Label assumptions (not verified against a live cluster; see docs/design/insights/kubernetes-widgets.md):
 * - kube-state-metrics v2: kube_pod_info(namespace, pod, node), kube_pod_container_resource_requests and _limits
 *   (namespace, pod, node, container, resource, unit), kube_node_status_allocatable(node, resource, unit) and
 *   kube_node_status_condition(node, condition, status).
 * - cAdvisor: container_cpu_usage_seconds_total, container_memory_working_set_bytes, container_network_*_bytes_total
 *   and container_cpu_cfs_*periods_total, each labelled namespace, pod and container.
 * - Each query adds a `signal` label with label_replace. The widget reads that label, so one query can feed one widget.
 */

/** The pod-level selector used by the namespace-scoped widgets. `container="POD"` is the sandbox, not a workload. */
const CONTAINER = `namespace={{namespace}},container!="",container!="POD"`;

/** Requests for one resource. kube-state-metrics keeps completed pods too; a phase filter is a follow-up. */
const requests = (resource: "cpu" | "memory", unit: "core" | "byte") =>
  `kube_pod_container_resource_requests{namespace={{namespace}},resource="${resource}",unit="${unit}"}`;
const limits = (resource: "cpu" | "memory", unit: "core" | "byte", selector = `namespace={{namespace}}`) =>
  `kube_pod_container_resource_limits{${selector},resource="${resource}",unit="${unit}"}`;
const tag = (expression: string, signal: string) => `label_replace(${expression}, "signal", "${signal}", "", "")`;

/** Node capacity for nodes that run at least one pod in the namespace. */
const allocatable = (resource: "cpu" | "memory", unit: "core" | "byte") =>
  `max by (node) (kube_node_status_allocatable{resource="${resource}",unit="${unit}"}) and on (node) count by (node) (kube_pod_info{namespace={{namespace}},node!=""})`;

/** Placement: node capacity and pod requests. A request with an empty `node` is a pending pod. */
export const PLACEMENT_QUERY = [
  tag(allocatable("cpu", "core"), "cpu-allocatable"),
  tag(allocatable("memory", "byte"), "memory-allocatable"),
  tag(`sum by (namespace, pod, node) (${requests("cpu", "core")})`, "cpu-request"),
  tag(`sum by (namespace, pod, node) (${requests("memory", "byte")})`, "memory-request"),
  tag(`max by (node) (kube_node_status_condition{condition="Ready",status="true"}) and on (node) count by (node) (kube_pod_info{namespace={{namespace}},node!=""})`, "node-ready"),
].join(" or ");

/** The six resource clauses for bars, grouped by a label. The group label is the one the widget configures. */
const barClauses = (by: string, selector: string, cpuLimit: string, memoryLimit: string) => [
  tag(`sum by (${by}) (rate(container_cpu_usage_seconds_total{${selector}}[5m]))`, "cpu-usage"),
  tag(`sum by (${by}) (${requests("cpu", "core").replace(`{namespace={{namespace}},`, `{${selector},`)})`, "cpu-request"),
  tag(`sum by (${by}) (${cpuLimit})`, "cpu-limit"),
  tag(`sum by (${by}) (container_memory_working_set_bytes{${selector}})`, "memory-usage"),
  tag(`sum by (${by}) (${requests("memory", "byte").replace(`{namespace={{namespace}},`, `{${selector},`)})`, "memory-request"),
  tag(`sum by (${by}) (${memoryLimit})`, "memory-limit"),
];

/** Resource bars grouped by pod inside the namespace. The widget's groupLabel can name another label on these series. */
export const RESOURCE_BARS_BY_POD_QUERY = barClauses(
  "pod",
  CONTAINER,
  limits("cpu", "core"),
  limits("memory", "byte"),
).join(" or ");

/** The control-plane selector comes from the PaprikaOOMKilled rule in charts/chart/templates/prometheus/prometheusrules.yaml. */
export const CONTROL_PLANE_SELECTOR = `pod=~".*paprika.*",container=~"manager|api-server|repo-server|webhook-receiver|observability-gateway|dashboard-renderer|insights|agent|redis"`;

/** Resource bars for the Paprika control plane, grouped by container. It has no namespace variable, so it needs no starter variable. */
export const CONTROL_PLANE_BARS_QUERY = barClauses(
  "container",
  CONTROL_PLANE_SELECTOR,
  limits("cpu", "core", CONTROL_PLANE_SELECTOR),
  limits("memory", "byte", CONTROL_PLANE_SELECTOR),
).join(" or ");

/** CFS period counts over five minutes, per pod. Counts are not always integers because increase extrapolates. */
export const THROTTLE_BY_POD_QUERY = [
  tag(`sum by (pod) (increase(container_cpu_cfs_throttled_periods_total{${CONTAINER}}[5m]))`, "throttled"),
  tag(`sum by (pod) (increase(container_cpu_cfs_periods_total{${CONTAINER}}[5m]))`, "periods"),
].join(" or ");

/** Namespace totals over time for the resource strips. */
export const RESOURCE_TREND_QUERY = [
  tag(`sum(rate(container_cpu_usage_seconds_total{${CONTAINER}}[5m]))`, "cpu-usage"),
  tag(`sum(${requests("cpu", "core")})`, "cpu-request"),
  tag(`sum(container_memory_working_set_bytes{${CONTAINER}})`, "memory-usage"),
  tag(`sum(${requests("memory", "byte")})`, "memory-request"),
  tag(`sum(rate(container_network_receive_bytes_total{namespace={{namespace}}}[5m]))`, "network-rx"),
  tag(`sum(rate(container_network_transmit_bytes_total{namespace={{namespace}}}[5m]))`, "network-tx"),
].join(" or ");

/** Each signal, the unit its values carry, and the family that reads it. */
export const KUBERNETES_SIGNALS = {
  "cpu-allocatable": { unit: "cores", families: ["placement"] },
  "memory-allocatable": { unit: "B", families: ["placement"] },
  "cpu-request": { unit: "cores", families: ["placement", "bars", "trend"] },
  "memory-request": { unit: "B", families: ["placement", "bars", "trend"] },
  "node-ready": { unit: "", families: ["placement"] },
  "cpu-usage": { unit: "cores", families: ["bars", "trend"] },
  "cpu-limit": { unit: "cores", families: ["bars"] },
  "memory-usage": { unit: "B", families: ["bars", "trend"] },
  "memory-limit": { unit: "B", families: ["bars"] },
  throttled: { unit: "periods", families: ["throttle"] },
  periods: { unit: "periods", families: ["throttle"] },
  "network-rx": { unit: "B/s", families: ["trend"] },
  "network-tx": { unit: "B/s", families: ["trend"] },
} as const;

export type KubernetesSignal = keyof typeof KUBERNETES_SIGNALS;
export type KubernetesFamily = "placement" | "bars" | "throttle" | "trend";

export function isKubernetesSignal(value: string): value is KubernetesSignal {
  return Object.prototype.hasOwnProperty.call(KUBERNETES_SIGNALS, value);
}

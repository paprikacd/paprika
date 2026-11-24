# Kubernetes widgets

Four product widgets show workload placement, per-group resource use, CPU throttling and namespace resource trends.
They are metrics plugins: each query returns series with a `signal` label, and the widget reads that label. The default
PromQL lives in `ui/src/features/insights/plugins/kubernetes-queries.ts`. The starters use those strings.

| Widget (plugin id) | Config | Signals |
| --- | --- | --- |
| Workload placement (`kubernetes-placement`) | `resource` cpu or memory, `pressure` 0.5 to 1, `showPods`, `maxNodes` 1 to 64 | `cpu-allocatable`, `memory-allocatable`, `cpu-request`, `memory-request`, `node-ready` |
| Resource comparison (`kubernetes-resource-bars`) | `groupLabel`, `maxGroups` 1 to 16, `showLimits`, `showValues` | `cpu-usage`, `cpu-request`, `cpu-limit`, `memory-usage`, `memory-request`, `memory-limit` |
| CPU throttling matrix (`kubernetes-throttle-matrix`) | `groupLabel`, `rows` 6 to 24, `ceiling` 1 to 100 | `throttled`, `periods` |
| Namespace resource trend (`kubernetes-resource-trend`) | `showNetwork`, `showRequested`, `fill` | `cpu-usage`, `cpu-request`, `memory-usage`, `memory-request`, `network-rx`, `network-tx` |

Units: CPU is in cores, memory in bytes, network in bytes per second. Throttle signals are CFS period counts over a window.

## Rules the widgets apply

- A missing sample is unavailable, never zero. Zero CFS periods is observed but neutral, so it is not painted as throttling.
- A pod with an empty `node` label is pending. A pod on a node that is not in the returned capacity is listed as outside.
- Bars keep the busiest groups first, up to `maxGroups`. The footer says how many were left out. A limit sum covers only the containers that declare a limit.
- Each series needs a `signal`; an unknown signal, a negative value or a duplicate identity is reported as an input issue.
- Every number honours the widget's `decimals` setting.

## Series budget

A query returns at most 100 series (`maxSeries` in the metrics provider). The default queries fit that cap with the tiles
that starters place: placement is two series per pod plus three per node, throttle is two per pod, and the trend is six.
Bars truncate past about 16 groups. The footer says when a result is truncated; the widget does not rank hidden series.

## Label and exporter assumptions

These assumptions are not verified against a live cluster. No reachable Prometheus in this repository has the exporters.

- kube-state-metrics v2: `kube_pod_info` (`namespace`, `pod`, `node`), `kube_pod_container_resource_requests` and `_limits`
  (`namespace`, `pod`, `node`, `container`, `resource`, `unit`), `kube_node_status_allocatable` (`node`, `resource`, `unit`) and
  `kube_node_status_condition` (`node`, `condition`, `status`).
- cAdvisor: `container_cpu_usage_seconds_total`, `container_memory_working_set_bytes`, `container_cpu_cfs_throttled_periods_total`,
  `container_cpu_cfs_periods_total`, `container_network_receive_bytes_total` and `container_network_transmit_bytes_total`, each with
  `namespace`, `pod` and `container`.
- `kube_pod_container_resource_requests` includes completed pods. A phase filter is a follow-up.
- The control-plane bars tile matches pods with `pod=~".*paprika.*"` and the containers named in the `PaprikaOOMKilled` rule. A
  Helm `nameOverride` changes the pod names, and the tile then shows no data.

## Gallery data

`demo/insights-gallery/generate-metrics.py` writes the same metric names for the four control-plane containers. Every value is
synthetic.

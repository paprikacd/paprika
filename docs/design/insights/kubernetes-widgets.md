# Kubernetes widgets

Four product widgets show workload placement, per-group resource use, CPU throttling and namespace resource trends.
They are metrics plugins: each query returns series with a `signal` label, and the widget reads that label. The default
PromQL lives in `ui/src/features/insights/plugins/kubernetes-queries.ts`. The starters use those strings.

| Widget (plugin id) | Config | Signals |
| --- | --- | --- |
| Workload placement (`kubernetes-placement`, node to pod treemap) | `resource` cpu or memory, `pressure` 0.5 to 1, `showPods`, `maxNodes` 1 to 64 | `cpu-allocatable`, `memory-allocatable`, `cpu-request`, `memory-request`, `node-ready` |
| Resource comparison (`kubernetes-resource-bars`) | `groupLabel`, `maxGroups` 1 to 16, `showLimits`, `showValues` | `cpu-usage`, `cpu-request`, `cpu-limit`, `memory-usage`, `memory-request`, `memory-limit` |
| CPU throttling matrix (`kubernetes-throttle-matrix`) | `groupLabel`, `rows` 6 to 24, `ceiling` 1 to 100 | `throttled`, `periods` |
| Namespace resource trend (`kubernetes-resource-trend`) | `showNetwork`, `showRequested`, `fill` | `cpu-usage`, `cpu-request`, `memory-usage`, `memory-request`, `network-rx`, `network-tx` |

Units: CPU is in cores, memory in bytes, network in bytes per second. Throttle signals are CFS period counts over a window.

## Rules the widgets apply

- A missing sample is unavailable, never zero. Zero CFS periods is observed but neutral, so it is not painted as throttling.
- A pod with an empty `node` label is pending. A pod on a node that is not in the returned capacity is listed as outside.
- Placement and bars show the present. A series whose last sample is more than one step before the newest sample in the
  result (a deleted or rescheduled pod) is left out. A pod that was pending and then scheduled is placed on its node.
- A pod with no request series for a resource declared none and counts as zero. A request series whose newest sample is
  missing is unavailable, and so is its node's sum.
- Node pressure is the query's pod requests over the node's allocatable. Pods in other namespaces are not counted, so it is
  this namespace's share of the node, not the node's total commitment. A node that is not ready has a dashed outline and
  says so in its label.
- Every mark is one tab stop per widget. Arrow keys move between marks (up and down move between rows or strips), and Enter
  or Space pins the tooltip.
- Placement is a treemap. A node's box is its allocatable capacity, its pods are tiles sized by request, and the unrequested rest is
  an open tile. Pending and outside pods sit in their own groups. Zone groups appear only when nodes carry a `zone` label. A node
  at or above `pressure` is outlined in the warning token, and above 1 in the critical token.
- Hover, focus and click open the shared observation tooltip on every mark, with values formatted through `decimals`.
- Bars keep the busiest groups first, up to `maxGroups`. The footer says how many were left out. A limit sum covers only the containers that declare a limit.
- Each series needs a `signal`; an unknown signal, a negative value or a duplicate identity is reported as an input issue.
- Every number honours the widget's `decimals` setting.

## Series budget

A query returns at most 100 series (`maxSeries` in the metrics provider). Placement is two series per pod plus three per
node, so it fits while `2 × pods + 3 × nodes ≤ 100` (about 40 pods on 6 nodes). Throttle is two per pod (50 pods), bars six
per group (16 groups) and the trend six. Larger namespaces truncate, and the footer says so; the widget does not rank
hidden series.

Prometheus returns a range result sorted by label set, and the provider keeps the first 100. The placement query sums pod
requests `by (pod, node)` without `namespace`, so each node's pods sort just before its capacity series and pending pods
sort last. A cut then drops whole nodes from the end. At most one node keeps some pods but loses its capacity, and those
pods are listed as outside returned nodes. With `namespace` on the pod series, every pod would sort before every node and a
cut would drop all node capacity first.

The throttle matrix draws at most 36 columns. A longer result groups consecutive samples: a cell's share is the sum of
throttled periods over the sum of periods, and its counts are the mean per sample, because the samples are overlapping
five-minute windows.

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

import type { StarterQuery } from "./widget-registry";

// Starters offered when a widget's query is still empty or a default. Each metrics starter is a Prometheus query, and
// each traces starter a Tempo query. The default of each family must return data on any Prometheus or Tempo source.
// The request, error and latency metrics may be absent from a source, so the rest stay one-click hints.

const prometheus = ["prometheus"] as const;
const tempo = ["tempo"] as const;

/** A single value shows one number: the default counts the targets that are up. */
export const statStarters: readonly StarterQuery[] = [
  { id: "targets-up", label: "Targets up", providerTypes: prometheus, query: "count(up == 1)", default: true },
  { id: "request-rate", label: "Request rate", providerTypes: prometheus, query: "sum(rate(http_requests_total[5m]))", unit: "req/s" },
  { id: "error-ratio", label: "Error ratio", providerTypes: prometheus, query: '100 * sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))', unit: "%" },
  { id: "p95-latency", label: "p95 latency", providerTypes: prometheus, query: "histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))", unit: "s" },
  { id: "saturation", label: "Saturation", providerTypes: prometheus, query: '100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])))', unit: "%" },
];

/** Time series and bar charts split the same signals by job. */
export const seriesStarters: readonly StarterQuery[] = [
  { id: "targets-by-job", label: "Targets up by job", providerTypes: prometheus, query: "sum by (job) (up)", default: true },
  { id: "request-rate-by-job", label: "Request rate by job", providerTypes: prometheus, query: "sum by (job) (rate(http_requests_total[5m]))", unit: "req/s" },
  { id: "error-ratio-by-job", label: "Error ratio by job", providerTypes: prometheus, query: '100 * sum by (job) (rate(http_requests_total{code=~"5.."}[5m])) / sum by (job) (rate(http_requests_total[5m]))', unit: "%" },
  { id: "p95-latency-by-job", label: "p95 latency by job", providerTypes: prometheus, query: "histogram_quantile(0.95, sum by (le, job) (rate(http_request_duration_seconds_bucket[5m])))", unit: "s" },
  { id: "saturation-by-job", label: "Saturation by job", providerTypes: prometheus, query: '100 * (1 - avg by (job) (rate(node_cpu_seconds_total{mode="idle"}[5m])))', unit: "%" },
];

/** Status grids and metrics tables start from the target state. One starter shows no chips, only the default. */
export const gridStarters: readonly StarterQuery[] = [
  { id: "targets-up", label: "Targets up", providerTypes: prometheus, query: "up", default: true },
];

export const traceStarters: readonly StarterQuery[] = [
  { id: "all-traces", label: "All traces", providerTypes: tempo, query: "{}", default: true },
  { id: "errors", label: "Errors", providerTypes: tempo, query: "{ status = error }" },
  { id: "slow", label: "Slow", providerTypes: tempo, query: "{ duration > 1s }" },
];

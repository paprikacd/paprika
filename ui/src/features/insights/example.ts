import type { Dashboard, Provider, QueryRequest, QueryResult } from "./schema"
import type { InsightsClient } from "./client"

export const exampleProviders: Provider[] = [
  {
    id: "example-prometheus",
    name: "Prometheus · example",
    type: "prometheus",
    capabilities: ["metrics"],
  },
  {
    id: "example-tempo",
    name: "Tempo · example",
    type: "tempo",
    capabilities: ["traces"],
  },
]
export const exampleDashboard: Dashboard = {
  schemaVersion: 1,
  id: "service-overview",
  title: "Service overview",
  description: "A little clarity for everything you run.",
  folder: "Examples/Services",
  timeRange: "1h",
  refreshInterval: 0,
  widgets: [
    {
      id: "requests",
      title: "Request rate",
      type: "stat",
      providerId: "example-prometheus",
      query: "sum(rate(http_requests_total[5m]))",
      unit: "req/s",
      layout: { x: 0, y: 0, w: 4, h: 2 },
    },
    {
      id: "latency",
      title: "P95 latency",
      type: "stat",
      providerId: "example-prometheus",
      query:
        "histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m]))) * 1000",
      unit: "ms",
      color: "#648b76",
      layout: { x: 4, y: 0, w: 4, h: 2 },
    },
    {
      id: "errors",
      title: "Error ratio",
      type: "stat",
      providerId: "example-prometheus",
      query:
        'sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) * 100',
      unit: "%",
      color: "#7698ad",
      layout: { x: 8, y: 0, w: 4, h: 2 },
    },
    {
      id: "traffic",
      title: "Traffic over time",
      description: "Requests per second, by service",
      type: "timeseries",
      providerId: "example-prometheus",
      query: "sum by (service) (rate(http_requests_total[5m]))",
      unit: "req/s",
      layout: { x: 0, y: 2, w: 8, h: 4 },
    },
    {
      id: "services",
      title: "Requests by service",
      type: "bar",
      providerId: "example-prometheus",
      query: "sum by (service) (rate(http_requests_total[5m]))",
      unit: "req/s",
      layout: { x: 8, y: 2, w: 4, h: 4 },
    },
    {
      id: "health",
      title: "Service health",
      description: "Latest availability by service · red is unavailable",
      type: "heatmap",
      providerId: "example-prometheus",
      query: "up",
      unit: "",
      options: {
        thresholds: [
          { value: 0, color: "#c0644f", label: "Unavailable" },
          { value: 1, color: "#648b76", label: "Healthy" },
        ],
        showLegend: true,
        decimals: 0,
      },
      layout: { x: 0, y: 6, w: 12, h: 4 },
    },
    {
      id: "traces",
      title: "Recent traces",
      description: "Follow a request through your stack",
      type: "traces",
      providerId: "example-tempo",
      query: "{ duration > 100ms }",
      unit: "ms",
      layout: { x: 0, y: 10, w: 12, h: 4 },
    },
  ],
}

const exampleServices = [
  "api-gateway",
  "release-controller",
  "repo-server",
  "worker-east",
  "worker-west",
  "auth-service",
]
const exampleRequestRates = [1240, 940, 640, 390, 260, 180]

/** A small sample-data selector reader, not a general PromQL evaluator. */
function exampleServiceFilters(query: string): string[] {
  // Keep quoted values atomic so escaped quotes, braces and template-looking
  // label data cannot become another matcher. Saved queries use JSON literals.
  const tokens = query.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|#[^\n]*|[A-Za-z_][A-Za-z0-9_]*|=~|!~|!=|\S/g) ?? []
  const filters: string[] = []
  let inSelector = false
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token === "{") inSelector = true
    else if (token === "}") inSelector = false
    else if (inSelector && token === "service") {
      if (tokens[index + 1] !== "=" || !tokens[index + 2]?.startsWith('"'))
        throw new Error('Example service filters support exact matches: service="api-gateway".')
      try {
        filters.push(JSON.parse(tokens[index + 2]) as string)
      } catch {
        throw new Error("The example service filter needs a valid quoted value.")
      }
      index += 2
    }
  }
  return filters
}

// Deliberately isolated example adapter. Never used as a fallback for a failed live query.
export async function exampleQuery(
  request: QueryRequest,
  signal: AbortSignal,
): Promise<QueryResult> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError")
  const serviceFilters = request.kind === "metrics" ? exampleServiceFilters(request.query) : []
  const selectedServices = exampleServices.filter((name) => serviceFilters.every((value) => value === name))
  if (request.kind === "metrics" && /^\s*up\s*(?:\{[\s\S]*\})?\s*$/.test(request.query))
    return {
      series: selectedServices.map((name) => ({
        name,
        labels: { service: name, job: "paprika" },
        points: Array.from({ length: 121 }, (_, i) => ({
          timestamp: (request.start + ((request.end - request.start) * i) / 120) * 1000,
          value: (name === "repo-server" && i >= 30 && i < 42) || (name === "worker-west" && i >= 81) ? 0 : 1,
        })),
      })),
    }
  if (request.kind === "traces")
    return {
      traces: [
        {
          traceId: "e5a71bd983fa4a51",
          service: "api-gateway",
          operation: "GET /api/applications",
          durationMs: 142,
          startTime: request.end * 1000 - 12000,
          status: "ok",
        },
        {
          traceId: "c87ab23e764b92c1",
          service: "release-controller",
          operation: "reconcile release",
          durationMs: 286,
          startTime: request.end * 1000 - 28000,
          status: "ok",
        },
        {
          traceId: "a13dc9ed5a9e7f21",
          service: "repo-server",
          operation: "POST /render",
          durationMs: 510,
          startTime: request.end * 1000 - 42000,
          status: "error",
        },
        {
          traceId: "f92a6e20b3194d5a",
          service: "api-gateway",
          operation: "GET /api/pipelines",
          durationMs: 118,
          startTime: request.end * 1000 - 64000,
          status: "ok",
        },
      ],
    }
  const isLatency = request.query.includes("histogram_quantile")
  const isErrors = request.query.includes("5..")
  const names = serviceFilters.length
    ? selectedServices
    : request.query.includes("by (service)")
      ? exampleServices.slice(0, 3)
      : [isLatency ? "Latency" : isErrors ? "Errors" : "Requests"]
  return {
    series: names.map((name, seriesIndex) => {
      const index = serviceFilters.length ? exampleServices.indexOf(name) : seriesIndex
      return {
        name,
        labels: { service: name },
        points: Array.from({ length: 121 }, (_, i) => ({
          timestamp: (request.start + ((request.end - request.start) * i) / 120) * 1000,
          value: Math.max(
            0,
            (isLatency ? 42 : isErrors ? 0.08 : exampleRequestRates[index]) *
              (1 +
                0.09 * Math.sin(i * 0.14 + index) +
                0.045 * Math.cos(i * 0.7) +
                (i > 72 && i < 88 ? 0.13 : 0)),
          ),
        })),
      }
    }),
  }
}

export const exampleMetadata: InsightsClient["metadata"] = async (id, options, signal) => {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
  if (!exampleProviders.some((provider) => provider.id === id))
    throw new Error("Example provider not found.")
  if (options.kind === "series") {
    const end = Math.floor(Date.now() / 1000)
    return { values: [], series: {
      sample: true, count: 9, limit: 1000, start: end - 86400, end,
      labels: [
        { name: "job", cardinality: 1, values: ["paprika"] },
        { name: "service", cardinality: 3, values: ["api-gateway", "release-controller", "repo-server"] },
        { name: "status", cardinality: 3, values: ["200", "404", "500"] },
      ],
    } }
  }
  if (options.kind === "metrics")
    return {
      values: ["up", "http_requests_total", "http_request_duration_seconds_bucket"],
    }
  if (options.kind === "labels") return { values: ["job", "service", "status"] }
  return {
    values:
      (
        {
          service: ["api-gateway", "release-controller", "repo-server"],
          job: ["paprika"],
          status: ["200", "404", "500"],
        } as Record<string, string[]>
      )[options.label ?? ""] ?? [],
  }
}

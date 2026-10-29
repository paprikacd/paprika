import type { FixtureDefinition, FixtureSeries } from "../../src/features/insights/example-catalog-query"
import type { DataKind, RecordColumn, RecordFrame, SavedQuery, Widget, WidgetOptions } from "../../src/features/insights/schema"
import type { RepositoryExample } from "../../src/features/insights/repository-examples"

type QueryBinding = Pick<Widget, "providerId" | "query" | "queryRef">
type Cell = RecordFrame["rows"][number][number]
const providers = { metrics: "example-prometheus", traces: "example-tempo", records: "example-records" }
const fixtures: FixtureDefinition[] = []
const standardOptions: WidgetOptions = { decimals: 2, showTooltip: true, showLegend: true, showGrid: true, lineWidth: 1.5, fillOpacity: 0.12 }
const healthThresholds = [
  { value: 0, color: "#c5584f", label: "Unavailable" },
  { value: 0.5, color: "#ad7b29", label: "Degraded" },
  { value: 1, color: "#36876c", label: "Healthy" },
]

/** Test-only chart scenarios. Never imported by the application or public gallery. */
class Artboard {
  readonly savedQueries: SavedQuery[] = []
  readonly widgets: Widget[] = []
  readonly id: string
  readonly title: string
  readonly description: string
  readonly variable: string
  readonly label: string
  readonly choices: [string, string]
  constructor(id: string, title: string, description: string, variable: string, label: string, choices: [string, string]) {
    this.id = id; this.title = title; this.description = description
    this.variable = variable; this.label = label; this.choices = choices
  }

  query(key: string, name: string, kind: DataKind, query: string): QueryBinding {
    const id = `ab-${this.id}-${key}`
    const saved: SavedQuery = {
      schemaVersion: 1, id, name, kind, query, providerId: providers[kind],
      description: `Illustrative ${this.title} observations. The ${this.label.toLowerCase()} parameter applies to this whole result. Replace the saved query with an equivalent live provider query to use production data.`,
      tags: ["artboard", this.id, kind],
      metadata: { collection: "Dashboard studies", data: "deterministic sample" },
      parameters: [{ name: this.variable, label: this.label, type: "string", defaultValue: this.choices[0] }],
    }
    this.savedQueries.push(saved)
    return { providerId: saved.providerId, query, queryRef: { id, bindings: [{ parameter: this.variable, source: "variable", variable: this.variable }] } }
  }

  metrics(key: string, name: string, series: FixtureSeries[]): QueryBinding {
    const metric = `paprika_example_ab_${this.id.replaceAll("-", "_")}_${key.replaceAll("-", "_")}`
    fixtures.push({ id: metric, metric, series })
    return this.query(key, name, "metrics", `${metric}{${this.variable}={{${this.variable}}}}`)
  }

  scoped(series: FixtureSeries[], alternateFactor = 0.64): FixtureSeries[] {
    return this.choices.flatMap((choice, index) => series.map(source => ({
      ...source,
      labels: { ...source.labels, [this.variable]: choice },
      base: source.base === null ? null : source.base * (index ? alternateFactor : 1),
      variation: (source.variation ?? 0) * (index ? alternateFactor : 1),
      trend: (source.trend ?? 0) * (index ? alternateFactor : 1),
    })))
  }

  scalar(key: string, name: string, base: number, variation = 0, alternateFactor = 0.64) {
    return this.metrics(key, name, this.scoped([{ name, labels: {}, base, variation }], alternateFactor))
  }

  records(key: string, name: string, columns: RecordColumn[], rows: (choice: string, index: number) => Cell[][]): QueryBinding {
    const metric = `paprika_example_ab_${this.id.replaceAll("-", "_")}_${key.replaceAll("-", "_")}`
    fixtures.push({ id: metric, metric, records: {
      columns: [{ key: this.variable, type: "string", label: this.label }, ...columns],
      rows: this.choices.flatMap((choice, index) => rows(choice, index).map(row => [choice, ...row])),
    } })
    return this.query(key, name, "records", `{"fixture":"${metric}","filters":{"${this.variable}":{{${this.variable}}}}}`)
  }

  add(id: string, title: string, binding: QueryBinding, type: Widget["type"], layout: [number, number, number, number], unit = "", options: WidgetOptions = {}, plugin?: { id: string; kind: DataKind; config?: Widget["config"] }) {
    const [x, y, w, h] = layout
    this.widgets.push({ id, title, ...binding, type, unit, layout: { x, y, w, h }, options: { ...standardOptions, ...options },
      ...(plugin ? { pluginId: plugin.id, dataKind: plugin.kind, config: plugin.config ?? {} } : {}),
    })
  }

  stat(id: string, title: string, binding: QueryBinding, position: number, unit: string, options: WidgetOptions = {}) {
    this.add(id, title, binding, "stat", [position * 3, 0, 3, 3], unit, { showSparkline: true, ...options })
  }

  plugin(id: string, title: string, binding: QueryBinding, pluginId: string, kind: DataKind, layout: [number, number, number, number], config: Widget["config"] = {}, unit = "", options: WidgetOptions = {}) {
    this.add(id, title, binding, "plugin", layout, unit, options, { id: pluginId, kind, config })
  }

  finish(timeRange: "1h" | "6h" | "7d" = "6h"): RepositoryExample {
    return {
      id: `artboard-${this.id}`, title: this.title, project: "paprika", description: this.description,
      source: { revision: "dashboard-studies-2026-10-29", paths: ["docs/design/insights/artboard-implementation.md"] },
      sample: { dashboards: [{ schemaVersion: 1, id: `example-artboard-${this.id}`, title: `${this.title} · Test fixture`,
        description: `Illustrative data. ${this.description} The shared ${this.label.toLowerCase()} filter changes every panel.`,
        folder: "Dashboard studies", timeRange, refreshInterval: 0,
        variables: [{ name: this.variable, label: this.label, defaultValue: this.choices[0], options: this.choices }], widgets: this.widgets,
      }], savedQueries: this.savedQueries },
      liveStatus: "unavailable", providers: [],
      coverage: this.widgets.map(widget => ({ sourceId: widget.id, sourceTitle: widget.title, sourceType: "artboard", sampleWidgetIds: [widget.id], liveWidgetIds: [], status: "adapted", notes: ["Functional saved-query sample; provider-specific telemetry and record mappings must be configured before live use."] })),
      limitations: ["Representative deterministic observations, not live telemetry. No production providers are contacted.", "Live deployment requires equivalent saved queries and compatible result fields; changing a provider alone does not translate the sample query language."],
    }
  }
}

const number = (key: string, label: string, unit?: string): RecordColumn => ({ key, label, type: "number", ...(unit ? { unit } : {}) })
const text = (key: string, label: string): RecordColumn => ({ key, label, type: "string" })
const time = (key: string, label: string): RecordColumn => ({ key, label, type: "timestamp" })

function servicePulse(): RepositoryExample {
  const b = new Artboard("service-pulse", "Service Pulse", "Request rate, errors, latency distribution and traces in one service view.", "service", "Service", ["uptime-api", "brandbrain-api"])
  const requests = b.scalar("requests", "Service request rate", 842.16, 92)
  const errors = b.scalar("errors", "Service error ratio", 0.12, 0.04, 1.6)
  const latency = b.scalar("latency", "Service p95 latency", 128.42, 24, 0.72)
  const availability = b.scalar("availability", "Service availability", 99.98, 0.008, 0.9997)
  b.stat("requests", "Request rate", requests, 0, "req/s")
  b.stat("errors", "Error ratio", errors, 1, "%")
  b.stat("latency", "p95 latency", latency, 2, "ms")
  b.stat("availability", "Availability", availability, 3, "%")
  b.add("request-history", "Request rate over time", requests, "timeseries", [0, 3, 8, 6], "req/s", { display: "area" })
  const buckets = [10, 25, 50, 100, 250, 500, "+Inf"]
  const cumulative = [18, 56, 116, 216, 310, 358, 380]
  const histogram = b.metrics("latency-buckets", "Service latency distribution", b.scoped(buckets.map((bucket, index) => ({ name: `≤ ${bucket} ms`, labels: { le: String(bucket) }, base: cumulative[index], variation: 3 }))))
  b.plugin("latency-distribution", "Latency distribution", histogram, "distribution-heatmap", "metrics", [8, 3, 4, 6], { bucketLabel: "le", bucketUnit: "ms", densityUnit: "observations/s", maxColumns: 48 }, "ms")
  b.add("error-history", "Errors over time", errors, "timeseries", [0, 9, 4, 5], "%", { display: "area", min: 0 })
  const states = b.metrics("states", "Service component health", b.scoped(["api", "worker", "database", "cache"].map((name, index) => ({ name, labels: { component: name }, base: index === 1 ? 0.75 : 1, variation: index === 1 ? 0.24 : 0, ...(index === 3 ? { gaps: [{ from: 0.38, to: 0.44 }] } : {}) })), 1))
  b.plugin("states", "Component health history", states, "status-history", "metrics", [4, 9, 4, 5], { maxSeries: 4, maxPoints: 36 }, "", { thresholds: healthThresholds })
  const metric = "paprika_example_ab_service_pulse_traces"
  fixtures.push({ id: metric, metric, traces: b.choices.flatMap((service, serviceIndex) => Array.from({ length: 5 }, (_, index) => ({ traceId: `ab${serviceIndex}${String(index + 1).padStart(29, "0")}`, service, operation: ["GET /checks", "POST /events", "GET /health"][index % 3], durationMs: (index + 1) * (serviceIndex ? 21.8 : 9.6), status: index === 3 ? "error" : "ok", offsetSeconds: (index + 1) * 50 }))) })
  const traces = b.query("traces", "Matching service traces", "traces", `{ resource.paprika.fixture = "${metric}" && resource.service.name = {{service}} }`)
  b.add("traces", "Matching traces", traces, "traces", [8, 9, 4, 5], "ms")
  return b.finish("1h")
}

function fleetAtlas(): RepositoryExample {
  const b = new Artboard("fleet-atlas", "Fleet Atlas", "Cluster capacity, node comparisons and recorded health states.", "cluster", "Cluster", ["omega", "staging"])
  const cpu = b.scalar("cpu", "Cluster CPU utilization", 38.24, 5)
  b.stat("nodes", "Ready nodes", b.scalar("nodes", "Ready node count", 7, 0, 4 / 7), 0, "", { decimals: 0, showSparkline: false })
  b.stat("cpu", "CPU used", cpu, 1, "%")
  b.stat("memory", "Memory used", b.scalar("memory", "Cluster memory utilization", 62.18, 4, 0.8), 2, "%")
  b.stat("pressure", "Nodes under pressure", b.scalar("pressure", "Nodes under disk pressure", 1, 0, 0), 3, "", { decimals: 0, showSparkline: false })
  const nodes = b.metrics("node-cpu", "CPU utilization by node", b.scoped([78.42, 42.11, 31.24, 28.01, 18.27, 12.61, 25.33].map((base, index) => ({ name: `node-0${index + 1}`, labels: { node: `node-0${index + 1}` }, base, variation: 3 + index }))).filter(series => series.labels.cluster === "omega" || Number(series.labels.node.slice(-2)) <= 4))
  b.add("node-cpu", "CPU utilization by node", nodes, "timeseries", [0, 3, 8, 6], "%", { min: 0, max: 100 })
  const resources = b.records("resources", "Node resource inventory", [text("node", "Node"), number("cpu", "CPU", "%"), number("memory", "Memory", "%"), number("disk", "Disk", "%"), text("status", "Status")], (_choice, index) => Array.from({ length: index ? 4 : 7 }, (_, n) => [`node-0${n + 1}`, 78 - n * 9 - index * 12, 83 - n * 8, 71 - n * 7, n === 0 && !index ? "Near limit" : "Healthy"]))
  b.plugin("resources", "Node resource inventory", resources, "record-table", "records", [8, 3, 4, 6], { columns: ["node", "cpu", "memory", "disk", "status"], pageSize: 10 }, "%")
  const states = b.metrics("states", "Node condition history", b.scoped(Array.from({ length: 7 }, (_, index) => ({ name: `node-0${index + 1}`, labels: { node: `node-0${index + 1}` }, base: index === 2 ? 0.75 : 1, variation: index === 2 ? 0.25 : 0, ...(index === 5 ? { gaps: [{ from: 0.64, to: 1 }] } : {}) })), 1).filter(series => series.labels.cluster === "omega" || Number(series.labels.node.slice(-2)) <= 4))
  b.plugin("states", "Node condition history", states, "status-history", "metrics", [0, 9, 6, 5], { maxSeries: 7, maxPoints: 40 }, "", { thresholds: healthThresholds })
  b.plugin("cpu-meter", "CPU used", cpu, "threshold-gauge", "metrics", [6, 9, 3, 5], { display: "segmented", label: "CPU used", segments: 24 }, "%", { min: 0, max: 100, thresholds: [{ value: 0, color: "#36876c", label: "Within capacity" }, { value: 70, color: "#ad7b29", label: "Elevated" }, { value: 85, color: "#c5584f", label: "Near limit" }] })
  b.plugin("disk-meter", "Disk used", b.scalar("disk", "Cluster disk utilization", 71.05, 2, 0.51), "threshold-gauge", "metrics", [9, 9, 3, 5], { display: "radial", label: "Used capacity" }, "%", { min: 0, max: 100, thresholds: [{ value: 0, color: "#36876c", label: "Available" }, { value: 75, color: "#ad7b29", label: "Elevated" }, { value: 90, color: "#c5584f", label: "Critical" }] })
  return b.finish()
}

function edgeWatch(): RepositoryExample {
  const b = new Artboard("edge-watch", "Edge Watch", "Directional traffic, request outcomes and observed connection locations.", "gateway", "Gateway", ["edge-01", "edge-02"])
  b.stat("ingress", "Ingress", b.scalar("ingress", "Inbound traffic rate", 842.15, 100), 0, "Mb/s")
  b.stat("egress", "Egress", b.scalar("egress", "Outbound traffic rate", 218.46, 35), 1, "Mb/s")
  b.stat("blocked", "Blocked requests", b.scalar("blocked", "Blocked request ratio", 2.14, 0.5, 0.42), 2, "%")
  b.stat("connections", "Active connections", b.scalar("connections", "Active connection count", 18432, 600), 3, "", { decimals: 0 })
  const flow = b.metrics("flow", "Gateway directional traffic", b.scoped([{ name: "Inbound", labels: { direction: "inbound" }, base: 842.15, variation: 100 }, { name: "Outbound", labels: { direction: "outbound" }, base: 218.46, variation: 35 }]))
  b.plugin("flow", "Traffic flow", flow, "directional-traffic", "metrics", [0, 3, 8, 6], { directionLabel: "direction", outboundValue: "outbound" }, "Mb/s")
  const destinations = b.metrics("destinations", "Gateway destination traffic", b.scoped(["api.example.test", "cdn.example.test", "assets.example.test", "events.example.test"].map((host, index) => ({ name: host, labels: { destination: host }, base: 320 / (index + 1), variation: 12 }))))
  b.add("destinations", "Traffic by destination", destinations, "bar", [8, 3, 4, 6], "Mb/s")
  const locations = b.records("locations", "Observed connection locations", [text("label", "Location"), number("latitude", "Latitude"), number("longitude", "Longitude"), number("value", "Connections"), text("status", "Status")], (_choice, index) => [["Melbourne", -37.81, 144.96, 1240 - index * 400, "Allowed"], ["Singapore", 1.35, 103.82, 3400 - index * 900, "Allowed"], ["Frankfurt", 50.11, 8.68, 1820 + index * 400, "Challenged"], ["Virginia", 37.43, -78.65, 2180 - index * 600, "Allowed"], ["Tokyo", 35.68, 139.69, 840 + index * 300, "Blocked"]])
  b.plugin("locations", "Connection locations", locations, "connection-map", "records", [0, 9, 4, 5], { latitude: "latitude", longitude: "longitude", label: "label", value: "value", status: "status" })
  const outcomes = b.metrics("outcomes", "Gateway request outcomes", b.scoped([{ name: "Allowed", labels: { outcome: "allowed" }, base: 700, variation: 45 }, { name: "Challenged", labels: { outcome: "challenged" }, base: 90, variation: 20 }, { name: "Blocked", labels: { outcome: "blocked" }, base: 18, variation: 6 }]))
  b.plugin("outcomes", "Request outcomes", outcomes, "stacked-timeseries", "metrics", [4, 9, 4, 5], { display: "bar", maxPoints: 28 }, "req/s")
  const risks = b.records("risks", "Recent gateway actions", [text("source", "Source"), text("rule", "Rule"), number("requests", "Requests"), text("status", "Status")], (_choice, index) => [["192.0.2.14", "Rate limit", 124 + index * 20, "Blocked"], ["198.51.100.27", "Bot challenge", 37 + index * 10, "Challenged"], ["203.0.113.8", "Known client", 245 - index * 40, "Allowed"]])
  b.plugin("risks", "Recent gateway actions", risks, "record-table", "records", [8, 9, 4, 5], { columns: ["source", "rule", "requests", "status"], pageSize: 5 })
  return b.finish()
}

function marketLens(): RepositoryExample {
  const b = new Artboard("market-lens", "Market Lens", "Sector composition, ranked companies and exact application records. Historical sample records cover October 2026.", "sector", "Sector", ["Materials", "Financials"])
  b.stat("companies", "Covered companies", b.scalar("companies", "Company coverage", 84, 0, 0.75), 0, "", { decimals: 0, showSparkline: false })
  b.stat("interest", "Short interest", b.scalar("interest", "Sector short interest", 4.82, 0.35, 0.62), 1, "%")
  b.stat("change", "Daily change", b.scalar("change", "Sector daily change", 0.24, 0.04, -0.5), 2, "pp")
  b.stat("coverage", "Coverage", b.scalar("coverage", "Record completeness", 98.72, 0.1, 0.996), 3, "%")
  const names = [["BHP", "BHP Group", 236, 5.92], ["RIO", "Rio Tinto", 128, 4.13], ["FMG", "Fortescue", 54.7, 6.83], ["S32", "South32", 14.2, 4.91]] as const
  const banks = [["CBA", "Commonwealth Bank", 198, 2.13], ["NAB", "National Australia Bank", 99, 3.42], ["WBC", "Westpac", 91.1, 2.81], ["ANZ", "ANZ Group", 76.2, 2.63]] as const
  const companies = b.records("companies-list", "Sector company records", [text("ticker", "Ticker"), text("company", "Company"), number("market_cap", "Market cap", "B AUD"), number("short_interest", "Short interest", "%")], (_choice, index) => (index ? banks : names).map(row => [...row]))
  b.plugin("composition", "Company composition by market cap", companies, "record-treemap", "records", [0, 3, 7, 6], { label: "ticker", value: "market_cap", group: "sector" }, "B AUD")
  b.plugin("rankings", "Company short positions", companies, "record-table", "records", [7, 3, 5, 6], { columns: ["ticker", "company", "short_interest", "market_cap"], pageSize: 5 }, "%")
  const history = b.records("history", "Daily sector observations", [number("day", "October day"), number("short_interest", "Short interest", "%"), number("coverage", "Coverage", "%")], (_choice, index) => Array.from({ length: 29 }, (_, day) => [day + 1, Number((3.9 - index * 1.2 + day * 0.025 + Math.sin(day / 4) * 0.3).toFixed(4)), 98.3 + day * 0.014]))
  b.plugin("history", "Short interest · October 2026", history, "records-line", "records", [0, 9, 8, 5], { x: "day", y: ["short_interest"] }, "%")
  b.plugin("latest-records", "Latest daily records", history, "record-table", "records", [8, 9, 4, 5], { columns: ["day", "short_interest", "coverage"], pageSize: 5 }, "%")
  return b.finish("7d")
}

function reliabilityRoom(): RepositoryExample {
  const b = new Artboard("reliability-room", "Reliability Room", "Thirty-day availability, error budget and incident context. Calendar and incident records are fixed October 2026 samples.", "service", "Service", ["uptime-api", "brandbrain-api"])
  const availability = b.scalar("availability", "Achieved availability", 99.96, 0, 99.93 / 99.96)
  const target = b.scalar("target", "Availability target", 99.9, 0, 1)
  const budget = b.scalar("budget", "Remaining error budget", 60, 0, 0.5)
  b.stat("availability", "Achieved availability", availability, 0, "%")
  b.stat("target", "SLO target", target, 1, "%", { showSparkline: false })
  b.stat("budget", "Budget remaining", budget, 2, "%", { showSparkline: false })
  b.stat("incidents", "Recorded incidents", b.scalar("incident-count", "Recorded incident count", 3, 0, 2 / 3), 3, "", { decimals: 0, showSparkline: false })
  const burn = b.metrics("burn", "Availability burn rates", b.scoped([{ name: "1h burn rate", labels: { window: "1h" }, base: 1.42, variation: 0.9 }, { name: "6h burn rate", labels: { window: "6h" }, base: 0.81, variation: 0.3 }], 1.7))
  b.add("burn", "Availability burn rate", burn, "timeseries", [0, 3, 8, 6], "×", { min: 0, thresholds: [{ value: 2, color: "#ad7b29", label: "2× burn threshold" }] })
  b.plugin("budget-meter", "Remaining error budget", budget, "threshold-gauge", "metrics", [8, 3, 4, 6], { display: "segmented", label: "Remaining proportion", segments: 30 }, "%", { min: 0, max: 100, thresholds: [{ value: 0, color: "#c5584f", label: "Exhausting" }, { value: 25, color: "#ad7b29", label: "At risk" }, { value: 50, color: "#36876c", label: "Available" }] })
  const incidents = b.records("incidents", "October incident records", [time("date", "Started (UTC)"), text("label", "Incident"), number("value", "Duration", "min"), text("status", "State")], (_choice, index) => index ? [["2026-10-10T09:10:00Z", "Queue saturation", 23, "Resolved"], ["2026-10-22T15:00:00Z", "Upstream latency", 14, "Resolved"]] : [["2026-10-05T18:37:00Z", "Connection pool exhaustion", 72, "Resolved"], ["2026-10-10T03:14:00Z", "Elevated error rate", 22, "Resolved"], ["2026-10-16T10:21:00Z", "Third-party latency", 56, "Resolved"]])
  b.plugin("calendar", "Incident duration by day · UTC", incidents, "incident-calendar", "records", [0, 9, 5, 5], { date: "date", value: "value", label: "label", status: "status", aggregation: "sum", months: 1, endDate: "2026-10-31" }, "min")
  b.plugin("incidents-list", "Recorded incidents · October 2026", incidents, "record-table", "records", [5, 9, 7, 5], { columns: ["date", "label", "value", "status"], pageSize: 5 }, "min")
  return b.finish("7d")
}

function collectionControl(): RepositoryExample {
  const b = new Artboard("collection-control", "Collection Control", "Ingestion throughput, source freshness, pipeline edges and job outcomes.", "pipeline", "Pipeline", ["production", "staging"])
  b.stat("ingested", "Metrics ingested", b.scalar("ingested", "Metric ingestion rate", 124820, 19000), 0, "obs/s")
  b.stat("freshness", "Freshness p95", b.scalar("freshness", "Source freshness p95", 8.42, 2, 0.75), 1, "s")
  b.stat("rejected", "Rejected observations", b.scalar("rejected", "Rejected observation ratio", 0.03, 0.012, 0.4), 2, "%")
  b.stat("sources", "Active sources", b.scalar("sources", "Active source count", 24, 0, 0.5), 3, "", { decimals: 0, showSparkline: false })
  const throughput = b.metrics("throughput", "Ingestion throughput by signal", b.scoped([{ name: "Metrics", labels: { signal: "metrics" }, base: 124820, variation: 19000 }, { name: "Traces", labels: { signal: "traces" }, base: 61420, variation: 9500 }, { name: "Logs", labels: { signal: "logs" }, base: 38710, variation: 7000 }]))
  b.plugin("throughput", "Ingestion throughput", throughput, "stacked-timeseries", "metrics", [0, 3, 8, 6], { display: "area", maxPoints: 96 }, "obs/s")
  const freshness = b.metrics("source-freshness", "Freshness by source", b.scoped(["prometheus", "tempo", "shorted-api", "brandbrain", "market-sync"].map((name, index) => ({ name, labels: { source: name }, base: [2.14, 3.67, 5.91, 12.38, 42.18][index], variation: index === 4 ? 8 : 0.5 }))))
  b.add("source-freshness", "Freshness by source", freshness, "bar", [8, 3, 4, 6], "s", { thresholds: [{ value: 30, color: "#ad7b29", label: "Freshness threshold" }] })
  const topology = b.records("topology", "Pipeline edge throughput", [text("source", "Source stage"), text("target", "Target stage"), number("value", "Observations", "obs/s"), text("status", "State")], (_choice, index) => ["Sources", "Collector", "Enricher", "Transformer", "Gateway"].map((source, n) => [source, ["Collector", "Enricher", "Transformer", "Gateway", "Storage"][n], (124820 - n * 720) * (index ? 0.64 : 1), n === 2 && !index ? "Delayed" : "Healthy"]))
  b.plugin("topology", "Pipeline flow", topology, "pipeline-topology", "records", [0, 9, 8, 5], { source: "source", target: "target", value: "value", status: "status" }, "obs/s")
  const states = b.metrics("job-states", "Collection job states", b.scoped(["scrape-metrics", "collect-traces", "ingest-logs", "enrich-events", "write-storage"].map((name, index) => ({ name, labels: { job: name }, base: index === 3 ? 0.75 : 1, variation: index === 3 ? 0.24 : 0, ...(index === 4 ? { gaps: [{ from: 0.6, to: 0.7 }] } : {}) })), 1))
  b.plugin("job-states", "Job execution history", states, "status-history", "metrics", [8, 9, 4, 5], { maxSeries: 5, maxPoints: 36 }, "", { thresholds: healthThresholds })
  const failures = b.records("failures", "Collection job outcomes", [text("source", "Source"), number("freshness", "Age", "s"), number("retries", "Retries"), text("message", "Result"), text("status", "State")], (_choice, index) => [["market-sync", index ? 24.18 : 42.18, index ? 1 : 3, "Upstream timeout", "Delayed"], ["shorted-api", 6.14, 1, "Recovered after HTTP 429", "Healthy"], ["telemetry-canary", null, 0, "No observations received", "Unknown"]])
  b.plugin("failures", "Recent collection outcomes", failures, "record-table", "records", [0, 14, 12, 4], { columns: ["source", "freshness", "retries", "message", "status"], pageSize: 5 })
  return b.finish()
}

export const chartFixtureCollections: RepositoryExample[] = [servicePulse(), fleetAtlas(), edgeWatch(), marketLens(), reliabilityRoom(), collectionControl()]
export const chartFixtures: FixtureDefinition[] = fixtures

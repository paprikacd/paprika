/** Test-only reproductions of the four supplied Grafana references; never registered in the app gallery. */
import type { DashboardBundle } from "../../src/features/insights/workspace-transfer"
import type { DataKind, QueryRequest, QueryResult, RecordColumn, RecordFrame, SavedQuery, Widget, WidgetOptions } from "../../src/features/insights/schema"

type Values = (number | null)[]
type Metric = { name: string; labels?: Record<string, string>; values: Values }
type Fixture = { metric: string; series?: Metric[]; records?: RecordFrame }
type Binding = Pick<Widget, "query" | "providerId" | "queryRef"> & { kind: DataKind }
type Layout = [number, number, number, number]
export interface ReferencePanel { id: string; title: string; component: string; visual: string; layout: Widget["layout"]; kind: DataKind; queryId: string; dataShape: string }
export interface ReferenceDashboard {
  id: string; title: string; referenceKey: string; oneScreen: boolean; bundle: DashboardBundle;
  requiredPanels: ReferencePanel[]; approximations: string[];
  sourceImage: { filename: string; width: number; height: number };
}
const samples = 121
const end = Date.parse("2026-10-28T13:00:00Z")
const fixtures: Fixture[] = []
const colors = { green: "#74b367", blue: "#5b9cdb", purple: "#b08dc9", orange: "#d49745", red: "#ce6266", cyan: "#5db2b0", yellow: "#c5b749" }
const statColors: Record<string, string> = { [colors.green]: "#538d48", [colors.blue]: "#447faf", [colors.purple]: "#9166b0", [colors.orange]: "#ad7b27", [colors.red]: "#bd5d62", [colors.cyan]: "#318b89", [colors.yellow]: "#968825" }
const health = [{ value: 0, color: colors.green, label: "Normal" }, { value: 40, color: colors.orange, label: "Elevated" }, { value: 70, color: colors.red, label: "High" }]
const freeSpace = [{ value: 0, color: colors.red, label: "Critical" }, { value: 10, color: colors.orange, label: "Low" }, { value: 30, color: colors.yellow, label: "Available" }, { value: 60, color: colors.green, label: "Healthy" }]
const number = (key: string, label: string, unit?: string): RecordColumn => ({ key, label, type: "number", ...(unit ? { unit } : {}) })
const text = (key: string, label: string): RecordColumn => ({ key, label, type: "string" })
const timestamp: RecordColumn = { key: "at", label: "Time (UTC)", type: "timestamp" }
const at = (index: number, hours = 1) => new Date(end - hours * 3600000 + index / (samples - 1) * hours * 3600000).toISOString()

/** Seeded irregular observations: correlated jitter, isolated bursts, ramps, steps and outages. */
function signal(seed: number, base: number, noise = .12, options: { drift?: number; spikes?: [number, number, number][]; drop?: [number, number, number]; gap?: [number, number]; last?: number; integer?: boolean; max?: number } = {}): Values {
  let state = seed >>> 0, walk = 0
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296 }
  const values = Array.from({ length: samples }, (_, index) => {
    const fraction = index / (samples - 1), fresh = random() * 2 - 1
    walk = walk * .66 + fresh * .34
    let value = base * (1 + noise * (.62 * fresh + .38 * walk)) + (options.drift ?? 0) * fraction
    for (const [center, amplitude, radius] of options.spikes ?? []) value += amplitude * Math.max(0, 1 - Math.abs(index - center) / radius)
    if (options.drop && index >= options.drop[0] && index <= options.drop[1]) value *= options.drop[2]
    if (options.gap && index >= options.gap[0] && index <= options.gap[1]) return null
    value = Math.min(options.max ?? Infinity, Math.max(0, value))
    return options.integer ? Math.round(value) : Number(value.toFixed(5))
  })
  if (options.last !== undefined) values[values.length - 1] = options.last
  return values
}
const constant = (value: number) => Array.from({ length: samples }, () => value)
const sum = (...series: Values[]): Values => series[0].map((_value, index) => series.some(values => values[index] === null) ? null : series.reduce((total, values) => total + values[index]!, 0))
const countSeries = (seed: number, base: number, spikes: [number, number, number][], last?: number) => signal(seed, base, .65, { spikes, integer: true, last })

class ReferenceBuilder {
  readonly id: string; readonly title: string; readonly referenceKey: string; readonly choices: [string, string]; readonly filterLabel: string
  readonly widgets: Widget[] = []; readonly savedQueries: SavedQuery[] = []; readonly panels: ReferencePanel[] = []
  constructor(id: string, title: string, referenceKey: string, choices: [string, string], filterLabel = "Service") { this.id = id; this.title = title; this.referenceKey = referenceKey; this.choices = choices; this.filterLabel = filterLabel }
  bind(key: string, title: string, kind: DataKind, query: string): Binding {
    const id = `${this.id}-${key}`, providerId = kind === "records" ? "example-records" : "example-prometheus"
    this.savedQueries.push({ schemaVersion: 1, id, name: title, providerId, kind, query,
      description: "Deterministic reference-image test observations. This is fixture data, not a live provider query.",
      tags: ["reference-image", this.referenceKey], metadata: { reference: this.referenceKey, fixture: "deterministic" },
      parameters: [{ name: "service", label: this.filterLabel, type: "string", defaultValue: this.choices[0] }],
    })
    return { providerId, query, kind, queryRef: { id, bindings: [{ parameter: "service", source: "variable", variable: "service" }] } }
  }
  metric(key: string, title: string, series: Metric[], alternateFactor = .73, independentPhase = true): Binding {
    const metric = `paprika_reference_${this.id.replaceAll("-", "_")}_${key.replaceAll("-", "_")}`
    fixtures.push({ metric, series: this.choices.flatMap((service, variant) => series.map((source, seriesIndex) => ({
      name: source.name, labels: { ...source.labels, service },
      values: !variant ? source.values : source.values.map((value, index) => value === null ? null : Number((source.values[(index + 7 + (independentPhase ? seriesIndex : 0)) % samples] === null ? value * alternateFactor : source.values[(index + 7 + (independentPhase ? seriesIndex : 0)) % samples]! * alternateFactor).toFixed(5))),
    }))) })
    return this.bind(key, title, "metrics", `${metric}{service={{service}}}`)
  }
  records(key: string, title: string, columns: RecordColumn[], rows: (variant: number) => RecordFrame["rows"]): Binding {
    const metric = `paprika_reference_${this.id.replaceAll("-", "_")}_${key.replaceAll("-", "_")}`
    fixtures.push({ metric, records: { columns: [text("service", this.filterLabel), ...columns], rows: this.choices.flatMap((service, variant) => rows(variant).map(row => [service, ...row])) } })
    return this.bind(key, title, "records", `{"fixture":"${metric}","filters":{"service":{{service}}}}`)
  }
  add(key: string, title: string, binding: Binding, type: Widget["type"], layout: Layout, unit: string, visual: string, options: WidgetOptions = {}, pluginId?: string, config: Widget["config"] = {}) {
    const [x, y, w, h] = layout, { kind, ...query } = binding
    const id = `${this.id}-${key}`
    this.widgets.push({ id, title, ...query, type, unit, layout: { x, y, w, h }, options: { decimals: 1, showTooltip: true, showLegend: true, showGrid: true, lineWidth: 1.2, fillOpacity: .22, ...options },
      ...(pluginId ? { pluginId, dataKind: kind, config } : {}),
    })
    const fixture = fixtures.find(item => query.query.startsWith(`${item.metric}{`) || query.query.includes(`"fixture":"${item.metric}"`))
    const dataShape = fixture?.series ? `${fixture.series.length / 2} metric series per scope; ${samples} timestamp-aligned numeric/null observations; labels ${Object.keys(fixture.series[0].labels ?? {}).join(", ")}` : `Record columns: ${fixture?.records?.columns.map(column => `${column.key}:${column.type}${column.unit ? ` (${column.unit})` : ""}`).join(", ")}`
    this.panels.push({ id, title, component: pluginId ?? type, visual, layout: { x, y, w, h }, kind, queryId: query.queryRef!.id, dataShape })
  }
  stat(key: string, title: string, values: Values, layout: Layout, unit: string, color?: string, sparkline = false, decimals = 0) {
    this.add(key, title, this.metric(key, title, [{ name: title, values }]), "stat", layout, unit, "Compact top-line numeric card; authored color conveys the signal family.", { showSparkline: sparkline, showLegend: false, decimals })
    if (color) this.widgets[this.widgets.length - 1].color = statColors[color] ?? color
  }
  plugin(key: string, title: string, binding: Binding, pluginId: string, layout: Layout, unit: string, config: Widget["config"], visual: string, options: WidgetOptions = {}) {
    this.add(key, title, binding, "plugin", layout, unit, visual, options, pluginId, config)
  }
  finish(sourceImage: ReferenceDashboard["sourceImage"], oneScreen: boolean, approximations: string[], hours = 1): ReferenceDashboard {
    return { id: this.id, title: this.title, referenceKey: this.referenceKey, oneScreen, sourceImage, requiredPanels: this.panels, approximations,
      bundle: { dashboards: [{ schemaVersion: 1, id: this.id, title: this.title,
        description: `Reference ${this.referenceKey.slice(-1)} reproduction · deterministic test data.`, timeRange: hours === 6 ? "6h" : "1h",
        customTimeRange: { from: at(0, hours), to: at(samples - 1, hours) }, refreshInterval: 0,
        variables: [{ name: "service", label: this.filterLabel, defaultValue: this.choices[0], options: this.choices }], widgets: this.widgets,
      }], savedQueries: this.savedQueries },
    }
  }
}

function ingress(): ReferenceDashboard {
  const b = new ReferenceBuilder("reference-ingress", "Ingress controller", "image-1", ["ingress-public", "ingress-internal"])
  const successful = signal(101, 18.3, .34, { spikes: [[31, 5.2, 6], [86, 11.4, 3], [111, 8.6, 4]], last: 18.3 })
  const redirects = signal(102, .26, .8, { spikes: [[42, .6, 2], [91, 1.2, 3]], last: .26 })
  const clientErrors = signal(103, .10, 1.1, { spikes: [[52, .9, 2], [108, 1.5, 2]], last: .10 })
  const serverErrors = signal(104, .03, 1.2, { spikes: [[77, .45, 2], [109, .3, 2]], last: .03 })
  const requests = sum(successful, redirects, clientErrors, serverErrors)
  b.stat("total", "Requests · period", signal(105, 42000, .01, { drift: 25283, last: 67283 }), [0, 0, 2, 2], "", undefined, false)
  b.stat("availability", "Available", signal(106, 97, .001, { last: 97 }), [2, 0, 1, 2], "%", undefined, false, 1)
  b.stat("connections", "Connections", countSeries(107, 311, [[44, 210, 2], [102, 280, 4]], 311), [3, 0, 1, 2], "")
  b.stat("duration", "p95 latency", signal(108, 850, .1, { spikes: [[102, 2100, 2]], last: 850 }), [4, 0, 1, 2], "ms")
  b.stat("success", "Success rate", signal(109, 99.3, .001, { last: 99.3 }), [5, 0, 2, 2], "%", colors.green, false, 1)
  b.stat("http2xx", "HTTP 2xx", successful, [7, 0, 1, 2], "/s", colors.green, true, 1)
  b.stat("http3xx", "HTTP 3xx", redirects, [8, 0, 1, 2], "/s", colors.blue, true, 2)
  b.stat("http4xx", "HTTP 4xx", clientErrors, [9, 0, 1, 2], "/s", colors.orange, true, 2)
  b.stat("http5xx", "HTTP 5xx", serverErrors, [10, 0, 2, 2], "/s", colors.red, true, 2)
  b.add("traffic", "HTTP requests / ingress", b.metric("traffic", "HTTP requests by ingress", [{ name: "public", labels: { ingress: "public" }, values: requests }, { name: "internal", labels: { ingress: "internal" }, values: signal(110, 2.2, .8, { spikes: [[59, 14, 2], [110, 18, 3]] }) }]), "timeseries", [0, 2, 4, 3], "req/s", "First of three equal-width traffic plots; irregular request rates with short bursts.", { display: "area", decimals: 1 })
  b.add("status", "HTTP status codes", b.metric("status", "HTTP response rates by status", [{ name: "HTTP 2xx", values: successful }, { name: "HTTP 3xx", values: redirects }, { name: "HTTP 4xx", values: clientErrors }, { name: "HTTP 5xx", values: serverErrors }]), "timeseries", [4, 2, 4, 3], "req/s", "Four low-opacity response-code lines with a compact legend.", { decimals: 2 })
  b.plugin("request-bars", "Total HTTP requests", b.metric("request-bars", "Requests per observation interval", [{ name: "Requests", values: signal(111, 540, .2, { drift: 600, spikes: [[48, 700, 2], [83, 1200, 1], [117, 1600, 1]] }) }]), "stacked-timeseries", [8, 2, 4, 3], "", { display: "bar", maxPoints: 48 }, "Green-style vertical time bars with varying heights, not categorical bars.", { showLegend: false, decimals: 0 })
  const quantiles = [50, 90, 95, 99].map((quantile, index) => ({ name: `p${quantile}`, labels: { quantile: String(quantile / 100) }, values: signal(120 + index, [38, 95, 180, 580][index], .11, { spikes: [[96, [50, 230, 680, 2800][index], 2], [113, [18, 35, 70, 200][index], 2]] }) }))
  b.add("quantiles", "Latency · average and percentiles", b.metric("quantiles", "Ingress latency quantiles", quantiles), "timeseries", [0, 5, 6, 3], "ms", "Half-width multi-quantile line chart; a sharp high-percentile excursion preserves the reference silhouette.", { decimals: 0 })
  const bounds = [10, 25, 50, 100, 250, 500, 1000, 2500, "+Inf"]
  const proportions = [.02, .08, .22, .47, .73, .87, .95, .988, 1]
  const buckets = bounds.map((le, index) => ({ name: `≤ ${le} ms`, labels: { le: String(le) }, values: requests.map((value, point) => value === null ? null : value * Math.min(1, Math.max(0, proportions[index] - (index === bounds.length - 1 ? 0 : (point >= 88 && point <= 103 ? .08 : 0))))) }))
  b.plugin("distribution", "Latency distribution", b.metric("distribution", "Ingress cumulative latency bucket rates", buckets, .73, false), "distribution-heatmap", [6, 5, 6, 3], "ms", { bucketLabel: "le", bucketUnit: "ms", densityUnit: "observations/s", maxColumns: 120 }, "Half-width dense time-by-latency color field; cumulative buckets are valid and overflow is explicit.", { decimals: 1 })
  b.plugin("opened", "New connections opened", b.metric("opened", "Opened connections per interval", [{ name: "Opened", values: countSeries(132, 260, [[14, 500, 1], [41, 630, 1], [78, 450, 2], [106, 720, 1]]) }]), "stacked-timeseries", [0, 8, 6, 3], "", { display: "bar", maxPoints: 64 }, "Lower-left thin vertical bars with sparse large spikes.", { showLegend: false, decimals: 0 })
  let cumulative = 0
  const totals = countSeries(133, 210, [[18, 500, 1], [63, 310, 2], [99, 550, 1]]).map(value => cumulative += value ?? 0)
  b.add("total-connections", "Total connections open", b.metric("total-connections", "Accumulated connections", [{ name: "Connections", values: totals }]), "timeseries", [6, 8, 6, 3], "", "Lower-right cumulative area rises in irregular steps.", { display: "area", decimals: 0 })
  return b.finish({ filename: "codex-clipboard-3576a3e9-1377-493e-829a-18b2545bd80a.png", width: 468, height: 427 }, true, ["Nine KPI widths use the existing twelve-column grid, so three values receive wider cells.", "The reference's collapsible row headings and percentile mean/max table are represented by panel titles and latest-value legends.", "Values and timestamps are deterministic test observations, not numbers extracted from the low-resolution screenshot."])
}

function networkHosts(): ReferenceDashboard {
  const b = new ReferenceBuilder("reference-network-hosts", "Network and host operations", "image-2", ["edge-01", "edge-02"], "Gateway")
  const clock = b.records("clock", "Snapshot time", [text("clock", "Time"), text("zone", "Timezone"), text("date", "Date")], variant => [["13:00:00", "UTC", "28 October 2026"], [variant ? "22:00:00" : "00:00:00", variant ? "Tokyo" : "Melbourne", variant ? "28 October 2026" : "29 October 2026"]])
  b.plugin("clock", "Observation clocks", clock, "record-list", [0, 0, 2, 3], "", { title: "clock", subtitle: "zone", body: "date" }, "Top-left time readouts belong to the fixed source snapshot, not live ticking browser clocks.")
  const blocked = signal(201, 120, .48, { spikes: [[14, 200, 1], [54, 360, 1], [101, 270, 2]], last: 143 })
  b.add("blocked", "Firewall block events", b.metric("blocked", "Firewall block event history", [{ name: "Blocked", values: blocked }]), "timeseries", [2, 0, 4, 3], "events/s", "Compact event-rate area plot with narrow irregular spikes.", { display: "area", showLegend: false, decimals: 0 })
  b.add("destinations", "Top connection destinations", b.metric("destinations", "Most active network destinations", ["api", "cdn", "dns", "updates", "telemetry"].map((name, index) => ({ name, values: signal(210 + index, [418, 285, 170, 115, 63][index], .05) }))), "bar", [6, 0, 3, 3], "connections", "Five ranked destination counts replace the original horizontal list with the existing comparison bars.", { decimals: 0 })
  b.plugin("power", "UPS battery capacity", b.metric("power", "Gateway UPS battery capacity", [{ name: "UPS-1", values: signal(216, 96, .002) }, { name: "UPS-2", values: signal(217, 100, 0) }], .91), "threshold-gauge", [9, 0, 3, 3], "%", { display: "segmented", seriesMode: "all", columns: 1, maxSeries: 2, showThresholds: false }, "Two short green capacity rows echo the reference's UPS status strip.", { min: 0, max: 100, thresholds: freeSpace, showLegend: false, decimals: 0 })
  const locations = b.records("locations", "Source of firewall block events", [text("label", "Location"), number("latitude", "Latitude"), number("longitude", "Longitude"), number("value", "Events"), text("status", "Action")], variant => [["San Francisco", 37.77, -122.42, 180 + variant * 110, "Blocked"], ["Virginia", 37.43, -78.65, 840 - variant * 230, "Allowed"], ["Frankfurt", 50.11, 8.68, 1210 + variant * 340, "Blocked"], ["Singapore", 1.35, 103.82, 960 - variant * 180, "Allowed"], ["Melbourne", -37.81, 144.96, 420 + variant * 210, "Allowed"]])
  b.plugin("locations", "Firewall event origins", locations, "connection-map", [0, 3, 4, 4], "events", { latitude: "latitude", longitude: "longitude", label: "label", value: "value", status: "status", showLocations: false }, "Location-weighted dots use actual supplied coordinates; geographic outline is visual context only.", { decimals: 0 })
  b.plugin("traffic", "WAN traffic", b.metric("traffic", "Gateway traffic by direction", [{ name: "Inbound", labels: { direction: "inbound" }, values: signal(220, 320, .4, { drift: 180, spikes: [[18, 620, 1], [64, 480, 2], [108, 740, 1]] }) }, { name: "Outbound", labels: { direction: "outbound" }, values: signal(221, 90, .6, { drift: 70, spikes: [[33, 150, 1], [99, 360, 2]] }) }]), "directional-traffic", [4, 3, 4, 4], "Mb/s", { directionLabel: "direction", outboundValue: "outbound" }, "Spiky bandwidth with inbound above/outbound below the shared baseline.", { decimals: 0 })
  const protocol = b.records("protocol", "Protocol counters", [text("name", "Protocol"), number("packets", "Packets"), number("bytes", "Traffic", "MB"), text("state", "State")], variant => [["TCP", 185421 - variant * 32000, 8712.3, "Pass"], ["UDP", 84912 + variant * 15000, 3318.9, "Pass"], ["ICMP", 2138, 24.7, "Pass"], ["Other", 97, 1.2, "Inspect"]])
  b.plugin("protocol", "Protocol observations", protocol, "record-table", [8, 3, 4, 4], "", { density: "compact", showSearch: false, columns: ["name", "packets", "bytes", "state"], pageSize: 5, cellStyles: [{ column: "packets", display: "bar", min: 0, max: 200000 }] }, "Dense protocol table balances the network plots.", { decimals: 1 })
  const clients = b.records("clients", "DHCP client inventory", [text("ip", "IP"), text("host", "Hostname"), text("lease", "Lease"), text("state", "State")], variant => Array.from({ length: 8 }, (_, index) => [`192.0.2.${index + 10 + variant * 20}`, ["workstation", "nas", "camera", "phone", "runner", "router", "printer", "sensor"][index], `${index + 1}h`, index === 6 ? "Stale" : "Active"]))
  b.plugin("clients", "DHCP clients", clients, "record-table", [0, 7, 4, 3], "", { density: "compact", showSearch: false, columns: ["ip", "host", "lease", "state"], pageSize: 10 }, "The first of three compact operational tables uses documentation-range addresses.")
  const rules = b.records("rules", "Firewall rule counters", [text("rule", "Rule"), number("hits", "Hits"), number("rate", "Rate", "/s"), text("state", "Action")], variant => ["Known clients", "Rate limit", "Bot challenge", "Inbound deny", "DNS allow", "Private route"].map((rule, index) => [rule, Math.round(14320 / (index + 1) * (variant ? .77 : 1)), Number((124 / (index + 1)).toFixed(2)), index === 3 ? "Blocked" : "Pass"]))
  b.plugin("rules", "Firewall rule counters", rules, "record-table", [4, 7, 4, 3], "", { density: "compact", showSearch: false, columns: ["rule", "hits", "rate", "state"], pageSize: 10, cellStyles: [{ column: "hits", display: "bar", min: 0, max: 15000 }] }, "Horizontal in-cell magnitude bars retain exact counts on a fixed 0–15,000 scale.")
  const flows = b.records("flows", "Recent network flows", [text("source", "Source"), text("destination", "Destination"), number("packets", "Packets"), text("state", "State")], variant => Array.from({ length: 7 }, (_, index) => [`198.51.100.${index + 4}`, ["api", "dns", "cdn", "updates"][index % 4], 210 + index * 127 + variant * 40, index === 5 ? "Drop" : "Pass"]))
  b.plugin("flows", "Recent flows", flows, "record-table", [8, 7, 4, 3], "", { density: "compact", showSearch: false, columns: ["source", "destination", "packets", "state"], pageSize: 10 }, "A third table preserves the network dashboard's lower-row density.")
  const hostNames = ["host-01", "host-02", "host-03", "host-04", "host-05", "host-06"]
  for (let index = 0; index < 6; index++) b.stat(`host-${index}`, hostNames[index], signal(230 + index, 99.7, .0005, { last: 99.7 - index * .1 }), [index * 2, 10, 2, 2], "%", colors.green, false, 1)
  const hosts = (seed: number, base: number, noise: number, spikes: [number, number, number][], unit: string, group: string) => hostNames.map((name, index) => ({ name, labels: { host: name, signal: group }, values: signal(seed + index, base * (1 + index * .11), noise, { spikes: spikes.map(([center, amplitude, radius]) => [center + index % 3, amplitude * (1 + index * .07), radius]), ...(unit === "%" ? { max: 100, gap: index === 5 ? [66, 68] : undefined } : {}) }) }))
  const rows = [
    { y: 12, key: "cpu", title: "CPU usage", unit: "%", left: hosts(240, 12, .5, [[25, 62, 1], [75, 48, 2], [105, 73, 1]], "%", "cpu"), right: hosts(250, 3, .7, [[20, 55, 1], [61, 75, 1], [109, 63, 2]], "%", "gpu") },
    { y: 15, key: "temperature", title: "Temperature", unit: "°C", left: hosts(260, 44, .08, [[24, 9, 3], [76, 12, 4]], "°C", "cpu-temp"), right: hosts(270, 37, .1, [[19, 14, 2], [62, 18, 3]], "°C", "gpu-temp") },
    { y: 18, key: "power", title: "Power draw", unit: "W", left: hosts(280, 68, .12, [[22, 32, 4], [75, 44, 5]], "W", "power"), right: hosts(290, 1100, .25, [[19, 1300, 2], [66, 1800, 1], [110, 1600, 2]], "rpm", "fan") },
    { y: 21, key: "memory", title: "Memory used", unit: "%", left: hosts(300, 32, .006, [], "%", "memory"), right: hosts(310, 22, .008, [], "%", "gpu-memory") },
  ]
  for (const row of rows) {
    b.plugin(`${row.key}-current`, `${row.title} · now`, b.metric(`${row.key}-current`, `Current host ${row.title.toLowerCase()}`, row.left), "threshold-gauge", [0, row.y, 2, 3], row.unit, { display: "segmented", orientation: "vertical", seriesMode: "all", columns: 6, maxSeries: 6, showThresholds: false }, "Six vertical current-value host meters align with all six series in the neighboring host telemetry plot.", { min: 0, max: row.key === "power" ? 180 : 100, thresholds: health, showLegend: false, decimals: 0 })
    b.add(`${row.key}-hosts`, `${row.title} · hosts`, b.metric(`${row.key}-hosts`, `${row.title} by host`, row.left), "timeseries", [2, row.y, 5, 3], row.unit, "Six thin host series form the center column of the original hardware matrix.", { decimals: 0 })
    b.add(`${row.key}-devices`, row.key === "power" ? "Fan speed · devices" : `${row.title} · GPUs`, b.metric(`${row.key}-devices`, `${row.title} by device`, row.right), "timeseries", [7, row.y, 5, 3], row.key === "power" ? "rpm" : row.unit, "Six related device series form the right column; flat memory bands contrast with bursty utilization.", { decimals: 0 })
  }
  return b.finish({ filename: "codex-clipboard-39e37762-0d41-4e67-bccb-e64bb369e081.png", width: 518, height: 590 }, false, ["The supplied image combines two separate dashboards. This composition intentionally preserves both as a vertically scrolling network block and host matrix.", "Snapshot clocks are source records and do not tick in the browser.", "The top destination comparison uses vertical bars; host meters use vertical columns while UPS meters remain horizontal. Table magnitude bars retain explicit source scales.", "Location markers represent supplied coordinates; no location or connection is inferred from an IP address."], 6)
}

function mixedSignals(): ReferenceDashboard {
  const b = new ReferenceBuilder("reference-mixed-signals", "Mixed service signals", "image-3", ["frontend", "backoffice"])
  const servers = [0, 1, 2, 3].map(index => ({ name: `web_server_0${index + 1}`, labels: { server: `web_server_0${index + 1}` }, values: signal(401 + index, 23 + index * 8, .15, { spikes: [[18 + index, 8, 2], [94, 14, 3]] }) }))
  b.plugin("requests", "Server requests / s", b.metric("requests", "Requests by web server", servers), "stacked-timeseries", [0, 0, 8, 3], "req/s", { display: "area", maxPoints: 121 }, "Wide four-layer traffic area at the upper left; layers have independent jagged load.", { decimals: 0 })
  const cpu = signal(410, 2.1, .4, { spikes: [[20, 1.1, 1], [58, 1.8, 1], [113, 1.4, 2]] }), memory = signal(411, 2.2, .17, { spikes: [[15, 1.4, 1], [67, 1.9, 1], [105, 1.6, 1]] })
  const resources = b.records("resources", "CPU and memory observations", [timestamp, number("cpu", "CPU", "%"), number("memory", "Memory", "GB")], variant => cpu.map((value, index) => [at(index), value! * (variant ? .72 : 1), memory[index]! * (variant ? .8 : 1)]))
  b.plugin("resources", "CPU / Memory", resources, "records-line", [8, 0, 4, 3], "", { x: "at", y: ["cpu", "memory"], rightAxis: ["memory"] }, "Small dual-axis line-and-point panel with CPU percent left and memory GB right.", { decimals: 1 })
  const components = [{ name: "Network", values: signal(420, .7, .18) }, { name: "Server", values: signal(421, .9, .13) }, { name: "Render", values: signal(422, 1.5, .15) }, { name: "Scripts", values: signal(423, .9, .12) }]
  b.plugin("page-load", "Client-side full page load", b.metric("page-load", "Nonoverlapping page-load duration components", components), "stacked-timeseries", [0, 3, 8, 3], "s", { display: "bar", maxPoints: 22 }, "Warm multicolor time bars preserve the reference shape while stacking additive phases rather than incorrectly summing percentiles.", { decimals: 2 })
  const logins = [{ name: "Logins", values: signal(430, 20, .22, { drop: [72, 86, .35] }) }, { name: "Logins · previous hour", values: signal(431, 53, .12, { drop: [72, 86, .18] }) }]
  b.add("logins", "Logins", b.metric("logins", "Current and previous-hour login observations", logins), "timeseries", [8, 3, 4, 3], "", "Overlapping translucent areas with a clear short outage before recovery.", { display: "area", decimals: 0 })
  const traffic = [0, 1, 2].flatMap(index => [{ name: `Inbound · link ${index + 1}`, labels: { direction: "inbound", link: String(index + 1) }, values: signal(440 + index, 570 + index * 170, .17, { spikes: [[12, 330, 2], [84, 420, 2]] }) }, { name: `Outbound · link ${index + 1}`, labels: { direction: "outbound", link: String(index + 1) }, values: signal(450 + index, 180 + index * 60, .25) }])
  b.plugin("traffic", "Traffic In/Out", b.metric("traffic", "Interface traffic direction rates", traffic), "directional-traffic", [0, 6, 12, 3], "B/s", { directionLabel: "direction", outboundValue: "outbound", maxSeries: 6 }, "A full-width final traffic panel retains the signed baseline and multiple network bands.", { decimals: 0 })
  return b.finish({ filename: "codex-clipboard-c9fa678c-26c1-4b9b-acad-f681e1f1c288.png", width: 738, height: 414 }, true, ["The top of this reference is cropped; the missing server panel title is inferred from its visible web_server legend.", "Page-load phases are additive durations. The screenshot's percentile-looking series labels would not be mathematically valid as a stacked total.", "Per-series mean/current tabular legends are approximated by current-value legends; dual-axis units remain explicit."])
}

function serviceOverview(): ReferenceDashboard {
  const b = new ReferenceBuilder("reference-service-overview", "Service overview", "image-4", ["uptime-api", "brandbrain-api"])
  const login = [{ name: "Logins", values: signal(501, 26, .14, { drop: [68, 83, .78] }) }, { name: "Logins · previous hour", values: signal(502, 53, .07, { drop: [68, 83, .91] }) }]
  b.add("logins", "Logins", b.metric("logins", "Login activity comparison", login), "timeseries", [0, 0, 4, 3], "", "Two translucent overlapping login bands, blue/purple in the reference.", { display: "area", decimals: 0 })
  const cpu = signal(503, 16, .16, { drift: 8, spikes: [[26, 6, 2], [69, 7, 2], [112, 6, 2]] }), memory = signal(504, 10, .12, { spikes: [[20, 12, 1], [53, 18, 1], [75, 10, 1], [108, 16, 1]] })
  const resources = b.records("resources", "Service CPU and memory", [timestamp, number("cpu", "CPU", "%"), number("memory", "Memory", "GB")], variant => cpu.map((value, index) => [at(index), value! * (variant ? .66 : 1), memory[index]! * (variant ? .8 : 1)]))
  b.plugin("resources", "Memory / CPU", resources, "records-line", [4, 0, 4, 3], "", { x: "at", y: ["cpu", "memory"], rightAxis: ["memory"] }, "Independent red/blue-style dual axes preserve percent versus GB semantics.", { decimals: 0 })
  const capacity = b.metric("capacity", "Free disk capacity by volume", [22.7, 9.89, 71, 78.5, 32.4, 40.3].map((value, index) => ({ name: `sda${index + 1}`, labels: { disk: `sda${index + 1}` }, values: signal(510 + index, value, .002, { last: value }) })), .8)
  b.plugin("disk-bars", "Free disk space", capacity, "threshold-gauge", [8, 0, 4, 3], "GB", { display: "segmented", seriesMode: "all", columns: 1, maxSeries: 6, segments: 32, showThresholds: false }, "Six compact segmented horizontal disk rows, matching the reference's top-right capacity bank.", { min: 0, max: 100, thresholds: freeSpace, showLegend: false, decimals: 1 })
  const requests = [22, 34, 27, 31].map((base, index) => ({ name: `web_server_0${index + 1}`, labels: { server: `web_server_0${index + 1}` }, values: signal(520 + index, base, .18, { spikes: [[15, 8, 1], [68, 13, 2], [108, 12, 1]] }) }))
  b.plugin("requests", "Server requests / s", b.metric("requests", "Service request rates by web server", requests), "stacked-timeseries", [0, 3, 8, 4], "req/s", { display: "area", maxPoints: 121 }, "The broad middle-left traffic chart is the visual anchor with four jagged stacked layers.", { decimals: 0 })
  const free = b.metric("free-radial", "Free capacity radial observations", [2.35, 52.2, 93, 50.9, 4.84, 53.9].map((value, index) => ({ name: `sda${index + 1}`, labels: { disk: `sda${index + 1}` }, values: constant(value) })), .82)
  b.plugin("disk-gauges", "Free disk space · volumes", free, "threshold-gauge", [8, 3, 4, 4], "GB", { display: "radial", seriesMode: "all", columns: 3, maxSeries: 6, showThresholds: false }, "Six radial gauges in a three-by-two bank; low space is red, middle yellow and ample space green.", { min: 0, max: 100, thresholds: freeSpace, showLegend: false, decimals: 1 })
  const hosts = ["Backend-ops-01", "Backend-ops-02", "Backend-ops-03", "Backend-ops-04", "Frontend-web-01", "Frontend-web-02"]
  const states = hosts.map((name, index) => ({ name, labels: { host: name }, values: Array.from({ length: samples }, (_, point) => {
    if (index === 4 && point >= 101 && point <= 104) return null
    if (index === 2 && point > 44 || index === 0 && point < 12) return 83
    if ((point + index * 11) % 43 < 3) return 78
    if ((point + index * 7) % 19 < 3) return 54
    return 18
  }) }))
  b.plugin("cpu-history", "Server CPU usage", b.metric("cpu-history", "Recorded server CPU bands", states, 1), "status-history", [0, 7, 8, 3], "%", { maxSeries: 6, maxPoints: 100 }, "Six continuous horizontal state lanes with abrupt green/yellow/red transitions and an explicit unknown interval.", { thresholds: health, decimals: 0 })
  const readings = b.records("flow-readings", "Flow readings", [timestamp, number("flow1", "flow1", "%"), number("flow2", "flow2", "%"), number("flow3", "flow3", "%")], variant => Array.from({ length: 5 }, (_, index) => [at(samples - 1 - index * 2), Number((48.6 + index * .7 + variant * 3).toFixed(1)), Number((51.7 - index * .8 - variant * 2).toFixed(1)), Number((58.9 - index * 1.6 + variant).toFixed(1))]))
  b.plugin("flow-readings", "Flow readings", readings, "record-table", [8, 7, 4, 3], "", { density: "compact", showSearch: false, columns: ["at", "flow1", "flow2", "flow3"], pageSize: 5, cellStyles: [{ column: "flow1", display: "bar", min: 0, max: 100 }, { column: "flow2", display: "color-text" }, { column: "flow3", display: "color-background" }] }, "Five exact timestamped flow rows with in-cell gauge, threshold text and heat backgrounds.", { decimals: 1, thresholds: [{ value: 0, color: colors.green, label: "Below 50%" }, { value: 50, color: colors.yellow, label: "50% or more" }, { value: 57, color: colors.red, label: "57% or more" }] })
  return b.finish({ filename: "codex-clipboard-8e02f56f-0d25-4739-8b42-d10f263f027b.png", width: 1280, height: 640 }, true, ["Radial and segmented capacities are multi-series components rather than six independent dashboard tiles.", "The original free-space panels show different readings, so the two banks use separately named saved queries.", "The flow table supports per-column bars, colored values and heat backgrounds while retaining exact values and units."])
}

export const referenceDashboards: ReferenceDashboard[] = [ingress(), networkHosts(), mixedSignals(), serviceOverview()]
export const referenceDashboardBundles = referenceDashboards.map(entry => entry.bundle)
export const referenceSpecs = referenceDashboards.map(({ bundle: _bundle, ...spec }) => { void _bundle; return spec })
export const referenceQueryFixtures = fixtures

/** Normalized endpoint fixture. Provider IDs may be remapped by the real Go import harness. */
export function resultForReferenceQuery(request: QueryRequest): QueryResult {
  if (request.query.replace(/"(?:\\.|[^"\\])*"/g, '""').includes("{{")) throw new Error("Resolve the saved query's service parameter before executing it.")
  if (request.kind === "records") {
    const parsed = JSON.parse(request.query) as { fixture: string; filters: Record<string, string> }
    const fixture = fixtures.find(item => item.metric === parsed.fixture)
    if (!fixture?.records) throw new Error("Unknown reference record fixture.")
    const frame = structuredClone(fixture.records)
    frame.rows = frame.rows.filter(row => Object.entries(parsed.filters ?? {}).every(([key, value]) => {
      const index = frame.columns.findIndex(column => column.key === key)
      if (index < 0) throw new Error("Unknown reference filter field.")
      return row[index] === value
    }))
    return { records: frame }
  }
  if (request.kind !== "metrics") throw new Error("The supplied reference screenshots contain metrics and records, not trace panels.")
  const match = request.query.match(/^([A-Za-z_][A-Za-z0-9_]*)\{(.*)\}$/)
  if (!match) throw new Error("Unknown reference metric query.")
  const fixture = fixtures.find(item => item.metric === match[1])
  if (!fixture?.series) throw new Error("Unknown reference metric fixture.")
  const labels = [...match[2].matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("(?:\\.|[^"\\])*")/g)].map(item => [item[1], JSON.parse(item[2]) as string])
  if (!labels.some(([key]) => key === "service")) throw new Error("Reference metrics require an exact shared-service matcher.")
  return { series: fixture.series.filter(series => labels.every(([key, value]) => series.labels?.[key] === value)).map(series => ({
    name: series.name, labels: { ...series.labels, __name__: fixture.metric },
    points: series.values.map((value, index) => ({ timestamp: (request.start + (request.end - request.start) * index / Math.max(1, series.values.length - 1)) * 1000, value })),
  })) }
}

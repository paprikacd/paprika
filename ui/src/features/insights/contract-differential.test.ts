// @vitest-environment node
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { galleryDocuments } from "../../../../demo/insights-gallery/dashboards.mjs"
import { referenceDashboardBundles } from "../../../e2e/fixtures/reference-dashboard-data"
import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge"
import { dashboardSchema } from "./schema"
import { getWidgetDefinition } from "./widget-registry"

// The differential fixture: every shipped example document and a set of deliberate mutations of one rich base
// document, each with the verdict the canonical Zod schema gives it. internal/insights/contract_differential_test.go
// runs the same cases through the Go validator, the published dashboard JSON Schema and the plugin config schemas,
// and requires the same verdict. `npm run schema:generate` writes the fixture; otherwise it must be current, so a
// change to Zod that is not regenerated fails here, and one that is regenerated fails in Go until Go agrees.

const repository = new URL("../../../../", import.meta.url)
const fixturePath = new URL("docs/design/insights/conformance/contract-differential.json", repository)

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
interface WidgetLike { id?: string; type?: string; pluginId?: string; config?: unknown }
interface DocumentLike { id?: string; widgets?: WidgetLike[] }

/** One change to the base document. `json` is raw JSON text, so number spellings such as 2.0 reach Go unchanged. */
interface MutationOp { path: string; value?: Json; json?: string; remove?: true }
interface Mutation {
  name: string
  ops: MutationOp[]
  /** Why the published JSON Schema accepts a document Zod refuses: a refinement it cannot express. */
  jsonSchemaGap?: string
  /**
   * Why the published JSON Schema refuses a document Zod accepts. Only trim: JSON Schema bounds the untrimmed string,
   * Zod the trimmed one. Pinned so it stays visible; a new kind of stricter case is a contract bug.
   */
  jsonSchemaStricter?: "trim"
  /**
   * Why Go refuses a document Zod accepts. Only number spelling: JSON.parse reads 2.0 as 2, so Zod cannot see it, and
   * Go refuses it for an integer member and names the member.
   */
  goRefuses?: "number spelling"
}

// ---- The corpus ----------------------------------------------------------------------------------------------

function starters(): DocumentLike[] {
  const folder = new URL("internal/insights/starters/", repository)
  return readdirSync(folder)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(new URL(name, folder), "utf8")) as DocumentLike)
}

function catalog(): DocumentLike[] {
  const entries = JSON.parse(readFileSync(new URL("ui/src/features/insights/repository-examples/catalog.json", repository), "utf8")) as Array<{
    sample: { dashboards: DocumentLike[] }
  }>
  return entries.flatMap((entry) => entry.sample.dashboards)
}

const corpora: Array<[string, () => DocumentLike[]]> = [
  ["starter", starters],
  ["catalog", catalog],
  ["gallery", () => galleryDocuments({ metrics: "metrics", traces: "traces", records: "records" }).dashboards as DocumentLike[]],
  ["reference", () => referenceDashboardBundles.flatMap((bundle) => bundle.dashboards as DocumentLike[])],
]

// ---- The base document: one of every contract feature the mutations reach ------------------------------------

const BASE: Json = {
  schemaVersion: 1,
  id: "contract-base",
  title: "Contract base",
  description: "One of every contract feature",
  folder: "platform/checkout",
  timeZone: "Europe/London",
  timeRange: "1h",
  refreshInterval: 30,
  covers: { applications: [{ namespace: "shop", name: "checkout" }, {}], variables: { namespace: "namespace" }, summaryWidget: "latency" },
  annotationSource: { queryRef: { id: "deploys" }, timestampColumn: "time", labelColumn: "title", endColumn: "end", severityColumn: "level" },
  variables: [
    { name: "namespace", label: "Namespace", options: ["shop", "payments"], defaultValue: "shop" },
    { name: "pods", label: "Pods", multi: true, allowAll: true, options: ["api", "worker"], defaultValue: [] },
    { name: "nodes", multi: true, source: { type: "labelValues", providerId: "metrics", label: "node", selector: "up{namespace={{namespace}}}", limit: 20 }, defaultValue: ["a"] },
  ],
  widgets: [
    {
      id: "latency",
      title: "Latency",
      type: "timeseries",
      providerId: "metrics",
      query: "histogram_quantile(0.99, rate(http_duration_bucket{namespace={{namespace}}}[5m]))",
      unit: "ms",
      layout: { x: 0, y: 0, w: 6, h: 4 },
      options: {
        decimals: 1,
        baseline: { window: "1d", band: "p10p90" },
        showEvents: false,
        thresholds: [{ value: 0, status: "ok" }, { value: 250, status: "warning", label: "Slow" }, { value: 500, color: "#AA0000" }],
        referenceLines: [{ value: 200, label: "Objective" }],
        seriesColors: [{ label: "pod", value: "api", color: "#00aa00" }],
        lineWidth: 1.5,
        fillOpacity: 0.25,
      },
      drilldowns: [
        { id: "open-app", title: "Open application", application: { namespace: { source: "label", value: "namespace" }, name: { source: "constant", value: "checkout" } } },
        { id: "detail", title: "Detail", dashboardId: "checkout-detail", carryTimeRange: true, bindings: [{ variable: "namespace", source: "label", value: "namespace" }] },
      ],
      selectionBindings: [{ variable: "pods", source: "label", value: "pod" }],
    },
    {
      id: "errors",
      title: "Errors",
      type: "stat",
      providerId: "metrics",
      query: "sum(rate(http_errors_total[5m]))",
      unit: "req/s",
      layout: { x: 6, y: 0, w: 3, h: 1 },
      options: { compare: { window: "1d", good: "down" }, showSparkline: true, sparklinePlacement: "side", staleAfterSeconds: 60 },
    },
    {
      id: "budget",
      title: "Budget",
      type: "stat",
      providerId: "metrics",
      query: "slo_budget_remaining",
      unit: "%",
      layout: { x: 9, y: 0, w: 3, h: 3 },
      options: { showStatBar: true, min: 0, max: 100, thresholds: [{ value: 0, status: "critical" }, { value: 25, status: "warning" }, { value: 50, status: "ok" }] },
    },
    {
      id: "placement",
      title: "Placement",
      type: "plugin",
      pluginId: "kubernetes-placement",
      dataKind: "metrics",
      providerId: "metrics",
      query: "kube_node_status_allocatable",
      unit: "",
      config: { resource: "memory", pressure: 0.8, showPods: true, maxNodes: 12 },
      layout: { x: 0, y: 4, w: 6, h: 6 },
    },
    {
      id: "throttle",
      title: "Throttling",
      type: "plugin",
      pluginId: "kubernetes-throttle-matrix",
      dataKind: "metrics",
      providerId: "metrics",
      query: "container_cpu_cfs_throttled_periods_total",
      unit: "%",
      config: { groupLabel: "pod", rows: 12, ceiling: 50 },
      layout: { x: 6, y: 4, w: 6, h: 6 },
    },
    {
      id: "records",
      title: "Records",
      type: "plugin",
      pluginId: "record-table",
      dataKind: "records",
      providerId: "records",
      query: "select * from incidents",
      unit: "",
      config: { columns: ["name", "status"], pageSize: 10, cellStyles: [{ column: "status", display: "status-badge", mappings: [{ value: "down", status: "critical" }, { value: "up", color: "#00AA00" }] }] },
      layout: { x: 0, y: 10, w: 12, h: 4 },
    },
  ],
}

const W = (index: number, rest = "") => `/widgets/${index}${rest}`
const set = (path: string, value: Json): MutationOp => ({ path, value })
const raw = (path: string, json: string): MutationOp => ({ path, json })
const drop = (path: string): MutationOp => ({ path, remove: true })
const refinement = "refinement"
const trim = "trim"

// Each mutation changes one thing. Valid ones guard against Go or the published schema being stricter than Zod;
// invalid ones guard against them being more permissive. A jsonSchemaGap names a refinement JSON Schema cannot carry.
const MUTATIONS: Mutation[] = [
  // Document envelope
  { name: "unknown top-level field", ops: [set("/extra", true)] },
  { name: "schemaVersion 2", ops: [set("/schemaVersion", 2)] },
  { name: "id with a space", ops: [set("/id", "contract base")] },
  { name: "title of spaces", ops: [set("/title", "   ")], jsonSchemaGap: trim },
  { name: "title of 120 characters", ops: [set("/title", "t".repeat(120))] },
  { name: "title of 121 characters", ops: [set("/title", "t".repeat(121))] },
  { name: "title padded to 122 characters", ops: [set("/title", ` ${"t".repeat(120)} `)], jsonSchemaStricter: "trim" },
  // Zod and JSON Schema count a plain bound in code points, so an emoji counts once; Go must too.
  { name: "description of 250 astral characters", ops: [set("/description", "😀".repeat(250))] },
  { name: "description of 251 astral characters", ops: [set("/description", "😀".repeat(251))] },
  { name: "description of 501 astral characters", ops: [set("/description", "😀".repeat(501))] },
  { name: "title of 120 astral characters", ops: [set("/title", "😀".repeat(120))] },
  { name: "title of 121 astral characters", ops: [set("/title", "😀".repeat(121))] },
  { name: "folder of 100 astral characters", ops: [set("/folder", "📁".repeat(100))] },
  { name: "widget title of 100 astral characters", ops: [set(W(0, "/title"), "📈".repeat(100))] },
  { name: "widget unit of 20 astral characters", ops: [set(W(0, "/unit"), "µ😀".repeat(10))] },
  { name: "axis label of 60 astral characters", ops: [set(W(0, "/options/yAxisLabel"), "😀".repeat(60))] },
  { name: "tooltip title of 100 astral characters", ops: [set(W(0, "/options/tooltipTitle"), "😀".repeat(100))] },
  { name: "threshold label of 60 astral characters", ops: [set(W(0, "/options/thresholds/1/label"), "😀".repeat(60))] },
  { name: "reference line label of 60 astral characters", ops: [set(W(0, "/options/referenceLines/0/label"), "😀".repeat(60))] },
  { name: "series rule value of 200 astral characters", ops: [set(W(0, "/options/seriesColors/0/value"), "😀".repeat(200))] },
  { name: "variable label of 60 astral characters", ops: [set("/variables/0/label", "😀".repeat(60))] },
  { name: "link title of 100 astral characters", ops: [set(W(0, "/drilldowns/1/title"), "😀".repeat(100))] },
  { name: "application link title of 100 astral characters", ops: [set(W(0, "/drilldowns/0/title"), "😀".repeat(100))] },
  { name: "annotation column of 100 astral characters", ops: [set("/annotationSource/labelColumn", "😀".repeat(100))] },
  // A variable value is bounded in UTF-16 units on purpose (a Zod refinement); JSON Schema counts code points.
  { name: "variable option of 600 astral characters", ops: [set("/variables/0/options/1", "😀".repeat(600))], jsonSchemaGap: "UTF-16 length" },
  { name: "variable option of 512 astral characters", ops: [set("/variables/0/options/1", "😀".repeat(512))] },
  { name: "description null", ops: [set("/description", null)] },
  { name: "folder with a parent segment", ops: [set("/folder", "platform/../x")], jsonSchemaGap: refinement },
  { name: "folder with an empty segment", ops: [set("/folder", "platform//x")], jsonSchemaGap: refinement },
  { name: "timeZone UTC", ops: [set("/timeZone", "UTC")] },
  { name: "timeZone unknown", ops: [set("/timeZone", "Mars/Olympus")], jsonSchemaGap: refinement },
  { name: "timeZone wrong case", ops: [set("/timeZone", "europe/london")], jsonSchemaGap: refinement },
  { name: "timeZone a number", ops: [set("/timeZone", 5)] },
  { name: "timeRange 2h", ops: [set("/timeRange", "2h")] },
  { name: "refreshInterval 45", ops: [set("/refreshInterval", 45)] },
  { name: "refreshInterval as a string", ops: [set("/refreshInterval", "15")] },
  { name: "refreshInterval 15.0", ops: [raw("/refreshInterval", "15.0")], goRefuses: "number spelling" },
  { name: "custom range of a day", ops: [set("/customTimeRange", { from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00+00:00" })] },
  { name: "custom range of 32 days", ops: [set("/customTimeRange", { from: "2026-01-01T00:00:00Z", to: "2026-02-02T00:00:00Z" })], jsonSchemaGap: refinement },
  { name: "custom range backwards", ops: [set("/customTimeRange", { from: "2026-01-02T00:00:00Z", to: "2026-01-01T00:00:00Z" })], jsonSchemaGap: refinement },
  { name: "custom range without a zone", ops: [set("/customTimeRange", { from: "2026-01-01T00:00:00", to: "2026-01-02T00:00:00" })] },
  { name: "no widgets", ops: [set("/widgets", []), drop("/covers/summaryWidget")] },

  // Coverage
  { name: "covers with no applications", ops: [set("/covers/applications", [])] },
  { name: "covers with 16 applications", ops: [set("/covers/applications", Array.from({ length: 16 }, (_, i) => ({ name: `app-${i}` })))] },
  { name: "covers with 17 applications", ops: [set("/covers/applications", Array.from({ length: 17 }, (_, i) => ({ name: `app-${i}` })))] },
  { name: "covers namespace in capitals", ops: [set("/covers/applications/0/namespace", "Shop")] },
  { name: "covers namespace of 64 characters", ops: [set("/covers/applications/0/namespace", "n".repeat(64))] },
  { name: "covers name with dots", ops: [set("/covers/applications/0/name", "checkout.v2")] },
  { name: "covers name ending in a hyphen", ops: [set("/covers/applications/0/name", "checkout-")] },
  { name: "covers unknown member", ops: [set("/covers/applications/0/kind", "Deployment")] },
  { name: "covers maps an undeclared variable", ops: [set("/covers/variables/cluster", "name")], jsonSchemaGap: refinement },
  { name: "covers maps a variable to kind", ops: [set("/covers/variables/namespace", "kind")] },
  { name: "covers summary names no widget", ops: [set("/covers/summaryWidget", "missing")], jsonSchemaGap: refinement },
  { name: "covers without summary", ops: [drop("/covers/summaryWidget")] },

  // Variables
  { name: "multi variable with a text default", ops: [set("/variables/1/defaultValue", "api")], jsonSchemaGap: refinement },
  { name: "multi variable with a list default", ops: [set("/variables/1/defaultValue", ["api", "worker"])] },
  { name: "multi variable repeats a default", ops: [set("/variables/1/defaultValue", ["api", "api"])], jsonSchemaGap: refinement },
  { name: "allowAll without multi", ops: [drop("/variables/1/multi")], jsonSchemaGap: refinement },
  { name: "empty default without allowAll", ops: [drop("/variables/1/allowAll")], jsonSchemaGap: refinement },
  { name: "multi without options or source", ops: [drop("/variables/1/options")], jsonSchemaGap: refinement },
  { name: "single variable with a list default", ops: [set("/variables/0/defaultValue", ["shop"])], jsonSchemaGap: refinement },
  { name: "variable list of 101 values", ops: [set("/variables/1/defaultValue", Array.from({ length: 101 }, (_, i) => `v${i}`))] },
  { name: "variable options repeat", ops: [set("/variables/0/options", ["shop", "shop"])], jsonSchemaGap: refinement },
  { name: "variable name reserved", ops: [set("/variables/0/name", "constructor"), set("/covers/variables", { constructor: "namespace" })], jsonSchemaGap: refinement },
  { name: "variable names repeat", ops: [set("/variables/1/name", "namespace"), drop("/widgets/0/selectionBindings")], jsonSchemaGap: refinement },
  { name: "variable source reads an undeclared variable", ops: [set("/variables/2/source/selector", "up{node={{cluster}}}")], jsonSchemaGap: refinement },
  { name: "variable source unknown type", ops: [set("/variables/2/source/type", "query")] },
  { name: "variable source limit 0", ops: [set("/variables/2/source/limit", 0)] },
  { name: "variable source limit 2.5", ops: [set("/variables/2/source/limit", 2.5)] },

  // Widget envelope and layout
  { name: "widget unknown field", ops: [set(W(0, "/extra"), 1)] },
  { name: "widget ids repeat", ops: [set(W(1, "/id"), "latency")], jsonSchemaGap: refinement },
  { name: "widget type unknown", ops: [set(W(0, "/type"), "gauge")] },
  { name: "widget query of spaces", ops: [set(W(0, "/query"), "  ")], jsonSchemaGap: trim },
  { name: "widget unit of 25 characters", ops: [set(W(0, "/unit"), "u".repeat(25))] },
  { name: "widget colour in capitals", ops: [set(W(0, "/color"), "#AABBCC")] },
  { name: "widget colour of three digits", ops: [set(W(0, "/color"), "#abc")] },
  { name: "widget dataKind unknown", ops: [set(W(3, "/dataKind"), "logs")] },
  { name: "layout x 1.5", ops: [set(W(0, "/layout/x"), 1.5)] },
  { name: "layout x 0.0", ops: [raw(W(0, "/layout/x"), "0.0")], goRefuses: "number spelling" },
  { name: "layout x 1e0", ops: [raw(W(0, "/layout/x"), "1e0")], goRefuses: "number spelling" },
  { name: "layout past the right edge", ops: [set(W(0, "/layout/x"), 7)], jsonSchemaGap: refinement },
  { name: "layout x 12", ops: [set(W(0, "/layout/x"), 12)] },
  { name: "layout y 1001", ops: [set(W(0, "/layout/y"), 1001)] },
  { name: "layout h 1 on a time series", ops: [set(W(0, "/layout/h"), 1)] },
  { name: "layout without w", ops: [drop(W(0, "/layout/w"))] },

  // Options
  { name: "options unknown key", ops: [set(W(0, "/options/smooth"), true)] },
  { name: "decimals 8", ops: [set(W(0, "/options/decimals"), 8)] },
  { name: "decimals 9", ops: [set(W(0, "/options/decimals"), 9)] },
  { name: "decimals 1.5", ops: [set(W(0, "/options/decimals"), 1.5)] },
  { name: "decimals 2.0", ops: [raw(W(0, "/options/decimals"), "2.0")] },
  { name: "decimals as a string", ops: [set(W(0, "/options/decimals"), "2")] },
  { name: "decimals null", ops: [set(W(0, "/options/decimals"), null)] },
  { name: "staleAfterSeconds 0", ops: [set(W(1, "/options/staleAfterSeconds"), 0)] },
  { name: "lineWidth 0.4", ops: [set(W(0, "/options/lineWidth"), 0.4)] },
  { name: "fillOpacity 1.01", ops: [set(W(0, "/options/fillOpacity"), 1.01)] },
  { name: "showStatBar without max", ops: [drop(W(2, "/options/max"))] },
  { name: "min equal to max", ops: [set(W(2, "/options/min"), 100)], jsonSchemaGap: refinement },
  { name: "thresholds out of order", ops: [set(W(0, "/options/thresholds/1/value"), -1)], jsonSchemaGap: "ordering" },
  { name: "threshold with neither status nor colour", ops: [set(W(0, "/options/thresholds/1"), { value: 250 })] },
  { name: "threshold status unknown", ops: [set(W(0, "/options/thresholds/1/status"), "error")] },
  { name: "thirteen thresholds", ops: [set(W(0, "/options/thresholds"), Array.from({ length: 13 }, (_, i) => ({ value: i, status: "ok" })))] },
  { name: "reference line label empty", ops: [set(W(0, "/options/referenceLines/0/label"), "")] },
  { name: "series rule with colour and role", ops: [set(W(0, "/options/seriesColors/0/role"), "primary")] },
  { name: "series rules repeat", ops: [set(W(0, "/options/seriesColors/1"), { label: "pod", value: "api", color: "#0000aa" })], jsonSchemaGap: refinement },
  { name: "series rule label with a dash", ops: [set(W(0, "/options/seriesColors/0/label"), "pod-name")] },
  { name: "seriesColorMode index", ops: [set(W(0, "/options/seriesColorMode"), "index")] },
  { name: "tooltip placement inside", ops: [set(W(0, "/options/tooltipPlacement"), "inside")] },
  { name: "tooltip view of a stat", ops: [set(W(0, "/options/tooltipView"), { type: "stat", height: 120, source: { type: "series" } })] },
  { name: "tooltip view height 100", ops: [set(W(0, "/options/tooltipView"), { type: "stat", height: 100 })] },
  { name: "statIcon unknown", ops: [set(W(1, "/options/statIcon"), "rocket")] },
  { name: "sparkline placement top", ops: [set(W(1, "/options/sparklinePlacement"), "top")] },

  // Compare, baseline and events
  { name: "compare on a time series", ops: [set(W(0, "/options/compare"), { window: "1d" })] },
  { name: "compare window rolling", ops: [set(W(1, "/options/compare/window"), "rolling")] },
  { name: "baseline on a stat", ops: [set(W(1, "/options/baseline"), { window: "1d" })] },
  { name: "baseline window rolling", ops: [set(W(0, "/options/baseline/window"), "rolling")] },
  { name: "baseline band unknown", ops: [set(W(0, "/options/baseline/band"), "p5p95")] },
  { name: "baseline without window", ops: [set(W(0, "/options/baseline"), { band: "range" })] },
  { name: "showEvents as a string", ops: [set(W(0, "/options/showEvents"), "false")] },
  { name: "widget annotation source on a time series", ops: [set(W(0, "/annotationSource"), { queryRef: { id: "deploys" }, timestampColumn: "time", labelColumn: "title" })] },
  { name: "widget annotation source on a records table", ops: [set(W(5, "/annotationSource"), { queryRef: { id: "deploys" }, timestampColumn: "time", labelColumn: "title" })], jsonSchemaGap: refinement },
  { name: "annotation source column of spaces", ops: [set("/annotationSource/labelColumn", " ")], jsonSchemaGap: trim },
  { name: "annotation source unknown member", ops: [set("/annotationSource/colour", "red")] },
  { name: "annotation source without a label column", ops: [drop("/annotationSource/labelColumn")] },

  // Links
  { name: "application link with a fixed namespace", ops: [set(W(0, "/drilldowns/0/application/namespace"), { source: "constant", value: "shop" })] },
  { name: "application link source series", ops: [set(W(0, "/drilldowns/0/application/name/source"), "series")] },
  { name: "application link value empty", ops: [set(W(0, "/drilldowns/0/application/name/value"), "")] },
  { name: "application link with a dashboard id", ops: [set(W(0, "/drilldowns/0/dashboardId"), "other")] },
  { name: "drilldown label binding without a key", ops: [drop(W(0, "/drilldowns/1/bindings/0/value"))], jsonSchemaGap: refinement },
  { name: "drilldown value binding with a value", ops: [set(W(0, "/drilldowns/1/bindings/0"), { variable: "namespace", source: "value", value: "x" })], jsonSchemaGap: refinement },
  { name: "nine links", ops: [set(W(0, "/drilldowns"), Array.from({ length: 9 }, (_, i) => ({ id: `d${i}`, title: "D", dashboardId: "x" })))] },
  { name: "selection binding repeats a variable", ops: [set(W(0, "/selectionBindings/1"), { variable: "pods", source: "value" })], jsonSchemaGap: refinement },

  // Plugin envelope (the dashboard schema; per-plugin config is checked below)
  { name: "plugin config null", ops: [set(W(3, "/config"), null)] },
  { name: "plugin config an array", ops: [set(W(3, "/config"), [1])] },
  { name: "plugin config with a reserved key", ops: [set(W(3, "/config/__proto__"), 1)], jsonSchemaGap: refinement },
  { name: "plugin id with a slash", ops: [set(W(3, "/pluginId"), "k8s/placement")] },
  { name: "host plugin id", ops: [set(W(3, "/pluginId"), "acme-host-plugin")] },

  // Kubernetes plugin configs (valid at the document level; the plugin verdict differs)
  { name: "placement pressure 0.4", ops: [set(W(3, "/config/pressure"), 0.4)] },
  { name: "placement resource gpu", ops: [set(W(3, "/config/resource"), "gpu")] },
  { name: "placement maxNodes 2.0", ops: [raw(W(3, "/config/maxNodes"), "2.0")] },
  { name: "placement unknown key", ops: [set(W(3, "/config/zoom"), 2)] },
  { name: "throttle rows 5", ops: [set(W(4, "/config/rows"), 5)] },
  { name: "throttle group label with a dash", ops: [set(W(4, "/config/groupLabel"), "pod-name")] },
  { name: "record-table pageSize 2", ops: [set(W(5, "/config/pageSize"), 2)] },
  { name: "record-table mapping colour in capitals", ops: [set(W(5, "/config/cellStyles/0/mappings/1/color"), "#ABCDEF")] },
  { name: "record-table without config", ops: [drop(W(5, "/config"))] },
]

// ---- Applying a mutation -------------------------------------------------------------------------------------

function unescape(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~")
}

function applyOp(document: Json, op: MutationOp): void {
  const segments = op.path.split("/").slice(1).map(unescape)
  const last = segments.pop()
  if (last === undefined) throw new Error(`mutation path ${op.path} names the document`)
  let parent: Json = document
  for (const segment of segments) {
    const next: Json | undefined = Array.isArray(parent) ? parent[Number(segment)] : (parent as Record<string, Json>)[segment]
    if (next === undefined || next === null || typeof next !== "object") throw new Error(`mutation path ${op.path} does not exist`)
    parent = next
  }
  const value = op.json !== undefined ? (JSON.parse(op.json) as Json) : op.value
  if (Array.isArray(parent)) {
    const index = Number(last)
    if (!Number.isInteger(index) || index < 0 || index > parent.length) throw new Error(`mutation path ${op.path} is outside its array`)
    if (op.remove) parent.splice(index, 1)
    else parent[index] = value as Json
    return
  }
  const object = parent as Record<string, Json>
  if (op.remove) {
    if (!(last in object)) throw new Error(`mutation path ${op.path} removes nothing`)
    delete object[last]
  } else if (last === "__proto__") {
    Object.defineProperty(object, last, { value, enumerable: true, configurable: true, writable: true })
  } else object[last] = value as Json
}

function mutate(base: Json, ops: readonly MutationOp[]): Json {
  const document = structuredClone(base)
  for (const op of ops) applyOp(document, op)
  return document
}

// ---- Verdicts ------------------------------------------------------------------------------------------------

registerDefaultWidgetPlugins()

interface PluginVerdict { widget: string; pluginId: string; valid: boolean }

function zodValid(document: unknown): boolean {
  return dashboardSchema.safeParse(document).success
}

/** The plugin verdict of every built-in plugin widget whose plugin publishes a config schema. */
function pluginVerdicts(document: unknown): PluginVerdict[] {
  const widgets = (document as DocumentLike | null)?.widgets
  if (!Array.isArray(widgets)) return []
  return widgets.flatMap((widget) => {
    if (widget?.type !== "plugin" || typeof widget.pluginId !== "string" || typeof widget.id !== "string") return []
    const schema = getWidgetDefinition("plugin", widget.pluginId)?.configSchema
    if (!schema) return []
    const config = widget.config ?? {}
    return [{ widget: widget.id, pluginId: widget.pluginId, valid: schema.safeParse(config).success }]
  })
}

function fixture() {
  const documents = corpora.flatMap(([source, load]) =>
    load().map((document) => ({
      name: `${source}/${document.id ?? "(no id)"}`,
      valid: zodValid(document),
      plugins: pluginVerdicts(document),
      document: document as Json,
    })),
  )
  const mutations = MUTATIONS.map((mutation) => {
    const document = mutate(BASE, mutation.ops)
    return {
      name: mutation.name,
      ops: mutation.ops,
      valid: zodValid(document),
      plugins: pluginVerdicts(document),
      ...(mutation.jsonSchemaGap === undefined ? {} : { jsonSchemaGap: mutation.jsonSchemaGap }),
      ...(mutation.jsonSchemaStricter === undefined ? {} : { jsonSchemaStricter: mutation.jsonSchemaStricter }),
      ...(mutation.goRefuses === undefined ? {} : { goRefuses: mutation.goRefuses }),
    }
  })
  return {
    $comment: "Generated by `npm run schema:generate` (contract-differential.test.ts). Do not edit. valid and plugins are the Zod verdicts; Go must agree.",
    base: BASE,
    documents,
    mutations,
  }
}

describe("contract differential fixture", () => {
  const generated = fixture()

  it("is current with the corpus, the mutations and Zod", () => {
    const text = `${JSON.stringify(generated, null, 1)}\n`
    if (process.env.UPDATE_INSIGHTS_CONTRACT === "1") {
      mkdirSync(new URL(".", fixturePath), { recursive: true })
      writeFileSync(fixturePath, text)
      return
    }
    expect(readFileSync(fixturePath, "utf8")).toBe(text)
  })

  it("starts from a base document every validator accepts", () => {
    expect(dashboardSchema.safeParse(BASE).error?.issues ?? []).toEqual([])
    expect(pluginVerdicts(BASE).every((verdict) => verdict.valid)).toBe(true)
  })

  it("ships only documents Zod accepts", () => {
    const refused = generated.documents.filter((entry) => !entry.valid || entry.plugins.some((plugin) => !plugin.valid)).map((entry) => entry.name)
    expect(refused).toEqual([])
  })

  it("names a gap only where Zod refuses", () => {
    const misplaced = generated.mutations.filter((entry) => entry.jsonSchemaGap !== undefined && entry.valid).map((entry) => entry.name)
    expect(misplaced).toEqual([])
  })

  it("names a stricter validator only where Zod accepts", () => {
    const misplaced = generated.mutations
      .filter((entry) => (entry.jsonSchemaStricter !== undefined || entry.goRefuses !== undefined) && !entry.valid)
      .map((entry) => entry.name)
    expect(misplaced).toEqual([])
  })

  it("has accepted and refused mutations, and unique names", () => {
    expect(generated.mutations.some((entry) => entry.valid)).toBe(true)
    expect(generated.mutations.some((entry) => !entry.valid)).toBe(true)
    expect(generated.mutations.some((entry) => entry.plugins.some((plugin) => !plugin.valid))).toBe(true)
    const names = [...generated.documents, ...generated.mutations].map((entry) => entry.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

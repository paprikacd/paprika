import { describe, expect, it } from "vitest"
import { createExampleCatalogQuery } from "../example-catalog-query"
import { dashboardToOpenUI, parseOpenUIDashboard } from "../openui"
import { resolveSavedQueryReference } from "../saved-queries"
import { dashboardSchema, savedQuerySchema, widgetKind, type QueryResult, type Widget } from "../schema"
import { parseDashboardBundle, serializeDashboardBundle } from "../workspace-transfer"
import { chartFixtureCollections as artboardExamples, chartFixtures as artboardFixtures } from "../../../../e2e/fixtures/rich-chart-data"

const engine = createExampleCatalogQuery(artboardFixtures)
const range = { start: 1_792_500_000, end: 1_792_503_600, step: 60 }

function observationCount(result: QueryResult) {
  return result.series?.length ?? result.records?.rows.length ?? result.traces?.length ?? 0
}

describe("test-only rich chart fixture coverage", () => {
  it("keeps six isolated chart fixtures bound to ordinary saved queries", () => {
    expect(artboardExamples.map(entry => entry.id)).toEqual([
      "artboard-service-pulse", "artboard-fleet-atlas", "artboard-edge-watch",
      "artboard-market-lens", "artboard-reliability-room", "artboard-collection-control",
    ])
    const queryIds = artboardExamples.flatMap(entry => entry.sample.savedQueries!.map(query => query.id))
    expect(new Set(queryIds).size).toBe(queryIds.length)
    expect(new Set(artboardFixtures.map(fixture => fixture.metric)).size).toBe(artboardFixtures.length)
    for (const entry of artboardExamples) {
      expect(entry.live).toBeUndefined()
      expect(entry.liveStatus).toBe("unavailable")
      expect(entry.limitations.join(" ")).toContain("not live telemetry")
      const dashboard = entry.sample.dashboards[0]
      expect(dashboardSchema.parse(dashboard)).toEqual(dashboard)
      expect(dashboard.description).toContain("Illustrative data")
      for (const query of entry.sample.savedQueries!) {
        expect(savedQuerySchema.parse(query)).toEqual(query)
        expect(query.tags).toContain("artboard")
      }
      for (const widget of dashboard.widgets) {
        expect(widget.queryRef).toBeDefined()
        const saved = entry.sample.savedQueries!.find(query => query.id === widget.queryRef!.id)!
        expect(saved, widget.id).toBeDefined()
        expect(saved.kind).toBe(widgetKind(widget))
        expect(saved.providerId).toBe(widget.providerId)
        expect(widget.queryRef!.bindings).toEqual([{ parameter: dashboard.variables![0].name, source: "variable", variable: dashboard.variables![0].name }])
      }
    }
  })

  it.each(artboardExamples)("filters every $title panel through the shared declared scope", async entry => {
    const dashboard = entry.sample.dashboards[0]
    const variable = dashboard.variables![0]
    for (const widget of dashboard.widgets) {
      const results: QueryResult[] = []
      for (const choice of variable.options!) {
        const query = resolveSavedQueryReference(widget.queryRef!, entry.sample.savedQueries!, { [variable.name]: choice }, widgetKind(widget))
        expect(query.query).not.toContain("{{")
        const result = await engine.query({ ...query, ...range }, new AbortController().signal)
        expect(observationCount(result), `${entry.id}/${widget.id}/${choice}`).toBeGreaterThan(0)
        if (result.series) expect(result.series.every(series => series.labels[variable.name] === choice)).toBe(true)
        if (result.records) {
          const index = result.records.columns.findIndex(column => column.key === variable.name)
          expect(index).toBeGreaterThanOrEqual(0)
          expect(result.records.rows.every(row => row[index] === choice)).toBe(true)
        }
        if (result.traces) expect(result.traces.every(trace => trace.service === choice)).toBe(true)
        results.push(result)
      }
      expect(results[0], `${entry.id}/${widget.id} changes with the scope`).not.toEqual(results[1])
      const unknown = resolveSavedQueryReference(widget.queryRef!, entry.sample.savedQueries!, { [variable.name]: 'missing"} or {{service}}' }, widgetKind(widget))
      expect(observationCount(await engine.query({ ...unknown, ...range }, new AbortController().signal))).toBe(0)
    }
  })

  it.each(artboardExamples)("preserves $title bindings/configuration through JSON, YAML and OpenUI", entry => {
    for (const format of ["json", "yaml"] as const) {
      expect(parseDashboardBundle(serializeDashboardBundle(entry.sample, format), format)).toEqual(entry.sample)
    }
    for (const dashboard of entry.sample.dashboards) {
      expect(parseOpenUIDashboard(dashboardToOpenUI(dashboard))).toEqual(dashboard)
      for (let i = 0; i < dashboard.widgets.length; i++) {
        const a = dashboard.widgets[i]
        for (const b of dashboard.widgets.slice(i + 1)) {
          expect(a.layout.x < b.layout.x + b.layout.w && a.layout.x + a.layout.w > b.layout.x && a.layout.y < b.layout.y + b.layout.h && a.layout.y + a.layout.h > b.layout.y, `${dashboard.id}: ${a.id} overlaps ${b.id}`).toBe(false)
        }
      }
    }
  })

  it("reuses one request saved query for both the primary value and its history", () => {
    const widgets = artboardExamples[0].sample.dashboards[0].widgets
    expect(widgets.find(widget => widget.id === "requests")!.queryRef).toEqual(widgets.find(widget => widget.id === "request-history")!.queryRef)
  })

  it("supplies valid cumulative histogram rates with explicit infinity overflow and no invented buckets", async () => {
    const entry = artboardExamples[0]
    const widget = entry.sample.dashboards[0].widgets.find(widget => widget.pluginId === "distribution-heatmap")!
    const result = await query(entry.id, widget, "uptime-api")
    expect(result.series!.map(series => series.labels.le)).toEqual(["10", "25", "50", "100", "250", "500", "+Inf"])
    for (let point = 0; point < result.series![0].points.length; point++) {
      let lower = 0
      for (const bucket of result.series!) {
        const value = bucket.points[point].value!
        expect(value).toBeGreaterThanOrEqual(lower)
        lower = value
      }
    }
  })

  it("uses raw positive directional traffic and preserves missing source freshness as null", async () => {
    const edge = artboardExamples.find(entry => entry.id === "artboard-edge-watch")!
    const flow = edge.sample.dashboards[0].widgets.find(widget => widget.pluginId === "directional-traffic")!
    const result = await query(edge.id, flow, "edge-01")
    expect(result.series!.map(series => series.labels.direction)).toEqual(["inbound", "outbound"])
    expect(result.series!.every(series => series.points.every(point => point.value! >= 0))).toBe(true)
    const collection = artboardExamples.find(entry => entry.id === "artboard-collection-control")!
    const failures = collection.sample.dashboards[0].widgets.find(widget => widget.id === "failures")!
    const records = (await query(collection.id, failures, "production")).records!
    const row = records.rows.find(row => row[1] === "telemetry-canary")!
    expect(row[2]).toBeNull()
    expect(row.at(-1)).toBe("Unknown")
  })

  it("keeps metric history deterministic and retains unknown intervals", async () => {
    const entry = artboardExamples.find(entry => entry.id === "artboard-fleet-atlas")!
    const widget = entry.sample.dashboards[0].widgets.find(widget => widget.id === "states")!
    const first = await query(entry.id, widget, "omega")
    expect(await query(entry.id, widget, "omega")).toEqual(first)
    const missing = first.series!.find(series => series.labels.node === "node-06")!
    expect(missing.points.at(-1)!.value).toBeNull()
    expect(missing.points.some(point => point.value === 1)).toBe(true)
  })
})

async function query(exampleId: string, widget: Widget, value: string) {
  const entry = artboardExamples.find(entry => entry.id === exampleId)!
  const variable = entry.sample.dashboards[0].variables![0].name
  const resolved = resolveSavedQueryReference(widget.queryRef!, entry.sample.savedQueries!, { [variable]: value }, widgetKind(widget))
  return engine.query({ ...resolved, ...range }, new AbortController().signal)
}

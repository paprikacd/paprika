import { describe, expect, it } from "vitest"
import { referenceDashboards, referenceSpecs, resultForReferenceQuery } from "../../../../e2e/fixtures/reference-dashboard-data"
import { dashboardSchema, savedQuerySchema, widgetKind, type QueryRequest } from "../schema"
import { resolveSavedQueryReference } from "../saved-queries"
import { parseDashboardBundle, serializeDashboardBundle } from "../workspace-transfer"
import { registerDefaultWidgetPlugins } from "./threshold-gauge"
import { getWidgetDefinition } from "../widget-registry"

registerDefaultWidgetPlugins()
const range = { start: Date.parse("2026-10-28T12:00:00Z") / 1000, end: Date.parse("2026-10-28T13:00:00Z") / 1000, step: 30 }
function execute(entry: typeof referenceDashboards[number], widgetId: string, service: string) {
  const widget = entry.bundle.dashboards[0].widgets.find(widget => widget.id === widgetId)!
  const query = resolveSavedQueryReference(widget.queryRef!, entry.bundle.savedQueries!, { service }, widgetKind(widget))
  return resultForReferenceQuery({ ...query, ...range })
}

describe("reference screenshot dashboard acceptance fixtures", () => {
  it("maps all four references to explicit panel geometry, components and result contracts without public presets", () => {
    expect(referenceSpecs.map(spec => spec.referenceKey)).toEqual(["image-1", "image-2", "image-3", "image-4"])
    expect(referenceDashboards.map(entry => entry.requiredPanels.length)).toEqual([16, 28, 5, 7])
    expect(referenceDashboards.map(entry => entry.oneScreen)).toEqual([true, false, true, true])
    const queryIds = referenceDashboards.flatMap(entry => entry.bundle.savedQueries!.map(query => query.id))
    expect(new Set(queryIds).size).toBe(queryIds.length)
    for (const entry of referenceDashboards) {
      const board = entry.bundle.dashboards[0]
      expect(dashboardSchema.parse(board)).toEqual(board)
      expect(entry.requiredPanels.map(panel => panel.id)).toEqual(board.widgets.map(widget => widget.id))
      for (const panel of entry.requiredPanels) {
        expect(panel.dataShape.length).toBeGreaterThan(20)
        expect(panel.visual.length).toBeGreaterThan(35)
        expect(panel.layout).toEqual(board.widgets.find(widget => widget.id === panel.id)!.layout)
      }
      for (const saved of entry.bundle.savedQueries!) expect(savedQuerySchema.parse(saved)).toEqual(saved)
      for (const widget of board.widgets) {
        expect(getWidgetDefinition(widget)).toBeDefined()
        if (widget.pluginId) expect(() => getWidgetDefinition(widget)!.parseConfig!(widget.config)).not.toThrow()
        expect(widget.queryRef!.bindings).toEqual([{ parameter: "service", source: "variable", variable: "service" }])
        const layout = widget.layout
        for (const other of board.widgets.filter(candidate => candidate.id !== widget.id)) {
          const b = other.layout
          expect(layout.x < b.x + b.w && layout.x + layout.w > b.x && layout.y < b.y + b.h && layout.y + layout.h > b.y, `${widget.id} overlaps ${other.id}`).toBe(false)
        }
      }
    }
  })

  it.each(referenceDashboards)("executes every $title saved query with both exact shared-filter choices", entry => {
    const board = entry.bundle.dashboards[0], choices = board.variables![0].options!
    for (const widget of board.widgets) {
      const results = choices.map(service => execute(entry, widget.id, service))
      for (const [index, result] of results.entries()) {
        if (result.series) {
          expect(result.series.length, widget.id).toBeGreaterThan(0)
          expect(result.series.every(series => series.labels.service === choices[index])).toBe(true)
          expect(result.series.every(series => series.points.length === 121 && series.points.every(point => point.value === null || Number.isFinite(point.value)))).toBe(true)
        } else {
          expect(result.records!.rows.length, widget.id).toBeGreaterThan(0)
          expect(result.records!.rows.every(row => row[0] === choices[index])).toBe(true)
        }
      }
      expect(results[0]).not.toEqual(results[1])
      const missing = execute(entry, widget.id, 'missing"} or {{service}}')
      expect(missing.series?.length ?? missing.records!.rows.length).toBe(0)
    }
  })

  it.each(referenceDashboards)("round-trips $title through the actual JSON/YAML import bundle format", entry => {
    for (const format of ["json", "yaml"] as const) expect(parseDashboardBundle(serializeDashboardBundle(entry.bundle, format), format)).toEqual(entry.bundle)
  })

  it("keeps every latency histogram group cumulative under both selected services", () => {
    const entry = referenceDashboards[0]
    expect(entry.bundle.dashboards[0].widgets.find(widget => widget.id === "reference-ingress-distribution")!.config!.maxColumns).toBe(120)
    for (const service of entry.bundle.dashboards[0].variables![0].options!) {
      const series = execute(entry, "reference-ingress-distribution", service).series!
      expect(series.at(-1)!.labels.le).toBe("+Inf")
      for (let index = 0; index < series[0].points.length; index++) {
        const values = series.map(bucket => bucket.points[index].value!)
        expect(values.every((value, bucket) => value >= 0 && (!bucket || value >= values[bucket - 1]))).toBe(true)
      }
    }
  })

  it("preserves six volume observations for both capacity-bank render modes", () => {
    const entry = referenceDashboards[3], board = entry.bundle.dashboards[0]
    for (const id of ["reference-service-overview-disk-bars", "reference-service-overview-disk-gauges"]) {
      const widget = board.widgets.find(widget => widget.id === id)!
      expect(widget.config!.seriesMode).toBe("all")
      expect(execute(entry, id, "uptime-api").series).toHaveLength(6)
    }
    expect(board.widgets.find(widget => widget.id === "reference-service-overview-disk-gauges")!.config!.columns).toBe(3)
  })

  it("keeps all six current host meters aligned with their neighboring plots under both gateway filters", () => {
    const entry = referenceDashboards[1], board = entry.bundle.dashboards[0]
    for (const signal of ["cpu", "temperature", "power", "memory"]) {
      const id = `reference-network-hosts-${signal}-current`
      const widget = board.widgets.find(widget => widget.id === id)!
      expect(widget.config).toMatchObject({ display: "segmented", orientation: "vertical", seriesMode: "all", maxSeries: 6 })
      for (const service of board.variables![0].options!) {
        const current = execute(entry, id, service).series!
        const plot = execute(entry, `reference-network-hosts-${signal}-hosts`, service).series!
        expect(current).toHaveLength(6)
        expect(current.map(series => ({ ...series, labels: Object.fromEntries(Object.entries(series.labels).filter(([key]) => key !== "__name__")) }))).toEqual(
          plot.map(series => ({ ...series, labels: Object.fromEntries(Object.entries(series.labels).filter(([key]) => key !== "__name__")) })),
        )
      }
    }
  })

  it("uses compact tables without search chrome while retaining the five service flow readings", () => {
    const tables = referenceDashboards.flatMap(entry => entry.bundle.dashboards[0].widgets.filter(widget => widget.pluginId === "record-table"))
    expect(tables).toHaveLength(5)
    for (const widget of tables) expect(widget.config).toMatchObject({ density: "compact", showSearch: false })
    const entry = referenceDashboards[3]
    for (const service of entry.bundle.dashboards[0].variables![0].options!) {
      expect(execute(entry, "reference-service-overview-flow-readings", service).records!.rows).toHaveLength(5)
    }
  })

  it("retains irregular samples, outages, unknowns and distinct dual-axis units", () => {
    const ingress = execute(referenceDashboards[0], "reference-ingress-opened", "ingress-public").series![0].points.map(point => point.value!)
    const changes = ingress.slice(1).map((value, index) => value - ingress[index])
    expect(changes.filter((value, index) => index && Math.sign(value) !== Math.sign(changes[index - 1])).length).toBeGreaterThan(50)
    const logins = execute(referenceDashboards[2], "reference-mixed-signals-logins", "frontend").series![0].points
    expect(logins[80].value!).toBeLessThan(logins[60].value! / 2)
    const status = execute(referenceDashboards[3], "reference-service-overview-cpu-history", "uptime-api").series!
    expect(status.some(series => series.points.some(point => point.value === null))).toBe(true)
    const records = execute(referenceDashboards[3], "reference-service-overview-resources", "uptime-api").records!
    expect(records.columns.find(column => column.key === "cpu")!.unit).toBe("%")
    expect(records.columns.find(column => column.key === "memory")!.unit).toBe("GB")
  })

  it("accepts provider remapping but rejects unresolved parameters and unsupported signal kinds", () => {
    const entry = referenceDashboards[0], saved = entry.bundle.savedQueries![0]
    const query = saved.query.replace("{{service}}", JSON.stringify("ingress-public"))
    const request = { ...range, providerId: "real-go-reference-provider", kind: "metrics", query } as QueryRequest
    expect(resultForReferenceQuery(request).series!.length).toBe(1)
    expect(() => resultForReferenceQuery({ ...request, query: saved.query })).toThrow(/Resolve/)
    expect(() => resultForReferenceQuery({ ...request, kind: "traces" })).toThrow(/not trace panels/)
  })
})

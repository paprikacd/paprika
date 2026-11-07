import { describe, expect, it } from "vitest"
import { resolveSelectionBindings } from "./drilldown"
import { dashboardSchema, widgetSchema, parseDashboard, serializeDashboard, type Dashboard } from "./schema"
import { dashboardToOpenUI, parseOpenUIDashboard } from "./openui"

const board: Dashboard = { schemaVersion: 1, id: "market", title: "Market", timeRange: "1h", refreshInterval: 0,
  variables: [{ name: "sector", defaultValue: "Materials" }, { name: "company", defaultValue: "BHP" }], widgets: [] }
const binding = { variable: "company", source: "label" as const, value: "symbol" }

describe("dashboard selection bindings", () => {
  it("preserves unrelated current filters and persisted defaults while applying the exact selected field", () => {
    expect(resolveSelectionBindings([binding], { labels: { symbol: 'RIO "quoted"' } }, board, { sector: "Financials", company: "BHP" }))
      .toEqual({ sector: "Financials", company: 'RIO "quoted"' })
    expect(board.variables?.[1].defaultValue).toBe("BHP")
  })
  it("rejects missing and undeclared fields and duplicate bindings without returning partial updates", () => {
    expect(() => resolveSelectionBindings([binding], { labels: {} }, board, {})).toThrow(/no label/)
    expect(() => resolveSelectionBindings([{ ...binding, variable: "missing" }], { labels: { symbol: "RIO" } }, board, {})).toThrow(/not declared/)
    expect(() => resolveSelectionBindings([binding, binding], { labels: { symbol: "RIO" } }, board, {})).toThrow()
  })
  it("accepts bounded explicit bindings in the document and rejects duplicates", () => {
    const widget = { id: "companies", title: "Companies", type: "plugin", pluginId: "record-treemap", dataKind: "records", providerId: "data", query: "SELECT 1", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, selectionBindings: [binding] }
    expect(widgetSchema.safeParse(widget).success).toBe(true)
    expect(dashboardSchema.safeParse({ ...board, widgets: [widget] }).success).toBe(true)
    expect(widgetSchema.safeParse({ ...widget, selectionBindings: [binding, binding] }).success).toBe(false)
  })
  it("preserves bindings in JSON, YAML and OpenUI authoring", () => {
    const document: Dashboard = { ...board, widgets: [{ id: "companies", title: "Companies", type: "plugin", pluginId: "record-treemap", dataKind: "records", providerId: "data", query: "SELECT 1", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, selectionBindings: [binding] }] }
    for (const format of ["json", "yaml"] as const) expect(parseDashboard(serializeDashboard(document, format), format)).toEqual(document)
    expect(parseOpenUIDashboard(dashboardToOpenUI(document))).toEqual(document)
  })
})

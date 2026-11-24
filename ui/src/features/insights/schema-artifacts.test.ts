// @vitest-environment node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { widgetSchema, parseDashboard } from "./schema"
import { dashboardJSONSchema, savedQueryJSONSchema, stableJSON, WIDGET_ALL_OF } from "./contract-artifacts"

const dashboardPath = new URL("../../../../docs/design/insights/dashboard.schema.json", import.meta.url)
const savedQueryPath = new URL("../../../../docs/design/insights/saved-query.schema.json", import.meta.url)

// `npm run schema:generate` sets UPDATE_INSIGHTS_CONTRACT=1 and writes the committed files from the builders.
// Otherwise each file must equal the builder output byte for byte.
function checkOrWrite(path: URL, expected: string) {
  if (process.env.UPDATE_INSIGHTS_CONTRACT === "1") {
    mkdirSync(new URL(".", path), { recursive: true })
    writeFileSync(path, expected)
    return
  }
  expect(readFileSync(path, "utf8")).toBe(expected)
}

describe("published dashboard authoring artifacts", () => {
  it("keeps the machine-readable JSON Schema aligned with the runtime contract", () => {
    checkOrWrite(dashboardPath, stableJSON(dashboardJSONSchema()))
  })

  it("keeps the published widget rules that Zod cannot emit", () => {
    const schema = JSON.parse(readFileSync(dashboardPath, "utf8"))
    expect(schema.properties.widgets.items.allOf).toEqual(WIDGET_ALL_OF)
  })

  it("publishes the series colour mode, which old documents may omit", () => {
    const dashboard = JSON.parse(readFileSync(new URL("../../../../docs/design/insights/dashboard.schema.json", import.meta.url), "utf8"))
    const options = dashboard.properties.widgets.items.properties.options
    expect(options.properties.seriesColorMode).toEqual({ type: "string", enum: ["name", "index"] })
    expect(options.required).toBeUndefined()
  })

  it("publishes the saved-query contract", () => {
    checkOrWrite(savedQueryPath, stableJSON(savedQueryJSONSchema()))
  })

  it("can expose the full standalone widget contract without losing recursive definitions", () => {
    const dashboard = JSON.parse(readFileSync(new URL("../../../../docs/design/insights/dashboard.schema.json", import.meta.url), "utf8"))
    const widget = {
      ...dashboard.properties.widgets.items,
      $schema: dashboard.$schema,
      $defs: dashboard.$defs,
    }
    // Drop the four published refinements Zod cannot emit, then compare the generated remainder.
    const published = structuredClone(widget) as Record<string, unknown>
    const at = (...keys: string[]) => keys.reduce((node, key) => (node as Record<string, unknown>)[key], published) as Record<string, unknown>
    delete published.allOf
    delete at("properties", "options").allOf
    delete at("properties", "options", "properties", "thresholds", "items").anyOf
    delete at("properties", "options", "properties", "seriesColors", "items").oneOf
    expect(published).toEqual(z.toJSONSchema(widgetSchema))
  })

  it("publishes the annotation interval end column and validates its bounds", () => {
    const dashboard = JSON.parse(readFileSync(new URL("../../../../docs/design/insights/dashboard.schema.json", import.meta.url), "utf8"))
    expect(dashboard.properties.widgets.items.properties.annotationSource.properties.endColumn).toEqual({ type: "string", minLength: 1, maxLength: 128 })
    const widget = { id: "events", title: "Events", type: "timeseries", providerId: "prom", query: "up", unit: "", layout: { x: 0, y: 0, w: 6, h: 2 }, annotationSource: { queryRef: { id: "events" }, timestampColumn: "start", endColumn: "end", labelColumn: "name" } }
    expect(widgetSchema.safeParse(widget).success).toBe(true)
    for (const endColumn of ["", "x".repeat(129)])
      expect(widgetSchema.safeParse({ ...widget, annotationSource: { ...widget.annotationSource, endColumn } }).success).toBe(false)
  })

  it("ships an importable YAML example", () => {
    const source = readFileSync(
      new URL("../../../../docs/design/insights/example-dashboard.yaml", import.meta.url),
      "utf8",
    )
    const dashboard = parseDashboard(source, "yaml")
    expect(dashboard.id).toBe("service-health")
    expect(dashboard.widgets.map((widget) => widget.type)).toEqual(["stat", "timeseries", "traces"])
  })
})

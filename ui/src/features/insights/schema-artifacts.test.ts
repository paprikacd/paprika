// @vitest-environment node
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { dashboardSchema, savedQuerySchema, widgetSchema, parseDashboard } from "./schema"

// Zod's JSON Schema exporter cannot emit superRefine's cross-field rule.
// Check the published rule explicitly before comparing the generated remainder.
function assertAndRemoveStatHeightConstraint(widget: Record<string, unknown>) {
  expect(widget.allOf).toEqual([{
    if: { properties: { type: { const: "stat" } }, required: ["type"] },
    else: { properties: { layout: { properties: { h: { minimum: 2 } } } } },
  }])
  delete widget.allOf
  const options = (widget.properties as Record<string, Record<string, unknown>>).options
  expect(options.allOf).toEqual([{
    if: { properties: { showStatBar: { const: true } }, required: ["showStatBar"] },
    then: { required: ["min", "max"] },
  }])
  delete options.allOf
}

describe("published dashboard authoring artifacts", () => {
  it("keeps the machine-readable JSON Schema aligned with the runtime contract", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL("../../../../docs/design/insights/dashboard.schema.json", import.meta.url),
        "utf8",
      ),
    )
    delete schema.title
    delete schema.description
    delete schema.$comment
    assertAndRemoveStatHeightConstraint(schema.properties.widgets.items)
    expect(schema).toEqual(z.toJSONSchema(dashboardSchema))
  })

  it("publishes the saved-query contract", () => {
    const schema = JSON.parse(readFileSync(new URL("../../../../docs/design/insights/saved-query.schema.json", import.meta.url), "utf8"))
    delete schema.title
    delete schema.description
    expect(schema).toEqual(z.toJSONSchema(savedQuerySchema))
  })

  it("can expose the full standalone widget contract without losing recursive definitions", () => {
    const dashboard = JSON.parse(readFileSync(new URL("../../../../docs/design/insights/dashboard.schema.json", import.meta.url), "utf8"))
    const widget = {
      ...dashboard.properties.widgets.items,
      $schema: dashboard.$schema,
      $defs: dashboard.$defs,
    }
    assertAndRemoveStatHeightConstraint(widget)
    expect(widget).toEqual(z.toJSONSchema(widgetSchema))
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

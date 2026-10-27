// @vitest-environment node
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { dashboardSchema, savedQuerySchema, widgetSchema, parseDashboard } from "./schema"

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
    expect(widget).toEqual(z.toJSONSchema(widgetSchema))
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

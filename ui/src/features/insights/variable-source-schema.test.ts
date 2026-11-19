import { describe, expect, it } from "vitest"
import { dashboardSchema, variableSourceSchema } from "./schema"

const base = (variables: unknown[]) => ({
  schemaVersion: 1,
  id: "demo",
  title: "Demo",
  timeRange: "1h",
  refreshInterval: 0,
  widgets: [],
  variables,
})

describe("dashboard variable sources", () => {
  it("accepts a label values source with a selector over a declared variable", () => {
    const result = dashboardSchema.safeParse(base([
      { name: "cluster", options: ["omega", "delta"] },
      { name: "service", source: { type: "labelValues", providerId: "prom", label: "service", selector: "up{cluster={{cluster}}}" } },
    ]))
    expect(result.success).toBe(true)
  })

  it("rejects a selector placeholder that names no declared variable", () => {
    const result = dashboardSchema.safeParse(base([
      { name: "service", source: { type: "labelValues", providerId: "prom", label: "service", selector: "up{cluster={{cluster}}}" } },
    ]))
    expect(result.success).toBe(false)
  })

  it("rejects a dependency cycle between sources", () => {
    const result = dashboardSchema.safeParse(base([
      { name: "cluster", source: { type: "labelValues", providerId: "prom", label: "cluster", selector: "up{service={{service}}}" } },
      { name: "service", source: { type: "labelValues", providerId: "prom", label: "service", selector: "up{cluster={{cluster}}}" } },
    ]))
    expect(result.success).toBe(false)
  })

  it("rejects a source with an unknown member", () => {
    expect(variableSourceSchema.safeParse({ type: "labelValues", providerId: "prom", label: "service", refresh: "load" }).success).toBe(false)
  })

  it("rejects a saved query source with a label binding", () => {
    expect(variableSourceSchema.safeParse({
      type: "savedQuery",
      field: "service",
      queryRef: { id: "services", bindings: [{ parameter: "cluster", source: "label", label: "cluster" }] },
    }).success).toBe(false)
  })
})

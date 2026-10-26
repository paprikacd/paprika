import { describe, expect, it } from "vitest"
import { resolveTooltipQuery, validateTooltipQueryTemplate } from "./tooltip-context"
import type { Series } from "./chart-data"
import type { TooltipQuerySource } from "./schema"

const series: Series = {
  name: 'checkout"{{value}}', labels: { service: 'a"\\\n{{time}}' },
  points: [{ timestamp: 1792490400125, value: -7.25 }, { timestamp: 1792490415000, value: 32 }],
}
const source: TooltipQuerySource = {
  type: "query", providerId: "prom",
  query: "up{service={{service}},name={{name}}}@{{time}} > {{value}}",
  bindings: [
    { variable: "service", label: "service" }, { variable: "name", field: "series" },
    { variable: "time", field: "timestamp" }, { variable: "value", field: "value" },
  ],
}

describe("tooltip observation context", () => {
  it("binds the explicit historical observation rather than the latest series sample", () => {
    expect(resolveTooltipQuery(source, series, series.points[0])).toBe(
      `up{service=${JSON.stringify(series.labels.service)},name=${JSON.stringify(series.name)}}@1792490400.125 > -7.25`,
    )
    expect(resolveTooltipQuery(source, series, { timestamp: 0, value: 0 })).toContain("@0 > 0")
    expect(() => validateTooltipQueryTemplate(source)).not.toThrow()
  })
  it("does not revive the latest value when the hovered observation is missing or null", () => {
    expect(() => resolveTooltipQuery(source, series)).toThrow(/no valid timestamp|no finite value/)
    expect(() => resolveTooltipQuery(source, series, { timestamp: 1000, value: null })).toThrow(/no finite value/)
    for (const timestamp of [NaN, Infinity, 1e20])
      expect(() => resolveTooltipQuery(source, series, { timestamp, value: 1 })).toThrow(/no valid timestamp/)
  })
  it("validates template source types without requiring a runtime observation", () => {
    expect(() => validateTooltipQueryTemplate({ ...source, query: "up@{{time}}+{{value}}" })).not.toThrow()
    expect(() => validateTooltipQueryTemplate({ ...source, query: 'up{a="{{time}}"}' })).toThrow(/surrounding quotes/)
    expect(() => validateTooltipQueryTemplate({ ...source, query: "up@{{missing}}" })).toThrow()
    expect(() => resolveTooltipQuery({ ...source, bindings: [{ variable: "missing", label: "missing" }] }, series)).toThrow(/no label/)
  })
})

// @vitest-environment node
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { interpolateTypedTemplate } from "./drilldown"

// The same fixture runs through interpolatedLiteral in Go (variable_interpolation_conformance_test.go).
// Both must give the same query text, or both must refuse.
interface InterpolationCase {
  name: string
  template: string
  types: Record<string, "string" | "number" | "strings">
  values: Record<string, string | number | string[]>
  expected?: string
  error?: boolean
}
const fixtures = JSON.parse(
  readFileSync(new URL("../../../../docs/design/insights/conformance/variable-interpolation.json", import.meta.url), "utf8"),
) as { interpolate: InterpolationCase[] }

describe("variable interpolation conformance fixtures", () => {
  it("has cases", () => {
    expect(fixtures.interpolate.length).toBeGreaterThan(0)
  })
  for (const entry of fixtures.interpolate) {
    it(entry.name, () => {
      if (entry.error) {
        expect(() => interpolateTypedTemplate(entry.template, entry.values, entry.types)).toThrow()
        return
      }
      expect(interpolateTypedTemplate(entry.template, entry.values, entry.types)).toBe(entry.expected)
    })
  }
})

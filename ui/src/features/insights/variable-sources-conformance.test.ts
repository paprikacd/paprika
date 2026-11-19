// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dashboardSchema } from "./schema";

// The same fixtures run through validateDashboardVariables in Go
// (internal/insights/variable_sources_conformance_test.go). Both must reach the same verdict.
const fixtures = JSON.parse(
  readFileSync(new URL("../../../../docs/design/insights/conformance/variable-sources.json", import.meta.url), "utf8"),
) as { cases: { name: string; valid: boolean; variables: unknown[] }[] };

describe("variable source conformance fixtures", () => {
  it("has cases", () => {
    expect(fixtures.cases.length).toBeGreaterThan(0)
  })
  for (const entry of fixtures.cases) {
    it(entry.name, () => {
      const result = dashboardSchema.safeParse({
        schemaVersion: 1,
        id: "demo",
        title: "Demo",
        timeRange: "1h",
        refreshInterval: 0,
        widgets: [],
        variables: entry.variables,
      })
      expect(result.success).toBe(entry.valid)
    })
  }
})

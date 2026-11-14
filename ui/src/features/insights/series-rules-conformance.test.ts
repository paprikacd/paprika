// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { widgetSchema } from "./schema";
import { SERIES_ROLES } from "./series-palette";

// The same fixtures run through the Go validateDashboard path and the embedded dashboard JSON Schema
// (internal/insights/series_conformance_test.go). All three must agree on every case.
const fixtures = JSON.parse(
  readFileSync(new URL("../../../../docs/design/insights/conformance/series-rules.json", import.meta.url), "utf8"),
) as { roles: string[]; cases: { name: string; valid: boolean; seriesColors: unknown }[] };

function widgetWithSeriesColors(seriesColors: unknown) {
  return {
    id: "conformance",
    title: "Conformance",
    type: "timeseries",
    providerId: "prometheus",
    query: "up",
    unit: "",
    layout: { x: 0, y: 0, w: 6, h: 4 },
    options: { seriesColors },
  };
}

describe("series colour rule conformance fixtures", () => {
  it("keeps the role vocabulary identical to the published fixture", () => {
    expect([...SERIES_ROLES]).toEqual(fixtures.roles);
  });

  it("includes both valid and invalid cases", () => {
    expect(fixtures.cases.some((entry) => entry.valid)).toBe(true);
    expect(fixtures.cases.some((entry) => !entry.valid)).toBe(true);
  });

  for (const entry of fixtures.cases) {
    it(`${entry.valid ? "accepts" : "rejects"} ${entry.name}`, () => {
      const result = widgetSchema.safeParse(widgetWithSeriesColors(entry.seriesColors));
      expect(result.success).toBe(entry.valid);
    });
  }
});

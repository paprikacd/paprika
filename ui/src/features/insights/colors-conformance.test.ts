// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { widgetSchema } from "./schema";
import { SERIES_COLOR_MODES, WELL_KNOWN_PERCENTILE_LABELS, WELL_KNOWN_STATUS_LABELS } from "./series-colors";

// The same cases run through the Go validateDashboard path and the embedded dashboard JSON Schema
// (internal/insights/series_conformance_test.go). All three must agree on every case.
const fixtures = JSON.parse(
  readFileSync(new URL("../../../../docs/design/insights/conformance/colors.json", import.meta.url), "utf8"),
) as { modes: string[]; statusLabels: string[]; percentileLabels: string[]; cases: { name: string; valid: boolean; options: Record<string, unknown> }[] };

function widgetWithOptions(options: Record<string, unknown>) {
  return {
    id: "colors",
    title: "Colors",
    type: "timeseries",
    providerId: "prometheus",
    query: "up",
    unit: "",
    layout: { x: 0, y: 0, w: 6, h: 4 },
    options,
  };
}

describe("series colour mode conformance fixtures", () => {
  it("keeps the mode vocabulary identical to the published fixture", () => {
    expect([...SERIES_COLOR_MODES]).toEqual(fixtures.modes);
  });

  it("keeps the well-known labels the UI recognises identical to the published fixture", () => {
    expect([...WELL_KNOWN_STATUS_LABELS]).toEqual(fixtures.statusLabels);
    expect([...WELL_KNOWN_PERCENTILE_LABELS]).toEqual(fixtures.percentileLabels);
  });

  it("includes both valid and invalid cases", () => {
    expect(fixtures.cases.some((entry) => entry.valid)).toBe(true);
    expect(fixtures.cases.some((entry) => !entry.valid)).toBe(true);
  });

  for (const entry of fixtures.cases) {
    it(`${entry.valid ? "accepts" : "rejects"} ${entry.name}`, () => {
      const result = widgetSchema.safeParse(widgetWithOptions(entry.options));
      expect(result.success).toBe(entry.valid);
    });
  }
});

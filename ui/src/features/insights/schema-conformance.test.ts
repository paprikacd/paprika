// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { widgetSchema } from "./schema";
import { statusLevels } from "./status";

// The same fixtures run through the Go validateDashboard path and the embedded dashboard JSON Schema
// (internal/insights/schema_conformance_test.go). All three must agree on every case.
const fixtures = JSON.parse(
  readFileSync(new URL("../../../../docs/design/insights/conformance/thresholds.json", import.meta.url), "utf8"),
) as { cases: { name: string; valid: boolean; thresholds: unknown }[] };

const tokens = JSON.parse(
  readFileSync(new URL("../../../../docs/design/insights/status-tokens.json", import.meta.url), "utf8"),
) as { levels: string[] };

function widgetWithThresholds(thresholds: unknown) {
  return {
    id: "conformance",
    title: "Conformance",
    type: "timeseries",
    providerId: "prometheus",
    query: "up",
    unit: "",
    layout: { x: 0, y: 0, w: 6, h: 4 },
    options: { thresholds },
  };
}

describe("threshold conformance fixtures", () => {
  it("keeps the status vocabulary identical to the published token levels", () => {
    expect([...statusLevels]).toEqual(tokens.levels);
  });

  it("includes both valid and invalid cases", () => {
    expect(fixtures.cases.some((entry) => entry.valid)).toBe(true);
    expect(fixtures.cases.some((entry) => !entry.valid)).toBe(true);
  });

  for (const entry of fixtures.cases) {
    it(`${entry.valid ? "accepts" : "rejects"} ${entry.name}`, () => {
      const result = widgetSchema.safeParse(widgetWithThresholds(entry.thresholds));
      expect(result.success).toBe(entry.valid);
    });
  }
});

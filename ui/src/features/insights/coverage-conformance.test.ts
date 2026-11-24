// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dashboardSchema } from "./schema";

// The same fixtures run through validateDashboard in Go (internal/insights/coverage_conformance_test.go).
// Both must reach the same verdict.
const fixtures = JSON.parse(
  readFileSync(new URL("../../../../docs/design/insights/conformance/coverage.json", import.meta.url), "utf8"),
) as { cases: { name: string; valid: boolean; document: unknown }[] };

describe("covers conformance fixtures", () => {
  it("has cases", () => {
    expect(fixtures.cases.length).toBeGreaterThan(0);
  });
  for (const entry of fixtures.cases) {
    it(entry.name, () => {
      expect(dashboardSchema.safeParse(entry.document).success).toBe(entry.valid);
    });
  }
});

import { describe, expect, it } from "vitest";
import { formatMetric, formatReading, sharedScale } from "./units";

// A whole number with no unit stays whole only while nothing scales; once a compact prefix is chosen the decimals apply.
describe("compact whole numbers honour decimals once scaled", () => {
  it("keeps 18432 whole at decimals 0 when nothing scales", () => {
    expect(formatMetric(18432, "", false, 0)).toBe("18,432");
  });
  it("applies decimals to the K prefix instead of Auto's three figures", () => {
    expect(formatMetric(18432, "", true, 0)).toBe("18K");
    expect(formatMetric(18432, "", true, 3)).toBe("18.432K");
    expect(formatReading(18432, "", { compact: true, decimals: 2 }).value).toBe("18.43K");
  });
  it("gives the scaled shared-scale number the decimals too", () => {
    const scale = sharedScale([18432], "", { compact: true, decimals: 1 });
    expect(scale.number(18432)).toBe("18.4K");
  });
});

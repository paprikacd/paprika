import { describe, expect, it } from "vitest";
import { readTooltipPlacement } from "./tooltip-position";
import { widgetOptionsSchema } from "./schema";

const ranges = [
  ["tooltipOffset", 0, 40],
  ["tooltipMaxWidth", 220, 640],
  ["tooltipMaxHeight", 160, 800],
] as const;

describe("observation inspector placement options", () => {
  it("accepts every placement value", () => {
    for (const tooltipPlacement of ["auto", "top", "right", "bottom", "left"]) {
      expect(widgetOptionsSchema.safeParse({ tooltipPlacement }).success).toBe(true);
    }
  });

  it("accepts both bounds of each numeric setting, and values between them", () => {
    for (const [key, low, high] of ranges) {
      for (const value of [low, (low + high) / 2, high]) expect(widgetOptionsSchema.safeParse({ [key]: value }).success).toBe(true);
    }
  });

  it("rejects one step outside each numeric range, and non-numbers", () => {
    for (const [key, low, high] of ranges) {
      for (const value of [low - 1, high + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(widgetOptionsSchema.safeParse({ [key]: value }).success, `${key}=${value}`).toBe(false);
      }
      expect(widgetOptionsSchema.safeParse({ [key]: String(low) }).success, `${key} as text`).toBe(false);
    }
  });

  it("rejects placements outside the published set", () => {
    for (const tooltipPlacement of ["center", "TOP", "", null]) {
      expect(widgetOptionsSchema.safeParse({ tooltipPlacement }).success, String(tooltipPlacement)).toBe(false);
    }
  });

  it("hands the accepted settings to the placement reader unchanged", () => {
    const parsed = widgetOptionsSchema.parse({ tooltipPlacement: "top", tooltipOffset: 12, tooltipMaxWidth: 300, tooltipMaxHeight: 200 });
    expect(readTooltipPlacement(parsed)).toEqual({ placement: "top", offset: 12, maxWidth: 300, maxHeight: 200 });
  });
});

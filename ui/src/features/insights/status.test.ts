import { describe, expect, it } from "vitest";
import { statusLevels, statusToken, thresholdHex, thresholdInk, thresholdPaint } from "./status";

describe("threshold paint", () => {
  it("paints a status-only threshold with its theme mark", () => {
    expect(thresholdPaint({ status: "critical" })).toBe("var(--gamma-status-critical, #881418)");
    expect(thresholdInk({ status: "critical" })).toBe("var(--gamma-status-critical-on)");
  });

  it("keeps a legacy hex-only threshold exactly as authored", () => {
    expect(thresholdPaint({ color: "#20cba3" })).toBe("#20cba3");
    expect(thresholdHex({ color: "#20cba3" })).toBe("#20cba3");
  });

  it("lets a hex hue override replace the status mark", () => {
    expect(thresholdPaint({ status: "ok", color: "#20cba3" })).toBe("#20cba3");
  });

  it("returns nothing for a missing threshold", () => {
    expect(thresholdPaint(undefined)).toBeUndefined();
    expect(thresholdInk(undefined)).toBeUndefined();
    expect(thresholdHex(undefined)).toBeUndefined();
  });

  it("exposes a status token for every level and part", () => {
    expect(statusLevels).toEqual(["ok", "info", "warning", "critical", "unknown"]);
    for (const level of statusLevels) expect(statusToken(level, "-text")).toBe(`var(--gamma-status-${level}-text)`);
  });
});

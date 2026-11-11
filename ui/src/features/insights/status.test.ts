import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STATUS_HEX, statusLevels, statusToken, thresholdHex, thresholdInk, thresholdPaint, thresholdText } from "./status";

describe("threshold paint", () => {
  it("paints a status-only threshold with its theme mark", () => {
    expect(thresholdPaint({ status: "critical" })).toBe("var(--gamma-status-critical, #7f0a12)");
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

describe("status hex mirror", () => {
  const mirror = JSON.parse(readFileSync("../docs/design/insights/status-tokens.json", "utf8")) as { blocks: Record<string, Record<string, string>> };
  it("keeps the per-theme hex table identical to status-tokens.json", () => {
    for (const theme of ["light", "dark", "compact"] as const) expect(STATUS_HEX[theme]).toEqual(mirror.blocks[theme]);
  });
  it.each(statusLevels)("keeps the %s light fallback, thresholdHex and the light mark equal", (level) => {
    const expected = mirror.blocks.light[`--gamma-status-${level}`];
    expect(statusToken(level)).toBe(`var(--gamma-status-${level}, ${expected})`);
    expect(thresholdHex({ status: level }, "light")).toBe(expected);
  });
  it("swatches the requested appearance for a status-only threshold", () => {
    expect(thresholdHex({ status: "critical" }, "dark")).toBe(mirror.blocks.dark["--gamma-status-critical"]);
    expect(thresholdHex({ status: "critical" }, "compact")).toBe(mirror.blocks.compact["--gamma-status-critical"]);
  });
  it("uses the text token for text and keeps a hex override as authored", () => {
    expect(thresholdText({ status: "warning" })).toBe("var(--gamma-status-warning-text)");
    expect(thresholdText({ status: "ok", color: "#20cba3" })).toBe("#20cba3");
  });
});

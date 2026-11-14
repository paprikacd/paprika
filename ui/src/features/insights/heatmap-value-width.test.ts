import { describe, expect, it } from "vitest";
import { heatmapValueEm, heatmapValueGlyphs } from "./heatmap-value-width";

// Widths measured in Chromium with the heatmap's own font (Barlow 570, tabular figures) at 10px, as the box width in px.
const MEASURED_AT_10PX: Array<[text: string, width: number]> = [
  ["0.00", 18.875],
  ["0 Hz", 18.3125],
  ["100 B", 24.375],
  ["43 GB", 25.125],
  ["0.5 MB", 28.875],
  ["-13 Hz", 27.734375],
  ["99.12%", 32.59375],
  ["42.57 req/s", 49.953125],
  ["-12.50 req/s", 54],
  ["98,765 req/s", 55.25],
  ["100.00 kWh", 51.078125],
  ["100.00 dBm", 51.734375],
  ["1,234.57 mm", 56.25],
];

describe("heatmapValueEm", () => {
  it("gives every figure the same width, as tabular figures do", () => {
    expect(heatmapValueEm("0123456789")).toBeCloseTo(10 * heatmapValueEm("0"), 9);
    expect(heatmapValueEm("1111")).toBeCloseTo(heatmapValueEm("8888"), 9);
  });

  it("is never below the width the browser measures, so a value sized from it cannot overflow", () => {
    for (const [text, width] of MEASURED_AT_10PX) {
      expect(heatmapValueEm(text) * 10, text).toBeGreaterThanOrEqual(width);
    }
  });

  it("follows the glyphs rather than the character count, so a wide unit costs more than a narrow one", () => {
    // Both are four characters; "%" and "m" are wider than the half em per character the old length rule assumed.
    expect(heatmapValueEm("99.1%")).toBeGreaterThan(heatmapValueEm("99.1 "));
    expect(heatmapValueEm("1 mm")).toBeGreaterThan(heatmapValueEm("1 ms"));
  });

  it("charges an unknown character 1.35em, so authored CJK and emoji units fit the browser's width", () => {
    // "-12.5 🚀" measured 59.9px at 16.03px in Chromium on macOS, which is 3.74em.
    expect(heatmapValueEm("-12.5 🚀")).toBeGreaterThanOrEqual(3.74);
    // A CJK unit is about 1em in the fallback font.
    expect(heatmapValueEm("12 件/秒")).toBeGreaterThanOrEqual(heatmapValueEm("12 ") + 2 * 1);
    expect(heatmapValueEm("")).toBe(1);
  });
});

describe("heatmapValueGlyphs", () => {
  it("counts code points, so an emoji or CJK character is one glyph", () => {
    expect(heatmapValueGlyphs("42.57 req/s")).toBe(11);
    expect(heatmapValueGlyphs("🚀")).toBe(1);
    expect(heatmapValueGlyphs("件")).toBe(1);
  });
});

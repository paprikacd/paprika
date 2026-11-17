import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  readableTextColor,
  widgetTextColor,
} from "./appearance";

describe("widget appearance contrast", () => {
  it("uses WCAG relative luminance for black, white and the Gamma muted token", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21);
    expect(contrastRatio("#626e65", "#626e65")).toBeCloseTo(1);
    for (const surface of ["#ffffff", "#fafaf7", "#f1f2ed"])
      expect(contrastRatio("#626e65", surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps default labels legible on dark and light custom backgrounds", () => {
    expect(readableTextColor("#102030")).toBe("#ffffff");
    expect(readableTextColor("#fafaf7")).toBe("#27332e");
    expect(
      contrastRatio(readableTextColor("#808080"), "#808080"),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(readableTextColor("#102030"), "#102030"),
    ).toBeGreaterThan(4.5);
  });

  it("never rewrites an explicit color choice and leaves the uncustomized theme in control", () => {
    expect(widgetTextColor()).toBeUndefined();
    expect(widgetTextColor({ background: "#102030" })).toBe("#ffffff");
    expect(
      widgetTextColor({ background: "#102030", textColor: "#102030" }),
    ).toBe("#102030");
  });
});

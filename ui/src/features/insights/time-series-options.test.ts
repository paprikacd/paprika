import { describe, expect, it } from "vitest";
import { widgetSchema } from "./schema";

const base = { id: "latency", title: "API latency", type: "timeseries", providerId: "prom", query: "latency", unit: "ms", layout: { x: 0, y: 0, w: 6, h: 4 } };
const accepts = (options: Record<string, unknown>) => widgetSchema.safeParse({ ...base, options }).success;

describe("time-series rendering options in the widget contract", () => {
  it("accepts each option in its published form", () => {
    expect(accepts({ gridX: true, showZeroLine: false })).toBe(true);
    expect(accepts({ timeAxis: "calendar" })).toBe(true);
    expect(accepts({ timeAxis: "linear" })).toBe(true);
    expect(accepts({ axisUnit: "ticks" })).toBe(true);
    expect(accepts({ axisUnit: "caption" })).toBe(true);
    expect(accepts({ referenceLines: [{ value: 5, label: "Target", color: "#c08a2b" }, { value: -1 }] })).toBe(true);
    expect(accepts({ plotInsetLeft: 8, plotInsetRight: 120 })).toBe(true);
    expect(accepts({ plotInsetLeft: 240 })).toBe(true);
  });

  it("refuses values outside the published forms and ranges", () => {
    expect(accepts({ gridX: "yes" })).toBe(false);
    expect(accepts({ showZeroLine: 1 })).toBe(false);
    expect(accepts({ timeAxis: "monthly" })).toBe(false);
    expect(accepts({ axisUnit: "inline" })).toBe(false);
    expect(accepts({ plotInsetLeft: 7 })).toBe(false);
    expect(accepts({ plotInsetLeft: 241 })).toBe(false);
    expect(accepts({ plotInsetRight: 121 })).toBe(false);
  });

  it("limits reference lines to eight entries with a finite value, a bounded label and a hex colour", () => {
    expect(accepts({ referenceLines: Array.from({ length: 8 }, (_, index) => ({ value: index })) })).toBe(true);
    expect(accepts({ referenceLines: Array.from({ length: 9 }, (_, index) => ({ value: index })) })).toBe(false);
    expect(accepts({ referenceLines: [{ label: "No value" }] })).toBe(false);
    expect(accepts({ referenceLines: [{ value: Number.POSITIVE_INFINITY }] })).toBe(false);
    expect(accepts({ referenceLines: [{ value: 1, label: "" }] })).toBe(false);
    expect(accepts({ referenceLines: [{ value: 1, label: "x".repeat(81) }] })).toBe(false);
    expect(accepts({ referenceLines: [{ value: 1, color: "red" }] })).toBe(false);
    expect(accepts({ referenceLines: [{ value: 1, style: "dashed" }] })).toBe(false);
  });
});

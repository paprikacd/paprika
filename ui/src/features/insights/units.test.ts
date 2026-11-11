import { describe, expect, it } from "vitest";
import { autoAxisDomain, axisScale, formatMetric, formatReading, niceDomain, symmetricDomain } from "./units";

describe("auto precision", () => {
  it.each([
    [100, "%", "100%"],
    [99.97, "%", "100%"],
    [0.04, "%", "0.0400%"],
    [17.58, "req/s", "17.6 req/s"],
    [24.93, "req/s", "24.9 req/s"],
    [812.06, "ms", "812 ms"],
    [1.5, "x", "1.50 x"],
    [0.158, "", "0.158"],
    [0.0412, "", "0.0412"],
    [18423, "", "18,423"],
    [100814.88, "", "100,815"],
    [100814.88, "obs/s", "101K obs/s"],
    [1070.4, "req/s", "1.07K req/s"],
    [5, "", "5.00"],
  ])("formats %s %s as %s", (value, unit, expected) => {
    expect(formatMetric(value, unit)).toBe(expected);
  });

  it("keeps the authored unit for percent, multipliers and unknown units", () => {
    expect(formatMetric(40, "%")).toBe("40.0%");
    expect(formatMetric(2.5, "×")).toBe("2.50 ×");
    expect(formatMetric(123456.78, "requests")).toBe("123,457 requests");
    expect(formatMetric(123456.78, "MB/s")).toBe("123,457 MB/s");
  });
});

describe("duration scaling", () => {
  it.each([
    [999.5, "ms", "1.00 s"],
    [1000, "ms", "1.00 s"],
    [999.4, "ms", "999 ms"],
    [1234.5678, "ms", "1.23 s"],
    [12.345678, "ms", "12.3 ms"],
    [0.5, "ms", "500 us"],
    [0.5, "s", "500 ms"],
    [0.0005, "s", "500 us"],
    [0.5, "us", "0.500 us"],
    [999.5, "us", "1.00 ms"],
    [0, "ms", "0 ms"],
  ])("formats %s %s as %s", (value, unit, expected) => {
    expect(formatMetric(value, unit)).toBe(expected);
  });

  it("returns the scaled unit separately for readings", () => {
    expect(formatReading(999.5, "ms")).toEqual({ value: "1.00", unit: "s" });
    expect(formatReading(812.06, "ms")).toEqual({ value: "812", unit: "ms" });
  });
});

describe("byte scaling (IEC)", () => {
  it.each([
    [1000, "B", "1,000 B"],
    [1500, "B", "1.46 KiB"],
    [1023.9, "B", "1.00 KiB"],
    [1536 * 1024, "B", "1.50 MiB"],
    [5 * 1024 ** 3, "B", "5.00 GiB"],
    [2048, "KiB", "2.00 MiB"],
    [1024, "bytes", "1.00 KiB"],
    [0.5, "B", "0.500 B"],
  ])("formats %s %s as %s", (value, unit, expected) => {
    expect(formatMetric(value, unit)).toBe(expected);
  });
});

describe("bit-rate scaling (SI)", () => {
  it.each([
    [992.15, "Mb/s", "992 Mb/s"],
    [1250, "Mb/s", "1.25 Gb/s"],
    [1_250_000, "bit/s", "1.25 Mbit/s"],
    [500, "bit/s", "500 bit/s"],
    [0.5, "Mb/s", "500 kb/s"],
    [999.5, "kbit/s", "1.00 Mbit/s"],
  ])("formats %s %s as %s", (value, unit, expected) => {
    expect(formatMetric(value, unit)).toBe(expected);
  });
});

describe("per-second rates", () => {
  it.each([
    [18423, "obs/s", "18.4K obs/s"],
    [999.5, "req/s", "1.00K req/s"],
    [0.5, "req/s", "0.500 req/s"],
    [2_500_000, "req/s", "2.50M req/s"],
    [3, "/s", "3.00 /s"],
  ])("formats %s %s as %s", (value, unit, expected) => {
    expect(formatMetric(value, unit)).toBe(expected);
  });
});

describe("authored decimals", () => {
  it("honours decimals exactly, without scaling or precision loss", () => {
    expect(formatMetric(124820, "obs/s", false, 2)).toBe("124,820.00 obs/s");
    expect(formatMetric(1234.5678, "ms", false, 2)).toBe("1,234.57 ms");
    expect(formatMetric(0.5, "%", false, 0)).toBe("1%");
    expect(formatMetric(1, "req/s", false, 4)).toBe("1.0000 req/s");
  });

  it("treats decimals as fixed even when a value would round below them", () => {
    expect(formatMetric(0.001, "", false, 4)).toBe("0.0010");
  });

  it("clamps and floors invalid decimals", () => {
    expect(formatMetric(12.345, "", false, -1)).toBe("12");
    expect(formatMetric(12.345, "", false, 2.9)).toBe("12.35");
    expect(formatMetric(12.345, "", false, 99)).toBe(formatMetric(12.345, "", false, 8));
  });

  it("uses compact fixed notation for compact decimals", () => {
    expect(formatMetric(1500, "", true, 1)).toBe("1.5K");
  });
});

describe("zero, negatives, non-finite and extreme values", () => {
  it("prints zero without a sign and negatives with a hyphen", () => {
    expect(formatMetric(0, "%")).toBe("0%");
    expect(formatMetric(-0, "ms")).toBe("0 ms");
    expect(formatMetric(-992.15, "Mb/s")).toBe("-992 Mb/s");
    expect(formatMetric(-1234.5, "ms")).toBe("-1.23 s");
  });

  it("returns an em dash for non-finite values", () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(formatMetric(value, "ms")).toBe("—");
      expect(formatReading(value, "ms")).toEqual({ value: "—", unit: "ms" });
    }
  });

  it("uses exponential notation for very small and very large magnitudes", () => {
    expect(formatMetric(0.00001, "")).toBe("0.0000100");
    expect(formatMetric(0.0000001, "")).toBe("1.00e-7");
    expect(formatMetric(1e-13, "s")).toBe("1.00e-7 us");
    expect(formatMetric(2e21, "")).toBe("2.00e+21");
  });

  it("keeps large plain counts whole when not compact", () => {
    expect(formatMetric(123456789, "")).toBe("123,456,789");
  });

  it("abbreviates plain counts only when compact", () => {
    expect(formatMetric(1234, "requests", true)).toBe("1.23K requests");
    expect(formatMetric(1_000_000, "", true)).toBe("1.00M");
  });
});

describe("axis labels", () => {
  it("uses the tick step for precision", () => {
    const axis = axisScale([0, 1], "");
    expect(axis.ticks.map(tick => axis.label(tick, false))).toEqual(["0.0", "0.2", "0.4", "0.6", "0.8", "1.0"]);
  });

  it("does not add decimals to integer steps", () => {
    const axis = axisScale([0, 50], "req/s", { count: 5 });
    expect(axis.ticks.map(tick => axis.label(tick))).toEqual(["0 req/s", "10 req/s", "20 req/s", "30 req/s", "40 req/s", "50 req/s"]);
  });

  it("shares one scaled unit across the axis and labels every tick in it", () => {
    const axis = axisScale([0, 1000], "ms", { count: 4 });
    expect(axis.unit).toBe("s");
    expect(axis.ticks.map(tick => axis.label(tick, false))).toEqual(["0.0", "0.2", "0.4", "0.6", "0.8", "1.0"]);
  });

  it("scales rate axes with a count prefix", () => {
    const axis = axisScale([0, 200000], "obs/s", { count: 4 });
    expect(axis.unit).toBe("obs/s");
    expect(axis.ticks.map(tick => axis.label(tick))).toEqual(["0K obs/s", "50K obs/s", "100K obs/s", "150K obs/s", "200K obs/s"]);
  });

  it("labels custom evenly spaced ticks without collisions", () => {
    const axis = axisScale([0, 1], "", { ticks: [0, 0.25, 0.5, 0.75, 1] });
    expect(axis.ticks.map(tick => axis.label(tick, false))).toEqual(["0.00", "0.25", "0.50", "0.75", "1.00"]);
  });

  it("gives colliding labels more digits instead of duplicating them", () => {
    const axis = axisScale([0, 0.0003], "", { ticks: [0, 0.0001, 0.0002, 0.0003] });
    const labels = axis.ticks.map(tick => axis.label(tick, false));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("uses the authored decimals on every tick and keeps the unit as authored", () => {
    const axis = axisScale([0, 1000], "ms", { count: 4, decimals: 1 });
    expect(axis.unit).toBe("ms");
    expect(axis.label(250)).toBe("250.0 ms");
  });

  it("omits the unit when asked for a captioned axis", () => {
    const axis = axisScale([0, 4], "req/s", { count: 4 });
    expect(axis.label(2, false)).toBe("2");
  });
});

describe("domains", () => {
  it("rounds outward to nice bounds", () => {
    expect(niceDomain([-37.2, 58.9], 5)).toEqual([-40, 60]);
  });

  it("keeps a symmetric domain around zero", () => {
    expect(symmetricDomain(-992.15, 500, 4)).toEqual([-1000, 1000]);
  });

  it("does not round an invalid or degenerate domain", () => {
    expect(niceDomain([5, 5], 5)).toEqual([5, 5]);
    expect(niceDomain([NaN, 5], 5)).toEqual([NaN, 5]);
  });

  it("derives an automatic domain from the values and zero when requested", () => {
    expect(autoAxisDomain([40, 50], 5, true)).toEqual([0, 50]);
    expect(autoAxisDomain([40, 50], 5, false)).toEqual([40, 50]);
    expect(autoAxisDomain([], 5, true)).toEqual([0, 1]);
  });
});

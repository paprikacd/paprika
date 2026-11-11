import { describe, expect, it } from "vitest";
import { autoAxisDomain, axisScale, formatMetric, formatRange, formatReading, formatRecordValue, niceDomain, symmetricDomain } from "./units";

describe("auto precision", () => {
  it.each([
    [100, "%", "100%"],
    [99.97, "%", "99.97%"],
    [0.04, "%", "0.04%"],
    [17.58, "req/s", "17.6 req/s"],
    [24.93, "req/s", "24.9 req/s"],
    [812.06, "ms", "812 ms"],
    [1.5, "x", "1.5 x"],
    [0.158, "", "0.158"],
    [0.0412, "", "0.0412"],
    [18423, "", "18,423"],
    [100814.88, "", "100,815"],
    [100814.88, "obs/s", "101K obs/s"],
    [1070.4, "req/s", "1.07K req/s"],
    [5, "", "5"],
  ])("formats %s %s as %s", (value, unit, expected) => {
    expect(formatMetric(value, unit)).toBe(expected);
  });

  it("keeps the authored unit for percent, multipliers and unknown units", () => {
    expect(formatMetric(40, "%")).toBe("40%");
    expect(formatMetric(2.5, "×")).toBe("2.5 ×");
    expect(formatMetric(123456.78, "requests")).toBe("123,457 requests");
    expect(formatMetric(123456.78, "MB/s")).toBe("123,457 MB/s");
  });
});

describe("trimmed three-figure rounding", () => {
  it.each([
    [999.5, "ms", "1 s"],
    [812.06, "ms", "812 ms"],
    [1069, "req/s", "1.07K req/s"],
    [100, "%", "100%"],
    [100.0, "%", "100%"],
    [0.995, "", "0.995"],
    [1.005, "", "1.01"],
    [0.0042, "", "0.0042"],
    [17.58, "", "17.6"],
    [12.345, "", "12.3"],
    [1.2345, "", "1.23"],
    [99.97, "", "100"],
    [0.04, "%", "0.04%"],
    [1999.5, "B", "1.95 KiB"],
    [1000, "B", "1,000 B"],
    [18423, "obs/s", "18.4K obs/s"],
    [18423, "", "18,423"],
  ])("trims %s %s to %s", (value, unit, expected) => {
    expect(formatMetric(value, unit)).toBe(expected);
  });

  it("rounds negatives symmetrically", () => {
    expect(formatMetric(-1.005, "")).toBe("-1.01");
    expect(formatMetric(-0.995, "")).toBe("-0.995");
    expect(formatMetric(-999.5, "ms")).toBe("-1 s");
    expect(formatMetric(-1999.5, "B")).toBe("-1.95 KiB");
    expect(formatMetric(-0.0042, "")).toBe("-0.0042");
  });
});

describe("duration scaling", () => {
  it.each([
    [999.5, "ms", "1 s"],
    [1000, "ms", "1 s"],
    [999.4, "ms", "999 ms"],
    [1234.5678, "ms", "1.23 s"],
    [12.345678, "ms", "12.3 ms"],
    [0.5, "ms", "500 us"],
    [0.5, "s", "500 ms"],
    [0.0005, "s", "500 us"],
    [0.5, "us", "500 ns"],
    [999.5, "us", "1 ms"],
    [0, "ms", "0 ms"],
  ])("formats %s %s as %s", (value, unit, expected) => {
    expect(formatMetric(value, unit)).toBe(expected);
  });

  it("returns the scaled unit separately for readings", () => {
    expect(formatReading(999.5, "ms")).toEqual({ value: "1", unit: "s" });
    expect(formatReading(812.06, "ms")).toEqual({ value: "812", unit: "ms" });
  });
});

describe("byte scaling (IEC)", () => {
  it.each([
    [1000, "B", "1,000 B"],
    [1500, "B", "1.46 KiB"],
    [1023.9, "B", "1 KiB"],
    [1536 * 1024, "B", "1.5 MiB"],
    [5 * 1024 ** 3, "B", "5 GiB"],
    [2048, "KiB", "2 MiB"],
    [1024, "bytes", "1 KiB"],
    [0.5, "B", "0.5 B"],
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
    [999.5, "kbit/s", "1 Mbit/s"],
  ])("formats %s %s as %s", (value, unit, expected) => {
    expect(formatMetric(value, unit)).toBe(expected);
  });
});

describe("per-second rates", () => {
  it.each([
    [18423, "obs/s", "18.4K obs/s"],
    [999.5, "req/s", "1K req/s"],
    [0.5, "req/s", "0.5 req/s"],
    [2_500_000, "req/s", "2.5M req/s"],
    [3, "/s", "3 /s"],
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
    expect(formatMetric(0.00001, "")).toBe("0.00001");
    expect(formatMetric(0.0000001, "")).toBe("1e-7");
    expect(formatMetric(1e-13, "s")).toBe("0.0001 ns");
    expect(formatMetric(2e21, "")).toBe("2e+21");
  });

  it("keeps large plain counts whole when not compact", () => {
    expect(formatMetric(123456789, "")).toBe("123,456,789");
  });

  it("abbreviates plain counts only when compact", () => {
    expect(formatMetric(1234, "requests", true)).toBe("1.23K requests");
    expect(formatMetric(1_000_000, "", true)).toBe("1M");
  });
});

describe("axis labels", () => {
  it("uses the tick step for precision", () => {
    const axis = axisScale([0, 1], "");
    expect(axis.ticks.map(tick => axis.label(tick, false))).toEqual(["0.00", "0.25", "0.50", "0.75", "1.00"]);
  });

  it("does not add decimals to integer steps", () => {
    const axis = axisScale([0, 50], "req/s", { count: 5 });
    expect(axis.ticks.map(tick => axis.label(tick))).toEqual(["0 req/s", "10 req/s", "20 req/s", "30 req/s", "40 req/s", "50 req/s"]);
  });

  it("shares one scaled unit across the axis and labels every tick in it", () => {
    const axis = axisScale([0, 1000], "ms", { count: 4 });
    expect(axis.unit).toBe("s");
    expect(axis.ticks.map(tick => axis.label(tick, false))).toEqual(["0.00", "0.25", "0.50", "0.75", "1.00"]);
  });

  it("scales rate axes with a count prefix", () => {
    const axis = axisScale([0, 200000], "obs/s", { count: 4 });
    expect(axis.unit).toBe("obs/s");
    expect(axis.ticks.map(tick => axis.label(tick))).toEqual(["0 obs/s", "50K obs/s", "100K obs/s", "150K obs/s", "200K obs/s"]);
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

describe("large integers are never rounded", () => {
  it.each([
    [500_000_000, "500,000,000"],
    [1_000_000_000, "1,000,000,000"],
    [2 ** 31, "2,147,483,648"],
    [1e14, "100,000,000,000,000"],
    [9.99e14, "999,000,000,000,000"],
  ])("keeps %s whole", (value, expected) => {
    expect(formatMetric(value, "")).toBe(expected);
    expect(formatMetric(value, "requests")).toBe(`${expected} requests`);
    expect(formatRecordValue(value, "")).toBe(expected);
  });
});

describe("percent", () => {
  it.each([
    [99.97, "99.97%"],
    [99.5, "99.5%"],
    [100, "100%"],
    [100.4, "100.4%"],
    [0.04, "0.04%"],
    [99.996, "99.996%"],
    [99.999, "99.999%"],
    [99.99999, "99.99999%"],
  ])("never reads 100 unless the value is 100: %s -> %s", (value, expected) => {
    expect(formatMetric(value, "%")).toBe(expected);
  });
});

describe("threshold crossing", () => {
  it("adds precision so 99.86 never reads 99.9 against a 99.9 threshold", () => {
    expect(formatMetric(99.86, "ms")).toBe("99.9 ms");
    expect(formatReading(99.86, "ms", { keepSides: [99.9] })).toEqual({ value: "99.86", unit: "ms" });
    expect(formatReading(99.86, "%", { keepSides: [99.9] })).toEqual({ value: "99.86", unit: "%" });
  });

  it("keeps a value above a threshold on its side too", () => {
    expect(formatReading(100.04, "ms", { keepSides: [100.04] }).value).toBe("100.04");
    expect(formatReading(100.04, "ms", { keepSides: [100] }).value).toBe("100");
  });
});

describe("authored unit text", () => {
  it.each([
    [1500, "kB/s", "1,500 kB/s"],
    [1500, "kiB/s", "1,500 kiB/s"],
    [1500, "ms/s", "1,500 ms/s"],
    [1500, "m/s", "1,500 m/s"],
    [1500, "MB/s", "1,500 MB/s"],
  ])("does not add a count prefix to unknown %s", (value, unit, expected) => {
    expect(formatMetric(value, unit)).toBe(expected);
  });

  it("keeps the authored text when nothing is scaled", () => {
    expect(formatReading(5, "µs")).toEqual({ value: "5", unit: "µs" });
    expect(formatReading(5, "μs")).toEqual({ value: "5", unit: "μs" });
    expect(formatReading(100, "bytes")).toEqual({ value: "100", unit: "bytes" });
    expect(formatReading(500, "Kb/s")).toEqual({ value: "500", unit: "Kb/s" });
  });

  it("recognises micro in both spellings and nanoseconds as a duration", () => {
    expect(formatMetric(1500, "µs")).toBe("1.5 ms");
    expect(formatMetric(1500, "μs")).toBe("1.5 ms");
    expect(formatMetric(1500, "ns")).toBe("1.5 us");
    expect(formatMetric(0.5, "ns")).toBe("0.5 ns");
  });
});

describe("zero ticks and near-zero ticks", () => {
  it("never reads a zero tick with a prefix, or a near-zero tick as -0", () => {
    const counts = axisScale([0, 1_500_000_000_000_000], "", { compact: true, count: 3 });
    expect(counts.ticks.map(tick => counts.label(tick, false))[0]).toBe("0");
    const near = axisScale([-0.1, 0.3], "", { ticks: [-0.1, -1.3877787807814457e-17, 0.09999999999999999, 0.19999999999999998, 0.3] });
    expect(near.ticks.map(tick => near.label(tick, false))).toEqual(["-0.1", "0.0", "0.1", "0.2", "0.3"]);
  });
});

describe("byte axes", () => {
  it("chooses the display unit first and generates nice ticks in it", () => {
    const axis = axisScale([0, 2048], "B", { count: 4 });
    expect(axis.unit).toBe("KiB");
    const labels = axis.ticks.map(tick => axis.label(tick));
    expect(labels).toEqual(["0.0 KiB", "0.5 KiB", "1.0 KiB", "1.5 KiB", "2.0 KiB"]);
    expect(Math.max(...labels.map(label => label.length))).toBeLessThan(10);
  });
});

describe("flat series", () => {
  it.each([[0.04, "%"], [1.5, "x"], [-0.04, ""]])("labels a constant %s with distinct ticks", (value, unit) => {
    const domain = autoAxisDomain([value, value], 5, false);
    expect(domain[0]).toBeLessThan(value < 0 ? value : value);
    expect(Math.min(...domain)).toBeLessThan(Math.max(...domain));
    const axis = axisScale(domain, unit, { count: 5 });
    const labels = axis.ticks.map(tick => axis.label(tick, false));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("pads a constant five per cent either side", () => {
    expect(autoAxisDomain([100, 100], 5, false)).toEqual([95, 105]);
  });
});

describe("range labels", () => {
  it("shares one scale and carries the unit on both bounds", () => {
    expect(formatRange(0.1, 250, "ms")).toBe("0.1 ms–250 ms");
    expect(formatRange(10, 100, "ms")).toBe("10 ms–100 ms");
    expect(formatRange(1500, 2000, "ms")).toBe("1.5 s–2 s");
    expect(formatRange(0.5, 1500, "ms")).toBe("0.0005 s–1.5 s");
  });
});

describe("rounding at scale boundaries", () => {
  it("rounds before choosing a scaled unit", () => {
    expect(formatMetric(999.5, "us")).toBe("1 ms");
    expect(formatMetric(1999.5, "B")).toBe("1.95 KiB");
  });
});

describe("half-way rounding and negatives", () => {
  it.each([
    [0.995, "", "0.995"],
    [1.005, "", "1.01"],
    [-1.005, "", "-1.01"],
    [-0.995, "", "-0.995"],
    [-999.5, "ms", "-1 s"],
  ])("rounds %s %s to %s", (value, unit, expected) => {
    expect(formatMetric(value, unit)).toBe(expected);
  });
});

describe("a guard that needs extra digits keeps the authored unit", () => {
  it("reads 999.5 ms, not 0.9995 s, against a 999.9 ms objective", () => {
    expect(formatReading(999.5, "ms", { keepSides: [999.9] })).toEqual({ value: "999.5", unit: "ms" });
    expect(formatReading(999.5, "ms")).toEqual({ value: "1", unit: "s" });
  });
});

describe("percent ranges and exponent guards", () => {
  it("applies the percent rule to range bounds", () => {
    expect(formatRange(99.9996, 100, "%")).toBe("99.9996%–100%");
  });

  it("keeps a guard in the exponent form, showing the full value when three figures would cross it", () => {
    expect(formatReading(1.2345e-7, "", { keepSides: [1.234e-7] }).value).toBe("1.2345e-7");
    expect(formatReading(1.2345e-7, "", { keepSides: [1.2e-7] }).value).toBe("1.23e-7");
  });

  it("shows 99.995% for a value that would otherwise round to 100", () => {
    expect(formatMetric(99.995, "%")).toBe("99.995%");
  });
});

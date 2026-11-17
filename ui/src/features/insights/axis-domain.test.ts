import { describe, expect, it } from "vitest";
import { autoAxisDomain, axisScale, formatMetric, formatRange, formatReading, formatRecordValue, niceAxis, niceDomain, ticksWithin } from "./units";

/** Deterministic sweep of extents, from tiny to large, with the offsets a chart produces (zero, negative, mixed). */
function sweep(): Array<[number, number]> {
  const domains: Array<[number, number]> = [];
  for (let hi = 0.9; hi <= 2000; hi = hi * 1.37 + 0.3)
    for (const lo of [0, -hi / 3, hi / 4, -hi * 1.7])
      domains.push([lo, hi]);
  return domains;
}

describe("every tick lies within the drawn domain", () => {
  it.each([3, 4, 5])("ticksWithin keeps ticks inside the domain for count %i", count => {
    for (const domain of sweep()) {
      const drawn = niceDomain(domain, count);
      for (const tick of ticksWithin(drawn, count)) {
        expect(tick).toBeGreaterThanOrEqual(drawn[0] - 1e-9 * Math.abs(drawn[1]));
        expect(tick).toBeLessThanOrEqual(drawn[1] + 1e-9 * Math.abs(drawn[1]));
      }
    }
  });

  it("the stacked plot's 6.5 maximum never draws a tick above its plot", () => {
    const drawn = niceDomain([0, 6.5], 4);
    expect(ticksWithin(drawn, 4).every(tick => tick <= drawn[1])).toBe(true);
    expect(ticksWithin(drawn, 4)).not.toContain(8);
  });

  it("a record extent of -0.82..4.1 draws no tick below its clipped domain", () => {
    const drawn = niceDomain([-0.82, 4.1], 5);
    expect(ticksWithin(drawn, 5).every(tick => tick >= drawn[0])).toBe(true);
  });

  it("axis labels for a fixed domain never leave it either", () => {
    for (const domain of sweep()) {
      const axis = axisScale(niceDomain(domain, 4), "", { count: 4, fixedDomain: true });
      expect(axis.ticks.every(tick => tick >= axis.domain[0] - 1e-9 * Math.abs(axis.domain[1]) && tick <= axis.domain[1] + 1e-9 * Math.abs(axis.domain[1]))).toBe(true);
    }
  });
});

describe("niceAxis is idempotent", () => {
  it.each([3, 4, 5])("re-rounding a nice domain changes nothing (count %i)", count => {
    for (const domain of sweep()) {
      const once = niceAxis(domain, count).domain;
      expect(niceAxis(once, count).domain).toEqual(once);
    }
  });

  it("[0, 5] stays [0, 5] for four ticks, rather than growing to [0, 6]", () => {
    expect(niceAxis([0, 5], 4).domain).toEqual([0, 5]);
    expect(niceAxis(niceAxis([0, 5], 4).domain, 4).domain).toEqual([0, 5]);
  });
});

describe("tiny values never ask Intl for more than its digit limit", () => {
  it.each([1e-120, 1e-320, 5e-324])("formats %s as a percentage without throwing", value => {
    expect(() => formatMetric(value, "%")).not.toThrow();
    expect(() => formatReading(value, "%", { keepSides: [0.5] })).not.toThrow();
    expect(() => formatRecordValue(value, "%")).not.toThrow();
    expect(() => formatRange(value, 1, "%")).not.toThrow();
  });

  it.each([1e-120, 1e-320, 5e-324])("formats %s as a reading and a record without throwing", value => {
    expect(() => formatMetric(value, "ms")).not.toThrow();
    expect(() => formatRecordValue(value, "")).not.toThrow();
    // Below the digit limit a record shows its exponent rather than a misleading zero.
    expect(formatRecordValue(value, "")).toBe(`${value.toExponential()}`);
  });

  it("never prints -0 in a record, and shows a tiny negative exactly", () => {
    expect(formatRecordValue(-3e-22, "")).toBe("-3e-22");
    expect(formatRecordValue(-0, "")).toBe("0");
    expect(formatRecordValue(1.5e-21, "")).toBe("1.5e-21");
    expect(formatRecordValue(0, "")).toBe("0");
  });

  it("shows a tiny reading in exponent form, which is exact enough", () => {
    expect(formatMetric(1e-120, "")).toBe("1e-120");
  });
});

describe("extreme magnitudes stay finite", () => {
  it("draws a 0 to 1.7e308 byte axis with finite bounds and ticks", () => {
    const axis = axisScale([0, Number.MAX_VALUE], "B", { count: 3 });
    expect(Number.isFinite(axis.domain[0]) && Number.isFinite(axis.domain[1])).toBe(true);
    expect(axis.ticks.every(Number.isFinite)).toBe(true);
    expect(axis.label(axis.ticks.at(-1) ?? 0)).not.toContain("∞");
  });

  it("pads a flat ±MAX series to a finite domain", () => {
    const [low, high] = autoAxisDomain([Number.MAX_VALUE, Number.MAX_VALUE], 3, false);
    expect(Number.isFinite(low) && Number.isFinite(high)).toBe(true);
    expect(low).toBeLessThan(high);
    const [negLow, negHigh] = autoAxisDomain([-Number.MAX_VALUE, -Number.MAX_VALUE], 3, false);
    expect(Number.isFinite(negLow) && Number.isFinite(negHigh)).toBe(true);
    expect(ticksWithin([low, high], 3).every(Number.isFinite)).toBe(true);
  });

  it("gives ±MAX a finite tick set", () => {
    const ticks = ticksWithin([-Number.MAX_VALUE, Number.MAX_VALUE], 5);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.every(Number.isFinite)).toBe(true);
  });
});

describe("gridline count", () => {
  it("never draws more gridlines than a count-3 axis asks for, plus one", () => {
    for (const domain of sweep()) {
      const drawn = niceDomain(domain, 3);
      expect(ticksWithin(drawn, 3).length).toBeLessThanOrEqual(4);
    }
  });
});

describe("fewer headroom on short tiles and at three ticks", () => {
  it("keeps the 40–100.5 % line inside about 110 %, not 150 %", () => {
    const [, high] = autoAxisDomain([40, 100.5], 3, false);
    expect(high).toBeLessThanOrEqual(110);
  });

  it("keeps stacked shares of 100.2 % inside about 125 %", () => {
    const [, high] = autoAxisDomain([0, 100.2], 3, true);
    expect(high).toBeLessThanOrEqual(125);
  });

  it("keeps a 1 GiB limit over 0.40–0.85 GiB inside about 1.25 GiB", () => {
    const gib = 1024 ** 3;
    const [, high] = autoAxisDomain([0.4 * gib, 0.85 * gib, gib], 3, true);
    expect(high).toBeLessThanOrEqual(1.25 * gib);
  });
});

describe("two steps with the same count: the one landing on both ends wins", () => {
  it("draws [0, 50] as 0/25/50, not 0/20/40", () => {
    expect(ticksWithin([0, 50], 3)).toEqual([0, 25, 50]);
  });

  it("keeps a 500 guide on [0, 525] from sitting above a top label of 400", () => {
    const ticks = ticksWithin([0, 525], 3);
    expect(Math.max(...ticks)).toBe(500);
  });
});

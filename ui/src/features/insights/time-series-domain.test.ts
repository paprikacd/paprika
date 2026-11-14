import { describe, expect, it } from "vitest";
import { resolveTimeSeriesDomain } from "./time-series-chart";
import { axisScale } from "./units";
import type { QueryResult } from "./schema";

type Series = NonNullable<QueryResult["series"]>[number];

const series = (values: number[]): Series[] => [{ name: "s", labels: {}, points: values.map((value, index) => ({ timestamp: 1000 * (index + 1), value })) }];

describe("guided time-series domains", () => {
  it("rounds the unpadded extent, pads outside it, and keeps a zero floor", () => {
    // Thresholds at 0 and 99.95 with data near 100: baseline padded to [-5, 105] without the floor.
    expect(resolveTimeSeriesDomain(series([99.91, 99.93, 99.94]), { thresholds: [{ value: 0, color: "red" }, { value: 99.95, color: "green" }] })).toEqual([0, 105]);
  });

  it("does not blow up a zero line over positive data", () => {
    expect(resolveTimeSeriesDomain(series([10, 30, 50]), { showZeroLine: true })).toEqual([0, 52.5]);
  });

  it("keeps the top ceiling of stacked guides within one step", () => {
    expect(resolveTimeSeriesDomain(series([20, 40, 60]), { thresholds: [{ value: 0, color: "g" }, { value: 80, color: "y" }, { value: 90, color: "r" }] })).toEqual([0, 94.5]);
  });

  it("leaves a padded negative floor when a guide is negative, and respects authored bounds", () => {
    const [low] = resolveTimeSeriesDomain(series([-10, 10]), { showZeroLine: true })!;
    expect(low).toBeLessThan(0);
    expect(resolveTimeSeriesDomain(series([20, 40]), { thresholds: [{ value: 50, color: "r" }], min: 10 })?.[0]).toBe(10);
  });
});

describe("a guide-set domain is rounded once and never re-rounded", () => {
  const points = (values: number[]) => series(values);

  it("keeps availability and CPU guides within about 105 %", () => {
    expect(resolveTimeSeriesDomain(points([99.91, 99.93, 99.94]), { thresholds: [{ value: 0, color: "red" }, { value: 99.95, color: "green" }] }, 3)).toEqual([0, 105]);
    expect(resolveTimeSeriesDomain(points([20, 40, 60]), { thresholds: [{ value: 0, color: "g" }, { value: 80, color: "y" }, { value: 90, color: "r" }] }, 3)?.[1]).toBeLessThanOrEqual(105);
  });

  it("does not stretch thresholds -3 and 5 over -5..8 to -10..20", () => {
    const [low, high] = resolveTimeSeriesDomain(points([-5, 8]), { thresholds: [{ value: -3, color: "a" }, { value: 5, color: "b" }] }, 3)!;
    expect(low).toBeGreaterThan(-7);
    expect(high).toBeLessThan(11);
  });

  it("keeps a ceiling of 10 over data 1..9 at the top, rather than 0 to 15", () => {
    const [, high] = resolveTimeSeriesDomain(points([1, 9]), { thresholds: [{ value: 10, color: "r" }] }, 3)!;
    expect(high).toBeLessThanOrEqual(10.5);
  });

  it("honours explicit author bounds exactly, guides or not", () => {
    expect(resolveTimeSeriesDomain(points([10, 60]), { max: 70, thresholds: [{ value: 0, color: "g" }] }, 3)?.[1]).toBe(70);
    expect(resolveTimeSeriesDomain(points([10, 60]), { max: 120, thresholds: [{ value: 0, color: "g" }] }, 3)?.[1]).toBe(120);
  });

  it("draws the fixed domain's ticks inside it, with a count near the request", () => {
    const [low, high] = resolveTimeSeriesDomain(points([99.91, 99.93, 99.94]), { thresholds: [{ value: 0, color: "red" }, { value: 99.95, color: "green" }] }, 3)!;
    const axis = axisScale([low, high], "%", { count: 3, fixedDomain: true });
    expect(axis.domain).toEqual([low, high]);
    expect(axis.ticks.every(tick => tick >= low && tick <= high)).toBe(true);
    expect(axis.ticks.length).toBeGreaterThanOrEqual(2);
    expect(axis.ticks.length).toBeLessThanOrEqual(4);
  });
});

describe("guided domains keep their headroom at three ticks", () => {
  it("rarely leaves more than a quarter of the axis above the guide", () => {
    let cases = 0, loose = 0, worst = 0;
    for (let guide = 1.5; guide < 3000; guide *= 1.23)
      for (const fraction of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
        const dataTop = guide * fraction;
        const [low, high] = resolveTimeSeriesDomain(series([dataTop * 0.6, dataTop]), { thresholds: [{ value: guide, color: "r" }] }, 3)!;
        // Headroom is the axis above the guide, as a share of the axis: how much of the plot is wasted above the limit.
        const headroom = (high - guide) / (high - low);
        cases++;
        if (headroom > 0.25) loose++;
        worst = Math.max(worst, headroom);
      }
    expect(loose / cases).toBeLessThanOrEqual(0.05);
    expect(worst).toBeLessThan(0.5);
  });
});

describe("an ok base band does not widen the axis", () => {
  it("keeps an availability plot near its data when the healthy base sits at 0", () => {
    const [low, high] = resolveTimeSeriesDomain(series([99.91, 99.93, 99.94]), { thresholds: [{ value: 0, status: "ok", label: "Within objective" }, { value: 99.95, status: "critical" }] })!;
    expect(low).toBeGreaterThan(99);
    expect(high).toBeGreaterThanOrEqual(99.95);
  });

  it("still autoscales to a base that is not ok, so a colour-only floor keeps its guide in range", () => {
    expect(resolveTimeSeriesDomain(series([99.91, 99.93, 99.94]), { thresholds: [{ value: 0, color: "red" }, { value: 99.95, color: "green" }] })).toEqual([0, 105]);
  });
});


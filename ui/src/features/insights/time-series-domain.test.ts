import { describe, expect, it } from "vitest";
import { resolveTimeSeriesDomain } from "./time-series-chart";
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
    expect(resolveTimeSeriesDomain(series([20, 40, 60]), { thresholds: [{ value: 0, color: "g" }, { value: 80, color: "y" }, { value: 90, color: "r" }] })).toEqual([0, 105]);
  });

  it("leaves a padded negative floor when a guide is negative, and respects authored bounds", () => {
    const [low] = resolveTimeSeriesDomain(series([-10, 10]), { showZeroLine: true })!;
    expect(low).toBeLessThan(0);
    expect(resolveTimeSeriesDomain(series([20, 40]), { thresholds: [{ value: 50, color: "r" }], min: 10 })?.[0]).toBe(10);
  });
});

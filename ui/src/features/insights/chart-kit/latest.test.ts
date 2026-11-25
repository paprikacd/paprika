import { describe, expect, it } from "vitest";
import { latestPoint, latestRaw } from "./latest";
import { latestPoint as latestFromChartData } from "../chart-data";

const series = (points: { timestamp: number; value: number | null }[]) => ({ name: "s", points }) as Parameters<typeof latestPoint>[0];

describe("latestPoint", () => {
  it("returns the newest finite point, skipping missing values at the end", () => {
    const result = latestPoint(series([
      { timestamp: 1_000, value: 4 },
      { timestamp: 2_000, value: 9 },
      { timestamp: 3_000, value: null },
    ]));
    expect(result).toMatchObject({ timestamp: 2_000, value: 9 });
  });

  it("returns nothing when no point has a finite value", () => {
    expect(latestPoint(series([{ timestamp: 1_000, value: null }, { timestamp: 2_000, value: Number.NaN }]))).toBeUndefined();
  });

  it("lets a later point win a timestamp tie", () => {
    const result = latestPoint(series([
      { timestamp: 1_000, value: 1 },
      { timestamp: 1_000, value: 2 },
    ]));
    expect(result?.value).toBe(2);
  });

  it("ignores a point with an invalid timestamp", () => {
    const result = latestPoint(series([
      { timestamp: 1_000, value: 1 },
      { timestamp: Number.NaN, value: 5 },
    ]));
    expect(result?.value).toBe(1);
  });

  it("is the same function chart-data exports", () => {
    expect(latestFromChartData).toBe(latestPoint);
  });
});

describe("latestRaw", () => {
  it("keeps a missing newest value, where latestPoint skips it", () => {
    const points = [{ timestamp: 1_000, value: 4 }, { timestamp: 2_000, value: null }];
    expect(latestRaw(points)).toBe(points[1]);
    expect(latestPoint(series(points))?.value).toBe(4);
  });

  it("lets a later point win a timestamp tie and ignores invalid timestamps", () => {
    const tied = [{ timestamp: 1_000, value: 1 }, { timestamp: 1_000, value: 2 }];
    expect(latestRaw(tied)?.value).toBe(2);
    expect(latestRaw([{ timestamp: 1_000, value: 1 }, { timestamp: Number.NaN, value: 5 }])?.value).toBe(1);
    expect(latestRaw([])).toBeUndefined();
  });
});

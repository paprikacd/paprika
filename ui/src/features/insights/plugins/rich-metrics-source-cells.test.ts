import { describe, expect, it } from "vitest";
import { buildDistribution, type MetricSeries } from "./rich-metrics-data";

const bucket = (le: string, values: (number | null)[]): MetricSeries => ({
  name: "request_duration_bucket",
  labels: { le },
  points: values.map((value, index) => ({ timestamp: (index + 1) * 1000, value })),
});

describe("distribution source cells", () => {
  it("keeps every window's exact observation when the drawn columns are sampled", () => {
    const low = Array.from({ length: 40 }, (_, index) => index + 1);
    const high = low.map((value) => value + 2);
    const data = buildDistribution([bucket("1", low), bucket("+Inf", high)], { maxColumns: 8 });
    expect(data.sampled).toBe(true);
    expect(data.timestamps.length).toBeLessThanOrEqual(8);
    const [first, overflow] = data.rows;
    expect(first.sourceCells).toHaveLength(40);
    expect(first.sourceCells.map((cell) => cell.value)).toEqual(low);
    expect(overflow.sourceCells.every((cell) => cell.value === 2 && cell.state === "observed")).toBe(true);
  });

  it("draws exactly the sampled subset of the source cells, unchanged", () => {
    const low = Array.from({ length: 40 }, (_, index) => index + 1);
    const data = buildDistribution([bucket("1", low), bucket("+Inf", low.map((value) => value + 2))], { maxColumns: 8 });
    for (const row of data.rows) {
      expect(row.cells).toEqual(row.sourceCells.filter((cell) => data.timestamps.includes(cell.timestamp)));
    }
  });

  it("matches the drawn cells exactly when nothing is sampled", () => {
    const data = buildDistribution([bucket("1", [4, 5, 6]), bucket("+Inf", [9, 9, 11])], {});
    expect(data.sampled).toBe(false);
    for (const row of data.rows) expect(row.sourceCells).toEqual(row.cells);
  });

  it("keeps a missing window in the source cells, where sampling may drop it from the drawn ones", () => {
    const low = Array.from({ length: 40 }, (_, index) => index + 1);
    const withGap = bucket("1", low.map((value, index) => (index === 17 ? null : value)));
    const data = buildDistribution([withGap, bucket("+Inf", low.map((value) => value + 2))], { maxColumns: 8 });
    const missing = data.rows[0].sourceCells.find((cell) => cell.timestamp === 18_000);
    expect(missing).toMatchObject({ value: null, state: "missing" });
  });
});

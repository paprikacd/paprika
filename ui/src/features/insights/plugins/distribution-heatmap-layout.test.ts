import { describe, expect, it } from "vitest";
import { heatmapColumnLimit, heatmapColumns, heatmapColumnAt, heatmapDensityLevel, heatmapGaps, quantileLine } from "./distribution-heatmap-layout";

describe("distribution heatmap layout", () => {
  it("spreads positive skewed densities logarithmically while keeping observed zero separate", () => {
    expect([0, 1, 10, 100, 1000].map(value => heatmapDensityLevel(value, 1000, 1, 24, "logarithmic"))).toEqual([null, 0, 8, 15, 23]);
    expect(heatmapDensityLevel(10, 1000, 1, 7, "linear")).toBe(0);
    expect(heatmapDensityLevel(2, 2, 2, 7, "logarithmic")).toBe(6);
    expect(heatmapDensityLevel(0, 0, null, 7, "logarithmic")).toBeNull();
    expect(heatmapDensityLevel(1e-300, 1e300, 1e-300, 7, "logarithmic")).toBe(0);
    expect(heatmapDensityLevel(1e300, 1e300, 1e-300, 7, "logarithmic")).toBe(6);
  });
  it("maps linear densities across all 24 steps, with the maximum on the top step and zero off the scale", () => {
    expect([0, 1, 500, 1000].map(value => heatmapDensityLevel(value, 1000, 1, 24, "linear"))).toEqual([null, 0, 12, 23]);
    expect(heatmapDensityLevel(-1, 1000, 1, 24, "linear")).toBeNull();
  });
  it("draws one p95 step line through consecutive drawable columns, joining them in the gutter", () => {
    const columns = heatmapColumns([0, 1, 2, 3], 0, 40);
    const rowCentre = (row: number) => (3 - row - .5) * 10;
    const line = quantileLine({ columns, buckets: [1, 1, 2, 2], breaks: [false, false, false, false], rows: 3, rowCentre, gaps: [] });
    expect(line.above).toEqual([]);
    expect(line.d.match(/M/g)).toHaveLength(1);
    expect(line.d).toMatch(/^M0\.5,15L/);
    expect(line.d).toMatch(/L20,15L20,5L/);
    expect(line.d).toMatch(/39\.5,5$/);
  });
  it("breaks the line at a non-ok column, a break flag, a source gap and a bucket above the displayed rows", () => {
    const columns = heatmapColumns([0, 1, 2, 3], 0, 40);
    const rowCentre = (row: number) => (3 - row - .5) * 10;
    expect(quantileLine({ columns, buckets: [1, null, 1, 2], breaks: [false, false, false, false], rows: 3, rowCentre, gaps: [] }).d.match(/M/g)).toHaveLength(2);
    expect(quantileLine({ columns, buckets: [1, 1, 1, 1], breaks: [false, false, true, false], rows: 3, rowCentre, gaps: [] }).d.match(/M/g)).toHaveLength(2);
    expect(quantileLine({ columns, buckets: [1, 1, 1, 1], breaks: [false, false, false, false], rows: 3, rowCentre, gaps: [{ left: 16, right: 24 }] }).d.match(/M/g)).toHaveLength(2);
    const above = quantileLine({ columns, buckets: [1, 3, 4, 1], breaks: [false, false, false, false], rows: 3, rowCentre, gaps: [] });
    expect(above.above).toEqual([15, 25]);
    expect(above.d.match(/M/g)).toHaveLength(2);
  });
  it("draws nothing when no column has a drawable p95", () => {
    const columns = heatmapColumns([0, 1], 0, 20);
    expect(quantileLine({ columns, buckets: [null, null], breaks: [false, false], rows: 2, rowCentre: row => row, gaps: [] })).toEqual({ d: "", above: [] });
  });
  it("uses fewer visible observations on narrow plots while respecting the authored maximum", () => {
    expect(heatmapColumnLimit(210, 120)).toBe(35);
    expect(heatmapColumnLimit(690, 120)).toBe(115);
    expect(heatmapColumnLimit(1200, 60)).toBe(60);
    expect(heatmapColumnLimit(12, 120)).toBe(8);
  });
  it("only selects painted observations, never a blank interval between irregular timestamps", () => {
    const columns = heatmapColumns([0, 1, 8, 9], 40, 120);
    const gaps = heatmapGaps([0, 1, 8, 9], 40, 120, 4);
    expect(columns).toHaveLength(4);
    expect(heatmapColumnAt(columns, columns[0].center)).toBe(0);
    expect(heatmapColumnAt(columns, columns[3].center)).toBe(3);
    expect(heatmapColumnAt(columns, (columns[1].center + columns[2].center) / 2, gaps)).toBeUndefined();
  });
  it("snaps across sampled gutters when the underlying source is continuous", () => {
    const columns = heatmapColumns([0, 2, 4], 0, 120);
    const gaps = heatmapGaps([0, 1, 2, 3, 4], 0, 120, 3);
    expect(heatmapColumnAt(columns, (columns[0].center + columns[1].center) / 2, gaps)).toBeDefined();
    expect(gaps).toHaveLength(0);
  });
  it("fills continuous sampled time with neighboring cells without crossing real source gaps", () => {
    const continuous = heatmapColumns([0, 2, 4, 9], 10, 180);
    for (let index = 1; index < continuous.length; index++) {
      const space = continuous[index].left - (continuous[index - 1].left + continuous[index - 1].width);
      expect(space).toBeGreaterThanOrEqual(0);
      expect(space).toBeLessThanOrEqual(1.1);
    }
    const source = [0, 1, 2, 8, 9, 10];
    const gaps = heatmapGaps(source, 10, 180, 4);
    const sparse = heatmapColumns([0, 2, 8, 10], 10, 180, gaps);
    expect(gaps).toHaveLength(1);
    expect(sparse[1].left + sparse[1].width).toBeLessThanOrEqual(gaps[0].left);
    expect(sparse[2].left).toBeGreaterThanOrEqual(gaps[0].right);
    expect(heatmapColumnAt(sparse, (gaps[0].left + gaps[0].right) / 2, gaps)).toBeUndefined();
  });
});

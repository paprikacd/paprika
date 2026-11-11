import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { breachSummary, breachingPoints, seriesBreaches, thresholdsAreOrdered, timeSeriesBreaches, unionSpans, type BreachInterval } from "./breaches";
import type { Threshold } from "./schema";

type Fixture = {
  cases: {
    name: string;
    thresholds: Threshold[];
    series: { step: number | null; points: { timestamp: number; value: number | null }[] }[];
    expected: { intervals: (BreachInterval & { series: number })[]; summary: { level: string; intervals: number; duration: number }[] };
  }[];
};

// The shared cases are also run by the Go breach port, so they live in docs/design and are not copied here.
const fixture: Fixture = JSON.parse(readFileSync("../docs/design/insights/conformance/breaches.json", "utf8"));

const ok: Threshold = { value: 0, status: "ok" };
const warning = (value: number): Threshold => ({ value, status: "warning" });
const critical = (value: number): Threshold => ({ value, status: "critical" });
const samples = (...pairs: [number, number | null][]) => pairs.map(([timestamp, value]) => ({ timestamp, value }));

describe("breach conformance fixtures", () => {
  it.each(fixture.cases.map((testCase) => [testCase.name, testCase] as const))("%s", (_name, testCase) => {
    const intervals = timeSeriesBreaches(testCase.series, testCase.thresholds);
    expect(intervals).toEqual(testCase.expected.intervals);
    expect(breachSummary(intervals)).toEqual(testCase.expected.summary);
  });
});

describe("seriesBreaches", () => {
  it("counts a value equal to a threshold in that threshold's band", () => {
    const intervals = seriesBreaches(samples([0, 2], [60_000, 2.5]), [ok, warning(2)], 60_000);
    expect(intervals).toEqual([{ start: 0, end: 120_000, level: "warning", duration: 120_000 }]);
  });

  it("ignores a value just below a threshold", () => {
    expect(seriesBreaches(samples([0, 1.999], [60_000, 1.5]), [ok, warning(2)], 60_000)).toEqual([]);
  });

  it("never breaches on a non-finite value, and a null value ends the run", () => {
    const intervals = seriesBreaches(samples([0, 3], [60_000, Number.NaN], [120_000, 3]), [ok, critical(2)], 60_000);
    expect(intervals).toEqual([
      { start: 0, end: 60_000, level: "critical", duration: 60_000 },
      { start: 120_000, end: 180_000, level: "critical", duration: 60_000 },
    ]);
  });

  it("sorts unsorted samples by time before measuring", () => {
    const intervals = seriesBreaches(samples([120_000, 3], [0, 1], [60_000, 3]), [ok, critical(2)], 60_000);
    expect(intervals).toEqual([{ start: 60_000, end: 180_000, level: "critical", duration: 120_000 }]);
  });

  it("returns no breaches for thresholds that are not strictly increasing", () => {
    const points = samples([0, 6], [60_000, 6]);
    expect(seriesBreaches(points, [critical(5), warning(2)], 60_000)).toEqual([]);
    expect(seriesBreaches(points, [warning(2), critical(2)], 60_000)).toEqual([]);
    expect(seriesBreaches(points, [{ value: Number.NaN, status: "critical" }], 60_000)).toEqual([]);
  });

  it("returns no breaches when there are no thresholds", () => {
    expect(seriesBreaches(samples([0, 9]), undefined, 60_000)).toEqual([]);
  });
});

describe("thresholdsAreOrdered", () => {
  it("accepts strictly increasing values and rejects repeats and descending order", () => {
    expect(thresholdsAreOrdered([ok, warning(1), critical(2)])).toBe(true);
    expect(thresholdsAreOrdered([])).toBe(true);
    expect(thresholdsAreOrdered([warning(1), warning(1)])).toBe(false);
    expect(thresholdsAreOrdered([critical(2), warning(1)])).toBe(false);
  });
});

describe("unionSpans and breachSummary", () => {
  it("merges overlapping and touching spans into disjoint ones", () => {
    expect(unionSpans([{ start: 10, end: 20 }, { start: 0, end: 5 }, { start: 5, end: 8 }, { start: 15, end: 30 }])).toEqual([
      { start: 0, end: 8 },
      { start: 10, end: 30 },
    ]);
  });

  it("lists the worst level first and omits levels with no intervals", () => {
    const intervals: BreachInterval[] = [
      { start: 0, end: 60_000, level: "warning", duration: 60_000 },
      { start: 0, end: 60_000, level: "critical", duration: 60_000 },
    ];
    expect(breachSummary(intervals).map((entry) => entry.level)).toEqual(["critical", "warning"]);
    expect(breachSummary([])).toEqual([]);
  });
});

describe("breachingPoints", () => {
  it("returns the samples from an interval start to its end, including the crossing sample, separated by null breaks", () => {
    const points = samples([0, 1], [60_000, 3], [120_000, 3], [180_000, 1], [240_000, 3], [300_000, 3]);
    const result = breachingPoints(points, [
      { start: 60_000, end: 180_000, level: "critical", duration: 120_000 },
      { start: 240_000, end: 300_000, level: "critical", duration: 60_000 },
    ]);
    expect(result).toEqual([
      { timestamp: 60_000, value: 3 },
      { timestamp: 120_000, value: 3 },
      { timestamp: 180_000, value: 1 },
      { timestamp: 180_000, value: null },
      { timestamp: 240_000, value: 3 },
      { timestamp: 300_000, value: 3 },
      { timestamp: 300_000, value: null },
    ]);
  });

  it("returns nothing without intervals", () => {
    expect(breachingPoints(samples([0, 9]), [])).toEqual([]);
  });

  it("stays linear on a long, noisy series with one interval per breaching sample", () => {
    const count = 60_000;
    const points = Array.from({ length: count }, (_, index) => ({ timestamp: index * 1000, value: index % 2 ? 1 : 3 }));
    const intervals = seriesBreaches(points, [ok, critical(2)], 1000);
    expect(intervals).toHaveLength(count / 2);
    // Each interval keeps its breaching sample and the crossing sample, then a null break.
    expect(breachingPoints(points, intervals)).toHaveLength((count / 2) * 3);
  });
});

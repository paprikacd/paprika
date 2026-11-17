import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { breachBands, breachEmphasisPoints, breachSummary, clampBreaches, seriesBreaches, thresholdsAreOrdered, timeSeriesBreaches, unionSpans, type BreachInterval } from "./breaches";
import type { Point } from "./chart-data";
import type { Threshold } from "./schema";

type Fixture = {
  cases: {
    name: string;
    thresholds: Threshold[];
    series: { step: number | null; points: { timestamp: number; value: number | null }[] }[];
    expected: { intervals: (BreachInterval & { series: number })[]; summary: { level: string; intervals: number; samples: number; duration: number }[] };
  }[];
};

// The shared cases are also run by the Go breach port, so they live in docs/design and are read relative to this file.
const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../docs/design/insights/conformance/breaches.json");
const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

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
    expect(intervals).toEqual([{ start: 0, end: 60_000, level: "warning", duration: 60_000 }]);
  });

  it("ignores a value just below a threshold", () => {
    expect(seriesBreaches(samples([0, 1.999], [60_000, 1.5]), [ok, warning(2)], 60_000)).toEqual([]);
  });

  it("never breaches on a non-finite value, and that value ends the run at its last breaching sample", () => {
    const intervals = seriesBreaches(samples([0, 3], [60_000, Number.NaN], [120_000, 3]), [ok, critical(2)], 60_000);
    expect(intervals).toEqual([
      { start: 0, end: 0, level: "critical", duration: 0 },
      { start: 120_000, end: 120_000, level: "critical", duration: 0 },
    ]);
  });

  it("sorts unsorted samples by time before measuring", () => {
    const intervals = seriesBreaches(samples([120_000, 3], [0, 1], [60_000, 3], [180_000, 1]), [ok, critical(2)], 60_000);
    // The run is followed by an observed, contiguous sample at 180 s, so it extends to that sample.
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

describe("unionSpans and clampBreaches", () => {
  it("merges overlapping and touching spans into disjoint ones", () => {
    expect(unionSpans([{ start: 10, end: 20 }, { start: 0, end: 5 }, { start: 5, end: 8 }, { start: 15, end: 30 }])).toEqual([
      { start: 0, end: 8 },
      { start: 10, end: 30 },
    ]);
  });

  it("also merges spans within a gap, so near neighbours become one band", () => {
    expect(unionSpans([{ start: 0, end: 10 }, { start: 12, end: 20 }, { start: 40, end: 50 }], 3)).toEqual([
      { start: 0, end: 20 },
      { start: 40, end: 50 },
    ]);
  });

  it("clips intervals to the window and drops those wholly outside it", () => {
    const intervals: BreachInterval[] = [
      { start: 0, end: 100, level: "critical", duration: 100 },
      { start: 150, end: 300, level: "warning", duration: 150 },
      { start: 400, end: 500, level: "warning", duration: 100 },
    ];
    expect(clampBreaches(intervals, [50, 200])).toEqual([
      { start: 50, end: 100, level: "critical", duration: 50 },
      { start: 150, end: 200, level: "warning", duration: 50 },
    ]);
  });
});

describe("breachBands", () => {
  const span = (start: number, level: "warning" | "critical"): BreachInterval => ({ start, end: start + 1_000, level, duration: 1_000 });

  it("keeps each level's most recent bands, warning first, and counts the rest as unshaded", () => {
    const intervals = [...Array.from({ length: 5 }, (_, index) => span(index * 10_000, "warning")), ...Array.from({ length: 4 }, (_, index) => span(index * 10_000, "critical"))];
    const plan = breachBands(intervals, 0, 3);
    expect(plan.unshaded).toBe(2 + 1);
    expect(plan.spans.map((band) => [band.level, band.start])).toEqual([
      ["warning", 20_000], ["warning", 30_000], ["warning", 40_000],
      ["critical", 10_000], ["critical", 20_000], ["critical", 30_000],
    ]);
  });

  it("merges spans closer than a pixel and gives no band to instants", () => {
    const intervals: BreachInterval[] = [
      { start: 0, end: 1_000, level: "critical", duration: 1_000 },
      { start: 1_500, end: 2_500, level: "critical", duration: 1_000 },
      { start: 9_000, end: 9_000, level: "critical", duration: 0 },
    ];
    expect(breachBands(intervals, 1_000, 200)).toEqual({ spans: [{ start: 0, end: 2_500, level: "critical" }], unshaded: 0 });
  });
});

describe("breachSummary", () => {
  it("lists the worst level first and omits levels with nothing to report", () => {
    const intervals: BreachInterval[] = [
      { start: 0, end: 60_000, level: "warning", duration: 60_000 },
      { start: 0, end: 60_000, level: "critical", duration: 60_000 },
    ];
    expect(breachSummary(intervals).map((entry) => entry.level)).toEqual(["critical", "warning"]);
    expect(breachSummary([])).toEqual([]);
  });

  it("merges overlapping intervals across series, so one incident counts once", () => {
    const intervals: BreachInterval[] = [
      { start: 0, end: 60_000, level: "critical", duration: 60_000 },
      { start: 30_000, end: 90_000, level: "critical", duration: 60_000 },
    ];
    expect(breachSummary(intervals)).toEqual([{ level: "critical", intervals: 1, samples: 0, duration: 90_000 }]);
  });

  it("reports a single breaching sample as a sample, not as a zero-length interval", () => {
    const intervals: BreachInterval[] = [{ start: 0, end: 0, level: "critical", duration: 0 }];
    expect(breachSummary(intervals)).toEqual([{ level: "critical", intervals: 0, samples: 1, duration: 0 }]);
  });
});

describe("breachEmphasisPoints", () => {
  // Thresholds: ok below 2, critical from 2. Crossings are interpolated along the plotted segment.
  const bands = [ok, critical(2)];
  const at = (timestamp: number, value: number | null): Point => ({ timestamp, value });

  it("starts and ends the stroke at the crossings, symmetrically on entry and exit", () => {
    // Entry: 1 to 3 crosses 2 halfway, at 30 s. Exit: 3 to 1 crosses 2 halfway, at 90 s.
    const points = [at(0, 1), at(60_000, 3), at(120_000, 1)];
    expect(breachEmphasisPoints(points, bands)).toEqual([at(30_000, 2), at(60_000, 3), at(90_000, 2)]);
  });

  it("interpolates each crossing on its own segment, so a rising and a falling edge differ as the data does", () => {
    const points = [at(0, 1), at(60_000, 1.5), at(120_000, 3), at(180_000, 2.5), at(240_000, 1)];
    // Entry: 1.5 to 3 crosses 2 at 80 s. Exit: 2.5 to 1 crosses 2 at 200 s.
    expect(breachEmphasisPoints(points, bands)).toEqual([at(80_000, 2), at(120_000, 3), at(180_000, 2.5), at(200_000, 2)]);
  });

  it("keeps one stroke per stretch: a missing value separates them with a null break", () => {
    const points = [at(0, 3), at(60_000, 3), at(120_000, null), at(180_000, 3), at(240_000, 3)];
    expect(breachEmphasisPoints(points, bands)).toEqual([at(0, 3), at(60_000, 3), at(180_000, null), at(180_000, 3), at(240_000, 3)]);
  });

  it("draws nothing for a series that never breaches", () => {
    expect(breachEmphasisPoints([at(0, 1), at(60_000, 1.5)], bands)).toEqual([]);
    expect(breachEmphasisPoints([at(0, 3), at(60_000, 3)], undefined)).toEqual([]);
  });
});

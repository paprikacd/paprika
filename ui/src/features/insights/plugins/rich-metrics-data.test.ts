import { describe, expect, it } from "vitest";
import { buildDistribution, buildMetricPlot, directionalConfigSchema, distributionConfigSchema, sampleTimeIndices, stackedConfigSchema, type MetricSeries } from "./rich-metrics-data";

const series = (name: string, values: (number | null)[], labels: Record<string, string> = {}): MetricSeries => ({ name, labels, points: values.map((value, i) => ({ timestamp: 1000 * (i + 1), value })) });
const bucket = (bound: string, values: (number | null)[], group = "api") => series(`bucket ${bound}`, values, { le: bound, service: group });

describe("histogram distributions", () => {
  it("differences cumulative rates per timestamp, preserving the overflow bucket and zero", () => {
    const data = buildDistribution([bucket("+Inf", [10, 18]), bucket("10", [0, 4]), bucket("50", [8, 13])], {});
    expect(data.rows.map(row => [row.lower, row.upper])).toEqual([[-Infinity, 10], [10, 50], [50, Infinity]]);
    expect(data.rows.map(row => row.cells.map(cell => cell.value))).toEqual([[0, 4], [8, 9], [2, 5]]);
    expect(data.max).toBe(9);
    expect(data.minPositive).toBe(2);
    expect(data.rows[2].labels).toEqual({ service: "api", le: "+Inf" });
  });
  it("uses all returned bucket observations for the color scale even when columns are sampled", () => {
    const values = Array.from({ length: 120 }, (_, index) => index === 20 ? 0.001 : index === 70 ? 1000 : 10);
    const data = buildDistribution([bucket("1", values), bucket("+Inf", values.map(value => value * 2))], { maxColumns: 8 });
    expect(data.sampled).toBe(true);
    expect(data.minPositive).toBe(0.001);
    expect(data.max).toBe(1000);
  });
  it("does not bridge missing lower bounds or silently repair non-monotonic buckets", () => {
    const data = buildDistribution([bucket("1", [4, null, 6]), bucket("2", [3, 8, 10]), bucket("+Inf", [9, 9, 11])], {});
    expect(data.rows.map(row => row.cells.map(cell => cell.value))).toEqual([[4, null, 6], [null, null, 4], [6, 1, 1]]);
    expect(data.invalidCells).toBe(1);
  });
  it("does not turn materially decreasing tiny bucket rates into an observed zero", () => {
    const data = buildDistribution([bucket("1", [1e-12]), bucket("2", [0]), bucket("3", [0])], {});
    expect(data.rows.map(row => row.cells[0].value)).toEqual([1e-12, null, 0]);
    expect(data.invalidCells).toBe(1);
    // Relative floating-point noise at any magnitude may still be rounded to
    // zero; the tolerance must scale with the data rather than with one.
    const noise = buildDistribution([bucket("1", [1e-12]), bucket("2", [1e-12 * (1 - 1e-10)])], {});
    expect(noise.rows[1].cells[0].value).toBe(0);
    expect(noise.invalidCells).toBe(0);
  });
  it("requires explicit grouping and only sums compatible bucket boundaries", () => {
    const input = [bucket("1", [2], "api"), bucket("+Inf", [5], "api"), bucket("1", [3], "worker"), bucket("+Inf", [7], "worker")];
    expect(() => buildDistribution(input, {})).toThrow("Multiple histogram groups");
    const sum = buildDistribution(input, { aggregation: "sum" });
    expect(sum.rows.map(row => row.cells[0].value)).toEqual([5, 7]);
    expect(sum.rows[0].labels).toEqual({ le: "1" });
    expect(buildDistribution(input, { group: { service: "worker" } }).rows.map(row => row.cells[0].value)).toEqual([3, 4]);
    expect(() => buildDistribution([...input, bucket("2", [4], "api")], { aggregation: "sum" })).toThrow("different bucket boundaries");
  });
  it("does not let a monotonic group conceal an invalid group during sum", () => {
    const data = buildDistribution([bucket("1", [5], "a"), bucket("2", [4], "a"), bucket("1", [0], "b"), bucket("2", [20], "b")], { aggregation: "sum" });
    expect(data.rows[1].cells[0].value).toBeNull();
  });
  it("rejects missing and duplicate bounds and duplicate timestamps", () => {
    expect(() => buildDistribution([series("unknown", [2])], {})).toThrow("numeric le");
    expect(() => buildDistribution([bucket("1", [2]), bucket("1.0", [3])], {})).toThrow("Duplicate histogram bucket");
    expect(() => buildDistribution([{ ...bucket("1", [2]), points: [{ timestamp: 1, value: 2 }, { timestamp: 1, value: 3 }] }], {})).toThrow("Duplicate observation timestamps");
  });
  it("joins disjoint observations for numerically identical migrated bucket labels", () => {
    const first = { ...bucket("1.0", []), points: [{ timestamp: 1000, value: 3 }, { timestamp: 2000, value: null }] };
    const second = { ...bucket("1", []), points: [{ timestamp: 3000, value: 7 }] };
    const overflow = bucket("+Inf", [5, 6, 10]);
    const result = buildDistribution([first, second, overflow], {});
    expect(result.timestamps).toEqual([1000, 2000, 3000]);
    expect(result.rows.map(row => row.cells.map(cell => cell.value))).toEqual([[3, null, 7], [2, null, 3]]);
    const overlapping = { ...second, points: [{ timestamp: 2000, value: 7 }] };
    expect(() => buildDistribution([first, overlapping], {})).toThrow("Duplicate histogram bucket");
  });
  it("bounds rows and columns and preserves missing snapshots in a sampled interval", () => {
    const values = Array.from({ length: 100 }, (_, index) => index === 28 ? null : index);
    const data = buildDistribution([bucket("1", values), bucket("2", values.map(value => value === null ? null : value + 1))], { maxBuckets: 1, maxColumns: 8 });
    expect(data.rows).toHaveLength(1); expect(data.omittedBuckets).toBe(1);
    // Eight columns in all: the missing column's bucket keeps it beside the densest column, so one fewer bucket fits.
    expect(data.timestamps).toHaveLength(8); expect(data.sampled).toBe(true);
    expect(data.rows[0].cells.some(cell => cell.timestamp === 29000 && cell.value === null)).toBe(true);
  });
});

describe("stack and directional geometry", () => {
  it("can center directional axes without changing the recorded values", () => {
    const directions = [series("in", [100, 80], { direction: "inbound" }), series("out", [20, 30], { direction: "outbound" })];
    const config = directionalConfigSchema.parse({ symmetricAxis: true });
    const centered = buildMetricPlot(directions, config, true);
    expect(centered.domain).toEqual([-100, 100]);
    expect(centered.tracks[1].cells.map(cell => [cell.value, cell.upper])).toEqual([[20, -20], [30, -30]]);
    expect(buildMetricPlot(directions, {}, true).domain).toEqual([-50, 100]);
    expect(buildMetricPlot([series("zero", [0])], config, true).domain).toEqual([-1, 1]);
    expect(buildMetricPlot([series("extreme", [Number.MAX_VALUE])], config, true).domain).toEqual([-Number.MAX_VALUE, Number.MAX_VALUE]);
  });
  it("uses independent positive and negative baselines without changing observed values", () => {
    const data = buildMetricPlot([series("A", [3]), series("B", [-4]), series("C", [2]), series("D", [-6])], {});
    expect(data.tracks.map(track => [track.cells[0].lower, track.cells[0].upper, track.cells[0].value])).toEqual([[0, 3, 3], [0, -4, -4], [3, 5, 2], [-4, -10, -6]]);
    expect(data.domain).toEqual([-10, 5]);
  });
  it("omits the entire time column when a positive or negative stack exceeds finite precision", () => {
    const data = buildMetricPlot([series("A", [1e308, -1e308, 2]), series("B", [1e308, -1e308, 3])], {});
    expect(data.overflowColumns).toBe(2);
    expect(data.tracks.map(track => track.cells.slice(0, 2).map(cell => [cell.value, cell.lower, cell.upper]))).toEqual([
      [[1e308, null, null], [-1e308, null, null]],
      [[1e308, null, null], [-1e308, null, null]],
    ]);
    expect(data.tracks.map(track => track.cells[2].upper)).toEqual([2, 5]);
    expect(data.domain).toEqual([0, 5]);
  });
  it("leaves an entire stack gap when any series is missing, while retaining inspectable raw values", () => {
    const data = buildMetricPlot([series("A", [4, 8, 0]), series("B", [3, null, -2])], {});
    expect(data.tracks[0].cells[1]).toEqual({ timestamp: 2000, value: 8, lower: null, upper: null });
    expect(data.tracks[1].cells[1].value).toBeNull();
    expect(data.tracks[0].cells[2]).toEqual({ timestamp: 3000, value: 0, lower: 0, upper: 0 });
  });
  it("aligns exact timestamps rather than lining up mismatched sample indexes", () => {
    const data = buildMetricPlot([series("A", [2, 3]), { ...series("B", [5, 6]), points: [{ timestamp: 2000, value: 5 }, { timestamp: 3000, value: 6 }] }], {});
    expect(data.timestamps).toEqual([1000, 2000, 3000]);
    expect(data.tracks[0].cells.map(cell => cell.upper)).toEqual([null, 3, null]);
    expect(data.tracks[1].cells[1].upper).toBe(8);
  });
  it("mirrors outbound geometry only and rejects negative raw traffic", () => {
    const data = buildMetricPlot([series("In", [8, 0], { direction: "inbound" }), series("Out", [3, -4], { direction: "outbound" })], {}, true);
    expect(data.tracks[1].cells[0]).toEqual({ timestamp: 1000, value: 3, lower: 0, upper: -3 });
    expect(data.tracks[1].cells[1].value).toBeNull(); expect(data.invalidValues).toBe(1);
    expect(data.domain).toEqual([-4, 8]);
  });
  it("uses configured direction labels and retains a zero baseline for a zero series", () => {
    const data = buildMetricPlot([series("sent", [0, 12], { flow: "sent" })], { directionLabel: "flow", outboundValue: "sent" }, true);
    expect(data.domain).toEqual([-12, 0]);
    expect(data.tracks[0].cells[0].value).toBe(0);
    expect(buildMetricPlot([series("zero", [0])], {}).domain).toEqual([0, 1]);
  });
  it("bounds series and time samples, preserving a spike and a null gap", () => {
    const values = Array.from({ length: 100 }, (_, i) => i === 25 ? null : i === 75 ? 1000 : 1);
    const data = buildMetricPlot([series("A", values), series("excluded", [10])], { maxPoints: 12, maxSeries: 1 });
    expect(data.omittedSeries).toBe(1); expect(data.tracks[0].cells).toHaveLength(12);
    expect(data.tracks[0].cells.some(cell => cell.value === 1000)).toBe(true);
    expect(data.tracks[0].cells.some(cell => cell.value === null)).toBe(true);
    expect(data.timestamps[0]).toBe(1000); expect(data.timestamps.at(-1)).toBe(100000);
  });
  it("computes legend statistics before sampling or stacking", () => {
    const data = buildMetricPlot([series("A", Array.from({ length: 100 }, (_, index) => index + 1)), series("B", Array.from({ length: 100 }, () => 200))], { maxPoints: 12 });
    expect(data.tracks[0].cells).toHaveLength(12);
    expect(data.tracks[0].statistics).toEqual({ current: 100, currentTimestamp: 100000, mean: 50.5, max: 100, finiteSamples: 100, totalSamples: 100 });
    expect(data.tracks[1].cells.at(-1)?.upper).toBe(300);
    expect(data.tracks[1].statistics.current).toBe(200);
    expect(data.tracks[1].statistics.mean).toBeCloseTo(200);
  });
  it("preserves missing current samples, excludes nonfinite values and invalid timestamps from summaries", () => {
    const entry: MetricSeries = { name: "Sparse", labels: {}, points: [{ timestamp: 3000, value: null }, { timestamp: 1000, value: -4 }, { timestamp: 2000, value: 0 }, { timestamp: 4000, value: NaN }, { timestamp: Infinity, value: 999 }] };
    const summary = buildMetricPlot([entry], {}).tracks[0].statistics;
    expect(summary).toEqual({ current: null, currentTimestamp: 4000, mean: -2, max: 0, finiteSamples: 2, totalSamples: 4 });
    expect(buildMetricPlot([series("missing", [null, null])], {}).tracks[0].statistics).toEqual({ current: null, currentTimestamp: 2000, mean: null, max: null, finiteSamples: 0, totalSamples: 2 });
  });
  it("summarizes each series's raw observations and its own latest timestamp, without negating outbound", () => {
    const entry = { ...series("Outbound", [2, 10], { direction: "outbound" }), points: [{ timestamp: 1000, value: 2 }, { timestamp: 9000, value: 10 }] };
    const data = buildMetricPlot([entry, series("Later", Array.from({ length: 10 }, () => 1))], {}, true);
    expect(data.tracks[0].cells.at(-1)?.value).toBeNull();
    expect(data.tracks[0].statistics).toEqual({ current: 10, currentTimestamp: 9000, mean: 6, max: 10, finiteSamples: 2, totalSamples: 2 });
    expect(data.tracks[0].cells.find(cell => cell.timestamp === 9000)?.upper).toBe(-10);
  });
  it("does not overflow mean accumulation for large finite samples", () => {
    expect(buildMetricPlot([series("Large", [1e308, 1e308])], {}).tracks[0].statistics.mean).toBe(1e308);
    expect(buildMetricPlot([series("Opposite", [-1e308, 1e308])], {}).tracks[0].statistics.mean).toBe(0);
  });
  it("preserves small observations through cancellation in legend means", () => {
    expect(buildMetricPlot([series("Cancellation", [1e16, 1, -1e16])], {}).tracks[0].statistics.mean).toBe(1 / 3);
    expect(buildMetricPlot([series("Wide", [1e308, 1e-308, -1e308])], {}).tracks[0].statistics.mean).toBe(1e-308 / 3);
    expect(buildMetricPlot([series("Overflow", [Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE])], {}).tracks[0].statistics.mean).toBe(Number.MAX_VALUE / 3);
    expect(buildMetricPlot([series("Negative", [-1e16, -1, 1e16])], {}).tracks[0].statistics.mean).toBe(-1 / 3);
    expect(buildMetricPlot([series("Half subnormal", [Number.MIN_VALUE, 0])], {}).tracks[0].statistics.mean).toBe(0);
    expect(buildMetricPlot([series("Odd tie", [3 * Number.MIN_VALUE, 0])], {}).tracks[0].statistics.mean).toBe(2 * Number.MIN_VALUE);
  });
  it("limits unsafe config instead of treating it as executable or unknown settings", () => {
    expect(distributionConfigSchema.safeParse({ maxColumns: 10000 }).success).toBe(false);
    expect(distributionConfigSchema.safeParse({ bucketLabel: "a.b" }).success).toBe(false);
    expect(distributionConfigSchema.safeParse({ colorScale: "logarithmic" }).success).toBe(true);
    expect(distributionConfigSchema.safeParse({ colorScale: "arbitrary" }).success).toBe(false);
    expect(stackedConfigSchema.safeParse({ display: "pie" }).success).toBe(false);
    expect(directionalConfigSchema.safeParse({ directionLabel: "direction", handler: "code" }).success).toBe(false);
    expect(stackedConfigSchema.safeParse({ legendDisplay: "table", legendPosition: "right" }).success).toBe(true);
    expect(directionalConfigSchema.safeParse({ legendDisplay: "table", legendPosition: "right" }).success).toBe(true);
    expect(stackedConfigSchema.safeParse({ legendDisplay: "full" }).success).toBe(false);
    expect(directionalConfigSchema.safeParse({ legendPosition: "left" }).success).toBe(false);
    expect(sampleTimeIndices(0, 12, () => false, () => 0)).toEqual([]);
  });
});

describe("distribution quantiles and gap states", () => {
  it("classifies each cell as observed, missing or invalid, and keeps observed zero distinct", () => {
    const data = buildDistribution([bucket("10", [5, null, 5, 0]), bucket("50", [10, 10, 4, 0]), bucket("+Inf", [10, 10, 10, 0])], {});
    expect(data.rows.map(row => row.cells.map(cell => cell.state))).toEqual([
      ["observed", "missing", "observed", "observed"],
      ["observed", "missing", "invalid", "observed"],
      ["observed", "observed", "observed", "observed"],
    ]);
    expect(data.rows[0].cells[3]).toMatchObject({ value: 0, state: "observed" });
    expect(data.invalidCells).toBe(1);
  });
  it("finds each window's p95 bucket from the full bucket list and never averages percentiles", () => {
    // Window A is all in the first bucket, B all in the second. Their per-window p95s average to 28.75, but
    // the p95 of the pooled counts (10 in each of two buckets) is 46.
    const data = buildDistribution([bucket("10", [10, 0]), bucket("50", [10, 10]), bucket("+Inf", [10, 10])], {});
    expect(data.quantiles.map(window => [window.state, window.p95?.bucket])).toEqual([["ok", 0], ["ok", 1]]);
    expect(data.quantiles[0].p95?.estimate).toBeCloseTo(9.5);
    expect(data.quantiles[1].p95?.estimate).toBeCloseTo(48);
    expect(data.merged).toMatchObject({ bounded: true, windows: 2, used: 2, missing: 0, invalid: 0, empty: 0 });
    expect(data.merged.estimate?.estimate).toBeCloseTo(46);
    expect(data.quantiles.map(window => window.total)).toEqual([10, 10]);
  });
  it("reports no p95 and no total without a +Inf bucket", () => {
    const data = buildDistribution([bucket("10", [5, 0]), bucket("50", [10, 10])], {});
    expect(data.quantiles.map(window => [window.state, window.p95, window.total])).toEqual([["unbounded", null, null], ["unbounded", null, null]]);
    expect(data.merged).toMatchObject({ estimate: null, bounded: false, used: 0 });
  });
  it("keeps every window unbounded without +Inf, but still reports the gap for sampling and counts", () => {
    const data = buildDistribution([bucket("10", [5, null, 5]), bucket("50", [10, 10, 4])], {});
    expect(data.quantiles.map(window => [window.state, window.gap, window.total, window.p95])).toEqual([
      ["unbounded", null, null, null], ["unbounded", "missing", null, null], ["unbounded", "invalid", null, null],
    ]);
    expect(data.merged).toMatchObject({ bounded: false, used: 0, missing: 1, invalid: 1 });
  });
  it("leaves missing and invalid windows out of the merge, and reports their counts", () => {
    const data = buildDistribution([bucket("10", [5, null, 5, 0]), bucket("50", [10, 10, 4, 0]), bucket("+Inf", [10, 10, 10, 0])], {});
    expect(data.quantiles.map(window => window.state)).toEqual(["ok", "missing", "invalid", "empty"]);
    expect(data.quantiles.map(window => window.total)).toEqual([10, null, null, 0]);
    expect(data.merged).toMatchObject({ windows: 4, used: 2, missing: 1, invalid: 1, empty: 1 });
    expect(data.merged.estimate?.estimate).toBeCloseTo(46);
  });
  it("quotes the highest window and marks an overflow p95 as above its last finite bound", () => {
    const data = buildDistribution([bucket("10", [5, 2]), bucket("50", [10, 6]), bucket("+Inf", [10, 10])], {});
    expect(data.quantiles[1].p95).toMatchObject({ bucket: 2, overflow: true, estimate: null, lower: 50 });
    expect(data.highest).toMatchObject({ timestamp: 2000, p95: { overflow: true, lower: 50 } });
    expect(data.merged.estimate).toMatchObject({ overflow: true, lower: 50 });
  });
  it("keeps a p95-only spike when sampling, because the magnitude rule would drop it", () => {
    // Ordinary windows put 90% in the second bucket. The spike has the smallest largest-bucket count but
    // pushes its p95 into +Inf, so only the peak rule keeps it.
    const ordinary = Array.from({ length: 40 }, () => [900, 90, 10]);
    ordinary[17] = [600, 300, 100];
    const spike = 17 * 1000 + 1000;
    const values = [0, 1, 2].map(row => ordinary.map(counts => counts[row]));
    const data = buildDistribution([bucket("10", values[0]), bucket("50", values[0].map((v, i) => v + values[1][i])), bucket("+Inf", values[0].map((v, i) => v + values[1][i] + values[2][i]))], { maxColumns: 8 });
    expect(data.sampled).toBe(true);
    expect(data.timestamps).toContain(spike);
    expect(data.quantiles.find(window => window.timestamp === spike)?.p95?.overflow).toBe(true);
    expect(data.highest).toMatchObject({ timestamp: spike, p95: { overflow: true } });
  });
  it("breaks the p95 line before a sampled column when an unsampled window in between is not ok", () => {
    // Window 10 is observed zero (empty), which sampling may drop. The column after it must break the line.
    const counts = Array.from({ length: 40 }, () => [900, 90, 10]);
    counts[10] = [0, 0, 0];
    const values = [0, 1, 2].map(row => counts.map(c => c[row]));
    const data = buildDistribution([bucket("10", values[0]), bucket("50", values[0].map((v, i) => v + values[1][i])), bucket("+Inf", values[0].map((v, i) => v + values[1][i] + values[2][i]))], { maxColumns: 8 });
    const indices = data.timestamps.map(timestamp => timestamp / 1000 - 1);
    expect(indices).not.toContain(10);
    const after = data.quantiles.findIndex((window, position) => position > 0 && indices[position - 1] < 10 && indices[position] > 10);
    expect(data.quantiles[after].breakBefore).toBe(true);
    expect(data.quantiles[0].breakBefore).toBe(false);
  });
  it("counts a gap above maxBuckets as hidden, and a gap in a displayed bucket as shown", () => {
    const hidden = buildDistribution([bucket("10", [1, 1, 1]), bucket("50", [2, 2, 2]), bucket("100", [3, null, 3]), bucket("+Inf", [4, 4, 4])], { maxBuckets: 2 });
    expect(hidden.quantiles.map(window => [window.state, window.gap, window.hiddenGap])).toEqual([["ok", null, false], ["missing", "missing", true], ["ok", null, false]]);
    expect(hidden.merged).toMatchObject({ missing: 1, hiddenMissing: 1, invalid: 0, hiddenInvalid: 0 });
    const invalid = buildDistribution([bucket("10", [1, 1]), bucket("50", [2, 2]), bucket("100", [3, 1]), bucket("+Inf", [4, 4])], { maxBuckets: 2 });
    expect(invalid.merged).toMatchObject({ invalid: 1, hiddenInvalid: 1, hiddenMissing: 0 });
    const shown = buildDistribution([bucket("10", [1, null]), bucket("50", [2, 2]), bucket("100", [3, null]), bucket("+Inf", [4, 4])], { maxBuckets: 2 });
    expect(shown.quantiles[1]).toMatchObject({ gap: "missing", hiddenGap: false });
    expect(shown.merged).toMatchObject({ missing: 1, hiddenMissing: 0 });
  });
  it("keeps the window to quote and each overflow run's edges, so other overflow windows compete by magnitude", () => {
    // Windows 0 and 10 have finite p95s; every other window's p95 is in +Inf. Window 10 is by far the densest.
    const first = Array.from({ length: 40 }, (_, index) => index === 0 ? 10 : index === 10 ? 500 : 0);
    const inf = Array.from({ length: 40 }, (_, index) => index === 0 ? 10 : index === 10 ? 500 : 10);
    const data = buildDistribution([bucket("10", first), bucket("50", first), bucket("+Inf", inf)], { maxColumns: 8 });
    expect(data.quantiles.map(window => window.p95?.overflow)).toContain(true);
    expect(data.quantiles[0].p95?.overflow).toBe(false);
    expect(data.highest).toMatchObject({ timestamp: 2000, p95: { overflow: true } });
    // The first overflow window is forced. Overflow 1-9 is one run, so its last window (10 s) is protected too, and the
    // densest window in the interval (11 s) is kept beside it. Window 8 is neither a run edge nor the densest, so it is dropped.
    expect(data.timestamps).toContain(2000);
    expect(data.timestamps).toContain(10000);
    expect(data.timestamps).toContain(11000);
    expect(data.timestamps).not.toContain(8000);
  });
  it("keeps the first and last window of every overflow run in a long window, not only the first excursion", () => {
    // Overflow at 101 s and 401 s out of 600 windows: each p95 lies in +Inf, and each one-window run is protected.
    const n = 600, overflowAt = [100, 400];
    const b10 = Array.from({ length: n }, (_, i) => overflowAt.includes(i) ? 50 : 90);
    const b50 = Array.from({ length: n }, (_, i) => overflowAt.includes(i) ? 80 : 99);
    const inf = Array.from({ length: n }, () => 100);
    const data = buildDistribution([bucket("10", b10), bucket("50", b50), bucket("+Inf", inf)], { maxColumns: 60 });
    expect(data.quantiles.filter(window => window.p95?.overflow).map(window => window.timestamp)).toEqual([101000, 401000]);
    expect(data.highest).toMatchObject({ timestamp: 101000, p95: { overflow: true } });
    expect(data.timestamps.length).toBeLessThanOrEqual(60);
  });
});

describe("stacked columns, partial stacks and totals", () => {
  it("counts a track as not started before its first observation and missing after it, while a trailing absence is inside its grace", () => {
    // B has one sample, so it has no cadence of its own. A has too few samples for a peer cadence, so B's trailing absence
    // has no grace that it could outlast and stays missing.
    const data = buildMetricPlot([series("A", [1, null, 3]), series("B", [null, 2, null])], {});
    expect(data.columns.map(column => [column.missing, column.notStarted, column.ended])).toEqual([[[], [1], []], [[0], [], []], [[1], [], []]]);
  });
  it("keeps a series that ended from counting as missing once its grace has passed, so the stack total survives pod churn", () => {
    // old reports at 1-3 s, new starts at 4 s, steady reports throughout. old's grace is two of its one-second cadence,
    // so at 4 and 5 s it is missing and the total is null. At 6 s it has ended and the total returns.
    const old = series("old", [2, 2, 2, null, null, null]), fresh = series("new", [null, null, null, 2, 2, 2]), steady = series("steady", [1, 1, 1, 1, 1, 1]);
    const data = buildMetricPlot([steady, old, fresh], stackedConfigSchema.parse({ display: "bar" }));
    expect(data.columns.map(column => [column.missing, column.notStarted, column.ended])).toEqual([
      [[], [2], []], [[], [2], []], [[], [2], []], [[1], [], []], [[1], [], []], [[], [], [1]],
    ]);
    expect(data.totals.map(total => total.value)).toEqual([3, 3, 3, null, null, 3]);
    expect(data.tracks.map(track => track.lastFinite)).toEqual([6000, 3000, 6000]);
  });
  it("reports each track's last finite time from the unzoomed history, or null when it never reported", () => {
    const full = [series("A", [1, 2, 3]), series("B", [5, null, null]), series("C", [null, null, null])];
    const zoomed = full.map(entry => ({ ...entry, points: entry.points.filter(point => point.timestamp >= 2000) }));
    expect(buildMetricPlot(zoomed, {}, false, full).tracks.map(track => track.lastFinite)).toEqual([3000, 1000, null]);
  });
  it("keeps a track that reported before a zoomed window missing inside it when the unzoomed history is given", () => {
    const full = [series("A", [1, 2, 3]), series("B", [5, null, 6])];
    const zoomed = full.map(entry => ({ ...entry, points: entry.points.filter(point => point.timestamp >= 2000) }));
    expect(buildMetricPlot(zoomed, {}, false, full).columns.map(column => [column.missing, column.notStarted])).toEqual([[[1], []], [[], []]]);
  });
  it("stacks the reporting tracks of an incomplete column on the complete stack's running sums", () => {
    const data = buildMetricPlot([series("A", [2, 2]), series("B", [3, null]), series("C", [-1, -1])], {});
    expect(data.columns[0]).toMatchObject({ total: 4, partial: [] });
    // B's only sample is at 1 s, so its absence at 2 s is inside its grace: it is missing, the total is null, and the
    // partial stack still stacks A and C on the complete stack's running sums.
    expect(data.columns[1]).toMatchObject({ total: null, missing: [1], notStarted: [], ended: [] });
    expect(data.columns[1].partial).toEqual([{ index: 0, lower: 0, upper: 2 }, { index: 2, lower: 0, upper: -1 }]);
    const signed = buildMetricPlot([series("A", [2, 2]), series("B", [-3, null]), series("C", [1, 1])], {});
    expect(signed.columns[1].partial).toEqual([{ index: 0, lower: 0, upper: 2 }, { index: 2, lower: 2, upper: 3 }]);
  });
  it("reports a stack total only for a complete, finite column", () => {
    const data = buildMetricPlot([series("A", [4, 8, 1e308]), series("B", [3, null, 1e308]), series("C", [1, 2, 0])], {});
    expect(data.totals.map(total => total.value)).toEqual([8, null, null]);
    expect(data.columns[2]).toMatchObject({ total: null, overflow: true, partial: [] });
    expect(data.overflowColumns).toBe(1);
  });
  it("keeps totals at every unsampled timestamp while columns follow the displayed samples", () => {
    const values = Array.from({ length: 100 }, (_, index) => index === 25 ? null : index);
    const data = buildMetricPlot([series("A", values), series("B", values.map(value => value === null ? null : 1))], { maxPoints: 12 });
    expect(data.timestamps).toHaveLength(12);
    expect(data.columns.map(column => column.timestamp)).toEqual(data.timestamps);
    expect(data.totals).toHaveLength(100);
    expect(data.totals.slice(0, 3).map(total => total.value)).toEqual([1, 2, 3]);
    expect(data.totals[25]).toEqual({ timestamp: 26000, value: null });
  });
  it("gives directional columns empty stack data", () => {
    const data = buildMetricPlot([series("in", [4, null], { direction: "inbound" }), series("out", [1, 2], { direction: "outbound" })], {}, true);
    expect(data.columns).toEqual([
      { timestamp: 1000, total: null, missing: [], notStarted: [], ended: [], partial: [] },
      { timestamp: 2000, total: null, missing: [], notStarted: [], ended: [], partial: [] },
    ]);
    expect(data.totals).toEqual([{ timestamp: 1000, value: null }, { timestamp: 2000, value: null }]);
  });
  it("includes partial stacks in the bar-mode domain, and leaves the area-mode domain to complete stacks", () => {
    const spike = [series("A", [1, 1, 50]), series("B", [null, 1, null])];
    expect(buildMetricPlot(spike, {}).domain).toEqual([0, 2]);
    expect(buildMetricPlot(spike, stackedConfigSchema.parse({ display: "bar" })).domain).toEqual([0, 50]);
    // With no complete column, bar mode still shows the reporting stacks instead of an empty [0, 1] axis.
    const sparse = [series("A", [null, 40]), series("B", [7, null])];
    expect(buildMetricPlot(sparse, stackedConfigSchema.parse({ display: "bar" })).domain).toEqual([0, 40]);
  });
  it("omits a column whose reporting stack overflows, even when another series has not started", () => {
    const data = buildMetricPlot([series("A", [1e308]), series("B", [1e308]), series("C", [null])], stackedConfigSchema.parse({ display: "bar" }));
    expect(data.columns[0]).toMatchObject({ overflow: true, partial: [], total: null, notStarted: [2] });
    expect(data.overflowColumns).toBe(1);
  });
  it("keeps a series that misses only its newest sample missing rather than ended, so the newest total is null", () => {
    const data = buildMetricPlot([series("a", [10, 10, 10, 10, 10, 10]), series("b", [10, 10, 10, 10, 10, 10]), series("c", [10, 10, 10, 10, 10, null])], stackedConfigSchema.parse({ display: "bar" }));
    expect(data.columns.at(-1)).toMatchObject({ total: null, missing: [2], ended: [], notStarted: [] });
    expect(data.totals.at(-1)?.value).toBeNull();
  });
  it("treats the skill's [4, 7, null] tail the same way: missing at its final sample, with no total", () => {
    const data = buildMetricPlot([series("tail", [4, 7, null]), series("steady", [1, 1, 1]), series("other", [2, 2, 2])], stackedConfigSchema.parse({ display: "bar" }));
    expect(data.columns.at(-1)).toMatchObject({ total: null, missing: [0], ended: [] });
    expect(data.columns[1]).toMatchObject({ total: 10, missing: [] });
  });
  it("ends a missing track only once its trailing absence outlasts two cadences, and the total then returns", () => {
    const tracks = [series("a", [10, 10, 10, 10, 10, 10]), series("b", [10, 10, 10, 10, 10, 10]), series("c", [10, 10, 10, null, null, null])];
    const barConfig = stackedConfigSchema.parse({ display: "bar" });
    const data = buildMetricPlot(tracks, barConfig);
    expect(data.columns.map(column => [column.missing, column.ended])).toEqual([[[], []], [[], []], [[], []], [[2], []], [[2], []], [[], [2]]]);
    expect(data.totals.map(total => total.value)).toEqual([30, 30, 30, null, null, 20]);
    // The widget's staleAfterSeconds lengthens the grace when it outlasts two cadences.
    const stale = buildMetricPlot(tracks, barConfig, false, undefined, { staleAfterSeconds: 10 });
    expect(stale.columns.map(column => column.ended)).toEqual([[], [], [], [], [], []]);
    expect(stale.columns.at(-1)?.missing).toEqual([2]);
  });
  it("gives a track with fewer than three samples its peers' median cadence, so its own short life does not decide the end", () => {
    const data = buildMetricPlot([series("short", [5, 5, null, null, null, null]), series("a", [10, 10, 10, 10, 10, 10]), series("b", [10, 10, 10, 10, 10, 10])], stackedConfigSchema.parse({ display: "bar" }));
    expect(data.columns.slice(2).map(column => [column.missing, column.ended])).toEqual([[[0], []], [[0], []], [[], [0]], [[], [0]]]);
  });
  it("makes every absence missing on a truncated result, so no series is called ended or not started", () => {
    // old reports at 1-3 s and new at 4-6 s. On a cut result an absence may be a cut, so it is never an end or a late start.
    const old = series("old", [2, 2, 2, null, null, null]), fresh = series("new", [null, null, null, 2, 2, 2]), steady = series("steady", [1, 1, 1, 1, 1, 1]);
    const data = buildMetricPlot([steady, old, fresh], stackedConfigSchema.parse({ display: "bar" }), false, undefined, { truncated: true });
    expect(data.columns.map(column => [column.missing, column.notStarted, column.ended])).toEqual([
      [[2], [], []], [[2], [], []], [[2], [], []], [[1], [], []], [[1], [], []], [[1], [], []],
    ]);
    expect(data.columns.every(column => column.total === null)).toBe(true);
  });
});

describe("sampling priority", () => {
  it("keeps a missing column over a peak, and a peak over magnitude", () => {
    expect(sampleTimeIndices(10, 4, () => false, index => index)).toEqual([0, 4, 8, 9]);
    expect(sampleTimeIndices(10, 4, () => false, index => index, index => index === 3)).toEqual([0, 3, 8, 9]);
    expect(sampleTimeIndices(10, 4, index => index === 2, index => index, index => index === 3)).toEqual([0, 2, 8, 9]);
    expect(sampleTimeIndices(10, 4, index => index === 5, () => 0)).toEqual([0, 1, 5, 9]);
  });
  it("with twoPerBucket keeps a bucket's protected column and its peak within the limit", () => {
    // Two per bucket would keep [0, 2, 4, 8, 9], one over the limit of 4. One bucket then keeps the protected 2 and the peak 8.
    expect(sampleTimeIndices(10, 4, index => index === 2, index => index, () => false, { twoPerBucket: true })).toEqual([0, 2, 8, 9]);
    expect(sampleTimeIndices(1000, 12, () => true, index => index, () => false, { twoPerBucket: true }).length).toBeLessThanOrEqual(12);
  });
  it("gives a missing column its bucket's protected slot over an edge that comes first in the bucket", () => {
    // Bucket [1, 10) holds edge 5 before gap 7. The gap keeps the slot in every bucketing, and the edge is left out for lack of room.
    expect(sampleTimeIndices(20, 4, index => index === 7, index => index, () => false, { edge: index => index === 5 })).toEqual([0, 7, 18, 19]);
    expect(sampleTimeIndices(20, 4, index => index === 7, index => index, () => false, { twoPerBucket: true, edge: index => index === 5 })).toEqual([0, 7, 18, 19]);
  });
});

// Deterministic pseudo-random inputs (mulberry32), so a failing case reproduces exactly.
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("sampling budget", () => {
  it("keeps the ends in order, stays within the limit, and keeps a lone missing column and a peak, for random inputs and limits", () => {
    const random = seeded(7);
    for (let trial = 0; trial < 500; trial++) {
      const length = 1 + Math.floor(random() * 400), limit = 2 + Math.floor(random() * 130);
      const gaps = new Set(Array.from({ length: Math.floor(random() * 40) }, () => Math.floor(random() * length)));
      const edges = new Set(Array.from({ length: Math.floor(random() * 40) }, () => Math.floor(random() * length)));
      const magnitudes = Array.from({ length }, () => Math.floor(random() * 50));
      const spike = Math.floor(random() * length);
      const kept = sampleTimeIndices(length, limit, index => gaps.has(index), index => magnitudes[index], index => index === spike, { twoPerBucket: true, edge: index => edges.has(index) });
      const context = `length ${length}, limit ${limit}, gaps ${[...gaps].join(",")}, edges ${[...edges].join(",")}, spike ${spike}`;
      expect(kept.length, context).toBeLessThanOrEqual(limit);
      expect(kept.every((index, position) => position === 0 || index > kept[position - 1]), context).toBe(true);
      if (length <= limit) continue;
      expect(kept[0], context).toBe(0);
      expect(kept.at(-1), context).toBe(length - 1);
      // A lone missing column survives from a limit of three, and the peak survives from a limit of four.
      const interior = [...gaps].filter(index => index > 0 && index < length - 1);
      if (interior.length === 1 && limit >= 3) expect(kept, context).toContain(interior[0]);
      if (spike > 0 && spike < length - 1 && limit >= 4) expect(kept, context).toContain(spike);
    }
  });
  it("keeps a heatmap within maxColumns for random histograms and budgets", () => {
    const random = seeded(11);
    const cell = () => random() < 0.05 ? null : Math.floor(random() * 100);
    for (let trial = 0; trial < 80; trial++) {
      const windows = 2 + Math.floor(random() * 300), maxColumns = 8 + Math.floor(random() * 113);
      const low = Array.from({ length: windows }, cell), mid = Array.from({ length: windows }, cell), high = Array.from({ length: windows }, cell);
      const data = buildDistribution([bucket("10", low), bucket("50", mid), bucket("+Inf", high)], { maxColumns });
      expect(data.timestamps.length, `${windows} windows, maxColumns ${maxColumns}`).toBeLessThanOrEqual(maxColumns);
    }
  });
  it("keeps bar mode within maxPoints for random series and budgets", () => {
    const random = seeded(13);
    for (let trial = 0; trial < 80; trial++) {
      const length = 2 + Math.floor(random() * 400), maxPoints = 12 + Math.floor(random() * 229);
      const tracks = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, track) => {
        const start = Math.floor(random() * length);
        return series(`track ${track}`, Array.from({ length }, (_, index) => index < start || random() < 0.05 ? null : Math.floor(random() * 100)));
      });
      const data = buildMetricPlot(tracks, stackedConfigSchema.parse({ display: "bar", maxPoints }));
      expect(data.timestamps.length, `${length} columns, maxPoints ${maxPoints}`).toBeLessThanOrEqual(maxPoints);
    }
  });
  it("keeps a 24-column heatmap within its budget when a window is missing, and keeps that window", () => {
    // One missing window in a 200-window history, shown in 24 columns: the missing window must stay and the budget must hold.
    const windows = 200, missingAt = 100;
    const low = Array.from({ length: windows }, (_, index) => index === missingAt ? null : 1 + (index * 7) % 13);
    const high = Array.from({ length: windows }, (_, index) => 20 + (index * 3) % 11);
    const data = buildDistribution([bucket("10", low), bucket("+Inf", high)], { maxColumns: 24 });
    expect(data.sampled).toBe(true);
    expect(data.timestamps.length).toBeLessThanOrEqual(24);
    expect(data.timestamps).toContain((missingAt + 1) * 1000);
    expect(data.rows[0].cells.find(cell => cell.timestamp === (missingAt + 1) * 1000)).toMatchObject({ value: null, state: "missing" });
  });
});

describe("bar-mode sampling, domain and overflow", () => {
  const bars = stackedConfigSchema.parse({ display: "bar" });
  // a reports 10 at every time except a spike of 1000 at 152 s. late starts at 291 s, so every earlier column is incomplete.
  const spikeAndLate = () => [
    series("a", Array.from({ length: 300 }, (_, index) => index === 151 ? 1000 : 10)),
    series("late", Array.from({ length: 300 }, (_, index) => index >= 290 ? 5 : null)),
  ];
  it("keeps a partial spike when sampling, and lets it set the bar domain", () => {
    const data = buildMetricPlot(spikeAndLate(), bars);
    expect(data.timestamps).toContain(152000);
    expect(data.tracks[0].cells.find(cell => cell.timestamp === 152000)?.value).toBe(1000);
    expect(data.columns.find(column => column.timestamp === 152000)).toMatchObject({ notStarted: [1], partial: [{ index: 0, lower: 0, upper: 1000 }] });
    expect(data.domain).toEqual([0, 1000]);
  });
  it("keeps area-mode sampling and domain on complete stacks, as before", () => {
    const data = buildMetricPlot(spikeAndLate(), {});
    expect(data.timestamps).not.toContain(152000);
    expect(data.domain).toEqual([0, 15]);
  });
  it("keeps a spike at 149 s next to a series that starts at 151 s, and lets the spike set the bar domain", () => {
    // Regression for the M3 review input: a 1000 spike at 149 s, beside a series that starts at 151 s, must be drawn and must set the domain.
    const data = buildMetricPlot([
      series("a", Array.from({ length: 300 }, (_, index) => index === 148 ? 1000 : 10)),
      series("late", Array.from({ length: 300 }, (_, index) => index >= 150 ? 5 : null)),
    ], bars);
    expect(data.timestamps).toContain(149000);
    expect(data.tracks[0].cells.find(cell => cell.timestamp === 149000)?.value).toBe(1000);
    expect(data.domain).toEqual([0, 1000]);
  });
  it("keeps a cap and a spike that share a sampling bucket, so sampling never trades one for the other", () => {
    // b misses only 148 s, so its cap run's edge is at 148 s, and a spikes to 1000 at 149 s, the next column in the same bucket.
    const data = buildMetricPlot([
      series("a", Array.from({ length: 300 }, (_, index) => index === 148 ? 1000 : 10)),
      series("b", Array.from({ length: 300 }, (_, index) => index === 147 ? null : 5)),
    ], bars);
    expect(data.timestamps).toContain(148000);
    expect(data.columns.find(column => column.timestamp === 148000)?.missing).toEqual([1]);
    expect(data.timestamps).toContain(149000);
    expect(data.domain[1]).toBeGreaterThanOrEqual(1005);
  });
  it("keeps every one-sample gap of a steady series inside churn, so each gap's cap survives sampling", () => {
    // Forty offsets of six single-sample gaps. old stops at 10 s and other reports throughout, so each gap is a one-column cap run.
    for (let offset = 0; offset < 40; offset++) {
      const gaps = Array.from({ length: 6 }, (_, k) => 20 + offset + k * 45);
      const data = buildMetricPlot([
        series("steady", Array.from({ length: 300 }, (_, index) => gaps.includes(index + 1) ? null : 10)),
        series("old", Array.from({ length: 300 }, (_, index) => index < 10 ? 5 : null)),
        series("other", Array.from({ length: 300 }, () => 3)),
      ], bars);
      expect(data.sampled).toBe(true);
      for (const gap of gaps) expect(data.columns.find(column => column.timestamp === gap * 1000)?.missing, `gap ${gap} s`).toEqual([0]);
    }
  });
  it("reports the bounds of complete stacks alone, so an overlay of this plot never widens the axis to partial stacks", () => {
    // The previous-period overlay draws complete stacks only. Its partial 100 must not reach the axis it is merged into.
    const data = buildMetricPlot([series("a", [1, 100, 1]), series("b", [1, null, 1])], bars);
    expect(data.domain).toEqual([0, 100]);
    expect(data.completeDomain).toEqual([0, 2]);
  });
  it("counts an incomplete column as overflowing only in bar mode, as before partial stacks existed", () => {
    const overflowing = [series("a", [1e308, 1]), series("b", [1e308, 1]), series("c", [null, 1])];
    const area = buildMetricPlot(overflowing, {});
    expect(area.overflowColumns).toBe(0);
    expect(area.columns[0].overflow).toBeUndefined();
    const barData = buildMetricPlot(overflowing, bars);
    expect(barData.overflowColumns).toBe(1);
    expect(barData.columns[0]).toMatchObject({ overflow: true, partial: [], total: null });
  });
});

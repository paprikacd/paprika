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
    expect(data.rows[2].labels).toEqual({ service: "api", le: "+Inf" });
  });
  it("does not bridge missing lower bounds or silently repair non-monotonic buckets", () => {
    const data = buildDistribution([bucket("1", [4, null, 6]), bucket("2", [3, 8, 10]), bucket("+Inf", [9, 9, 11])], {});
    expect(data.rows.map(row => row.cells.map(cell => cell.value))).toEqual([[4, null, 6], [null, null, 4], [6, 1, 1]]);
    expect(data.invalidCells).toBe(1);
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
  it("bounds rows and columns and preserves missing snapshots in a sampled interval", () => {
    const values = Array.from({ length: 100 }, (_, index) => index === 28 ? null : index);
    const data = buildDistribution([bucket("1", values), bucket("2", values.map(value => value === null ? null : value + 1))], { maxBuckets: 1, maxColumns: 8 });
    expect(data.rows).toHaveLength(1); expect(data.omittedBuckets).toBe(1);
    expect(data.timestamps).toHaveLength(8); expect(data.sampled).toBe(true);
    expect(data.rows[0].cells.some(cell => cell.timestamp === 29000 && cell.value === null)).toBe(true);
  });
});

describe("stack and directional geometry", () => {
  it("uses independent positive and negative baselines without changing observed values", () => {
    const data = buildMetricPlot([series("A", [3]), series("B", [-4]), series("C", [2]), series("D", [-6])], {});
    expect(data.tracks.map(track => [track.cells[0].lower, track.cells[0].upper, track.cells[0].value])).toEqual([[0, 3, 3], [0, -4, -4], [3, 5, 2], [-4, -10, -6]]);
    expect(data.domain).toEqual([-10, 5]);
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
    expect(data.domain).toEqual([-3, 8]);
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
  it("limits unsafe config instead of treating it as executable or unknown settings", () => {
    expect(distributionConfigSchema.safeParse({ maxColumns: 10000 }).success).toBe(false);
    expect(distributionConfigSchema.safeParse({ bucketLabel: "a.b" }).success).toBe(false);
    expect(stackedConfigSchema.safeParse({ display: "pie" }).success).toBe(false);
    expect(directionalConfigSchema.safeParse({ directionLabel: "direction", handler: "code" }).success).toBe(false);
    expect(stackedConfigSchema.safeParse({ legendDisplay: "table", legendPosition: "right" }).success).toBe(true);
    expect(directionalConfigSchema.safeParse({ legendDisplay: "table", legendPosition: "right" }).success).toBe(true);
    expect(stackedConfigSchema.safeParse({ legendDisplay: "full" }).success).toBe(false);
    expect(directionalConfigSchema.safeParse({ legendPosition: "left" }).success).toBe(false);
    expect(sampleTimeIndices(0, 12, () => false, () => 0)).toEqual([]);
  });
});

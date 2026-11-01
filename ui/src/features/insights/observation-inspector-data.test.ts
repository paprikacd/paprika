import { describe, expect, it } from "vitest";
import type { Series } from "./chart-data";
import { buildObservationInspector, inspectPreparedObservation, inspectionSeriesKey, prepareObservationInspector } from "./observation-inspector-data";

const series = (name: string, points: [number, number | null][], labels: Record<string, string> = {}): Series => ({
  name,
  labels,
  points: points.map(([timestamp, value]) => ({ timestamp, value })),
});

describe("observation inspector data", () => {
  it("keeps the window's history, counts its statistics, and reports invalid timestamps as excluded", () => {
    const prepared = prepareObservationInspector([
      { name: "cpu", labels: {}, points: [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: null }, { timestamp: 3000, value: 5 }, { timestamp: 4000, value: 7 }, { timestamp: Number.NaN, value: 9 }] },
    ], { start: 2000, end: 4000 });
    const [row] = prepared.rows;
    expect(prepared.windowed).toBe(true);
    expect([prepared.start, prepared.end]).toEqual([2000, 4000]);
    expect(row).toMatchObject({ sampleCount: 3, finiteCount: 2, missingCount: 1, min: 5, max: 7, invalidTimestampCount: 1 });
  });

  it("takes its bounds from the returned data when no window is given", () => {
    const prepared = prepareObservationInspector([series("a", [[3000, 1], [1000, 2]]), series("b", [[4000, 3]])]);
    expect(prepared.windowed).toBe(false);
    expect([prepared.start, prepared.end]).toEqual([1000, 4000]);
  });

  it("reports a missing sample as missing and a nearby sample as absent, never as the inspected time", () => {
    const data = [series("a", [[1000, 1], [2000, null], [3000, 5]])];
    const at = (timestamp: number) => buildObservationInspector(data, timestamp).rows[0].exact;
    expect(at(3000)).toEqual({ kind: "observed", value: 5 });
    expect(at(2000)).toEqual({ kind: "missing", value: null });
    expect(at(2500)).toEqual({ kind: "absent", value: null });
  });

  it("reports several samples at one timestamp as ambiguous and keeps each of them", () => {
    const inspected = buildObservationInspector([series("a", [[3000, 1], [3000, 2], [4000, 3]])], 3000);
    expect(inspected.rows[0].exact).toEqual({ kind: "ambiguous", value: null });
    expect(inspected.rows[0].exactSamples.map((point) => point.value)).toEqual([1, 2]);
  });

  it("keeps the selected series visible beyond the series limit, and counts what it omits", () => {
    const data = [series("a", [[1000, 1]]), series("b", [[1000, 2]]), series("c", [[1000, 3]])];
    const prepared = prepareObservationInspector(data, undefined, 2, 96, 2);
    expect(prepared.rows.map((row) => row.sourceIndex)).toEqual([0, 2]);
    expect(prepared.omittedSeries).toBe(1);
  });

  it("gives repeated series identities distinct keys, and ignores label order in identity", () => {
    const first = series("cpu", [[1000, 1]], { region: "eu", node: "a" });
    const second = series("cpu", [[1000, 2]], { node: "a", region: "eu" });
    expect(inspectionSeriesKey(first)).toBe(inspectionSeriesKey(second));
    const keys = prepareObservationInspector([first, second]).rows.map((row) => row.key);
    expect(new Set(keys).size).toBe(2);
  });

  it("thins a long history for display, while statistics keep every returned sample", () => {
    const points = Array.from({ length: 200 }, (_, index): [number, number] => [index * 1000, index]);
    const [row] = buildObservationInspector([series("ramp", points)], 50_000, undefined, 12, 16).rows;
    expect(row.points.length).toBeLessThanOrEqual(16);
    expect(row.reduced).toBe(true);
    expect(row.sampleCount).toBe(200);
    expect(row.max).toBe(199);
  });

  it("looks up exact observations on a prepared model without re-reading the series", () => {
    const prepared = prepareObservationInspector([series("a", [[1000, 1], [2000, 2]])]);
    expect(inspectPreparedObservation(prepared, 2000).rows[0].exact).toEqual({ kind: "observed", value: 2 });
    expect(inspectPreparedObservation(prepared, 1500).rows[0].exact).toEqual({ kind: "absent", value: null });
  });
});

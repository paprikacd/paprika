import { describe, expect, it } from "vitest";
import { historyHitSlices, statusHistoryLayout } from "./status-history-data";
import type { Series } from "../chart-data";

const series = (name: string, times: number[], values = times): Series => ({ name, labels: {}, points: times.map((timestamp, index) => ({ timestamp, value: values[index] })) });

describe("status history time layout", () => {
  it("uses a shared time axis and leaves missing periods blank instead of aligning samples by index", () => {
    const data = statusHistoryLayout([series("A", [0, 10, 20, 30]), series("B", [10, 30])], 60);
    expect(data.rows[0].cells[1].left).toBeCloseTo(data.rows[1].cells[0].left);
    expect(data.rows[0].cells[3].left).toBeCloseTo(data.rows[1].cells[1].left);
    expect(data.rows[1].cells[0].left + data.rows[1].cells[0].width).toBeLessThan(data.rows[1].cells[1].left);
  });
  it("shows an isolated sample without painting an invented duration", () => {
    const data = statusHistoryLayout([series("A", [100]), series("B", [1000])], 60);
    expect(data.rows.map(row => row.cells[0].width)).toEqual([2, 2]);
    expect(data.rows[0].cells[0].left).toBe(0);
    expect(data.rows[1].cells[0].left).toBe(100);
  });
  it("keeps missing observations, spikes and endpoints within the sampling budget", () => {
    const values = Array.from({ length: 100 }, (_, i) => i === 23 ? null : i === 27 ? 100 : i === 99 ? 5 : 0);
    const input: Series = { ...series("A", values.map((_, i) => i + 1)), points: values.map((value, i) => ({ timestamp: i + 1, value })) };
    const data = statusHistoryLayout([input], 8);
    expect(data.sampled).toBe(true);
    expect(data.rows[0].cells.length).toBeLessThanOrEqual(8);
    expect(data.rows[0].cells.map(cell => cell.point.value)).toEqual(expect.arrayContaining([null, 100, 5]));
  });
  it("fills a regularly observed, unchanged sampled interval without inventing gaps", () => {
    const data = statusHistoryLayout([series("A", Array.from({ length: 100 }, (_, i) => i + 1), Array.from({ length: 100 }, () => 1))], 8);
    expect(data.sampled).toBe(true);
    expect(data.rows[0].bridges.length).toBeGreaterThan(0);
    expect(data.rows[0].bridges.every(bridge => bridge.kind === "stable" && bridge.value === 1)).toBe(true);
  });
  it("marks hidden status changes and missing samples as mixed instead of extending a state across them", () => {
    const values = Array.from({ length: 100 }, (_, i) => i === 24 ? null : i === 25 || i === 70 ? 3 : 0);
    const input: Series = { ...series("A", values.map((_, i) => i + 1)), points: values.map((value, i) => ({ timestamp: i + 1, value })) };
    const data = statusHistoryLayout([input], 8, [{ value: 0, color: "green" }, { value: 2, color: "red" }]);
    expect(data.rows[0].bridges.some(bridge => bridge.kind === "mixed" && bridge.hasMissing)).toBe(true);
    expect(data.rows[0].bridges.some(bridge => bridge.kind === "mixed" && bridge.hasChange)).toBe(true);
    expect(data.rows[0].bridges.every(bridge => bridge.kind !== "stable" || (!bridge.hasMissing && !bridge.hasChange))).toBe(true);
  });
  it("leaves irregular cadence breaks empty and discloses duplicate timestamps", () => {
    const irregular = statusHistoryLayout([series("A", [0, 10, 20, 100, 110])], 60);
    expect(irregular.rows[0].bridges.some(bridge => bridge.kind === "gap")).toBe(true);
    const duplicate = statusHistoryLayout([series("A", [0, 10, 10, 20], [0, 0, 2, 2])], 60, [{ value: 0, color: "green" }, { value: 2, color: "red" }]);
    expect(duplicate.duplicateTimes).toBe(true);
    expect(duplicate.rows[0].bridges.some(bridge => bridge.kind === "mixed")).toBe(true);
  });
});

describe("status history pointer slices", () => {
  it("never overlap in a dense lane, and always contain their own sample's centre and drawn edges", () => {
    const lane = 300, marks = Array.from({ length: 85 }, (_, index) => ({ centre: 2 + index * (lane - 4) / 84, halfWidth: 1.9 }));
    const slices = historyHitSlices(marks.map(mark => ({ centre: mark.centre, halfWidth: Math.max(3, mark.halfWidth) })), lane);
    slices.forEach((slice, index) => {
      // The drawn edge sits 1.9 px out; a point 0.75 px inside it must still belong to this sample.
      expect(slice.start).toBeLessThanOrEqual(marks[index].centre - 1.15);
      expect(slice.end).toBeGreaterThanOrEqual(marks[index].centre + 1.15);
      if (index > 0) expect(slice.start).toBeGreaterThanOrEqual(slices[index - 1].end - 1e-9);
    });
  });
  it("clamps endpoint slices to the lane and keeps each slice within its own reach", () => {
    const slices = historyHitSlices([{ centre: 0, halfWidth: 3 }, { centre: 200, halfWidth: 3 }], 200);
    expect(slices).toEqual([{ start: 0, end: 3 }, { start: 197, end: 200 }]);
  });
  it("does not extend a slice over a distant neighbour", () => {
    const slices = historyHitSlices([{ centre: 10, halfWidth: 3 }, { centre: 200, halfWidth: 3 }], 300);
    expect(slices[0]).toEqual({ start: 7, end: 13 });
    expect(slices[1]).toEqual({ start: 197, end: 203 });
  });
});


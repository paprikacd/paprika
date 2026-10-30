import { describe, expect, it } from "vitest";
import { nearestStatHistoryIndex, statHistoryObservations } from "./stat-history-interaction";

describe("actual stat history selection", () => {
  it("sorts actual observations and retains last-input missing duplicate", () => {
    const original = [{ timestamp: 30, value: 4 }, { timestamp: 10, value: 0 }, { timestamp: 30, value: null }, { timestamp: NaN, value: 9 }, { timestamp: 20, value: Infinity }];
    const before = structuredClone(original);
    expect(statHistoryObservations(original)).toEqual([{ timestamp: 10, value: 0 }, { timestamp: 20, value: null }, { timestamp: 30, value: null }]);
    expect(original).toEqual(before);
  });
  it("selects by actual time distance, not array offset or the rendered sample budget", () => {
    const points = statHistoryObservations([{ timestamp: 0, value: 1 }, { timestamp: 10, value: null }, { timestamp: 1000, value: 7 }]);
    expect(nearestStatHistoryIndex(points, 400)).toBe(1);
    expect(nearestStatHistoryIndex(points, 505)).toBe(2);
    expect(nearestStatHistoryIndex(points, -50)).toBe(0);
    expect(nearestStatHistoryIndex(points, 2000)).toBe(2);
    expect(nearestStatHistoryIndex([], 4)).toBe(-1);
  });
});

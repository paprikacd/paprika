import { describe, expect, it } from "vitest";
import { nearestStatHistoryIndex, statHistoryObservations, statPlotRectangle } from "./stat-history-interaction";

describe("actual stat history selection", () => {
  it("centres the inspector anchor on the drawn sample inside the stretched plot", () => {
    expect(statPlotRectangle({ left: 100, top: 50, width: 480, height: 128 }, 120, 32)).toEqual({ left: 337, top: 111, width: 6, height: 6 });
    expect(statPlotRectangle({ left: 0, top: 0, width: 240, height: 64 }, 1, 60)).toEqual({ left: -2, top: 57, width: 6, height: 6 });
  });

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

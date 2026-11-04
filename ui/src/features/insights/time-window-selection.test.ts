import { describe, expect, it } from "vitest";
import * as timeWindow from "./time-window";
import {
  formatWindowDuration,
  minimumTimeWindow,
  moveTimeWindowEdge,
  nearestTimeIndex,
  normalizeTimeWindow,
  observationsInWindow,
  sameTimeWindow,
  timeWindowExtent,
  timeWindowFromPixels,
  timeWindowStep,
} from "./time-window";

const series = [
  { points: [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: null }, { timestamp: 9000, value: 4 }] },
  { points: [{ timestamp: 1500, value: 2 }, { timestamp: Number.NaN, value: 9 }] },
];

describe("chart time windows", () => {
  it("keeps the dashboard window exports working beside the chart helpers", () => {
    expect(typeof timeWindow.observationTimes).toBe("function");
    expect(typeof timeWindow.seriesInWindow).toBe("function");
    expect(typeof timeWindow.compareWindow).toBe("function");
    expect(typeof timeWindow.comparePriorPeriod).toBe("function");
    expect(typeof timeWindow.alignPriorPeriod).toBe("function");
  });

  it("spans every valid observation and ignores timestamps outside the representable range", () => {
    expect(timeWindowExtent(series)).toEqual({ start: 1000, end: 9000 });
    expect(timeWindowExtent([{ points: [{ timestamp: 5000, value: 1 }] }])).toBeNull();
    expect(timeWindowExtent([{ points: [{ timestamp: 9e15, value: 1 }, { timestamp: 2000, value: 1 }, { timestamp: 4000, value: 1 }] }])).toEqual({ start: 2000, end: 4000 });
  });

  it("requires two of the densest source intervals, never less than a ten-thousandth of the extent", () => {
    const extent = { start: 0, end: 1_000_000 };
    // Two source intervals of 10 ms are 20 ms, below the 100 ms floor of a ten-thousandth of the extent.
    expect(minimumTimeWindow([{ points: [{ timestamp: 0, value: 1 }, { timestamp: 10, value: 1 }, { timestamp: 20, value: 1 }] }], extent)).toBe(100);
    // Two source intervals of 5 s are 10 s, which exceeds the floor.
    expect(minimumTimeWindow([{ points: [{ timestamp: 0, value: 1 }, { timestamp: 5000, value: 1 }] }], extent)).toBe(10_000);
    // A single observation has no interval, so the whole extent is the only honest minimum.
    expect(minimumTimeWindow([{ points: [{ timestamp: 0, value: 1 }] }], extent)).toBe(1_000_000);
  });

  it("clamps, rounds and orders a candidate, then rejects a span below the minimum", () => {
    const extent = { start: 1000, end: 9000 };
    expect(normalizeTimeWindow({ start: 9200.4, end: 500 }, extent, 10)).toEqual({ start: 1000, end: 9000 });
    expect(normalizeTimeWindow({ start: 4000.6, end: 2000.2 }, extent, 10)).toEqual({ start: 2000, end: 4001 });
    expect(normalizeTimeWindow({ start: 4000, end: 4005 }, extent, 10)).toBeNull();
    expect(normalizeTimeWindow({ start: Number.NaN, end: 4000 }, extent)).toBeNull();
  });

  it("compares windows by their exact edges", () => {
    expect(sameTimeWindow({ start: 1, end: 2 }, { start: 1, end: 2 })).toBe(true);
    expect(sameTimeWindow({ start: 1, end: 2 }, { start: 1, end: 3 })).toBe(false);
  });

  it("maps pointer positions inside a plot to a time window", () => {
    const domain = { start: 0, end: 10_000 };
    expect(timeWindowFromPixels(100, 300, 100, 200, domain, 1)).toEqual({ start: 0, end: 10_000 });
    expect(timeWindowFromPixels(150, 250, 100, 200, domain, 1)).toEqual({ start: 2500, end: 7500 });
    expect(timeWindowFromPixels(40, 200, 100, 200, domain, 1)).toEqual({ start: 0, end: 5000 });
    expect(timeWindowFromPixels(40, 60, 100, 200, domain, 1)).toBeNull();
    expect(timeWindowFromPixels(150, 250, 100, 0, domain, 1)).toBeNull();
  });

  it("keeps null gaps inside the window and includes neighbours only when asked", () => {
    const points = [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: null }, { timestamp: 3000, value: 3 }, { timestamp: 4000, value: 4 }];
    const window = { start: 2000, end: 3000 };
    expect(observationsInWindow(points, window)).toEqual([{ timestamp: 2000, value: null }, { timestamp: 3000, value: 3 }]);
    expect(observationsInWindow(points, window, true)).toEqual([{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: null }, { timestamp: 3000, value: 3 }, { timestamp: 4000, value: 4 }]);
  });

  it("finds the nearest valid point, keeping the earlier one on a tie", () => {
    const points = [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: 2 }, { timestamp: Number.NaN, value: 3 }, { timestamp: 3000, value: 4 }];
    expect(nearestTimeIndex(points, 2400)).toBe(1);
    expect(nearestTimeIndex(points, 2500)).toBe(1);
    expect(nearestTimeIndex(points, 2600, { start: 2500, end: 4000 })).toBe(3);
    expect(nearestTimeIndex(points, 9000, { start: 5000, end: 6000 })).toBeNull();
  });

  it("moves one edge while the opposite edge stays fixed and the minimum span holds", () => {
    const extent = { start: 0, end: 10_000 };
    const window = { start: 2000, end: 6000 };
    expect(moveTimeWindowEdge(window, extent, "start", 4500, 500)).toEqual({ start: 4500, end: 6000 });
    expect(moveTimeWindowEdge(window, extent, "start", 9000, 500)).toEqual({ start: 5500, end: 6000 });
    expect(moveTimeWindowEdge(window, extent, "end", 1000, 500)).toEqual({ start: 2000, end: 2500 });
    expect(moveTimeWindowEdge(window, extent, "end", -50, 500)).toEqual({ start: 2000, end: 2500 });
    expect(moveTimeWindowEdge(window, extent, "end", Number.POSITIVE_INFINITY, 500)).toBeNull();
  });

  it("steps by one percent of the extent but never below the minimum span", () => {
    expect(timeWindowStep({ start: 0, end: 10_000 }, 1)).toBe(100);
    expect(timeWindowStep({ start: 0, end: 10_000 }, 250)).toBe(250);
  });

  it("formats durations at the scale a reader expects", () => {
    expect(formatWindowDuration(1500)).toBe("1.5s");
    expect(formatWindowDuration(90_000)).toBe("1.5m");
    expect(formatWindowDuration(5_400_000)).toBe("1.5h");
    expect(formatWindowDuration(129_600_000)).toBe("1.5d");
  });
});

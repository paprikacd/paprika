import { describe, expect, it } from "vitest";
import { metricPriorPeriod } from "./metric-prior-period";
import type { MetricSeries } from "./rich-metrics-data";

const series = (name: string, labels: Record<string, string>, points: [number, number | null][]): MetricSeries => ({ name, labels, points: points.map(([timestamp, value]) => ({ timestamp, value })) });
const bounds = { start: 1000, end: 2000 };
const first = series("in", { direction: "inbound" }, [[1000, 7], [2000, 8]]);
const second = series("out", { direction: "outbound" }, [[1000, 2], [2000, 4]]);

describe("previous metric plot matching", () => {
  it("aligns all recorded stacked contributions without filling missing values", () => {
    const oldFirst = series("in", { direction: "inbound" }, [[0, 1], [500, null], [999, 3]]);
    const oldSecond = series("out", { direction: "outbound" }, [[0, 2], [500, 5], [999, 6]]);
    const matched = metricPriorPeriod([first, second], [oldSecond, oldFirst], bounds, false);
    expect(matched.map(item => item.index)).toEqual([0, 1]);
    expect(matched[0].original.points).toEqual(oldFirst.points);
    expect(matched[0].shifted.points).toEqual([{ timestamp: 1000, value: 1 }, { timestamp: 1500, value: null }, { timestamp: 1999, value: 3 }]);
  });
  it("never renders a partial stacked boundary when a contribution is missing or ambiguous", () => {
    const oldFirst = series("in", { direction: "inbound" }, [[500, 3]]);
    expect(metricPriorPeriod([first, second], [oldFirst], bounds, false)).toEqual([]);
    expect(metricPriorPeriod([first, second], [oldFirst, oldFirst], bounds, false)).toEqual([]);
  });
  it("allows independently matched directions but never matches an ambiguous direction", () => {
    const oldFirst = series("in", { direction: "inbound" }, [[500, 3]]);
    expect(metricPriorPeriod([first, second], [oldFirst], bounds, true).map(item => item.index)).toEqual([0]);
    expect(metricPriorPeriod([first, second], [oldFirst, oldFirst], bounds, true)).toEqual([]);
  });
});

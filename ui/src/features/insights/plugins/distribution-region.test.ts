import { describe, expect, it } from "vitest";
import { buildDistribution, compareHistogramLabels, traceQLForRegion, type MetricSeries } from "./rich-metrics-data";

// Cumulative histogram counts per route. Bucket boundaries are 1 and +Inf, so bucket 0 is "≤ 1" and bucket 1 is "> 1".
function histogram(route: string, cumulative: Record<string, number[]>): MetricSeries[] {
  return Object.entries(cumulative).map(([le, values]) => ({
    name: "latency_bucket",
    labels: { le, route },
    points: values.map((value, index) => ({ timestamp: (index + 1) * 1000, value })),
  }));
}

const config = { bucketLabel: "le", aggregation: "sum" as const };
const late = { startTs: 2000, endTs: 2000, lowBucket: 1, highBucket: 1 };

describe("label comparison inside a latency region", () => {
  it("ranks the labels that split the selected cells from the rest, and says where the selected share sits", () => {
    const series = [
      ...histogram("/slow", { "1": [1, 1], "+Inf": [2, 10] }),
      ...histogram("/fast", { "1": [5, 9], "+Inf": [6, 11] }),
    ];
    const result = compareHistogramLabels(series, config, late);
    expect(result.groups).toBe(2);
    expect(result.keys.map(entry => entry.key)).toEqual(["route"]);
    const [route] = result.keys;
    expect(route.values[0]).toMatchObject({ value: "/slow" });
    expect(route.values[0].selected).toBeGreaterThan(route.values[0].rest);
    expect(route.score).toBeGreaterThan(0);
    expect(result.selectedShare).toBeGreaterThan(0);
    expect(result.selectedShare).toBeLessThan(1);
  });

  it("shows the top eight values and pools the rest into an other row", () => {
    const series: MetricSeries[] = [];
    for (let index = 0; index < 10; index++) series.push(...histogram(`/route-${index}`, { "1": [0, 0], "+Inf": [index + 1, index + 2] }));
    const result = compareHistogramLabels(series, config, late);
    const [route] = result.keys;
    expect(route.values).toHaveLength(8);
    const shownSelected = route.values.reduce((sum, value) => sum + value.selected, 0);
    const shownRest = route.values.reduce((sum, value) => sum + value.rest, 0);
    expect(shownSelected + route.otherSelected).toBeCloseTo(1, 9);
    expect(shownRest + route.otherRest).toBeCloseTo(1, 9);
  });

  it("counts a missing observation in the region as skipped and as zero", () => {
    const series = histogram("/gap", { "1": [1, 1], "+Inf": [2, 3] });
    series[1].points[1] = { timestamp: 2000, value: null };
    const result = compareHistogramLabels([...series, ...histogram("/other", { "1": [1, 1], "+Inf": [2, 4] })], config, late);
    expect(result.skipped).toBeGreaterThan(0);
  });

  it("gives each value its exact share of each side", () => {
    // In the late "> 1" cell /slow observes 10 - 1 = 9 and /fast 11 - 9 = 2. Everywhere else /slow observes 1 + 1 + 1 = 3 and
    // /fast 5 + 1 + 9 = 15.
    const series = [
      ...histogram("/slow", { "1": [1, 1], "+Inf": [2, 10] }),
      ...histogram("/fast", { "1": [5, 9], "+Inf": [6, 11] }),
    ];
    const { keys, selectedShare, selectedTotal } = compareHistogramLabels(series, config, late);
    expect(selectedTotal).toBe(11);
    expect(selectedShare).toBeCloseTo(11 / 29, 12);
    expect(keys[0].values).toEqual([{ value: "/slow", selected: 9 / 11, rest: 3 / 18 }, { value: "/fast", selected: 2 / 11, rest: 15 / 18 }]);
    expect(keys[0].score).toBeCloseTo(9 / 11 - 3 / 18, 12);
  });

  it("reports an empty selection, so no label is ranked on zeros", () => {
    const series = [
      ...histogram("/slow", { "1": [1, 1], "+Inf": [1, 1] }),
      ...histogram("/fast", { "1": [5, 9], "+Inf": [5, 9] }),
    ];
    expect(compareHistogramLabels(series, config, late).selectedTotal).toBe(0);
  });

  it("names no label when one histogram group has every observation", () => {
    const result = compareHistogramLabels(histogram("/only", { "1": [1, 1], "+Inf": [2, 4] }), config, late);
    expect(result.groups).toBe(1);
    expect(result.keys).toEqual([]);
  });
});

describe("trace search for a latency region", () => {
  it("converts second bounds to milliseconds and names the duration window", () => {
    const seconds = [0.1, 0.5, Infinity];
    expect(traceQLForRegion({ startTs: 0, endTs: 0, lowBucket: 1, highBucket: 1 }, seconds, "s")).toEqual({ query: "{ duration >= 100ms && duration < 500ms }" });
    expect(traceQLForRegion({ startTs: 0, endTs: 0, lowBucket: 1, highBucket: 1 }, [100, 500, Infinity], "ms")).toEqual({ query: "{ duration >= 100ms && duration < 500ms }" });
  });

  it("omits the open infinite edges and keeps the filter", () => {
    const bounds = [0.1, 0.5, Infinity];
    expect(traceQLForRegion({ startTs: 0, endTs: 0, lowBucket: 2, highBucket: 2 }, bounds, "s")).toEqual({ query: "{ duration >= 500ms }" });
    expect(traceQLForRegion({ startTs: 0, endTs: 0, lowBucket: 0, highBucket: 0 }, bounds, "s", 'resource.service.name = "api"')).toEqual({ query: '{ (resource.service.name = "api") && duration < 100ms }' });
  });

  it("writes tiny and fractional bounds as TraceQL durations, never in exponent form", () => {
    const region = { startTs: 0, endTs: 0, lowBucket: 1, highBucket: 1 };
    expect(traceQLForRegion(region, [1e-10, 2.5e-7, Infinity], "s")).toEqual({ query: "{ duration < 250ns }" });
    expect(traceQLForRegion(region, [0.0005, 0.0025, Infinity], "s")).toEqual({ query: "{ duration >= 0.5ms && duration < 2.5ms }" });
  });

  it("refuses a filter that could close the span selector, and keeps braces inside strings", () => {
    const region = { startTs: 0, endTs: 0, lowBucket: 0, highBucket: 0 };
    for (const filter of ['.a = 1 } | count() > 2 { true', ".a = 1 | count() > 2", "(.a = 1", ".a = 1)", 'name = "open'])
      expect(traceQLForRegion(region, [0.1], "s", filter)).toHaveProperty("unavailable");
    expect(traceQLForRegion(region, [0.1], "s", 'name = "GET /{id}" && (.b = 2 || .c = "a\\"}")')).toEqual({ query: '{ (name = "GET /{id}" && (.b = 2 || .c = "a\\"}")) && duration < 100ms }' });
  });

  it("refuses units it cannot convert, with the reason", () => {
    expect(traceQLForRegion({ startTs: 0, endTs: 0, lowBucket: 0, highBucket: 0 }, [1], "events/s")).toEqual({ unavailable: "Bucket unit must be s or ms to search traces by duration" });
  });
});

describe("the distribution after the grouping refactor", () => {
  it("still differences cumulative counts per bucket", () => {
    const data = buildDistribution(histogram("/a", { "1": [2], "+Inf": [5] }), { bucketLabel: "le" });
    expect(data.rows.map(row => row.cells[0].value)).toEqual([2, 3]);
  });
});

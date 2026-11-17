import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateWidgetAttention, reduceAttention, widgetAttention, type AttentionFacts } from "./widget-attention";
import type { QueryResult, Widget } from "./schema";

type Fixture = {
  cases: { name: string; widgets: ({ id: string } & AttentionFacts)[]; expected: Record<string, unknown> }[];
};
// The shared cases are also run by the Go reducer, so they live in docs/design and are read relative to this file.
const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../docs/design/insights/conformance/attention.json");
const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

const stat = (options?: Widget["options"]) => ({ type: "stat", options }) as Pick<Widget, "type" | "options">;
const series = (name: string, points: { timestamp: number; value: number | null }[]) => ({ name, labels: {}, points });
const one = (value: number, timestamp = 1_000_000): QueryResult => ({ series: [series("api", [{ timestamp, value }])] });
const thresholds = [
  { value: 0, status: "ok", label: "Healthy" },
  { value: 5, status: "warning", label: "Elevated" },
  { value: 10, status: "critical", label: "Breached" },
] as const;

describe("attention conformance (the shared cases the Go reducer also runs)", () => {
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const rollup = reduceAttention(testCase.widgets);
      expect(rollup).toEqual(testCase.expected);
    });
  }
});

describe("stat facts", () => {
  it("reads each threshold boundary to its own band across several thresholds", () => {
    const widget = stat({ thresholds: [...thresholds] });
    const stateAt = (value: number) => widgetAttention(widget, { result: one(value), rangeEnd: 2_000_000 }).state;
    expect([4, 4.99, 5, 9.99, 10, 42].map(stateAt)).toEqual(["ok", "ok", "warning", "warning", "critical", "critical"]);
    expect(widgetAttention(widget, { result: one(7), rangeEnd: 2_000_000 }).band).toEqual(thresholds[1]);
  });

  it("judges the latest valid sample, so an older breach and a missing latest sample do not count", () => {
    const widget = stat({ thresholds: [...thresholds] });
    const recovered = { series: [series("api", [{ timestamp: 1, value: 12 }, { timestamp: 2, value: 1 }])] };
    expect(evaluateWidgetAttention(widget, recovered, undefined, 3_000)).toBe("ok");
    const missingLatest = { series: [series("api", [{ timestamp: 1, value: 1 }, { timestamp: 2, value: 12 }, { timestamp: 3, value: null }])] };
    // The displayed value is the last valid sample, so the breach at timestamp 2 is still the one shown.
    expect(evaluateWidgetAttention(widget, missingLatest, undefined, 3_000)).toBe("critical");
  });

  it("never raises attention from a colour-only band, and returns the band for its chip", () => {
    const widget = stat({ thresholds: [{ value: 0, color: "#008866" }, { value: 40, color: "#dd8800", label: "Hot" }] });
    const outcome = widgetAttention(widget, { result: one(42) });
    expect(outcome.state).toBe("ok");
    expect(outcome.band).toEqual({ value: 40, color: "#dd8800", label: "Hot" });
  });

  it("never reports an informational or unknown status as attention", () => {
    const widget = stat({ thresholds: [{ value: 0, status: "info" }, { value: 5, status: "unknown" }] });
    expect(evaluateWidgetAttention(widget, one(9), undefined, 2_000)).toBe("ok");
  });

  it("is stale only past an explicit staleAfterSeconds, and never by a default", () => {
    const aged = one(1, 1_000_000);
    expect(widgetAttention(stat({ staleAfterSeconds: 300 }), { result: aged, rangeEnd: 1_400_000 })).toMatchObject({ state: "stale", stale: true, ageSeconds: 400 });
    expect(evaluateWidgetAttention(stat({ staleAfterSeconds: 300 }), aged, undefined, 1_300_000)).toBe("ok");
    expect(evaluateWidgetAttention(stat(), aged, undefined, 9_000_000_000)).toBe("ok");
    expect(evaluateWidgetAttention(stat({ staleAfterSeconds: 1 }), aged, undefined, undefined)).toBe("ok");
  });

  it("keeps a breach outranking staleness", () => {
    const aged = one(11, 1_000_000);
    expect(evaluateWidgetAttention(stat({ staleAfterSeconds: 60, thresholds: [...thresholds] }), aged, undefined, 1_400_000)).toBe("critical");
  });
});

describe("failed, pending and unavailable reads", () => {
  it("has no band for a failed read, so a retained breach is reported as failed", () => {
    const widget = stat({ thresholds: [...thresholds] });
    const outcome = widgetAttention(widget, { result: one(11), failure: "provider", rangeEnd: 2_000_000 });
    expect(outcome.state).toBe("failed");
    expect(outcome.band).toBeUndefined();
    expect(evaluateWidgetAttention(widget, one(11), new Error("timeout"), 2_000_000)).toBe("failed");
  });

  it("reports an unconfigured provider or an unavailable source as final, never pending", () => {
    const widget = stat({ thresholds: [...thresholds] });
    expect(widgetAttention(widget, { failure: "planning" }).state).toBe("failed");
    expect(widgetAttention(widget, { failure: "provider" }).state).toBe("failed");
  });

  it("reports pending only before any result or failure", () => {
    expect(widgetAttention(stat(), {}).state).toBe("pending");
    expect(evaluateWidgetAttention(stat(), undefined, undefined, undefined)).toBe("pending");
  });

  it("reports empty data as empty and unchecked, never healthy", () => {
    const widget = stat({ thresholds: [...thresholds] });
    const empty = { series: [series("api", [{ timestamp: 1, value: null }])] };
    expect(widgetAttention(widget, { result: empty, rangeEnd: 2_000_000 }).state).toBe("empty");
    expect(widgetAttention({ type: "timeseries" } as Pick<Widget, "type" | "options">, { result: { series: [] } }).state).toBe("empty");
  });

  it("reports a truncated result with no usable data as partial, and one with data as ok", () => {
    const widget = { type: "table" } as Pick<Widget, "type" | "options">;
    expect(widgetAttention(widget, { result: { series: [], truncated: true } }).state).toBe("partial");
    expect(widgetAttention(widget, { result: { ...one(1), truncated: true } }).state).toBe("ok");
  });
});

describe("multi-series bands follow the drawn series and their latest sample", () => {
  const cell = (name: string, value: number | null, timestamp = 2) => series(name, [{ timestamp: 1, value: 0 }, { timestamp, value }]);
  const gauge = (config: Record<string, unknown>) => ({ type: "plugin", pluginId: "threshold-gauge", config, options: { thresholds: [{ value: 0, status: "ok" }, { value: 5, status: "critical", label: "Breached" }] } }) as unknown as Pick<Widget, "type" | "options"> & { pluginId: string; config: unknown };

  it("evaluates only the series a first-series gauge draws", () => {
    const result = { series: [cell("a", 1), cell("b", 9)] };
    expect(widgetAttention(gauge({ seriesMode: "first" }), { result }).state).toBe("ok");
    expect(widgetAttention(gauge({ seriesMode: "all" }), { result }).state).toBe("critical");
  });

  it("caps an all-series gauge at its maxSeries", () => {
    const result = { series: [cell("a", 1), cell("b", 1), cell("c", 9)] };
    expect(widgetAttention(gauge({ seriesMode: "all", maxSeries: 2 }), { result }).state).toBe("ok");
    expect(widgetAttention(gauge({ seriesMode: "all", maxSeries: 3 }), { result }).state).toBe("critical");
  });

  it("sets no band from a series whose latest sample is missing", () => {
    const result = { series: [cell("a", null)] };
    // The series has an observed earlier sample, so the data is usable; its band is simply unknown.
    expect(widgetAttention(gauge({ seriesMode: "all" }), { result })).toMatchObject({ state: "ok", facts: { threshold: { state: "unknown", status: "" } } });
  });

  it("gives a heatmap its worst drawn band, and a heatmap cell with no status threshold none", () => {
    const heatmap = { type: "heatmap", options: { thresholds: [{ value: 0, status: "critical" }, { value: 1, status: "ok" }] } } as Pick<Widget, "type" | "options">;
    expect(widgetAttention(heatmap, { result: { series: [cell("up", 1), cell("down", 0)] } }).state).toBe("critical");
    const colourOnly = { type: "heatmap", options: { thresholds: [{ value: 0, color: "#008866" }] } } as Pick<Widget, "type" | "options">;
    expect(widgetAttention(colourOnly, { result: { series: [cell("down", 0)] } }).state).toBe("ok");
  });
});

describe("time series breaches and staleness", () => {
  const timeseries = (options: Record<string, unknown> = {}) => ({ type: "timeseries", options: { thresholds: [{ value: 0, status: "ok" }, { value: 5, status: "warning" }], ...options } }) as unknown as Pick<Widget, "type" | "options">;
  const minute = 60_000;

  it("counts a breach in the window", () => {
    const points = [0, 1, 2, 3].map((index) => ({ timestamp: index * minute, value: index === 2 ? 6 : 1 }));
    expect(widgetAttention(timeseries(), { result: { series: [series("api", points)] }, rangeEnd: 3 * minute }).state).toBe("warning");
  });

  it("is stale past an explicit staleAfterSeconds", () => {
    const points = [0, 1, 2].map((index) => ({ timestamp: index * minute, value: 1 }));
    expect(widgetAttention(timeseries({ staleAfterSeconds: 60 }), { result: { series: [series("api", points)] }, rangeEnd: 4 * minute })).toMatchObject({ state: "stale", stale: true });
  });

  it("falls back to twice the sample cadence when no staleAfterSeconds is set", () => {
    // Samples every minute, the newest at 2 minutes. Twice the cadence is 2 minutes: 90 seconds of age is fresh, 130 seconds is stale.
    const points = [0, 1, 2].map((index) => ({ timestamp: index * minute, value: 1 }));
    expect(widgetAttention(timeseries(), { result: { series: [series("api", points)] }, rangeEnd: 2 * minute + 130_000 }).state).toBe("stale");
    expect(widgetAttention(timeseries(), { result: { series: [series("api", points)] }, rangeEnd: 2 * minute + 90_000 }).state).toBe("ok");
  });

  it("is not judged for a truncated result, which the chart draws no stale tail for", () => {
    const points = [0, 1, 2].map((index) => ({ timestamp: index * minute, value: 1 }));
    expect(widgetAttention(timeseries({ staleAfterSeconds: 60 }), { result: { series: [series("api", points)], truncated: true }, rangeEnd: 9 * minute }).state).toBe("ok");
  });
});

describe("records", () => {
  it("counts a record row as usable data", () => {
    const records = { columns: [{ key: "a", type: "string" as const }], rows: [["x"]] };
    expect(widgetAttention({ type: "plugin", pluginId: "record-table" } as unknown as Pick<Widget, "type" | "options">, { result: { series: [], records } }).state).toBe("ok");
  });
});

import { describe, expect, it } from "vitest";
import { parseDashboard, serializeDashboard, widgetOptionsSchema, type Dashboard } from "./schema";

const options = { tooltipTitle: "Checkout latency", tooltipValueLabel: "p95", tooltipShowUnit: false, tooltipDecimals: 3 };
describe("baseline tooltip presentation contract", () => {
  it("preserves optional display settings without rewriting units, queries or original precision", () => {
    const dashboard: Dashboard = { schemaVersion: 1, id: "presentation", title: "Presentation", timeRange: "1h", refreshInterval: 0, widgets: [{ id: "metric", title: "Metric", type: "stat", providerId: "prom", query: 'latency{service="checkout"}', unit: "s", layout: { x: 0, y: 0, w: 3, h: 1 }, options: { ...options, decimals: 1 } }] };
    for (const format of ["json", "yaml"] as const) expect(parseDashboard(serializeDashboard(dashboard, format), format)).toEqual(dashboard);
    expect(widgetOptionsSchema.parse({})).toEqual({});
    expect(widgetOptionsSchema.parse({ tooltipTitle: "", tooltipValueLabel: "" })).toEqual({ tooltipTitle: "", tooltipValueLabel: "" });
  });
  it("rejects unbounded, null and untyped settings", () => {
    for (const invalid of [{ tooltipTitle: "x".repeat(121) }, { tooltipValueLabel: "x".repeat(81) }, { tooltipTitle: null }, { tooltipValueLabel: 2 }, { tooltipShowUnit: "yes" }, { tooltipShowUnit: null }, { tooltipDecimals: -1 }, { tooltipDecimals: 9 }, { tooltipDecimals: 1.5 }, { tooltipDecimals: null }, { tooltipStyle: "color:red" }]) expect(widgetOptionsSchema.safeParse(invalid).success).toBe(false);
  });
});

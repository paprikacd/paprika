import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WidgetVisualization } from "./charts";
import { dashboardSchema, parseDashboard, serializeDashboard, type QueryResult, type Widget } from "./schema";
import { dashboardToOpenUI, parseOpenUIDashboard } from "./openui";
import { resolveSeriesColor, seriesColorRulesSchema } from "./series-colors";

afterEach(cleanup);
const rules = [{ label: "window", value: "1h", color: "#348cf0" }, { label: "window", value: "6h", color: "#15c7a1" }];
const series: NonNullable<QueryResult["series"]> = ["1h", "6h", "24h"].map((window, index) => ({ name: window, labels: { window }, points: [{ timestamp: 1000, value: index }, { timestamp: 2000, value: index + 1 }] }));
const widget: Widget = { id: "burn", title: "Burn rate", type: "timeseries", providerId: "prom", query: "burn", unit: "×", layout: { x: 0, y: 0, w: 8, h: 5 }, color: "#aa1122", options: { showLegend: true, seriesColors: rules } };

describe("time-series label colors", () => {
  it("uses exact label identities, first matching rule, and an explicit fallback", () => {
    expect(resolveSeriesColor({ window: "1h" }, rules, "#000000")).toBe("#348cf0");
    expect(resolveSeriesColor({ window: "1H" }, rules, "#000000")).toBe("#000000");
    expect(resolveSeriesColor({ window: "1h", service: "api" }, [{ label: "service", value: "api", color: "#123456" }, ...rules], "#000000")).toBe("#123456");
    expect(seriesColorRulesSchema.safeParse([rules[0], rules[0]]).success).toBe(false);
    expect(seriesColorRulesSchema.safeParse([{ ...rules[0], color: "red" }]).success).toBe(false);
  });
  it("preserves assigned legend colors when provider series order changes", () => {
    const { rerender } = render(<WidgetVisualization widget={widget} result={{ series }} />);
    const check = (name: string, color: string) => {
      const item = within(screen.getByRole("list", { name: "Latest values by series" })).getByRole("listitem", { name: new RegExp(name) });
      expect(item.querySelector('[aria-hidden="true"]')).toHaveStyle({ background: color });
    };
    check("1h", "#348cf0"); check("6h", "#15c7a1");
    rerender(<WidgetVisualization widget={widget} result={{ series: [series[1], series[0], series[2]] }} />);
    check("1h", "#348cf0"); check("6h", "#15c7a1");
  });
  it("round-trips rules in dashboard JSON and rejects malformed or duplicate rules", () => {
    const raw = { schemaVersion: 1, id: "reliability", title: "Reliability", timeRange: "1h", refreshInterval: 0, widgets: [widget] };
    const parsed = dashboardSchema.parse(raw);
    for (const format of ["json", "yaml"] as const) expect(parseDashboard(serializeDashboard(parsed, format), format)).toEqual(parsed);
    expect(parseOpenUIDashboard(dashboardToOpenUI(parsed))).toEqual(parsed);
    expect(dashboardSchema.safeParse({ ...raw, widgets: [{ ...widget, options: { seriesColors: [rules[0], rules[0]] } }] }).success).toBe(false);
  });
});

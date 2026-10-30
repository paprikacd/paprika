import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DashboardWindowProvider } from "./dashboard-window";
import { WidgetVisualization } from "./charts";
import { widgetSchema, parseDashboard, serializeDashboard, type Dashboard, type Widget } from "./schema";
import { dashboardToOpenUI, parseOpenUIDashboard } from "./openui";

afterEach(cleanup);
const widget: Widget = { id: "rate", title: "Rate", type: "stat", providerId: "prom", query: "up", unit: "req/s", layout: { x: 0, y: 0, w: 3, h: 2 }, options: { staleAfterSeconds: 300 } };
const history = { series: [{ name: "api", labels: {}, points: [{ timestamp: 1000000, value: 0 }, { timestamp: 1600000, value: null }] }] };

describe("single value returned-sample freshness", () => {
  it("compares the primary series' latest valid observation to the selected range end", () => {
    const { rerender, container } = render(<DashboardWindowProvider value={{ rangeEnd: 1400000 }}><WidgetVisualization widget={widget} result={history} /></DashboardWindowProvider>);
    expect(screen.getByText(/Last valid sample: 6 min before range end/)).toBeInTheDocument();
    expect(screen.getByText("Last valid · latest missing")).toBeInTheDocument();
    expect(container.querySelector('[data-metric-value="0"]')).toBeInTheDocument();
    rerender(<DashboardWindowProvider value={{ rangeEnd: 1300000 }}><WidgetVisualization widget={widget} result={history} /></DashboardWindowProvider>);
    expect(screen.queryByText(/Last valid sample:/)).not.toBeInTheDocument();
    rerender(<DashboardWindowProvider value={{ rangeEnd: 900000 }}><WidgetVisualization widget={widget} result={history} /></DashboardWindowProvider>);
    expect(screen.queryByText(/Last valid sample:/)).not.toBeInTheDocument();
  });
  it("never invents staleness for empty data, disabled thresholds or a missing range", () => {
    const { rerender } = render(<DashboardWindowProvider value={{ rangeEnd: 2000000 }}><WidgetVisualization widget={widget} result={{ series: [{ name: "api", labels: {}, points: [{ timestamp: 1000000, value: null }] }] }} /></DashboardWindowProvider>);
    expect(screen.getByText("No data in this time range")).toBeInTheDocument();
    expect(screen.queryByText(/Last valid sample:/)).not.toBeInTheDocument();
    rerender(<WidgetVisualization widget={widget} result={history} />);
    expect(screen.queryByText(/Last valid sample:/)).not.toBeInTheDocument();
    rerender(<DashboardWindowProvider value={{ rangeEnd: 2000000 }}><WidgetVisualization widget={{ ...widget, options: {} }} result={history} /></DashboardWindowProvider>);
    expect(screen.queryByText(/Last valid sample:/)).not.toBeInTheDocument();
  });
  it("bounds the optional integer threshold", () => {
    for (const value of [0, -1, 1.5, 2678401]) expect(widgetSchema.safeParse({ ...widget, options: { staleAfterSeconds: value } }).success).toBe(false);
    for (const value of [1, 300, 2678400]) expect(widgetSchema.safeParse({ ...widget, options: { staleAfterSeconds: value } }).success).toBe(true);
  });
  it("preserves the threshold in JSON, YAML and OpenUI", () => {
    const dashboard: Dashboard = { schemaVersion: 1, id: "test", title: "Test", timeRange: "1h", refreshInterval: 0, widgets: [widget] };
    for (const format of ["json", "yaml"] as const) expect(parseDashboard(serializeDashboard(dashboard, format), format)).toEqual(dashboard);
    expect(parseOpenUIDashboard(dashboardToOpenUI(dashboard))).toEqual(dashboard);
  });
});

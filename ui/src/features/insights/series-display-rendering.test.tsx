import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThresholdGauge } from "./plugins/threshold-gauge";
import { StackedTimeseries } from "./plugins/rich-metrics";
import { WidgetVisualization } from "./charts";
import type { QueryResult, Widget } from "./schema";

afterEach(cleanup);
const first = '{cluster="omega", namespace="platform", pod="collector-1"}';
const second = '{cluster="omega", namespace="platform", pod="collector-2"}';
const result: QueryResult = { series: [first, second].map((name, index) => ({
  name, labels: { cluster: "omega", namespace: "platform", pod: `collector-${index + 1}` },
  points: [{ timestamp: 1000, value: index + 1 }, { timestamp: 2000, value: index + 2 }],
})) };
const widget: Widget = { id: "labels", title: "Pod capacity", type: "plugin", pluginId: "threshold-gauge", providerId: "provider", dataKind: "metrics", query: "metric", unit: "%", layout: { x: 0, y: 0, w: 6, h: 4 }, options: { showLegend: false }, config: { seriesMode: "all" } };

describe("compact series names in chart components", () => {
  it("shows distinguishing gauge labels without changing full names or selection context", () => {
    const select = vi.fn();
    const { container } = render(<ThresholdGauge widget={widget} result={result} onContextChange={select} />);
    const rows = container.querySelectorAll('[data-gauge-series]');
    expect(rows[0]).toHaveAttribute("data-gauge-series", first);
    const label = rows[0].querySelector('[data-gauge-label]')!;
    expect(label).toHaveAttribute("title", first);
    expect(label.querySelector('[aria-hidden="true"]')).toHaveTextContent("collector-1");
    expect(label).toHaveTextContent(first);
    fireEvent.focus(screen.getByRole("button", { name: new RegExp(`Select signal for Pod capacity:.*collector-1`) }));
    expect(select).toHaveBeenLastCalledWith({ series: first, labels: result.series![0].labels, value: 2 });
  });
  it("keeps original identities in plotted series, legend titles and accessible row names", () => {
    const { container } = render(<StackedTimeseries widget={{ ...widget, pluginId: "stacked-timeseries", options: { showLegend: true }, config: { legendDisplay: "table" } }} result={result} />);
    expect(container.querySelector('g[data-series]')).toHaveAttribute("data-series", first);
    const legend = screen.getByRole("region", { name: "Series statistics" });
    const row = within(legend).getByRole("rowheader", { name: first });
    expect(row.querySelector('[title]')).toHaveAttribute("title", first);
    expect(row.querySelector('span[aria-hidden="true"]:not([class])')).toHaveTextContent("collector-1");
  });
  it("uses distinguishing provider labels on bar axes while retaining full source names for inspection", () => {
    const { container } = render(<WidgetVisualization widget={{ ...widget, type: "bar", options: { showLegend: true }, config: undefined }} result={result} />);
    expect(container.querySelector("svg")).toHaveTextContent("collector-1");
    expect(container.querySelector("svg")).toHaveTextContent("collector-2");
    fireEvent.click(screen.getByRole("button", { name: /Inspect chart data/ }));
    expect(screen.getByRole("dialog")).toHaveTextContent(first);
  });
  it("lists every plotted bar category with its latest value and full accessible identity", () => {
    const names = ["prometheus", "tempo", "shorted-api", "brandbrain", "market-sync"];
    const multi: QueryResult = { series: names.map((name, index) => ({ name: `{cluster="omega", source="${name}"}`, labels: { cluster: "omega", source: name }, points: [{ timestamp: 1000, value: index - 1 }, { timestamp: 2000, value: index - 1 }] })) };
    render(<WidgetVisualization widget={{ ...widget, type: "bar", options: { showLegend: true }, config: undefined }} result={multi} />);
    const legend = screen.getByRole("list", { name: "Latest values by category" });
    expect(within(legend).getAllByRole("listitem")).toHaveLength(5);
    for (const name of names) expect(within(legend).getByRole("listitem", { name: new RegExp(name) })).toHaveAttribute("title", `{cluster="omega", source="${name}"}`);
    const tempo = within(legend).getByRole("listitem", { name: /tempo/ });
    expect(tempo.querySelector("[data-legend-value]")).toHaveAttribute("data-legend-value", "0");
    expect(tempo.querySelector("[data-legend-timestamp]")).toHaveAttribute("data-legend-timestamp", "2000");
    expect(legend).toHaveAttribute("tabindex", "0");
  });
  it("hides the category key when its legend is explicitly disabled", () => {
    render(<WidgetVisualization widget={{ ...widget, type: "bar", options: { showLegend: false }, config: undefined }} result={result} />);
    expect(screen.queryByRole("list", { name: "Latest values by category" })).not.toBeInTheDocument();
  });
  it("shows short names in the standard time-series legend and retains full inspection names", () => {
    render(<WidgetVisualization widget={{ ...widget, type: "timeseries", options: { showLegend: true }, config: undefined }} result={result} />);
    const legend = screen.getByRole("list", { name: "Latest values by series" });
    const row = within(legend).getByRole("listitem", { name: new RegExp("collector-1") });
    expect(row).toHaveAttribute("title", first);
    expect(row.querySelector('span[aria-hidden="true"]:not([class])')).toHaveTextContent("collector-1");
    expect(row).toHaveTextContent(first);
    expect(within(row).getByLabelText(new RegExp("latest valid sample"))).toHaveAttribute("data-legend-value", "2");
  });
  it("identifies a lone generic series by the authored widget title without restating it as a visible name", () => {
    const lone: QueryResult = { series: [{ name: "Value", labels: {}, points: [{ timestamp: 1000, value: 1.61 }, { timestamp: 2000, value: 1.61 }] }] };
    render(<WidgetVisualization widget={{ ...widget, id: "error-history", title: "Error budget burn rate · 1h", type: "timeseries", options: { showLegend: true }, config: undefined }} result={lone} />);
    const legend = screen.getByRole("list", { name: "Latest values by series" });
    const row = within(legend).getByRole("listitem", { name: /Error budget burn rate · 1h, latest valid sample/ });
    expect(row).toHaveAttribute("title", "Error budget burn rate · 1h · Value");
    expect(row).toHaveTextContent("1.61");
    expect(legend.textContent).not.toMatch(/Value/);
  });
  it("keeps an explorer preview's selector as its visible identity", () => {
    const selector = 'up{instance="api-1:9090", job="api"}';
    const one: QueryResult = { series: [{ name: selector, labels: { __name__: "up", instance: "api-1:9090", job: "api" }, points: [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: 1 }] }] };
    render(<WidgetVisualization widget={{ ...widget, id: "explore-preview", title: "Query results", type: "timeseries", options: { showLegend: true }, config: undefined }} result={one} />);
    const legend = screen.getByRole("list", { name: "Latest values by series" });
    expect(within(legend).getByRole("listitem")).toHaveAttribute("title", selector);
    expect(legend).toHaveTextContent("up{instance");
  });
});

describe("compact series names in metric tables", () => {
  const canonical = (labels: Record<string, string>) => `{${Object.keys(labels).sort().map(key => `${key}=${JSON.stringify(labels[key])}`).join(", ")}}`;
  const applications = ["api-gateway", "catalog", "checkout"].map(application => {
    const labels = { application, namespace: "prod" };
    return { name: canonical(labels), labels, points: [{ timestamp: 1000, value: 0 }, { timestamp: 2000, value: application === "catalog" ? 2 : 0 }] };
  });

  it("names rows with the chart's compacted labels and keeps the full identity in the row title", () => {
    render(<WidgetVisualization widget={{ ...widget, type: "table", unit: "" }} result={{ series: applications }} />);
    for (const application of ["api-gateway", "catalog", "checkout"]) {
      const cell = screen.getByText(application);
      expect(cell.tagName).toBe("SPAN");
      expect(cell).toHaveAttribute("title", canonical({ application, namespace: "prod" }));
    }
    expect(screen.queryByText(/namespace=/)).toBeNull();
  });

  it("keeps the full series name in the inspect label of each row", () => {
    render(<WidgetVisualization widget={{ ...widget, type: "table", unit: "" }} result={{ series: applications }} />);
    expect(screen.getByRole("button", { name: `Inspect series ${canonical({ application: "catalog", namespace: "prod" })}` })).toBeInTheDocument();
  });
});

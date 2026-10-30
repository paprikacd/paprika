import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectionalTraffic, DistributionHeatmap, StackedTimeseries, registerRichMetricPlugins } from "./rich-metrics";
import { getWidgetDefinition } from "../widget-registry";
import { ChartCursorProvider } from "../chart-cursor";
import { EmbeddedWidgetProvider } from "../widget-presentation";
import type { QueryResult, Widget } from "../schema";

afterEach(cleanup);
const widget: Widget = { id: "rich", title: "Request outcomes", type: "plugin", pluginId: "stacked-timeseries", dataKind: "metrics", providerId: "metrics", query: "rate", unit: "req/s", options: { decimals: 2 }, layout: { x: 0, y: 0, w: 6, h: 4 } };
const result: QueryResult = { series: [
  { name: "API", labels: { service: "api", direction: "inbound" }, points: [{ timestamp: 1000, value: 4 }, { timestamp: 2000, value: 8.127 }] },
  { name: "Worker", labels: { service: "worker", direction: "outbound" }, points: [{ timestamp: 1000, value: 2 }, { timestamp: 2000, value: 3.14159 }] },
] };

describe("rich metric renderers", () => {
  it("distinguishes generated peer names visually without losing full accessible identities", () => {
    const input: QueryResult = { series: ["inbound", "outbound"].map((direction, index) => ({
      name: `traffic{cluster="omega", direction="${direction}"}`,
      labels: { __name__: "traffic", cluster: "omega", direction },
      points: [{ timestamp: 1000, value: index + 1 }],
    })) };
    render(<DirectionalTraffic widget={{ ...widget, pluginId: "directional-traffic" }} result={input} />);
    fireEvent.focus(screen.getByRole("group", { name: /Request outcomes/ }));
    const list = within(screen.getByRole("region", { name: "Observation details" })).getByRole("list", { name: "Series at selected time" });
    expect(within(list).getByText("inbound")).toBeVisible();
    expect(within(list).getByText("outbound")).toBeVisible();
    expect(list).toHaveTextContent('traffic{cluster="omega", direction="inbound"}');
    expect(list).toHaveTextContent('traffic{cluster="omega", direction="outbound"}');
    expect(list.querySelectorAll("li")[0]).toHaveAttribute("data-series-value", "1");
    expect(list.querySelectorAll("li")[1]).toHaveAttribute("data-series-value", "2");
  });
  it("keeps the transient inspector concise and restores complete details when pinned", () => {
    render(<DirectionalTraffic widget={{ ...widget, pluginId: "directional-traffic" }} result={result} />);
    const chart = screen.getByRole("group", { name: /Request outcomes/ });
    fireEvent.focus(chart);
    const inspector = screen.getByRole("region", { name: "Observation details" });
    expect(within(inspector).getByText("Click or tap chart to pin details")).toBeInTheDocument();
    expect(within(inspector).getByRole("list", { name: "Series at selected time" })).toBeInTheDocument();
    expect(inspector.querySelector("time")).toBeInTheDocument();
    expect(inspector.querySelector("[data-stat-sparkline]")).not.toBeInTheDocument();
    expect(inspector.querySelector('[data-tooltip-compact="true"]')).toBeInTheDocument();
    fireEvent.keyDown(chart, { key: "Enter" });
    expect(within(inspector).queryByText("Click or tap chart to pin details")).not.toBeInTheDocument();
    expect(inspector.querySelector("[data-stat-sparkline]")).toBeInTheDocument();
    expect(inspector.querySelector('[data-tooltip-compact="true"]')).not.toBeInTheDocument();
    expect(within(inspector).getByText("Outbound is drawn below zero; this is the original nonnegative observation.")).toBeInTheDocument();
  });
  it("shows exact same-time observations for every plotted series without inventing missing values", () => {
    const irregular: QueryResult = { series: [
      { name: "API", labels: { direction: "inbound" }, points: [{ timestamp: 1000, value: 4 }, { timestamp: 2000, value: 8.127 }] },
      { name: "Worker", labels: { direction: "outbound" }, points: [{ timestamp: 1000, value: 2 }, { timestamp: 3000, value: 3.14159 }] },
    ] };
    render(<DirectionalTraffic widget={{ ...widget, pluginId: "directional-traffic", unit: "Mb/s" }} result={irregular} />);
    const chart = screen.getByRole("group", { name: /Request outcomes/ });
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    const inspector = screen.getByRole("region", { name: "Observation details" });
    const comparisons = within(inspector).getByRole("list", { name: "Series at selected time" });
    expect(within(comparisons).getByText("API").closest("li")).toHaveTextContent("8.13 Mb/s");
    expect(within(comparisons).getByText("Worker").closest("li")).toHaveTextContent("No observation");
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(within(comparisons).getByText("API").closest("li")).toHaveTextContent("4.00 Mb/s");
    expect(within(comparisons).getByText("Worker").closest("li")).toHaveTextContent("2.00 Mb/s");
  });
  it("renders finite, distinct axis positions for extreme opposite-signed observations", () => {
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 600, height: 300, top: 0, left: 0, right: 600, bottom: 300, toJSON: () => ({}) });
    try {
      const extremes: QueryResult = { series: [{ name: "extreme", labels: {}, points: [{ timestamp: 1000, value: -1e308 }, { timestamp: 2000, value: 1e308 }] }] };
      const { container } = render(<StackedTimeseries widget={widget} result={extremes} />);
      const labels = [...container.querySelectorAll("[data-value-axis]")];
      expect(labels.length).toBeGreaterThan(2);
      const positions = labels.map(label => Number(label.getAttribute("y")));
      expect(positions.every(Number.isFinite)).toBe(true);
      expect(new Set(positions).size).toBe(labels.length);
      for (const path of container.querySelectorAll("[data-metric-marks] path")) expect(path.getAttribute("d")).not.toMatch(/NaN|Infinity/);
    } finally { bounds.mockRestore(); }
  });
  it("explains overflowing stack columns instead of rendering a fabricated height", () => {
    const extremes: QueryResult = { series: ["a", "b"].map(name => ({ name, labels: {}, points: [{ timestamp: 1000, value: 1e308 }, { timestamp: 2000, value: 1 }] })) };
    const { container } = render(<StackedTimeseries widget={widget} result={extremes} />);
    expect(screen.getByText(/1 time column omitted.*stack.*finite/i)).toBeInTheDocument();
    for (const path of container.querySelectorAll("[data-metric-marks] path")) expect(path.getAttribute("d")).not.toMatch(/NaN|Infinity/);
  });
  it.each([104, 128, 146, 180])("keeps bucket labels separated in a %ipx plot without dropping data cells", (height) => {
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 600, height, top: 0, left: 0, right: 600, bottom: height, toJSON: () => ({}) });
    try {
      const histogram = { series: Array.from({length: 9}, (_, index) => ({name: "Bucket", labels: {le: String((index + 1) * 10)}, points: [{timestamp: 1000, value: index + 1}]})) };
      const {container} = render(<DistributionHeatmap widget={widget} result={histogram} />);
      const centers = [...container.querySelectorAll("text[data-value-axis]")].map(label => Number(label.getAttribute("y"))).sort((a,b) => a-b);
      expect(centers.length).toBeGreaterThanOrEqual(2);
      for (let index = 1; index < centers.length; index++) expect(centers[index] - centers[index - 1]).toBeGreaterThanOrEqual(16);
      expect(container.querySelectorAll("[data-bucket-value]")).toHaveLength(9);
    } finally { bounds.mockRestore(); }
  });
  it("registers bounded reusable metrics plugins with guided defaults", () => {
    registerRichMetricPlugins(); registerRichMetricPlugins();
    for (const id of ["distribution-heatmap", "stacked-timeseries", "directional-traffic"]) {
      const definition = getWidgetDefinition("plugin", id)!;
      expect(definition.dataKind).toBe("metrics");
      expect(definition.configFields!.length).toBeGreaterThan(0);
      expect(definition.parseConfig!(definition.defaultConfig)).toEqual(definition.defaultConfig);
    }
    const directional = getWidgetDefinition("plugin", "directional-traffic")!;
    expect(directional.configFields).toEqual(expect.arrayContaining([expect.objectContaining({ key: "symmetricAxis", kind: "boolean" })]));
    expect(directional.parseConfig?.({ symmetricAxis: true })).toMatchObject({ symmetricAxis: true });
  });
  it("inspects and pins exact raw stacked values, not cumulative geometry", () => {
    const onContextChange = vi.fn();
    render(<StackedTimeseries widget={widget} result={result} onContextChange={onContextChange} />);
    const chart = screen.getByRole("group", { name: /Request outcomes/ });
    fireEvent.focus(chart); fireEvent.keyDown(chart, { key: "ArrowDown" }); fireEvent.keyDown(chart, { key: "Enter" });
    expect(onContextChange).toHaveBeenLastCalledWith({ series: "Worker", value: 3.14159, labels: { service: "worker", direction: "outbound" } });
    expect(screen.getByRole("region", { name: "Observation details" }).querySelector('[data-metric-value="3.14159"]')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unpin observation" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(chart, { key: "Escape" }); expect(screen.queryByRole("region", { name: "Observation details" })).not.toBeInTheDocument();
  });
  it("retains the complete source identity and exact observation in short-inspector details", () => {
    const longName = '{namespace="observability", pod="paprika-insights-observability-probe-8f7d6d97d8-12345", container="worker"}';
    const labels = { namespace: "observability", pod: "paprika-insights-observability-probe-8f7d6d97d8-12345", container: "worker" };
    const select = vi.fn();
    const longResult: QueryResult = { series: [{ name: longName, labels, points: [{ timestamp: 2000, value: 3.14159 }] }] };
    render(<StackedTimeseries widget={widget} result={longResult} onContextChange={select} />);
    const chart = screen.getByRole("group", { name: /Request outcomes/ });
    fireEvent.focus(chart);
    const inspector = screen.getByRole("region", { name: "Observation details" });
    expect(within(inspector).getByText(longName)).toBeInTheDocument();
    expect(inspector.querySelector('[data-metric-value="3.14159"]')).toHaveTextContent("3.14 req/s");
    expect(within(inspector).getByText(labels.pod)).toBeInTheDocument();
    fireEvent.keyDown(chart, { key: "Enter" });
    expect(select).toHaveBeenLastCalledWith({ series: longName, labels, value: 3.14159 });
    expect(within(inspector).getByRole("button", { name: "Unpin observation" })).toHaveAttribute("aria-pressed", "true");
  });
  it("makes only a pinned inspector keyboard-scrollable without changing its exact observation", async () => {
    const select = vi.fn();
    const longLabels = { ...result.series![1].labels, deployment: "production-worker-with-a-long-deployment-name", resource: "cluster/omega/namespace/observability/workload/processor/instance/worker-01" };
    const richResult: QueryResult = { series: [result.series![0], { ...result.series![1], labels: longLabels }] };
    const { container } = render(<StackedTimeseries widget={widget} result={richResult} onContextChange={select} />);
    const chart = screen.getByRole("group", { name: /Request outcomes/ });
    fireEvent.focus(chart); fireEvent.keyDown(chart, { key: "ArrowDown" });
    let inspector = screen.getByRole("region", { name: "Observation details" });
    expect(inspector).not.toHaveAttribute("tabindex");
    fireEvent.click(within(inspector).getByRole("button", { name: "Pin observation" }));
    expect(inspector).toHaveAttribute("tabindex", "0");
    inspector.focus(); expect(inspector).toHaveFocus();
    for (const key of ["ArrowDown", "PageDown", "End", "Home", "PageUp"])
      expect(fireEvent.keyDown(inspector, { key })).toBe(true);
    expect(inspector.querySelector('[data-metric-value="3.14159"]')).toBeInTheDocument();
    expect(inspector).toHaveTextContent(longLabels.resource);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenLastCalledWith({ series: "Worker", value: 3.14159, labels: longLabels });
    fireEvent.pointerLeave(container.firstElementChild!);
    expect(inspector).toBeInTheDocument();
    fireEvent.click(within(inspector).getByRole("button", { name: "Unpin observation" }));
    expect(screen.queryByRole("region", { name: "Observation details" })).not.toBeInTheDocument();
    expect(chart).toHaveFocus();
    fireEvent.focus(chart);
    inspector = screen.getByRole("region", { name: "Observation details" });
    expect(inspector).not.toHaveAttribute("tabindex");
    fireEvent.pointerLeave(container.firstElementChild!);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Observation details" })).not.toBeInTheDocument());
  });
  it("portals inspection outside the chart and keeps it open while moving into the panel", async () => {
    const { container } = render(<StackedTimeseries widget={widget} result={result} />);
    const chart = screen.getByRole("group", { name: /Request outcomes/ });
    fireEvent.focus(chart);
    const inspector = screen.getByRole("region", { name: "Observation details" });
    expect(container.contains(inspector)).toBe(false);
    expect(document.body.contains(inspector)).toBe(true);
    fireEvent.pointerLeave(container.firstElementChild!);
    fireEvent.pointerEnter(inspector);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
    expect(screen.getByRole("region", { name: "Observation details" })).toBe(inspector);
    fireEvent.pointerLeave(inspector);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Observation details" })).not.toBeInTheDocument());
  });
  it("dismisses keyboard-focused pinned details even if an ancestor stops bubbling events", () => {
    const parentKey = vi.fn((event: React.KeyboardEvent) => event.stopPropagation());
    render(<div onKeyDown={parentKey}><StackedTimeseries widget={widget} result={result} /></div>);
    const chart = screen.getByRole("group", { name: /Request outcomes/ });
    fireEvent.focus(chart); fireEvent.keyDown(chart, { key: "Enter" });
    const inspector = screen.getByRole("region", { name: "Observation details" });
    inspector.focus(); expect(inspector).toHaveFocus();
    parentKey.mockClear();
    expect(fireEvent.keyDown(inspector, { key: "Escape" })).toBe(false);
    expect(parentKey).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Observation details" })).not.toBeInTheDocument();
    expect(chart).toHaveFocus();
  });
  it.each(["Close observation", "Unpin observation"])("returns focus after %s without reopening, and leaves outside pointer focus alone", action => {
    render(<><button>Outside the chart</button><StackedTimeseries widget={widget} result={result} /></>);
    const chart = screen.getByRole("group", { name: /Request outcomes/ });
    fireEvent.focus(chart); fireEvent.keyDown(chart, { key: "Enter" });
    const button = screen.getByRole("button", { name: action });
    button.focus(); expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(screen.queryByRole("region", { name: "Observation details" })).not.toBeInTheDocument();
    expect(chart).toHaveFocus();
    fireEvent.keyDown(chart, { key: "Enter" });
    expect(screen.getByRole("region", { name: "Observation details" })).toBeInTheDocument();
    const outside = screen.getByRole("button", { name: "Outside the chart" });
    outside.focus(); fireEvent.pointerDown(outside);
    expect(screen.queryByRole("region", { name: "Observation details" })).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
  });
  it("retains raw outbound value and closes stale inspection on refreshed results", () => {
    const onContextChange = vi.fn();
    const { rerender } = render(<DirectionalTraffic widget={widget} result={result} onContextChange={onContextChange} />);
    const chart = screen.getByRole("group", { name: /Outbound traffic/ });
    fireEvent.focus(chart); fireEvent.keyDown(chart, { key: "ArrowDown" }); fireEvent.keyDown(chart, { key: "Enter" });
    expect(onContextChange.mock.calls.at(-1)![0].value).toBe(3.14159);
    rerender(<DirectionalTraffic widget={widget} result={{ ...result }} onContextChange={onContextChange} />);
    expect(screen.queryByRole("region", { name: "Observation details" })).not.toBeInTheDocument();
  });
  it("uses differenced bucket values for selection and density units", () => {
    const onContextChange = vi.fn();
    const histogram: QueryResult = { series: [
      { name: "bucket", labels: { service: "api", le: "10" }, points: [{ timestamp: 1000, value: 2 }, { timestamp: 2000, value: 5 }] },
      { name: "bucket", labels: { service: "api", le: "100" }, points: [{ timestamp: 1000, value: 9 }, { timestamp: 2000, value: 16 }] },
    ] };
    render(<DistributionHeatmap widget={{ ...widget, unit: "ms", config: { densityUnit: "observations/s" } }} result={histogram} onContextChange={onContextChange} />);
    const chart = screen.getByRole("group", { name: /histogram buckets/ });
    fireEvent.focus(chart); fireEvent.keyDown(chart, { key: "ArrowUp" }); fireEvent.keyDown(chart, { key: "Enter" });
    expect(onContextChange).toHaveBeenLastCalledWith({ series: "10–100 ms", value: 11, labels: { service: "api", le: "100" } });
    expect(screen.getByLabelText("Color encodes bucket observations/s")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Observation details" }).textContent).toContain("11.00 observations/s");
  });
  it("does not render area through an incomplete stack and explains the gap", () => {
    const broken: QueryResult = { series: result.series!.map((entry, i) => ({ ...entry, points: [{ timestamp: 1000, value: i ? 2 : 4 }, { timestamp: 2000, value: i ? null : 8 }, { timestamp: 3000, value: i ? 3 : 9 }] })) };
    const { container } = render(<StackedTimeseries widget={widget} result={broken} />);
    expect(container.querySelectorAll('g[data-series="API"] path[fill="none"]')).toHaveLength(2);
    expect(screen.getByText("Incomplete timestamps leave gaps in the stack")).toBeInTheDocument();
  });
  it("hides decorative stacked marks from the accessibility tree while retaining exact keyboard inspection", () => {
    const many: QueryResult = { series: Array.from({ length: 3 }, (_, row) => ({
      name: `Series ${row}`, labels: { source: `source-${row}` },
      points: Array.from({ length: 50 }, (_, column) => ({ timestamp: 1000 + column * 1000, value: row + column })),
    })) };
    const { container } = render(<StackedTimeseries widget={{ ...widget, config: { display: "bar" } }} result={many} />);
    const marks = container.querySelector("[data-metric-marks]")!;
    expect(marks).toHaveAttribute("aria-hidden", "true");
    expect(marks.querySelectorAll("rect[data-raw-value]").length).toBeGreaterThan(100);
    const chart = screen.getByRole("group", { name: /Request outcomes/ });
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "ArrowDown" });
    fireEvent.keyDown(chart, { key: "Enter" });
    expect(screen.getByRole("region", { name: "Observation details" })).toHaveTextContent("Series 1");
    expect(screen.getByRole("region", { name: "Observation details" })).toHaveTextContent("50.00");
  });
  it("keeps bars inside the clip boundary at the first and last timestamps", () => {
    const { container } = render(<StackedTimeseries widget={{ ...widget, config: { display: "bar" } }} result={result} />);
    const clip = container.querySelector("clipPath rect")!;
    const left = Number(clip.getAttribute("x")), right = left + Number(clip.getAttribute("width"));
    for (const bar of container.querySelectorAll("rect[data-raw-value]")) {
      expect(Number(bar.getAttribute("x"))).toBeGreaterThanOrEqual(left);
      expect(Number(bar.getAttribute("x")) + Number(bar.getAttribute("width"))).toBeLessThanOrEqual(right);
    }
  });
  it("provides deliberate context selection with tooltips off, but no interactions when embedded", () => {
    const select = vi.fn();
    const { rerender } = render(<StackedTimeseries widget={{ ...widget, options: { showTooltip: false } }} result={result} onContextChange={select} />);
    let chart = screen.getByRole("group", { name: /Stacked observations/ });
    fireEvent.focus(chart); fireEvent.keyDown(chart, { key: "Enter" }); expect(select).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "Observation details" })).not.toBeInTheDocument();
    rerender(<StackedTimeseries widget={widget} result={result} embedded onContextChange={select} />);
    chart = screen.getByRole("group", { name: /Stacked observations/ });
    expect(chart).not.toHaveAttribute("tabindex"); fireEvent.focus(chart); fireEvent.keyDown(chart, { key: "Enter" }); expect(select).toHaveBeenCalledTimes(1);
  });
  it("synchronizes a cursor only within the actual time range and clears it on unmount", () => {
    const { container, rerender } = render(<ChartCursorProvider><StackedTimeseries widget={widget} result={result} /><DirectionalTraffic widget={{ ...widget, id: "other", title: "Traffic" }} result={result} /></ChartCursorProvider>);
    fireEvent.focus(screen.getByRole("group", { name: /Request outcomes/ }));
    expect(container.querySelectorAll('[data-shared-cursor="2000"]')).toHaveLength(2);
    rerender(<ChartCursorProvider><DirectionalTraffic widget={{ ...widget, id: "other", title: "Traffic" }} result={result} /></ChartCursorProvider>);
    expect(container.querySelectorAll('[data-shared-cursor="2000"]')).toHaveLength(0);
  });
  it("honors the compact embedded presentation without axes or nested inspection", () => {
    const { container } = render(<EmbeddedWidgetProvider showAxis={false} descriptionId="selected"><StackedTimeseries widget={{ ...widget, options: { showLegend: false } }} result={result} /></EmbeddedWidgetProvider>);
    const chart = screen.getByRole("group", { name: /Stacked observations/ });
    expect(chart).not.toHaveAttribute("tabindex");
    expect(chart).toHaveAttribute("aria-describedby", "selected");
    expect(chart).not.toHaveAccessibleName(/Arrow keys/);
    expect(container.querySelectorAll("svg text")).toHaveLength(0);
    expect(container.querySelectorAll("g[data-series] path").length).toBeGreaterThan(0);
    fireEvent.focus(chart);
    expect(screen.queryByRole("region", { name: "Observation details" })).not.toBeInTheDocument();
  });
  it("dismisses a pinned observation even when a parent intercepts bubbling keyboard events", () => {
    render(<div onKeyDown={event => event.stopPropagation()}><StackedTimeseries widget={widget} result={result} /></div>);
    const chart = screen.getByRole("group", { name: /Stacked observations/ });
    fireEvent.focus(chart); fireEvent.keyDown(chart, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Unpin observation" })).toBeInTheDocument();
    fireEvent.keyDown(chart, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Observation details" })).not.toBeInTheDocument();
  });
  it("measures wide value and bucket labels before allocating a narrow plot gutter", () => {
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 280, height: 220, top: 0, left: 0, right: 280, bottom: 220, toJSON: () => ({}) });
    const previous = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getComputedTextLength");
    Object.defineProperty(SVGElement.prototype, "getComputedTextLength", { configurable: true, value(this: SVGElement) { return (this.textContent?.length ?? 0) * 7.5; } });
    const assertGutter = (container: HTMLElement) => {
      const labels = container.querySelectorAll<SVGTextElement>("text[data-value-axis]");
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) expect(Number(label.getAttribute("x")) - label.getComputedTextLength()).toBeGreaterThanOrEqual(9);
    };
    try {
      const { container, rerender } = render(<DirectionalTraffic widget={{ ...widget, unit: "Mb/s" }} result={{ series: [{ name: "Outbound", labels: { direction: "outbound" }, points: [{ timestamp: 1000, value: 253.42 }] }] }} />);
      expect(container.textContent).toContain("-253.42 Mb/s"); assertGutter(container);
      expect(Number(container.querySelector("clipPath rect")?.getAttribute("width"))).toBeGreaterThan(140);
      rerender(<DistributionHeatmap widget={{ ...widget, unit: "milliseconds" }} result={{ series: [
        { name: "Bucket", labels: { le: "250" }, points: [{ timestamp: 1000, value: 3 }] },
        { name: "Bucket", labels: { le: "500" }, points: [{ timestamp: 1000, value: 5 }] },
      ] }} />);
      assertGutter(container);
      expect(container.querySelectorAll("rect[data-bucket-value]")).toHaveLength(2);
    } finally {
      bounds.mockRestore();
      if (previous) Object.defineProperty(SVGElement.prototype, "getComputedTextLength", previous);
      else Reflect.deleteProperty(SVGElement.prototype, "getComputedTextLength");
    }
  });
  it("exposes keyboard scrolling only when the legend actually overflows and clears the cue after resize", () => {
    const callbacks: (() => void)[] = [], originalObserver = globalThis.ResizeObserver;
    let contentHeight = 90;
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { callbacks.push(callback); } observe() {} disconnect() {} });
    const client = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function(this: HTMLElement) { return this.getAttribute("aria-label") === "Latest recorded values" ? 96 : 0; });
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function(this: HTMLElement) { return this.getAttribute("aria-label") === "Latest recorded values" ? contentHeight : 0; });
    try {
      const { container } = render(<StackedTimeseries widget={widget} result={result} />);
      const legend = screen.getByRole("region", { name: "Latest recorded values" });
      expect(legend).not.toHaveAttribute("tabindex");
      expect(screen.queryByText("Scroll to see all series")).not.toBeInTheDocument();
      contentHeight = 190;
      act(() => callbacks.forEach(callback => callback()));
      expect(legend).toHaveAttribute("tabindex", "0");
      expect(legend).toHaveAccessibleDescription("Scroll to see all series");
      legend.focus(); expect(legend).toHaveFocus();
      expect(Number(container.querySelector("clipPath rect")?.getAttribute("height"))).toBeGreaterThan(48);
      expect(container.querySelectorAll("g[data-series] path").length).toBeGreaterThan(0);
      contentHeight = 90;
      act(() => callbacks.forEach(callback => callback()));
      expect(legend).not.toHaveAttribute("tabindex");
      expect(legend).not.toHaveAttribute("aria-describedby");
      expect(screen.queryByText("Scroll to see all series")).not.toBeInTheDocument();
    } finally {
      client.mockRestore(); scroll.mockRestore(); vi.stubGlobal("ResizeObserver", originalObserver);
    }
  });
  it("renders an opt-in aligned raw-statistics table with units, precision and explicit calculation semantics", () => {
    const { container } = render(<StackedTimeseries widget={{ ...widget, config: { legendDisplay: "table", legendPosition: "right" } }} result={result} />);
    const table = screen.getByRole("table");
    expect(table).toHaveAccessibleName(/Current is the latest sample, including missing values/);
    for (const name of ["Series", "Current", "Mean", "Max"]) expect(within(table).getByRole("columnheader", { name })).toHaveAttribute("scope", "col");
    const worker = container.querySelector('[data-legend-series="Worker"]')!;
    expect(worker.querySelector('[data-summary="current"]')).toHaveTextContent("3.14 req/s");
    expect(worker.querySelector('[data-summary="current"]')).toHaveAttribute("data-value", "3.14159");
    expect(worker.querySelector('[data-summary="mean"]')).toHaveTextContent("2.57 req/s");
    expect(worker.querySelector('[data-summary="max"]')).toHaveTextContent("3.14 req/s");
    expect(container.querySelector('[data-legend-position="right"]')).toHaveAttribute("data-legend-display", "table");
    expect(screen.queryByRole("region", { name: "Latest recorded values" })).not.toBeInTheDocument();
  });
  it("keeps outbound statistics positive and updates a missing current sample without backfilling", () => {
    const tableWidget = { ...widget, config: { legendDisplay: "table" } };
    const { container, rerender } = render(<DirectionalTraffic widget={tableWidget} result={result} />);
    expect(container.querySelector('[data-legend-series="Worker"] [data-summary="current"]')).toHaveAttribute("data-value", "3.14159");
    const missing = { series: [{ ...result.series![1], points: [{ timestamp: 1000, value: 2 }, { timestamp: 2000, value: null }] }] };
    rerender(<DirectionalTraffic widget={tableWidget} result={missing} />);
    expect(container.querySelector('[data-summary="current"]')).toHaveTextContent("No data");
    expect(container.querySelector('[data-summary="mean"]')).toHaveTextContent("2.00 req/s");
    expect(container.querySelector('[data-summary="max"]')).toHaveAttribute("data-value", "2");
    rerender(<DirectionalTraffic widget={{ ...tableWidget, options: { showLegend: false } }} result={missing} />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
  it("makes horizontally overflowing statistic tables focusable without forcing a hint when the table fits", () => {
    const callbacks: (() => void)[] = [], originalObserver = globalThis.ResizeObserver;
    let contentWidth = 420;
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { callbacks.push(callback); } observe() {} disconnect() {} });
    const client = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function(this: HTMLElement) { return this.getAttribute("aria-label") === "Series statistics" ? 280 : 0; });
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function(this: HTMLElement) { return this.getAttribute("aria-label") === "Series statistics" ? contentWidth : 0; });
    try {
      render(<StackedTimeseries widget={{ ...widget, config: { legendDisplay: "table" } }} result={result} />);
      const tableRegion = screen.getByRole("region", { name: "Series statistics" });
      expect(tableRegion).toHaveAttribute("tabindex", "0");
      expect(tableRegion).toHaveAccessibleDescription("Scroll to see all statistics");
      tableRegion.focus(); expect(tableRegion).toHaveFocus();
      contentWidth = 280; act(() => callbacks.forEach(callback => callback()));
      expect(tableRegion).not.toHaveAttribute("tabindex");
      expect(screen.queryByText("Scroll to see all statistics")).not.toBeInTheDocument();
    } finally {
      client.mockRestore(); scroll.mockRestore(); vi.stubGlobal("ResizeObserver", originalObserver);
    }
  });
});

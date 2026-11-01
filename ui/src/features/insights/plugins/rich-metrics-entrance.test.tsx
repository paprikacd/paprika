import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHART_REVEAL_MS } from "../chart-entrance";
import { EmbeddedWidgetProvider } from "../widget-presentation";
import type { QueryResult, Widget } from "../schema";
import { DistributionHeatmap, StackedTimeseries } from "./rich-metrics";

// The distribution and stacked plots are their own SVG, not TanStack's, so their draw-in is marked on their own groups.
const heatmap: Widget = { id: "latency", title: "Latency distribution", type: "plugin", pluginId: "distribution-heatmap", providerId: "metrics", dataKind: "metrics", query: "buckets", unit: "ms", layout: { x: 0, y: 0, w: 6, h: 4 }, config: { maxColumns: 120, densityUnit: "events/s" } };
const heatmapResult: QueryResult = { series: ["10", "100"].map((le, bucket) => ({ name: `bucket ${le}`, labels: { le }, points: Array.from({ length: 24 }, (_, index) => ({ timestamp: (index + 1) * 1000, value: index === 7 ? null : bucket ? 3 : 1 })) })) };
const stacked: Widget = { id: "rich", title: "Request outcomes", type: "plugin", pluginId: "stacked-timeseries", dataKind: "metrics", providerId: "metrics", query: "rate", unit: "req/s", options: { decimals: 2 }, layout: { x: 0, y: 0, w: 6, h: 4 } };
const stackedResult: QueryResult = { series: [
  { name: "API", labels: { service: "api", direction: "inbound" }, points: [{ timestamp: 1000, value: 4 }, { timestamp: 2000, value: 8.127 }, { timestamp: 3000, value: 6 }] },
  { name: "Worker", labels: { service: "worker", direction: "outbound" }, points: [{ timestamp: 1000, value: 2 }, { timestamp: 2000, value: 3.14159 }, { timestamp: 3000, value: 1 }] },
] };

function stubReducedMotion(reduce: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: reduce && query === "(prefers-reduced-motion: reduce)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList);
}

beforeEach(() => {
  vi.useFakeTimers();
  stubReducedMotion(false);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("draw-in on the distribution heatmap", () => {
  it("marks the plot on first render and clears the mark once the reveal has finished", () => {
    const { container } = render(<DistributionHeatmap widget={heatmap} result={heatmapResult} />);
    const plot = container.querySelector("[data-chart-entering]")!;
    expect(plot).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(CHART_REVEAL_MS + 100));
    expect(container.querySelector("[data-chart-entering]")).toBeNull();
  });

  it("reveals the bucket cells in their own groups, so the value-axis labels beside them never move", () => {
    const { container } = render(<DistributionHeatmap widget={heatmap} result={heatmapResult} />);
    const cells = [...container.querySelectorAll("[data-bucket-value]")];
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.parentElement!.tagName.toLowerCase()).toBe("g");
      expect(cell.parentElement!.getAttribute("class")).toBeTruthy();
    }
    const axis = container.querySelector("[data-value-axis]");
    expect(axis).not.toBeNull();
    expect(axis!.parentElement!.getAttribute("class")).toBeNull();
  });

  it("is off under reduced motion, inside a reduced scope, and for an embedded sub-widget", () => {
    stubReducedMotion(true);
    const reduced = render(<DistributionHeatmap widget={heatmap} result={heatmapResult} />);
    expect(reduced.container.querySelector("[data-chart-entering]")).toBeNull();
    reduced.unmount();

    const scoped = render(<div data-motion="reduced"><DistributionHeatmap widget={heatmap} result={heatmapResult} /></div>);
    expect(scoped.container.querySelector("[data-chart-entering]")).toBeNull();
    scoped.unmount();

    const embedded = render(<EmbeddedWidgetProvider><DistributionHeatmap widget={heatmap} result={heatmapResult} /></EmbeddedWidgetProvider>);
    expect(embedded.container.querySelector("[data-chart-entering]")).toBeNull();
  });
});

describe("draw-in on the stacked metric plot", () => {
  it("marks the plot on first render, and gives each series group the reveal", () => {
    const { container } = render(<StackedTimeseries widget={stacked} result={stackedResult} />);
    expect(container.querySelector("[data-chart-entering]")).toBeInTheDocument();
    const series = [...container.querySelectorAll("[data-series]")];
    expect(series).toHaveLength(2);
    for (const group of series) expect(group.getAttribute("class")).toBeTruthy();
    act(() => vi.advanceTimersByTime(CHART_REVEAL_MS + 100));
    expect(container.querySelector("[data-chart-entering]")).toBeNull();
  });

  it("does not replay the draw-in when a refreshed result arrives while the widget stays mounted", () => {
    const { container, rerender } = render(<StackedTimeseries widget={stacked} result={stackedResult} />);
    const plot = container.querySelector("[data-chart-entering]")!;
    act(() => vi.advanceTimersByTime(300));
    rerender(<StackedTimeseries widget={stacked} result={{ series: stackedResult.series!.map((entry) => ({ ...entry, points: entry.points.map((point) => ({ ...point, value: (point.value ?? 0) * 2 })) })) }} />);
    expect(container.querySelector("[data-chart-entering]")).toBe(plot);
    act(() => vi.advanceTimersByTime(CHART_REVEAL_MS + 100 - 300));
    expect(container.querySelector("[data-chart-entering]")).toBeNull();
  });
});

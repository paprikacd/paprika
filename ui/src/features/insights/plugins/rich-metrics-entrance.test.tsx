import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHART_REVEAL_MS } from "../chart-entrance";
import chartEntrance from "../chart-entrance.module.css";
import { EmbeddedWidgetProvider } from "../widget-presentation";
import type { QueryResult, Widget } from "../schema";
import { DistributionHeatmap, StackedTimeseries } from "./rich-metrics";

// The distribution and stacked plots are their own SVG, not TanStack's, so their draw-in is marked on one mark group per plot.
const heatmap: Widget = { id: "latency", title: "Latency distribution", type: "plugin", pluginId: "distribution-heatmap", providerId: "metrics", dataKind: "metrics", query: "buckets", unit: "ms", layout: { x: 0, y: 0, w: 6, h: 4 }, config: { maxColumns: 120, densityUnit: "events/s" } };
const heatmapResult: QueryResult = { series: ["10", "100"].map((le, bucket) => ({ name: `bucket ${le}`, labels: { le }, points: Array.from({ length: 24 }, (_, index) => ({ timestamp: (index + 1) * 1000, value: index === 7 ? null : bucket ? 3 : 1 })) })) };
const stacked: Widget = { id: "rich", title: "Request outcomes", type: "plugin", pluginId: "stacked-timeseries", dataKind: "metrics", providerId: "metrics", query: "rate", unit: "req/s", options: { decimals: 2 }, layout: { x: 0, y: 0, w: 6, h: 4 } };
const stackedResult: QueryResult = { series: [
  { name: "API", labels: { service: "api", direction: "inbound" }, points: [{ timestamp: 1000, value: 4 }, { timestamp: 2000, value: 8.127 }, { timestamp: 3000, value: 6 }] },
  { name: "Worker", labels: { service: "worker", direction: "outbound" }, points: [{ timestamp: 1000, value: 2 }, { timestamp: 2000, value: 3.14159 }, { timestamp: 3000, value: 1 }] },
] };
// Cumulative buckets with a +Inf bucket, so the p95 line is drawn. The third window has no value in any bucket, which breaks the line.
const histogramBucket = (le: string, values: (number | null)[]): NonNullable<QueryResult["series"]>[number] => ({ name: `bucket ${le}`, labels: { le }, points: values.map((value, index) => ({ timestamp: (index + 1) * 1000, value })) });
const quantileResult: QueryResult = { series: [histogramBucket("10", [10, 10, null, 0, 0]), histogramBucket("50", [10, 10, null, 10, 10]), histogramBucket("+Inf", [10, 10, null, 10, 10])] };
// Twelve finite bounds and +Inf make thirteen rows; each window is cumulative across the bounds.
const manyBuckets: QueryResult = { series: [
  ...Array.from({ length: 12 }, (_, bound) => histogramBucket(String(2 ** bound), Array.from({ length: 6 }, (_, window) => bound + window + 1))),
  histogramBucket("+Inf", Array.from({ length: 6 }, () => 30)),
] };
// The Worker series has no value at 2000, so its column in a bar plot is capped.
const gapped: QueryResult = { series: [
  { name: "API", labels: { service: "api" }, points: [{ timestamp: 1000, value: 4 }, { timestamp: 2000, value: 8 }, { timestamp: 3000, value: 6 }] },
  { name: "Worker", labels: { service: "worker" }, points: [{ timestamp: 1000, value: 2 }, { timestamp: 2000, value: null }, { timestamp: 3000, value: 1 }] },
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

// The one mark group a plot animates in. Axes, grids and legends are never inside it, so they never move.
const revealGroups = (root: ParentNode) => [...root.querySelectorAll("g")].filter(group => group.classList.contains(chartEntrance.revealMarks));

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

  it("reveals the bucket cells and the p95 line through one group, so the value-axis labels beside them never move", () => {
    const { container } = render(<DistributionHeatmap widget={heatmap} result={quantileResult} />);
    expect(revealGroups(container)).toHaveLength(1);
    const [reveal] = revealGroups(container);
    const cells = [...container.querySelectorAll("[data-bucket-value]")];
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(reveal.contains(cell)).toBe(true);
    expect(reveal.querySelector("[data-quantile-line]")).not.toBeNull();
    const axis = container.querySelector("[data-value-axis]");
    expect(axis).not.toBeNull();
    expect(reveal.contains(axis)).toBe(false);
    expect(axis!.parentElement!.getAttribute("class")).toBeNull();
  });

  it("animates exactly one entering group per heatmap plot, however many buckets it draws", () => {
    const { container } = render(<DistributionHeatmap widget={heatmap} result={manyBuckets} />);
    expect(container.querySelector("[data-chart-entering]")).toBeInTheDocument();
    expect(new Set([...container.querySelectorAll("[data-bucket-upper]")].map(cell => cell.getAttribute("data-bucket-upper"))).size).toBe(13);
    expect(revealGroups(container)).toHaveLength(1);
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
  it("marks the plot on first render, and reveals every series through one group", () => {
    const { container } = render(<StackedTimeseries widget={stacked} result={stackedResult} />);
    expect(container.querySelector("[data-chart-entering]")).toBeInTheDocument();
    const [reveal] = revealGroups(container);
    expect(revealGroups(container)).toHaveLength(1);
    const series = [...container.querySelectorAll("[data-series]")];
    expect(series).toHaveLength(2);
    for (const group of series) expect(reveal.contains(group)).toBe(true);
    act(() => vi.advanceTimersByTime(CHART_REVEAL_MS + 100));
    expect(container.querySelector("[data-chart-entering]")).toBeNull();
  });

  it("animates exactly one entering group per stacked plot, and keeps the missing-series caps out of it", () => {
    const { container } = render(<StackedTimeseries widget={{ ...stacked, config: { display: "bar" } }} result={gapped} />);
    expect(revealGroups(container)).toHaveLength(1);
    const [reveal] = revealGroups(container);
    const caps = [...container.querySelectorAll("[data-missing-series]")];
    expect(caps.length).toBeGreaterThan(0);
    for (const cap of caps) {
      expect(reveal.contains(cap)).toBe(false);
      expect(cap.parentElement!.classList.contains(chartEntrance.fadeMarks)).toBe(true);
    }
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

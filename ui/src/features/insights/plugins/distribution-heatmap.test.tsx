import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DistributionHeatmap } from "./rich-metrics";
import type { QueryResult, Widget } from "../schema";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const widget: Widget = { id: "latency", title: "Latency distribution", type: "plugin", pluginId: "distribution-heatmap", providerId: "metrics", dataKind: "metrics", query: "buckets", unit: "ms", layout: { x: 0, y: 0, w: 6, h: 4 }, config: { maxColumns: 120, densityUnit: "events/s" } };
const result: QueryResult = { series: ["10", "100"].map((le, bucket) => ({ name: `bucket ${le}`, labels: { le }, points: Array.from({ length: 120 }, (_, index) => ({ timestamp: (index + 1) * 1000, value: index === 37 ? null : bucket ? 3 : 1 })) })) };

describe("distribution heatmap", () => {
  it("does not label a nonzero color-domain maximum as zero at fixed display precision", () => {
    const tiny: QueryResult = { series: [{ name: "bucket", labels: { le: "1" }, points: [{ timestamp: 1000, value: 1e-12 }] }] };
    const { rerender } = render(<DistributionHeatmap widget={{ ...widget, options: { decimals: 2 } }} result={tiny} />);
    expect(screen.getByLabelText("Color encodes bucket events/s")).toHaveTextContent("1.00e-12 events/s");
    rerender(<DistributionHeatmap widget={{ ...widget, options: { decimals: 2 } }} result={{ series: [{ name: "bucket", labels: { le: "1" }, points: [{ timestamp: 1000, value: 0.125 }] }] }} />);
    expect(screen.getByLabelText("Color encodes bucket events/s")).toHaveTextContent("0.13 events/s");
  });
  it("shows logarithmic color bands using real bucket densities without changing values or missing cells", () => {
    const values = [0, 1, 10, 100, 1000, null];
    const skewed: QueryResult = { series: ["10", "100"].map(le => ({ name: `bucket ${le}`, labels: { le }, points: values.map((value, index) => ({ timestamp: (index + 1) * 1000, value })) })) };
    const { container, rerender } = render(<DistributionHeatmap widget={{ ...widget, config: { colorScale: "logarithmic", densityUnit: "events/s" } }} result={skewed} />);
    const firstRow = (value: string) => container.querySelector<SVGRectElement>(`[data-bucket-upper="10"][data-bucket-value="${value}"]`)!;
    expect(firstRow("0").getAttribute("fill")).not.toEqual(firstRow("1").getAttribute("fill"));
    expect(firstRow("1").getAttribute("fill")).not.toEqual(firstRow("10").getAttribute("fill"));
    expect(firstRow("100").getAttribute("fill")).not.toEqual(firstRow("1000").getAttribute("fill"));
    expect(firstRow("unknown").getAttribute("fill")).toMatch(/^url\(#.+-missing\)$/);
    expect(screen.getByLabelText("Color encodes bucket events/s")).toHaveTextContent("Logarithmic · zero separate · min ≈1.00");
    rerender(<DistributionHeatmap widget={{ ...widget, config: { densityUnit: "events/s" } }} result={skewed} />);
    expect(firstRow("0").getAttribute("fill")).toEqual(firstRow("1").getAttribute("fill"));
    expect(screen.getByLabelText("Color encodes bucket events/s")).not.toHaveTextContent("Logarithmic");
  });
  it("explains conflicting numeric bucket aliases without inventing a merged histogram, and recovers when the data changes", () => {
    const collision: QueryResult = { series: [
      { name: "one", labels: { le: "1" }, points: [{ timestamp: 1000, value: 12 }] },
      { name: "decimal", labels: { le: "1.0" }, points: [{ timestamp: 1000, value: 10 }] },
      { name: "overflow", labels: { le: "+Inf" }, points: [{ timestamp: 1000, value: 20 }] },
    ] };
    const view = render(<DistributionHeatmap widget={widget} result={collision} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Duplicate histogram bucket with overlapping observations. Filter or correct conflicting boundary labels before charting.");
    expect(view.container.querySelector("[data-bucket-value]")).toBeNull();
    view.rerender(<DistributionHeatmap widget={widget} result={result} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(view.container.querySelector("[data-bucket-value]")).not.toBeNull();
  });
  it("spreads real timestamp cells on narrow plots, retains missing observations, and expands on resize", () => {
    let width = 300;
    const resize: ResizeObserverCallback[] = [];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, width, height: 180, left: 0, right: width, top: 0, bottom: 180, toJSON() {} }));
    vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { resize.push(callback); } observe() {} disconnect() {} });
    const { container } = render(<DistributionHeatmap widget={widget} result={result} />);
    const cells = () => [...container.querySelectorAll<SVGRectElement>('[data-bucket-value]')];
    const narrow = cells();
    expect(narrow.length).toBeGreaterThan(16);
    expect(narrow.length).toBeLessThan(120);
    expect(narrow.every(cell => Number(cell.getAttribute("width")) > 0)).toBe(true);
    expect(narrow.every(cell => !cell.querySelector("title"))).toBe(true);
    expect(narrow.some(cell => cell.getAttribute("data-timestamp") === "38000" && cell.getAttribute("data-bucket-value") === "unknown")).toBe(true);
    const missing = narrow.find(cell => cell.getAttribute("data-bucket-value") === "unknown")!;
    expect(missing.getAttribute("fill")).toMatch(/^url\(#.+-missing\)$/);
    expect(screen.getByText("Sampled observations · column width does not show duration")).toBeInTheDocument();
    expect(screen.getByLabelText("Color encodes bucket events/s")).toHaveTextContent("Missing");
    fireEvent.focus(screen.getByRole("group", { name: /histogram buckets/ }));
    expect(screen.getByRole("region", { name: "Observation details" })).toBeInTheDocument();
    width = 680;
    act(() => resize.forEach(callback => callback([], {} as ResizeObserver)));
    expect(cells().length).toBeGreaterThan(narrow.length);
    expect(screen.queryByRole("region", { name: "Observation details" })).not.toBeInTheDocument();
    expect(cells().some(cell => cell.getAttribute("data-timestamp") === "38000" && cell.getAttribute("data-bucket-value") === "unknown")).toBe(true);
    expect(cells().some(cell => cell.getAttribute("data-timestamp") === "120000")).toBe(true);
  });
});

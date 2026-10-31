import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
    expect(firstRow("unknown").getAttribute("fill")).toMatch(/^url\(#.+-hatch\)$/);
    expect(screen.getByLabelText("Color encodes bucket events/s")).toHaveTextContent("Logarithmic · zero separate · min ≈1.00");
    rerender(<DistributionHeatmap widget={{ ...widget, config: { densityUnit: "events/s" } }} result={skewed} />);
    // Zero is observed and drawn with the empty fill, so it no longer shares the lowest density step.
    expect(firstRow("0").getAttribute("fill")).not.toEqual(firstRow("1").getAttribute("fill"));
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
    expect(missing.getAttribute("fill")).toMatch(/^url\(#.+-hatch\)$/);
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

describe("distribution heatmap states and p95", () => {
  const series = (le: string, points: (number | null)[]): NonNullable<QueryResult["series"]>[number] => ({ name: `bucket ${le}`, labels: { le }, points: points.map((value, index) => ({ timestamp: (index + 1) * 1000, value })) });
  it("draws observed zero flat, hatches missing cells and warning-hatches invalid ones", () => {
    const states: QueryResult = { series: [series("10", [0, null, 3]), series("50", [0, 4, 2])] };
    const { container } = render(<DistributionHeatmap widget={widget} result={states} />);
    const cell = (upper: string, timestamp: string) => container.querySelector<SVGRectElement>(`[data-bucket-upper="${upper}"][data-timestamp="${timestamp}"]`)!;
    expect(cell("10", "1000")).toHaveAttribute("data-bucket-state", "observed");
    expect(cell("10", "1000").getAttribute("fill")).toBe("var(--gamma-chart-empty)");
    expect(cell("10", "2000")).toHaveAttribute("data-bucket-state", "missing");
    expect(cell("10", "2000").getAttribute("fill")).toMatch(/-hatch\)$/);
    expect(cell("50", "3000")).toHaveAttribute("data-bucket-state", "invalid");
    expect(cell("50", "3000").getAttribute("fill")).toMatch(/-hatch-warning\)$/);
    const legend = screen.getByLabelText("Color encodes bucket events/s");
    expect(legend).toHaveTextContent("Zero");
    expect(legend).toHaveTextContent("Invalid");
    expect(screen.getByText(/1 non-monotonic or negative bucket observations shown hatched, not drawn as density/)).toBeInTheDocument();
  });
  it("draws the p95 as a step line, breaking it at a window with a missing bucket", () => {
    const quantile: QueryResult = { series: [series("10", [10, 10, null, 0, 0]), series("50", [10, 10, null, 10, 10]), series("+Inf", [10, 10, null, 10, 10])] };
    const { container } = render(<DistributionHeatmap widget={{ ...widget, unit: "ms" }} result={quantile} />);
    const line = container.querySelector<SVGPathElement>("[data-quantile-line]");
    expect(line).not.toBeNull();
    expect(line!.getAttribute("d")!.match(/M/g)).toHaveLength(2);
    expect(line).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText(/^p95 ≈ 46 ms · merged over 4 of 5 windows · 1 missing window excluded/)).toBeInTheDocument();
  });
  it("reports an overflow p95 as above its last finite bound and an unavailable p95 without +Inf", () => {
    const overflow: QueryResult = { series: [series("10", [0, 0]), series("50", [0, 0]), series("+Inf", [5, 5])] };
    const { container, rerender } = render(<DistributionHeatmap widget={{ ...widget, unit: "ms" }} result={overflow} />);
    expect(screen.getByText(/^p95 above 50 ms · merged over 2 of 2 windows/)).toBeInTheDocument();
    expect(container.querySelector("[data-quantile-line]")).not.toBeNull();
    rerender(<DistributionHeatmap widget={{ ...widget, unit: "ms" }} result={result} />);
    expect(screen.getByText(/^p95 unavailable: no \+Inf bucket/)).toBeInTheDocument();
    expect(container.querySelector("[data-quantile-line]")).toBeNull();
  });
  it("lists the window's buckets with shares of the full total, including the overflow bucket", () => {
    const shares: QueryResult = { series: [series("10", [3]), series("50", [5]), series("+Inf", [10])] };
    render(<DistributionHeatmap widget={{ ...widget, unit: "ms" }} result={shares} />);
    fireEvent.focus(screen.getByRole("group", { name: /histogram buckets/ }));
    // The inspector is portalled, so the histogram is read from its list rather than the render container.
    const list = screen.getByRole("list", { name: "Buckets at this time" });
    expect(within(list).getAllByRole("listitem").map(item => item.getAttribute("data-histogram-bucket"))).toEqual(["2", "1", "0"]);
    expect(list.querySelector<HTMLElement>('[data-histogram-bucket="0"] i')!.style.width).toBe("30%");
    expect(list.querySelector<HTMLElement>('[data-histogram-bucket="1"] i')!.style.width).toBe("20%");
    expect(list.querySelector<HTMLElement>('[data-histogram-bucket="2"] i')!.style.width).toBe("50%");
    expect(list.querySelector('[data-histogram-bucket="2"]')).toHaveAttribute("data-histogram-state", "observed");
  });
  it("hovers over a twelve-bucket histogram without a list, but pins it at any size", () => {
    const many: QueryResult = { series: Array.from({ length: 13 }, (_, index) => series(String((index + 1) * 10), [index + 1])) };
    render(<DistributionHeatmap widget={widget} result={many} />);
    const chart = screen.getByRole("group", { name: /histogram buckets/ });
    fireEvent.focus(chart);
    expect(screen.queryByRole("list", { name: "Buckets at this time" })).not.toBeInTheDocument();
    fireEvent.keyDown(chart, { key: "Enter" });
    const list = screen.getByRole("list", { name: "Buckets at this time" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(13);
    expect(list.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  });
  it("explains a missing window in its histogram: hatched rows, no share, and no p95", () => {
    const quantile: QueryResult = { series: [series("10", [10, 10, null, 0, 0]), series("50", [10, 10, null, 10, 10]), series("+Inf", [10, 10, null, 10, 10])] };
    render(<DistributionHeatmap widget={{ ...widget, unit: "ms" }} result={quantile} />);
    const chart = screen.getByRole("group", { name: /histogram buckets/ });
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    const list = screen.getByRole("list", { name: "Buckets at this time" });
    expect(list.querySelectorAll('[data-histogram-state="missing"]')).toHaveLength(3);
    expect(list.querySelector('[data-histogram-bucket="0"] i')!.getAttribute("style")).toContain("width: 100%");
    expect(list.querySelectorAll("b")[0]).toHaveTextContent("No observation");
    expect(screen.getByText("p95 unavailable: this time has missing buckets.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Observation details" })).toHaveTextContent("No observation for this bucket at this time. Missing cells are hatched and left out of the p95.");
  });
  it("marks a p95 in a bucket hidden by maxBuckets with a chevron at the top instead of a line", () => {
    const hidden: QueryResult = { series: [series("10", [0, 0]), series("50", [0, 0]), series("+Inf", [5, 5])] };
    const { container } = render(<DistributionHeatmap widget={{ ...widget, unit: "ms", config: { ...widget.config, maxBuckets: 2 } }} result={hidden} />);
    expect(container.querySelectorAll("[data-quantile-above]")).toHaveLength(2);
    expect(container.querySelector("[data-quantile-line]")).toBeNull();
    expect(screen.getByText(/^p95 above 50 ms · merged over 2 of 2 windows/)).toBeInTheDocument();
  });
  it("hatches a source gap across the full plot height rather than leaving it blank", () => {
    const gap: QueryResult = { series: [
      { name: "bucket 10", labels: { le: "10" }, points: [1000, 2000, 3000, 10000, 11000, 12000].map(timestamp => ({ timestamp, value: 1 })) },
      { name: "bucket +Inf", labels: { le: "+Inf" }, points: [1000, 2000, 3000, 10000, 11000, 12000].map(timestamp => ({ timestamp, value: 2 })) },
    ] };
    const { container } = render(<DistributionHeatmap widget={widget} result={gap} />);
    const bands = container.querySelectorAll<SVGRectElement>("[data-heatmap-gap]");
    expect(bands).toHaveLength(1);
    expect(bands[0].getAttribute("fill")).toMatch(/-hatch\)$/);
  });
  it("names a missing or invalid cell in its embedded title", () => {
    const states: QueryResult = { series: [series("10", [0, null, 3]), series("50", [0, 4, 2])] };
    const { container } = render(<DistributionHeatmap widget={widget} result={states} embedded />);
    expect(container.querySelector('[data-bucket-state="missing"] title')).toHaveTextContent("No observation");
    expect(container.querySelector('[data-bucket-state="invalid"] title')).toHaveTextContent("Invalid bucket counts: cumulative counts decrease or are negative");
  });
  it("reports only the missing +Inf bucket in the readout without +Inf, even when counts are invalid", () => {
    const invalid: QueryResult = { series: [series("10", [5, 5]), series("50", [3, 10])] };
    const { container } = render(<DistributionHeatmap widget={{ ...widget, unit: "ms" }} result={invalid} />);
    expect(container.querySelector("[data-heatmap-quantile]")!.textContent).toBe("p95 unavailable: no +Inf bucket");
  });
  it("leaves the readout out of an embedded heatmap, which keeps its legend", () => {
    const { container } = render(<DistributionHeatmap widget={{ ...widget, unit: "ms" }} result={{ series: [series("10", [0, 0]), series("50", [0, 0]), series("+Inf", [5, 5])] }} embedded />);
    expect(container.querySelector("[data-heatmap-quantile]")).toBeNull();
    expect(screen.getByLabelText("Color encodes bucket events/s")).toBeInTheDocument();
  });
  it("names only the p95 keys it draws: a chevron for a hidden bucket, a dashed key for overflow, a solid key for finite", () => {
    const overflow: QueryResult = { series: [series("10", [0, 0]), series("50", [0, 0]), series("+Inf", [5, 5])] };
    const { rerender } = render(<DistributionHeatmap widget={{ ...widget, unit: "ms", config: { ...widget.config, maxBuckets: 2 } }} result={overflow} />);
    // The +Inf row is hidden above maxBuckets, so the p95 is a chevron at the top and no line is drawn.
    const legend = () => screen.getByLabelText("Color encodes bucket events/s");
    expect(legend()).toHaveTextContent("p95 above shown buckets");
    expect(legend()).not.toHaveTextContent("p95 above the last bound");
    expect(legend()).not.toHaveTextContent("p95 bucket");
    rerender(<DistributionHeatmap widget={{ ...widget, unit: "ms" }} result={overflow} />);
    expect(legend()).toHaveTextContent("p95 above the last bound");
    expect(legend()).not.toHaveTextContent("p95 above shown buckets");
    rerender(<DistributionHeatmap widget={{ ...widget, unit: "ms" }} result={{ series: [series("10", [10, 10]), series("50", [10, 10]), series("+Inf", [10, 10])] }} />);
    expect(legend()).toHaveTextContent("p95 bucket");
    expect(legend()).not.toHaveTextContent("p95 above the last bound");
  });
  it("dashes the p95 run of a window above the last bound, and keeps finite runs solid", () => {
    // Window 2 has its p95 in +Inf. Windows 1 and 3 have finite p95s in the first bucket.
    const mixed: QueryResult = { series: [series("10", [10, 0, 10]), series("50", [10, 0, 10]), series("+Inf", [10, 10, 10])] };
    const { container } = render(<DistributionHeatmap widget={{ ...widget, unit: "ms" }} result={mixed} />);
    expect(container.querySelector("[data-quantile-line]")).toHaveAttribute("stroke-dasharray", "4 3");
    expect(container.querySelector("[data-quantile-halo]")).not.toHaveAttribute("stroke-dasharray");
    // The finite runs are drawn solid over the dashed line: two runs, one on each side of the overflow window.
    const solid = container.querySelector("[data-quantile-solid]")!;
    expect(solid).not.toHaveAttribute("stroke-dasharray");
    expect(solid.getAttribute("d")!.match(/M/g)).toHaveLength(2);
    expect(screen.getByLabelText("Color encodes bucket events/s")).toHaveTextContent("p95 above the last bound");
  });
  it("draws an all-overflow p95 line dashed, with no solid part", () => {
    const overflow: QueryResult = { series: [series("10", [0, 0]), series("50", [0, 0]), series("+Inf", [5, 5])] };
    const { container } = render(<DistributionHeatmap widget={{ ...widget, unit: "ms" }} result={overflow} />);
    expect(container.querySelector("[data-quantile-line]")).toHaveAttribute("stroke-dasharray", "4 3");
    expect(container.querySelector("[data-quantile-solid]")).toBeNull();
    expect(screen.getByLabelText("Color encodes bucket events/s")).not.toHaveTextContent("p95 bucket");
  });
  it("names a gap above maxBuckets in the readout and in the inspector of the window it breaks", () => {
    const hiddenGap: QueryResult = { series: [series("10", [1, 1, 1]), series("50", [2, 2, 2]), series("100", [3, null, 3]), series("+Inf", [4, 4, 4])] };
    const { container } = render(<DistributionHeatmap widget={{ ...widget, unit: "ms", config: { ...widget.config, maxBuckets: 2 } }} result={hiddenGap} />);
    expect(container.querySelector("[data-heatmap-quantile]")!.textContent).toContain("1 missing window excluded · 1 window has missing buckets above the shown range");
    const chart = screen.getByRole("group", { name: /histogram buckets/ });
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(screen.getByText("p95 unavailable: this time has missing buckets above the shown range.")).toBeInTheDocument();
  });
  it("scales an unbounded window's shares to its largest shown bucket, so no observed bucket is drawn empty", () => {
    const unbounded: QueryResult = { series: [series("10", [3]), series("50", [5]), series("100", [10])] };
    const { unmount } = render(<DistributionHeatmap widget={{ ...widget, unit: "ms" }} result={unbounded} />);
    fireEvent.focus(screen.getByRole("group", { name: /histogram buckets/ }));
    const list = screen.getByRole("list", { name: "Buckets at this time" });
    // The observed buckets are 3, 2 and 5 events/s and the window total is unknown, so the largest fills its track.
    expect(list.querySelector<HTMLElement>('[data-histogram-bucket="2"] i')!.style.width).toBe("100%");
    expect(list.querySelector<HTMLElement>('[data-histogram-bucket="1"] i')!.style.width).toBe("40%");
    expect(list.querySelector<HTMLElement>('[data-histogram-bucket="0"] i')!.style.width).toBe("60%");
    expect(screen.getByText("Scaled to the largest bucket shown; window total unknown.")).toBeInTheDocument();
    unmount();
    render(<DistributionHeatmap widget={{ ...widget, unit: "ms" }} result={{ series: [series("10", [3]), series("50", [5]), series("+Inf", [10])] }} />);
    fireEvent.focus(screen.getByRole("group", { name: /histogram buckets/ }));
    expect(screen.queryByText(/Scaled to the largest bucket/)).not.toBeInTheDocument();
  });
  it("scales the observed buckets of a window that is missing only its +Inf bucket, and hatches the missing one", () => {
    // At the last time the +Inf bucket is missing, so the total is unknown: observed 3 and 2 scale to the larger one.
    const plusInfMissing: QueryResult = { series: [series("10", [3, 3]), series("50", [5, 5]), series("+Inf", [10, null])] };
    render(<DistributionHeatmap widget={{ ...widget, unit: "ms" }} result={plusInfMissing} />);
    fireEvent.focus(screen.getByRole("group", { name: /histogram buckets/ }));
    const list = screen.getByRole("list", { name: "Buckets at this time" });
    expect(list.querySelector('[data-histogram-bucket="2"]')).toHaveAttribute("data-histogram-state", "missing");
    expect(list.querySelector<HTMLElement>('[data-histogram-bucket="0"] i')!.style.width).toBe("100%");
    expect(parseFloat(list.querySelector<HTMLElement>('[data-histogram-bucket="1"] i')!.style.width)).toBeCloseTo(66.67, 1);
    expect(screen.getByText("Scaled to the largest bucket shown; window total unknown.")).toBeInTheDocument();
  });
  it("keeps a visible sliver for an observed bucket too small to show beside a large one", () => {
    const tiny: QueryResult = { series: [series("10", [1]), series("50", [1001]), series("100", [1002])] };
    render(<DistributionHeatmap widget={{ ...widget, unit: "ms" }} result={tiny} />);
    fireEvent.focus(screen.getByRole("group", { name: /histogram buckets/ }));
    const list = screen.getByRole("list", { name: "Buckets at this time" });
    expect(list.querySelector<HTMLElement>('[data-histogram-bucket="0"] i')!.style.minWidth).toBe("2px");
    expect(list.querySelector<HTMLElement>('[data-histogram-bucket="2"] i')!.style.minWidth).toBe("2px");
    expect(list.querySelector<HTMLElement>('[data-histogram-bucket="1"] i')!.style.width).toBe("100%");
  });
  it("keeps a keyboard-opened heatmap inspection when the pointer leaves the chart", async () => {
    const threeColumns: QueryResult = { series: [series("10", [1, 1, 1]), series("50", [2, 2, 2]), series("+Inf", [3, 3, 3])] };
    const { container } = render(<DistributionHeatmap widget={{ ...widget, unit: "ms" }} result={threeColumns} />);
    const chart = screen.getByRole("group", { name: /histogram buckets/ });
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    fireEvent.pointerLeave(container.firstElementChild!);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
    expect(screen.getByRole("region", { name: "Observation details" })).toBeInTheDocument();
  });
  it("still ends a pointer-opened heatmap inspection when the pointer leaves the chart, and keeps a keyboard one through margin movement", async () => {
    const threeColumns: QueryResult = { series: [series("10", [1, 1, 1]), series("50", [2, 2, 2]), series("+Inf", [3, 3, 3])] };
    const bounds = vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 600, height: 240, top: 0, left: 0, right: 600, bottom: 240, toJSON: () => ({}) });
    try {
      const { container } = render(<DistributionHeatmap widget={{ ...widget, unit: "ms" }} result={threeColumns} />);
      const chart = screen.getByRole("group", { name: /histogram buckets/ });
      fireEvent.pointerMove(chart, { clientX: 300, clientY: 120, pointerType: "mouse" });
      expect(screen.getByRole("region", { name: "Observation details" })).toBeInTheDocument();
      fireEvent.pointerLeave(container.firstElementChild!);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
      expect(screen.queryByRole("region", { name: "Observation details" })).not.toBeInTheDocument();
      fireEvent.focus(chart);
      fireEvent.keyDown(chart, { key: "ArrowLeft" });
      // A stray pointer event in the chart margin, outside the plot, must not close a keyboard observation.
      fireEvent.pointerMove(chart, { clientX: 2, clientY: 2, pointerType: "mouse" });
      expect(screen.getByRole("region", { name: "Observation details" })).toBeInTheDocument();
    } finally { bounds.mockRestore(); }
  });
});

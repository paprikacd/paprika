import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThresholdGauge, gaugeConfigSchema, gaugeTrackLayout, gaugeArcSize, registerDefaultWidgetPlugins } from "./threshold-gauge";
import { getWidgetDefinition } from "../widget-registry";
import { EmbeddedWidgetProvider } from "../widget-presentation";
import type { QueryResult, Widget } from "../schema";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const widget: Widget = { id: "capacity", title: "Free disk space", type: "plugin", pluginId: "threshold-gauge", providerId: "p", dataKind: "metrics", query: "disk", unit: "GB", layout: { x: 0, y: 0, w: 6, h: 4 }, options: { min: 0, max: 100, decimals: 2, showLegend: false } };
const result: QueryResult = { series: Array.from({ length: 6 }, (_, index) => ({ name: `sda${index + 1}`, labels: { disk: `sda${index + 1}`, host: "omega" }, points: [{ timestamp: 1000, value: 99 }, { timestamp: 2000, value: 22.718 + index * 3 }] })) };

describe("multi-series threshold gauges", () => {
  it.each(["linear", "segmented", "radial"] as const)("keeps %s gauges finite across extreme signed bounds", display => {
    const value = { series: [{ name: "sample", labels: {}, points: [{ timestamp: 1000, value: 5e307 }] }] };
    const thresholds = [{ value: -1e308, color: "#00aa00" }, { value: 0, color: "#ffaa00" }, { value: 5e307, color: "#cc0000" }];
    const { container } = render(<ThresholdGauge widget={{ ...widget, options: { ...widget.options, min: -1e308, max: 1e308, thresholds }, config: { display, segments: 10 } }} result={value} />);
    const track = container.querySelector<HTMLElement>("[data-gauge-progress]")!;
    expect(Number(track.dataset.gaugeProgress)).toBeCloseTo(.75);
    expect(track.outerHTML).not.toMatch(/NaN|Infinity/);
    if (display === "segmented") {
      const segments = [...track.querySelectorAll<HTMLElement>("[data-filled]")];
      expect(segments).toHaveLength(10);
      expect(segments[0].style.getPropertyValue("--meter-fill")).toBe("#00aa00");
      expect(segments[5].style.getPropertyValue("--meter-fill")).toBe("#ffaa00");
      expect(segments[9].style.getPropertyValue("--meter-fill")).toBe("#cc0000");
    }
  });
  it.each([{ options: { max: -1e308 }, value: -1e308 }, { options: { min: 1e308 }, value: 1e308 }])("infers a distinct finite missing bound at large magnitudes", ({ options, value }) => {
    const { container } = render(<ThresholdGauge widget={{ ...widget, options }} result={{ series: [{ name: "sample", labels: {}, points: [{ timestamp: 1000, value }] }] }} />);
    const meter = container.querySelector<HTMLElement>('[role="meter"]')!;
    expect(Number(meter.getAttribute("aria-valuemin"))).toBeLessThan(Number(meter.getAttribute("aria-valuemax")));
    expect(meter.outerHTML).not.toMatch(/NaN|Infinity/);
  });
  it("keeps threshold bands finite when a narrow extreme-scale gauge switches to a continuous track", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, width: 30, height: 20, left: 0, right: 30, top: 0, bottom: 20, toJSON() {} }));
    const thresholds = [{ value: -1e308, color: "#00aa00" }, { value: 0, color: "#ffaa00" }, { value: 5e307, color: "#cc0000" }];
    const { container } = render(<ThresholdGauge widget={{ ...widget, options: { min: -1e308, max: 1e308, thresholds }, config: { display: "segmented", segments: 10 } }} result={{ series: [{ name: "sample", labels: {}, points: [{ timestamp: 1000, value: 5e307 }] }] }} />);
    const track = container.querySelector<HTMLElement>('[data-gauge-rendering="continuous"]')!;
    const fill = track.querySelector<HTMLElement>('[data-gauge-solid-fill]')!;
    expect(track).toHaveAttribute("data-gauge-progress", "0.75");
    expect(fill.style.background).toContain("50%");
    expect(fill.style.background).toContain("75%");
    expect(fill.outerHTML).not.toMatch(/NaN|Infinity/);
  });
  it("explains an impossible inferred scale rather than rendering an invalid meter", () => {
    render(<ThresholdGauge widget={{ ...widget, options: { min: Number.MAX_VALUE } }} result={{ series: [{ name: "sample", labels: {}, points: [{ timestamp: 1000, value: Number.MAX_VALUE }] }] }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/finite.*bounds/i);
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  });
  it("preserves the existing first-series default", () => {
    render(<ThresholdGauge widget={widget} result={result} />);
    expect(screen.getAllByRole("meter")).toHaveLength(1);
    expect(screen.getByRole("meter", { name: "Free disk space" })).toHaveAttribute("aria-valuetext", "22.718 GB");
    expect(screen.queryByRole("region", { name: "Free disk space gauges" })).not.toBeInTheDocument();
  });
  it("renders a six-gauge radial bank with individually labeled exact observations", () => {
    const { container } = render(<ThresholdGauge widget={{ ...widget, config: { seriesMode: "all", display: "radial", columns: 3 } }} result={result} />);
    const bank = screen.getByRole("region", { name: "Free disk space gauges" });
    expect(bank).toHaveAttribute("data-gauge-columns", "3");
    expect(bank).toHaveStyle({ "--gauge-columns": "3" });
    expect(within(bank).getAllByRole("meter")).toHaveLength(6);
    expect(screen.getByRole("meter", { name: "Free disk space: sda6" })).toHaveAttribute("aria-valuetext", "37.718 GB");
    expect(container.querySelectorAll('[data-gauge-display="radial"]')).toHaveLength(6);
    expect(screen.getByText("22.72")).toBeInTheDocument();
    for (let index = 1; index <= 6; index++) expect(screen.getByText(`sda${index}`)).toBeInTheDocument();
  });
  it("associates bank reading accents with the observed thresholds and preserves an authored text color", () => {
    const thresholds = [{ value: 0, color: "#d05b61", label: "Critical" }, { value: 30, color: "#59a56b", label: "Healthy" }];
    const bankWidget = { ...widget, config: { seriesMode: "all", display: "radial" }, options: { ...widget.options, thresholds } };
    const { container, rerender } = render(<ThresholdGauge widget={bankWidget} result={result} />);
    const values = [...container.querySelectorAll<HTMLElement>("[data-gauge-value]")];
    expect(values[0].style.getPropertyValue("--gauge-status-color")).toBe("#d05b61");
    expect(values[3].style.getPropertyValue("--gauge-status-color")).toBe("#59a56b");
    expect(screen.getByRole("meter", { name: "Free disk space: sda1" })).toHaveAttribute("aria-valuetext", "22.718 GB · Critical");
    rerender(<ThresholdGauge widget={{ ...bankWidget, options: { ...bankWidget.options, textColor: "#18293a" } }} result={result} />);
    expect(container.querySelector<HTMLElement>("[data-gauge-value]")!.style.color).toBe("#18293a");
  });
  it("keeps radial scale endpoints as readable, non-scaling text without duplicating the meter semantics", () => {
    const { container } = render(<ThresholdGauge widget={{ ...widget, config: { seriesMode: "all", display: "radial" } }} result={result} />);
    const first = container.querySelector('[data-gauge-series="sda1"]')!;
    const bounds = first.querySelector('[data-gauge-radial-bounds]')!;
    expect(bounds).toHaveAttribute("aria-hidden", "true");
    expect(bounds.querySelector('[data-gauge-bound="min"]')).toHaveTextContent("0.00");
    expect(bounds.querySelector('[data-gauge-bound="max"]')).toHaveTextContent("100.00");
    expect(first.querySelector("svg text")).toBeNull();
    expect(screen.getByRole("meter", { name: "Free disk space: sda1" })).toHaveAttribute("aria-valuemax", "100");
  });
  it("renders compact segmented rows and preserves the selected series rather than the first", () => {
    const select = vi.fn();
    const { container } = render(<ThresholdGauge widget={{ ...widget, config: { seriesMode: "all", display: "segmented", segments: 10, columns: 1, showThresholds: false } }} result={result} onContextChange={select} />);
    expect(screen.getByRole("region", { name: "Free disk space gauges" })).toHaveAttribute("data-gauge-columns", "1");
    expect(container.querySelectorAll('[data-gauge-display="segmented"] > span')).toHaveLength(60);
    fireEvent.focus(screen.getByRole("button", { name: /Select signal for Free disk space: sda4:/ }));
    expect(select).toHaveBeenLastCalledWith({ series: "sda4", labels: { disk: "sda4", host: "omega" }, value: 31.718 });
    expect(screen.getByRole("tooltip").querySelector('[data-metric-value="31.718"]')).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("31.72 GB");
  });
  it("explains the observed threshold band and exact scale in the gauge tooltip", () => {
    const thresholds = [{ value: 0, color: "#d05b61", label: "Critical" }, { value: 30, color: "#d1a130", label: "Low" }, { value: 60, color: "#59a56b", label: "Healthy" }];
    const { rerender } = render(<ThresholdGauge widget={{ ...widget, options: { ...widget.options, thresholds } }} result={result} />);
    const trigger = screen.getByRole("button", { name: /Inspect value for Free disk space:/ });
    fireEvent.focus(trigger);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Critical");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Below 30 GB");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Scale: 0 to 100 GB");
    expect(screen.getByRole("tooltip").querySelector('[data-gauge-threshold-swatch]')).toHaveStyle({ background: "#d05b61" });
    fireEvent.blur(trigger);
    rerender(<ThresholdGauge widget={{ ...widget, options: { ...widget.options, thresholds } }} result={{ series: [{ ...result.series![0], points: [{ timestamp: 3000, value: 42 }] }] }} />);
    fireEvent.focus(screen.getByRole("button", { name: /Inspect value for Free disk space:/ }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("≥ 30 GB and < 60 GB");
    fireEvent.blur(screen.getByRole("button", { name: /Inspect value for Free disk space:/ }));
    rerender(<ThresholdGauge widget={{ ...widget, options: { ...widget.options, thresholds } }} result={{ series: [{ ...result.series![0], points: [{ timestamp: 4000, value: null }] }] }} />);
    fireEvent.focus(screen.getByRole("button", { name: /Inspect value for Free disk space:/ }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Unknown");
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("Below 30 GB");
  });
  it("discloses actual bank overflow and keeps the last gauge keyboard and pointer accessible", () => {
    let availableHeight = 210;
    const callbacks: ResizeObserverCallback[] = [];
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.hasAttribute("data-gauge-columns") ? availableHeight + (this.parentElement?.querySelector("[data-gauge-overflow-hint]") ? 0 : 18) : 0; });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.hasAttribute("data-gauge-columns") ? 320 : 0; });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { const height = this.hasAttribute("data-gauge-overflow-hint") ? 18 : 0; return { x: 0, y: 0, width: 0, height, left: 0, right: 0, top: 0, bottom: height, toJSON() {} }; });
    vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { callbacks.push(callback); } observe() {} disconnect() {} });
    const select = vi.fn();
    render(<ThresholdGauge widget={{ ...widget, config: { display: "radial", seriesMode: "all" } }} result={result} onContextChange={select} />);
    const bank = screen.getByRole("region", { name: "Free disk space gauges" });
    const hint = screen.getByText("Scroll to see all gauges");
    expect(bank).toHaveAttribute("aria-describedby", hint.id);
    expect(bank).toHaveAttribute("tabindex", "0");
    const last = within(bank).getByRole("button", { name: /Select signal for Free disk space: sda6:/ });
    expect(last).not.toHaveAttribute("tabindex", "-1");
    fireEvent.focus(last);
    expect(select).toHaveBeenLastCalledWith({ series: "sda6", labels: { disk: "sda6", host: "omega" }, value: 37.718 });
    fireEvent.blur(last);
    fireEvent.pointerEnter(last);
    expect(screen.getByRole("tooltip")).toHaveTextContent("37.72 GB");
    // The rows fit without the hint, but not in the space that the hint leaves.
    availableHeight = 305;
    act(() => callbacks.forEach(callback => callback([], {} as ResizeObserver)));
    expect(screen.queryByText("Scroll to see all gauges")).not.toBeInTheDocument();
    expect(bank).not.toHaveAttribute("aria-describedby");
    act(() => callbacks.forEach(callback => callback([], {} as ResizeObserver)));
    expect(screen.queryByText("Scroll to see all gauges")).not.toBeInTheDocument();
    expect(within(bank).getAllByRole("meter")).toHaveLength(6);
  });
  it("rechecks a temporary responsive overflow after the dashboard grid settles", () => {
    let contentHeight = 300;
    const frames: FrameRequestCallback[] = [];
    const observed: Element[] = [];
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.hasAttribute("data-gauge-columns") ? 200 : 0; });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) { return this.hasAttribute("data-gauge-columns") ? contentHeight : 0; });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { const height = this.hasAttribute("data-gauge-overflow-hint") ? 18 : 0; return { x: 0, y: 0, width: 0, height, left: 0, right: 0, top: 0, bottom: height, toJSON() {} }; });
    vi.stubGlobal("ResizeObserver", class { observe(element: Element) { observed.push(element); } disconnect() {} });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    render(<ThresholdGauge widget={{ ...widget, config: { display: "radial", seriesMode: "all" } }} result={result} />);
    expect(screen.getByText("Scroll to see all gauges")).toBeInTheDocument();
    expect(observed.some(element => element.hasAttribute("data-gauge-arc-body"))).toBe(true);
    // No ResizeObserver notification is needed when only the grid placement
    // changed; the scheduled recheck must clear the stale overflow hint.
    contentHeight = 200;
    act(() => frames.shift()?.(0));
    act(() => frames.shift()?.(16));
    expect(screen.queryByText("Scroll to see all gauges")).not.toBeInTheDocument();
  });
  it("exposes the configured density without changing exact segmented progress or unknown values", () => {
    const values = [0, 12.5, 55.25, 100, null];
    const { container } = render(<ThresholdGauge widget={{ ...widget, unit: "%", config: { seriesMode: "all", display: "segmented", segments: 60, maxSeries: 6 } }}
      result={{ series: values.map((value, index) => ({ name: `host-${index}`, labels: {}, points: [{ timestamp: 2000, value }] })) }} />);
    const tracks = [...container.querySelectorAll<HTMLElement>('[data-gauge-display="segmented"]')];
    expect(tracks).toHaveLength(values.length);
    tracks.forEach((track, index) => {
      expect(track).toHaveStyle({ "--meter-segments": "60" });
      const segments = [...track.querySelectorAll<HTMLElement>("span")];
      expect(segments).toHaveLength(60);
      const filled = segments.reduce((sum, segment) => sum + Number(segment.style.getPropertyValue("--meter-fraction")), 0);
      expect(filled / 60).toBeCloseTo((values[index] ?? 0) / 100, 10);
    });
    expect(screen.getAllByRole("meter")).toHaveLength(4);
    expect(screen.getByRole("meter", { name: "Free disk space: host-2" })).toHaveAttribute("aria-valuetext", "55.25%");
    expect(screen.getByText("Unknown · latest sample has no finite value")).toBeInTheDocument();
  });
  it("keeps a missing latest scrape unknown without falling back to an older or neighboring series", () => {
    const select = vi.fn();
    const missing: QueryResult = { series: [result.series![0], { ...result.series![1], points: [{ timestamp: 3000, value: null }, { timestamp: 1000, value: 72 }] }, result.series![2]] };
    const { container } = render(<ThresholdGauge widget={{ ...widget, config: { seriesMode: "all", display: "radial" } }} result={missing} onContextChange={select} />);
    expect(screen.getAllByRole("meter")).toHaveLength(2);
    expect(screen.getByText("Unknown · latest sample has no finite value")).toBeInTheDocument();
    const unknown = container.querySelector('[data-gauge-series="sda2"]')!;
    expect(unknown.querySelector("[stroke-dasharray]")).toBeNull();
    fireEvent.focus(screen.getByRole("button", { name: /Select signal for Free disk space: sda2: No data/ }));
    expect(select).toHaveBeenLastCalledWith({ series: "sda2", labels: { disk: "sda2", host: "omega" }, value: null });
    expect(screen.getByRole("tooltip").querySelector("time")).toHaveAttribute("datetime", "1970-01-01T00:00:03.000Z");
  });
  it("discloses both the bank limit and partial source responses", () => {
    const { rerender } = render(<ThresholdGauge widget={{ ...widget, config: { seriesMode: "all", maxSeries: 3 } }} result={{ ...result, truncated: true }} />);
    expect(screen.getAllByRole("meter")).toHaveLength(3);
    expect(screen.getByRole("status")).toHaveTextContent("Showing 3 of 6 series");
    expect(screen.getByRole("status")).toHaveTextContent("Partial source response");
    rerender(<ThresholdGauge widget={{ ...widget, config: { seriesMode: "all", maxSeries: 6 } }} result={result} />);
    expect(screen.getAllByRole("meter")).toHaveLength(6);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
  it("keeps context exact outside the scale and uses optional labels as a prefix for the bank", () => {
    const select = vi.fn();
    render(<ThresholdGauge widget={{ ...widget, config: { seriesMode: "all", label: "Disk" } }} result={{ series: [{ ...result.series![0], points: [{ timestamp: 2000, value: 112.3456 }] }] }} onContextChange={select} />);
    expect(screen.getByText("Disk · sda1")).toBeInTheDocument();
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuetext", "112.3456 GB");
    fireEvent.focus(screen.getByRole("button", { name: /Select signal/ }));
    expect(select.mock.calls.at(-1)![0].value).toBe(112.3456);
  });
  it("validates bounded bank configuration and exposes its guided controls", () => {
    registerDefaultWidgetPlugins();
    const definition = getWidgetDefinition("plugin", "threshold-gauge")!;
    expect(definition.defaultConfig).toMatchObject({ seriesMode: "first", maxSeries: 6, orientation: "horizontal" });
    expect(definition.configFields?.map(field => field.key)).toEqual(expect.arrayContaining(["orientation", "seriesMode", "columns", "maxSeries"]));
    for (const config of [{ orientation: "diagonal" }, { seriesMode: "last" }, { columns: 0 }, { columns: 13 }, { columns: 2.5 }, { maxSeries: 0 }, { maxSeries: 13 }, { unexpected: true }]) expect(gaugeConfigSchema.safeParse(config).success).toBe(false);
    expect(gaugeConfigSchema.safeParse({ seriesMode: "all", columns: 12, maxSeries: 12 }).success).toBe(true);
  });
  it("puts every horizontal gauge in a label, bar and value row with one shared legend", () => {
    const longName = 'container_cpu{cluster="omega",node="pool-a",namespace="observability",pod="collector-123456789",container="otelcol"}';
    const { container } = render(<ThresholdGauge widget={{ ...widget, options: { ...widget.options, showLegend: true, thresholds: [{ value: 0, color: "#159977", label: "Normal" }, { value: 70, color: "#cc9833", label: "High" }] }, config: { display: "segmented", seriesMode: "all" } }} result={{ series: [{ ...result.series![0], name: longName }, result.series![1]] }} />);
    const row = container.querySelector('[data-gauge-series]')!;
    const label = row.querySelector('[data-gauge-label]')!;
    expect(label).toHaveAttribute("title", longName);
    expect(label.nextElementSibling).toHaveAttribute("data-gauge-display", "segmented");
    expect(label.nextElementSibling?.nextElementSibling).toHaveAccessibleName(expect.stringContaining(longName));
    expect(screen.getByRole("region", { name: "Free disk space gauges" })).toHaveAttribute("data-gauge-bank-orientation", "horizontal");
    expect(container.querySelectorAll('[data-gauge-legend]')).toHaveLength(1);
    expect(screen.getAllByLabelText("Threshold limits")).toHaveLength(1);
    expect(row.querySelector('[data-gauge-value]')).toHaveAttribute("data-gauge-value", "22.718");
    expect(row.querySelector('[data-gauge-value]')).not.toHaveAttribute("title");
  });
  it("keeps native exact-value text only when interactive details are disabled", () => {
    const { container, rerender } = render(<ThresholdGauge widget={{ ...widget, options: { ...widget.options, showTooltip: false }, config: { seriesMode: "all" } }} result={result} />);
    expect(container.querySelector('[data-gauge-value]')).toHaveAttribute("title", "22.718 GB");
    rerender(<ThresholdGauge widget={{ ...widget, options: { ...widget.options, showTooltip: true }, config: { seriesMode: "all" } }} result={result} />);
    expect(container.querySelector('[data-gauge-value]')).not.toHaveAttribute("title");
  });
  it("shows opt-in threshold status for horizontal banks, including unknown values", () => {
    const config = { display: "linear", seriesMode: "all", showStatus: true };
    const options = { ...widget.options, thresholds: [{ value: 0, color: "#159977", label: "OK" }, { value: 30, color: "#cc9833", label: "Delayed" }] };
    const values = [22, 31, null].map((value, index) => ({ name: `source-${index}`, labels: {}, points: [{ timestamp: 1000, value }] }));
    const { container, rerender } = render(<ThresholdGauge widget={{ ...widget, options, config }} result={{ series: values }} />);
    expect([...container.querySelectorAll('[data-gauge-status]')].map(element => element.textContent)).toEqual(["OK", "Delayed", "Unknown"]);
    expect(container.querySelector('[data-gauge-series="source-1"] [role="meter"]')).toHaveAttribute("aria-valuetext", expect.stringContaining("Delayed"));
    rerender(<ThresholdGauge widget={{ ...widget, options, config: { ...config, orientation: "vertical" } }} result={{ series: values }} />);
    expect(container.querySelectorAll('[data-gauge-status]')).toHaveLength(0);
  });
  it("renders explicit vertical continuous bars bottom-up while radial remains an arc", () => {
    const { container, rerender } = render(<ThresholdGauge widget={{ ...widget, unit: "%", config: { display: "linear", orientation: "vertical", seriesMode: "all" } }} result={{ series: [{ ...result.series![0], points: [{ timestamp: 2000, value: 12.5 }] }] }} />);
    const track = container.querySelector('[data-gauge-display="linear"]')!;
    expect(track).toHaveAttribute("data-gauge-orientation", "vertical");
    expect(track.querySelector('[data-gauge-solid-fill]')).toHaveStyle({ height: "12.5%" });
    expect(track).toHaveAttribute("aria-valuetext", "12.5%");
    expect(screen.getByRole("region", { name: "Free disk space gauges" })).toHaveAttribute("data-gauge-columns", "4");
    rerender(<ThresholdGauge widget={{ ...widget, config: { display: "radial", orientation: "vertical" } }} result={result} />);
    expect(container.querySelector('[data-gauge-display="radial"]')).not.toHaveAttribute("data-gauge-orientation");
    expect(container.querySelector('path[stroke-dasharray]')).toHaveAttribute("stroke-dasharray", "22.718 100");
  });
  it("keeps exact partial vertical cells, negative scales and missing observations", () => {
    const select = vi.fn();
    const { container } = render(<ThresholdGauge widget={{ ...widget, options: { min: -20, max: 20, showLegend: false }, config: { display: "segmented", orientation: "vertical", segments: 8, seriesMode: "all" } }} result={{ series: [{ ...result.series![0], points: [{ timestamp: 2000, value: -7.5 }] }, { ...result.series![1], points: [{ timestamp: 1000, value: 5 }, { timestamp: 2000, value: Infinity }] }] }} onContextChange={select} />);
    const tracks = container.querySelectorAll<HTMLElement>('[data-gauge-display="segmented"]');
    expect([...tracks[0].querySelectorAll<HTMLElement>('span')].map(segment => Number(segment.style.getPropertyValue("--meter-fraction")))).toEqual([1, 1, .5, 0, 0, 0, 0, 0]);
    expect(tracks[0]).toHaveAttribute("aria-valuetext", "-7.5 GB");
    expect(tracks[1]).toHaveAttribute("data-gauge-unknown", "true");
    expect(tracks[1]).not.toHaveAttribute("role");
    fireEvent.focus(screen.getByRole("button", { name: /Select signal for Free disk space: sda2: No data/ }));
    expect(select).toHaveBeenLastCalledWith({ series: "sda2", labels: { disk: "sda2", host: "omega" }, value: null });
  });
  it("uses continuous threshold bands when the axis cannot fit four-pixel cells, and restores cells on resize", () => {
    let width = 200, height = 80;
    const resize: ResizeObserverCallback[] = [];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, width, height, left: 0, right: width, top: 0, bottom: height, toJSON() {} }));
    vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { resize.push(callback); } observe() {} disconnect() {} });
    const { container, rerender } = render(<ThresholdGauge widget={{ ...widget, unit: "%", options: { ...widget.options, thresholds: [{ value: 0, color: "#159977" }, { value: 70, color: "#cc9833" }] }, config: { display: "segmented", segments: 60 } }} result={{ series: [{ ...result.series![0], points: [{ timestamp: 2000, value: 12.5 }] }] }} />);
    const track = container.querySelector('[data-gauge-display="segmented"]')!;
    expect(track).toHaveAttribute("data-gauge-rendering", "continuous");
    expect(track).toHaveAttribute("aria-description", "Continuous threshold scale");
    expect(track.querySelector('[data-gauge-solid-fill]')).toHaveStyle({ clipPath: "inset(0 87.5% 0 0)" });
    expect(track.querySelector('[data-gauge-solid-fill]')?.getAttribute("style")).toContain("70%");
    width = 360;
    act(() => resize.forEach(callback => callback([], {} as ResizeObserver)));
    expect(track).toHaveAttribute("data-gauge-rendering", "segmented");
    expect(track.querySelectorAll('span')).toHaveLength(60);
    rerender(<ThresholdGauge widget={{ ...widget, config: { display: "segmented", orientation: "vertical", segments: 60 } }} result={result} />);
    expect(track).toHaveAttribute("data-gauge-rendering", "continuous");
    height = 260;
    act(() => resize.forEach(callback => callback([], {} as ResizeObserver)));
    expect(track).toHaveAttribute("data-gauge-rendering", "segmented");
    expect(track).toHaveAttribute("aria-valuetext", "22.718 GB");
  });
  it("bounds separated cells at four pixels without altering configured segment counts", () => {
    for (const segments of [8, 24, 60]) for (const extent of [23, 32, 96, 120, 239, 240, 360, 600]) {
      const layout = gaugeTrackLayout(extent, segments);
      if (layout.continuous) expect(extent).toBeLessThan(segments * 4);
      else expect((extent - layout.gap * (segments - 1)) / segments).toBeGreaterThanOrEqual(4);
    }
  });
  it("separates full vertical numbers and units from each distinct host label", () => {
    const { container } = render(<ThresholdGauge widget={{ ...widget, unit: "W", options: { ...widget.options, max: 200, decimals: 0 }, config: { display: "segmented", orientation: "vertical", seriesMode: "all", columns: 6 } }} result={{ series: Array.from({ length: 6 }, (_, index) => ({ name: `host-0${index + 1}`, labels: { host: `host-0${index + 1}` }, points: [{ timestamp: 2000, value: 100 + index }] })) }} />);
    for (const [index, row] of [...container.querySelectorAll('[data-gauge-series]')].entries()) {
      expect(row.querySelector('[data-gauge-label]')).toHaveTextContent(`host-0${index + 1}`);
      expect(row.querySelector('[data-gauge-number]')).toHaveTextContent(String(100 + index));
      expect(row.querySelector('[data-gauge-unit]')).toHaveTextContent("W");
      expect(row.querySelector('[data-gauge-number]')?.textContent).not.toContain("…");
    }
  });
  it("bounds radial arcs by the remaining frame rather than taking the label's row", () => {
    for (const [width, height] of [[150, 76], [120, 70], [80, 45], [500, 180]]) {
      const size = gaugeArcSize(width, height, 200);
      expect(size.width).toBeLessThanOrEqual(width);
      expect(size.height).toBeLessThanOrEqual(height);
      expect(size.width).toBeLessThanOrEqual(200);
      expect(size.width / size.height).toBeCloseTo(200 / 114, 10);
    }
    let width = 150, height = 76;
    const resize: ResizeObserverCallback[] = [];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, width, height, left: 0, right: width, top: 0, bottom: height, toJSON() {} }));
    vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { resize.push(callback); } observe() {} disconnect() {} });
    const { container } = render(<ThresholdGauge widget={{ ...widget, config: { display: "radial", seriesMode: "all", maxSeries: 1 } }} result={result} />);
    const arc = container.querySelector<HTMLElement>('[data-gauge-arc-body]')!;
    expect(Number.parseFloat(arc.style.height)).toBe(76);
    expect(container.querySelector('[data-gauge-arc-frame]')?.nextElementSibling).toHaveAttribute("data-gauge-label");
    width = 200; height = 50;
    act(() => resize.forEach(callback => callback([], {} as ResizeObserver)));
    expect(Number.parseFloat(arc.style.height)).toBe(50);
    expect(Number.parseFloat(arc.style.width)).toBeCloseTo(50 * 200 / 114, 5);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuetext", "22.718 GB");
  });
  it("suppresses nested inspection in an embedded bank", () => {
    const select = vi.fn();
    render(<EmbeddedWidgetProvider><ThresholdGauge widget={{ ...widget, config: { seriesMode: "all" } }} result={result} onContextChange={select} /></EmbeddedWidgetProvider>);
    expect(screen.getAllByRole("meter")).toHaveLength(6);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(select).not.toHaveBeenCalled();
  });
});

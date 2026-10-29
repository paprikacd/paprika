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

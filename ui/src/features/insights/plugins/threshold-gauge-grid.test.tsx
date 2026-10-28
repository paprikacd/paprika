import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThresholdGauge, gaugeConfigSchema, registerDefaultWidgetPlugins } from "./threshold-gauge";
import { getWidgetDefinition } from "../widget-registry";
import { EmbeddedWidgetProvider } from "../widget-presentation";
import type { QueryResult, Widget } from "../schema";

afterEach(cleanup);
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
    expect(definition.defaultConfig).toMatchObject({ seriesMode: "first", maxSeries: 6 });
    expect(definition.configFields?.map(field => field.key)).toEqual(expect.arrayContaining(["seriesMode", "columns", "maxSeries"]));
    for (const config of [{ seriesMode: "last" }, { columns: 0 }, { columns: 5 }, { columns: 2.5 }, { maxSeries: 0 }, { maxSeries: 13 }, { unexpected: true }]) expect(gaugeConfigSchema.safeParse(config).success).toBe(false);
    expect(gaugeConfigSchema.safeParse({ seriesMode: "all", columns: 4, maxSeries: 12 }).success).toBe(true);
  });
  it("suppresses nested inspection in an embedded bank", () => {
    const select = vi.fn();
    render(<EmbeddedWidgetProvider><ThresholdGauge widget={{ ...widget, config: { seriesMode: "all" } }} result={result} onContextChange={select} /></EmbeddedWidgetProvider>);
    expect(screen.getAllByRole("meter")).toHaveLength(6);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(select).not.toHaveBeenCalled();
  });
});

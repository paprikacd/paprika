import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginConfigEditor } from "../plugin-config-editor";
import { getWidgetDefinition } from "../widget-registry";
import type { QueryResult, Widget } from "../schema";
import { RecordTreemap, registerRecordWidgetPlugins, treemapColor } from "./records";

afterEach(cleanup);
const widget: Widget = { id: "market", title: "Market", type: "plugin", pluginId: "record-treemap", dataKind: "records", providerId: "records", query: "select", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, config: { label: "ticker", value: "market_cap", colorField: "short_interest" } };
const result: QueryResult = { records: { columns: [{ key: "ticker", type: "string" }, { key: "market_cap", label: "Market cap", type: "number", unit: "B" }, { key: "short_interest", label: "Short interest", type: "number", unit: "%" }], rows: [["A", 100, 0], ["B", 50, 8], ["C", 25, null], ["D", 0, 100]] } };

describe("independent treemap color", () => {
  it("labels grouped areas and retains selection data", () => {
    const selected = vi.fn();
    const grouped = { records: { columns: [...result.records!.columns, { key: "sector", type: "string" as const }], rows: [["A", 100, 0, "Technology"], ["B", 50, 8, "Financials"]] } };
    render(<RecordTreemap widget={{ ...widget, config: { ...widget.config, group: "sector" } }} result={grouped} onContextChange={selected} />);
    expect(screen.getByText("Technology")).toBeInTheDocument();
    expect(screen.getByText("Financials")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /B:.*Short interest: 8/ }));
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ labels: expect.objectContaining({ ticker: "B", sector: "Financials" }) }));
  });
  it("keeps text readable across the complete color range", () => {
    for (let value = 0; value <= 100; value++) {
      const { fill, ink } = treemapColor(value, 0, 100);
      const channels = fill.match(/\d+/g)!.map(Number).map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2);
      const light = .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
      const contrast = ink === "#000000" ? (light + .05) / .05 : 1.05 / (light + .05);
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("lays out tiles in the actual viewport and responds to resizing", () => {
    let width = 320, height = 200;
    let resized: ResizeObserverCallback | undefined;
    const bounds = vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() {} }));
    vi.stubGlobal("ResizeObserver", class { constructor(callback: ResizeObserverCallback) { resized = callback; } observe() {} disconnect() {} });
    try {
      const { container } = render(<RecordTreemap widget={widget} result={result} />);
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("viewBox")).toBe("0 0 320 200");
      const area = Number(svg.querySelector("g rect")?.getAttribute("width"));
      width = 600; height = 300;
      act(() => resized?.([], {} as ResizeObserver));
      expect(svg.getAttribute("viewBox")).toBe("0 0 600 300");
      expect(Number(svg.querySelector("g rect")?.getAttribute("width"))).toBeGreaterThan(area);
    } finally { bounds.mockRestore(); vi.unstubAllGlobals(); }
  });
  it("uses area for size and a separate numerical scale for color; preserves zero and missing", () => {
    const selected = vi.fn();
    const { container } = render(<RecordTreemap widget={widget} result={result} onContextChange={selected} />);
    const a = screen.getByRole("button", { name: /A:.*Short interest: 0/ });
    const b = screen.getByRole("button", { name: /B:.*Short interest: 8/ });
    const c = screen.getByRole("button", { name: /C:.*Short interest: No data/ });
    const rect = (node: HTMLElement) => node.querySelector("rect")!;
    const area = (node: HTMLElement) => Number(rect(node).getAttribute("width")) * Number(rect(node).getAttribute("height"));
    expect(area(a)).toBeGreaterThan(area(b)); expect(area(b)).toBeGreaterThan(area(c));
    expect(rect(a).getAttribute("fill")).not.toEqual(rect(b).getAttribute("fill"));
    expect(rect(c).getAttribute("fill")).toMatch(/^url\(#/);
    expect(screen.getByText(/1 zero, missing or negative/)).toBeInTheDocument();
    const legend = screen.getByRole("group", { name: "Treemap color scale" });
    expect(within(legend).getByText("Short interest")).toBeInTheDocument();
    expect(within(legend).getByText("No data")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-treemap-color-value]")).toHaveLength(2);
    fireEvent.keyDown(b, { key: "Enter" });
    expect(selected).toHaveBeenCalledWith({ labels: { ticker: "B", market_cap: "50", short_interest: "8" }, value: 50, series: "B" });
  });
  it("supports an explicit stable scale and rejects invalid or nonnumeric configuration", () => {
    registerRecordWidgetPlugins();
    const definition = getWidgetDefinition("plugin", "record-treemap")!;
    expect(() => definition.parseConfig!({ label: "x", value: "y", colorField: "z", colorMin: 2 })).toThrow();
    expect(() => definition.parseConfig!({ label: "x", value: "y", colorField: "z", colorMin: 5, colorMax: 2 })).toThrow();
    expect(() => definition.parseConfig!({ label: "x", value: "y", colorMin: 0, colorMax: 1 })).toThrow();
    const fixed = { ...widget, config: { ...widget.config, colorMin: 0, colorMax: 16 } };
    const { container, rerender } = render(<RecordTreemap widget={fixed} result={result} />);
    const color = container.querySelector('[data-treemap-color-value="8"]')?.getAttribute("fill");
    rerender(<RecordTreemap widget={fixed} result={{ records: { ...result.records!, rows: [result.records!.rows[1]] } }} />);
    expect(container.querySelector('[data-treemap-color-value="8"]')?.getAttribute("fill")).toEqual(color);
    rerender(<RecordTreemap widget={{ ...widget, config: { label: "ticker", value: "market_cap", colorField: "ticker" } }} result={result} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Color field must be numeric");
  });
  it("exposes guided area and color inputs without discarding existing settings", () => {
    registerRecordWidgetPlugins();
    const change = vi.fn();
    render(<PluginConfigEditor definition={getWidgetDefinition("plugin", "record-treemap")} value={JSON.stringify(widget.config)} onChange={change} />);
    fireEvent.change(screen.getByLabelText("Color field"), { target: { value: "risk" } });
    expect(JSON.parse(change.mock.lastCall![0])).toEqual({ label: "ticker", value: "market_cap", colorField: "risk" });
  });
  it("offers result-column suggestions with numeric type guidance while preserving manual input", () => {
    registerRecordWidgetPlugins();
    const change = vi.fn();
    const fields = { seriesCount: 0, labels: [], partial: false, recordColumns: [{ name: "ticker", type: "string" }, { name: "market_cap", type: "number" }, { name: "sector", type: "string" }] };
    const { rerender } = render(<PluginConfigEditor definition={getWidgetDefinition("plugin", "record-treemap")} value={JSON.stringify(widget.config)} onChange={change} queryFields={fields} />);
    expect(screen.getByText(/Available result fields:/)).toHaveTextContent("market_cap (number)");
    const area = screen.getByLabelText("Area field") as HTMLInputElement;
    expect([...area.list!.options].map(option => option.value)).toEqual(["market_cap"]);
    const group = screen.getByLabelText("Group field") as HTMLInputElement;
    expect([...group.list!.options].map(option => option.value)).toContain("sector");
    fireEvent.change(group, { target: { value: "unloaded_field" } });
    expect(JSON.parse(change.mock.lastCall![0]).group).toBe("unloaded_field");
    rerender(<PluginConfigEditor definition={getWidgetDefinition("plugin", "record-treemap")} value={JSON.stringify({ ...widget.config, value: "ticker" })} onChange={change} queryFields={fields} />);
    expect(screen.getByText(/“ticker” is string; choose a numeric field/)).toBeInTheDocument();
  });
});

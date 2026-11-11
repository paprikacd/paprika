import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetEditor } from "./widget-editor";
import { seriesHex } from "./series-palette";
import { identitySlot } from "./series-colors";
import { registerRecordWidgetPlugins } from "./plugins/records";
import { registerRichMetricPlugins } from "./plugins/rich-metrics";
import { INSIGHTS_THEME_KEY } from "./insights-theme";
import { CANVAS_DENSITY_KEY } from "./canvas-density";
import type { Provider, QueryResult, Widget } from "./schema";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const providers: Provider[] = [{ id: "production", name: "Production Prometheus", type: "prometheus", capabilities: ["metrics"] }];
const base: Widget = { id: "rate", title: "Request rate", type: "timeseries", providerId: "production", query: "rate", unit: "req/s", layout: { x: 0, y: 0, w: 8, h: 4 } };
/** A labelled series, as Prometheus returns one: its identity is service=<name>. */
const sample = (service: string) => ({ name: `{service="${service}"}`, labels: { service }, points: [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: 2 }] });
const checkoutSlot = identitySlot("service=checkout");

/** The editor's Style tab, with the loaded result when one is given. Returns the apply callback the author's changes reach. */
function openStyle(widget: Widget, result?: QueryResult) {
  const onApply = vi.fn();
  render(<WidgetEditor widget={widget} providers={providers} result={result} onApply={onApply} onClose={vi.fn()} onDuplicate={vi.fn()} onDelete={vi.fn()} onMove={vi.fn()} />);
  fireEvent.click(screen.getByRole("tab", { name: "Style" }));
  return onApply;
}
const applied = (onApply: ReturnType<typeof vi.fn>) => onApply.mock.lastCall![0] as Widget;
const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");

describe("series colour controls", () => {
  it("shows Palette pressed for a widget without a colour of its own", () => {
    openStyle(base, { series: [sample("checkout")] });
    expect(pressed("Palette")).toBe("true");
    expect(pressed("Custom")).toBe("false");
  });

  it("shows the colour the series draws, from its label identity", () => {
    // The first series in identity order is service=checkout, which draws its home slot in light mode.
    openStyle(base, { series: [sample("worker"), sample("checkout")] });
    expect(screen.getByLabelText("Series color")).toHaveValue(seriesHex(checkoutSlot, "light"));
  });

  it("shows the first palette slot before data loads, and says when Custom becomes available", () => {
    openStyle(base);
    expect(screen.getByLabelText("Series color")).toHaveValue(seriesHex(0, "light"));
    expect(screen.getByText("Palette shows the colour the first series draws. Custom becomes available once data loads.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Custom" })).toBeDisabled();
  });

  it("keeps Custom unavailable before data loads, so it cannot write a colour that changes the line", () => {
    openStyle(base);
    expect(screen.getByRole("button", { name: "Custom" })).toBeDisabled();
  });

  it("Custom writes the colour the single series draws, and Palette clears it", () => {
    const onApply = openStyle(base, { series: [sample("checkout")] });
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(applied(onApply).color).toBe(seriesHex(checkoutSlot, "light"));
  });

  it("a chosen colour shows Custom pressed on a single-series widget, and Palette removes it", () => {
    const onApply = openStyle({ ...base, color: "#7c58ad" }, { series: [sample("checkout")] });
    expect(pressed("Custom")).toBe("true");
    expect(screen.getByLabelText("Series color")).toHaveValue("#7c58ad");
    fireEvent.click(screen.getByRole("button", { name: "Palette" }));
    expect(pressed("Palette")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(applied(onApply).color).toBeUndefined();
  });

  it("a chosen colour on a multi-series widget does not draw, so Custom is not pressed and the editor says why", () => {
    openStyle({ ...base, color: "#7c58ad" }, { series: [sample("catalog"), sample("checkout")] });
    expect(pressed("Custom")).toBe("false");
    expect(pressed("Palette")).toBe("true");
    expect(screen.getByText("A chosen colour applies only when this widget draws one series. These series keep their identity colours.")).toBeInTheDocument();
  });

  it("editing the swatch writes a hex colour and switches to Custom", () => {
    const onApply = openStyle(base, { series: [sample("checkout")] });
    fireEvent.change(screen.getByLabelText("Series color"), { target: { value: "#123456" } });
    expect(pressed("Custom")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(applied(onApply).color).toBe("#123456");
  });

  it("shows the compact-dark hex when the compact dark appearance is active", () => {
    window.localStorage.setItem(INSIGHTS_THEME_KEY, "dark");
    window.localStorage.setItem(CANVAS_DENSITY_KEY, "true");
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    openStyle(base, { series: [sample("checkout")] });
    expect(screen.getByLabelText("Series color")).toHaveValue(seriesHex(checkoutSlot, "compact"));
  });

  it("uses the rich-metrics rule in its plugin configuration for the swatch", () => {
    registerRichMetricPlugins();
    const stacked: Widget = { id: "traffic", title: "Traffic", type: "plugin", pluginId: "stacked-timeseries", dataKind: "metrics", providerId: "metrics", query: "rate", unit: "req/s", layout: { x: 0, y: 0, w: 8, h: 4 }, config: { seriesColors: [{ label: "service", value: "checkout", color: "#123456" }] } };
    openStyle(stacked, { series: [sample("checkout")] });
    expect(screen.getByLabelText("Series color")).toHaveValue("#123456");
  });

  it("offers no palette for a record table, which colours its cells by its own rules", () => {
    registerRecordWidgetPlugins();
    const table: Widget = { id: "records", title: "Records", type: "plugin", pluginId: "record-table", dataKind: "records", providerId: "uptime", query: "records", unit: "", layout: { x: 0, y: 0, w: 8, h: 4 } };
    openStyle(table, { records: { columns: [], rows: [] } });
    expect(screen.queryByRole("group", { name: "Series color source" })).not.toBeInTheDocument();
    expect(screen.getByText("No palette colour applies to this widget. Choose a colour to set one.")).toBeInTheDocument();
  });

  it("writes position colouring only when chosen, and name colouring removes it", () => {
    const onApply = openStyle(base);
    expect(pressed("By name")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "By position" }));
    expect(pressed("By position")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(applied(onApply).options?.seriesColorMode).toBe("index");
  });

  it("reads a saved position mode back and returns to name by removing it", () => {
    const onApply = openStyle({ ...base, options: { seriesColorMode: "index" } });
    expect(pressed("By position")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "By name" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(applied(onApply).options?.seriesColorMode).toBeUndefined();
  });

  it("offers no colour mode for a single value", () => {
    openStyle({ ...base, type: "stat" });
    expect(screen.queryByRole("group", { name: "Series color by" })).not.toBeInTheDocument();
  });
});

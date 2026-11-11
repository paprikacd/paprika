import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WidgetEditor } from "./widget-editor";
import { seriesHex, seriesSlot } from "./series-palette";
import { fnv1a32 } from "./series-colors";
import type { Provider, QueryResult, Widget } from "./schema";

const providers: Provider[] = [{ id: "production", name: "Production Prometheus", type: "prometheus", capabilities: ["metrics"] }];
const base: Widget = { id: "rate", title: "Request rate", type: "timeseries", providerId: "production", query: "rate", unit: "req/s", layout: { x: 0, y: 0, w: 8, h: 4 } };
const sample = (name: string) => ({ name, labels: { service: name }, points: [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: 2 }] });

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
    openStyle(base);
    expect(pressed("Palette")).toBe("true");
    expect(pressed("Custom")).toBe("false");
  });

  it("shows the colour a series draws in the swatch, not a hard-coded fallback", () => {
    // checkout hashes to slot 2 (--gamma-series-2) and sorts first, so it draws that slot in light mode.
    expect(seriesSlot(fnv1a32("checkout") % 8)).toContain("--gamma-series-2,");
    openStyle(base, { series: [sample("worker"), sample("checkout")] });
    expect(screen.getByLabelText("Series color")).toHaveValue(seriesHex(fnv1a32("checkout") % 8, "light"));
  });

  it("shows the first palette slot before data loads, and says when it will update", () => {
    openStyle(base);
    expect(screen.getByLabelText("Series color")).toHaveValue(seriesHex(0, "light"));
    expect(screen.getByText("Palette shows the colour the first series draws; it appears once data loads.")).toBeInTheDocument();
  });

  it("Custom writes the swatch colour, and Palette clears it", () => {
    const onApply = openStyle(base);
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(applied(onApply).color).toBe(seriesHex(0, "light"));
  });

  it("a chosen colour is kept, shows Custom pressed, and Palette removes it", () => {
    const onApply = openStyle({ ...base, color: "#7c58ad" });
    expect(pressed("Custom")).toBe("true");
    expect(screen.getByLabelText("Series color")).toHaveValue("#7c58ad");
    fireEvent.click(screen.getByRole("button", { name: "Palette" }));
    expect(pressed("Palette")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(applied(onApply).color).toBeUndefined();
  });

  it("editing the swatch writes a hex colour and switches to Custom", () => {
    const onApply = openStyle(base);
    fireEvent.change(screen.getByLabelText("Series color"), { target: { value: "#123456" } });
    expect(pressed("Custom")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Apply widget" }));
    expect(applied(onApply).color).toBe("#123456");
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

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WidgetEditor } from "./widget-editor";
import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge";
import type { Provider, Widget } from "./schema";

registerDefaultWidgetPlugins();

const providers: Provider[] = [
  { id: "production", name: "Production Prometheus", type: "prometheus", capabilities: ["metrics"] },
];
const timeseries: Widget = { id: "requests", title: "Requests", type: "timeseries", query: "up", providerId: "production", unit: "req/s", layout: { x: 0, y: 0, w: 6, h: 4 } };
const callbacks = () => ({ onApply: vi.fn(), onClose: vi.fn(), onDuplicate: vi.fn(), onDelete: vi.fn(), onMove: vi.fn() });

function openStyle(widget: Widget) {
  const handlers = callbacks();
  render(<WidgetEditor {...handlers} widget={widget} providers={providers} />);
  fireEvent.click(screen.getByRole("tab", { name: "Style" }));
  return handlers;
}
function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

describe("time-series rendering controls", () => {
  it("offers the time-axis, gridline, zero-line, inset and reference-line controls for a time series", () => {
    openStyle(timeseries);
    expect(screen.getByRole("combobox", { name: "Time axis" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Vertical gridlines" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Show zero line" })).toBeInTheDocument();
    expect(screen.getByLabelText("Left inset (px)")).toBeInTheDocument();
    expect(screen.getByLabelText("Right inset (px)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add reference line" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Y-axis unit" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Inspector side" })).toBeInTheDocument();
  });

  it("offers no time-axis, gridline or reference control to a bar chart, which does not draw them", () => {
    openStyle({ ...timeseries, id: "by-service", type: "bar", title: "By service" });
    expect(screen.queryByRole("combobox", { name: "Time axis" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Vertical gridlines" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add reference line" })).not.toBeInTheDocument();
    // A bar chart captions its unit and places its inspector, so those two stay.
    expect(screen.getByRole("combobox", { name: "Y-axis unit" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Inspector side" })).toBeInTheDocument();
  });

  it("offers inspector placement, but no axis controls, to a rich plugin that reads the placement keys", () => {
    openStyle({ ...timeseries, id: "stack", type: "plugin", pluginId: "stacked-timeseries", dataKind: "metrics", config: {} });
    expect(screen.getByRole("combobox", { name: "Inspector side" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Time axis" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Y-axis unit" })).not.toBeInTheDocument();
  });

  it("writes the chosen time axis into the live preview", () => {
    const { onApply } = openStyle(timeseries);
    choose("Time axis", "Calendar");
    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ timeAxis: "calendar" }) }));
  });

  it("adds a reference line whose value joins the preview, and removes it again", () => {
    const { onApply } = openStyle(timeseries);
    fireEvent.click(screen.getByRole("button", { name: "Add reference line" }));
    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ referenceLines: [{ value: 0 }] }) }));
    fireEvent.change(screen.getByLabelText("Reference line 1 value"), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText("Reference line 1 label"), { target: { value: "Target" } });
    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ referenceLines: [{ value: 50, label: "Target" }] }) }));
    fireEvent.click(screen.getByRole("button", { name: "Remove reference line 1" }));
    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ referenceLines: [] }) }));
  });

  it("caps the reference lines at eight", () => {
    openStyle({ ...timeseries, options: { referenceLines: Array.from({ length: 8 }, (_, index) => ({ value: index })) } });
    expect(screen.getByRole("button", { name: "Add reference line" })).toBeDisabled();
  });

  it("writes the Y-axis unit and the inspector placement into the live preview", () => {
    const { onApply } = openStyle(timeseries);
    choose("Y-axis unit", "Caption above the plot");
    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ axisUnit: "caption" }) }));
    choose("Inspector side", "Below");
    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ tooltipPlacement: "bottom", axisUnit: "caption" }) }));
  });
});

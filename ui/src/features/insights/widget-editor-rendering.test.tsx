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
    expect(screen.queryByRole("combobox", { name: "Inspector side" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Tooltips" }));
    expect(screen.getByRole("combobox", { name: "Inspector side" })).toBeInTheDocument();
  });

  it("offers no time-axis, gridline or reference control to a bar chart, which does not draw them", () => {
    openStyle({ ...timeseries, id: "by-service", type: "bar", title: "By service" });
    expect(screen.queryByRole("combobox", { name: "Time axis" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Vertical gridlines" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add reference line" })).not.toBeInTheDocument();
    // Axis styling stays in Style; inspector placement belongs with its tooltip.
    expect(screen.getByRole("combobox", { name: "Y-axis unit" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Inspector side" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Tooltips" }));
    expect(screen.getByRole("combobox", { name: "Inspector side" })).toBeInTheDocument();
  });

  it("offers inspector placement, but no axis controls, to a rich plugin that reads the placement keys", () => {
    openStyle({ ...timeseries, id: "stack", type: "plugin", pluginId: "stacked-timeseries", dataKind: "metrics", config: {} });
    expect(screen.queryByRole("combobox", { name: "Time axis" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Y-axis unit" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Configure tooltips" }));
    expect(screen.getByRole("combobox", { name: "Inspector side" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add tooltip widget" })).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("tab", { name: "Tooltips" }));
    choose("Inspector side", "Below");
    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ tooltipPlacement: "bottom", axisUnit: "caption" }) }));
  });

  it("preserves tooltip placement and reading presentation when appearance is reset", () => {
    const options = { tooltipPlacement: "bottom" as const, tooltipOffset: 18, tooltipMaxWidth: 420, tooltipMaxHeight: 320, tooltipTitle: "Request rate", tooltipDecimals: 3, showTooltip: false };
    const { onApply } = openStyle({ ...timeseries, options: { ...options, showGrid: false } });
    fireEvent.click(screen.getByRole("button", { name: "Reset appearance" }));
    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ query: "up", providerId: "production", layout: timeseries.layout, options }));
    fireEvent.click(screen.getByRole("tab", { name: "Tooltips" }));
    expect(screen.getByRole("switch", { name: "Show tooltips" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: "Show tooltips" }));
    expect(screen.getByRole("combobox", { name: "Inspector side" })).toHaveTextContent("Below");
    expect(screen.getByLabelText("Maximum width (px)")).toHaveValue(420);
    expect(screen.getByLabelText("Tooltip heading")).toHaveValue("Request rate");
  });

  it("keeps the last valid preview when an inspector dimension is outside its supported range", () => {
    const handlers = callbacks();
    const onDraftValidityChange = vi.fn();
    render(<WidgetEditor {...handlers} onDraftValidityChange={onDraftValidityChange} widget={timeseries} providers={providers} />);
    fireEvent.click(screen.getByRole("tab", { name: "Tooltips" }));
    fireEvent.change(screen.getByLabelText("Maximum width (px)"), { target: { value: "420" } });
    const validCalls = handlers.onApply.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Maximum width (px)"), { target: { value: "999" } });
    expect(handlers.onApply).toHaveBeenCalledTimes(validCalls);
    expect(onDraftValidityChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText("Maximum width (px)"), { target: { value: "320" } });
    expect(onDraftValidityChange).toHaveBeenLastCalledWith(true);
    expect(handlers.onApply).toHaveBeenLastCalledWith(expect.objectContaining({ query: "up", providerId: "production", options: { tooltipMaxWidth: 320 } }));
  });
});

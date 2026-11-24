import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WidgetEditor } from "./widget-editor";
import type { Widget } from "./schema";
import { editorProps, widget } from "./widget-editor.test-utils";

const base = (type: Widget["type"]): Widget => ({ ...widget, id: `${type}-subject`, type, title: "Subject", options: {} });

function openStyle(subject: Widget) {
  const callbacks = editorProps({ widget: subject });
  render(<WidgetEditor {...callbacks} widget={subject} />);
  fireEvent.click(screen.getByRole("tab", { name: "Style" }));
  return callbacks;
}

describe("appearance presets for bar, stat and heatmap widgets", () => {
  it.each([
    ["bar", "Minimal", { showGrid: false, showLegend: false }],
    ["bar", "Axis caption", { showGrid: true, axisUnit: "caption" }],
    ["stat", "Value only", { showSparkline: false, showStatBar: false }],
    ["stat", "Sparkline beside", { showSparkline: true, sparklinePlacement: "side" }],
    ["stat", "Sparkline behind", { showSparkline: true, sparklinePlacement: "background" }],
    ["heatmap", "Values only", { showLabels: false, showValues: true }],
    ["heatmap", "Color only", { showLabels: false, showValues: false }],
  ] as const)("%s: %s writes its options", (type, name, expected) => {
    const callbacks = openStyle(base(type));
    fireEvent.click(screen.getByRole("button", { name }));
    expect(callbacks.onApply.mock.lastCall![0].options).toMatchObject(expected);
  });

  it("a table offers no appearance presets", () => {
    openStyle(base("table"));
    expect(screen.queryByRole("region", { name: "Appearance" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Value only" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clean line" })).toBeNull();
  });

  it("keeps the time series presets unchanged", () => {
    const callbacks = openStyle(base("timeseries"));
    fireEvent.click(screen.getByRole("button", { name: "Soft area" }));
    expect(callbacks.onApply.mock.lastCall![0].options).toMatchObject({ display: "area", lineWidth: 2, fillOpacity: 0.12 });
    expect(screen.getByRole("button", { name: "Compare" })).toBeVisible();
  });
});

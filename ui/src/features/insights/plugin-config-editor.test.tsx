import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginConfigEditor } from "./plugin-config-editor";
import { getWidgetDefinition } from "./widget-registry";
import { registerDefaultWidgetPlugins, ThresholdGauge, gaugeConfigSchema } from "./plugins/threshold-gauge";
import { newWidget, type Widget } from "./schema";
afterEach(cleanup);

describe("guided plugin authoring", () => {
  it("lets a field be cleared and replaced without reinserting its default as typed text", () => {
    registerDefaultWidgetPlugins();
    const definition = getWidgetDefinition("plugin", "connection-map")!;
    function Controlled() {
      const [value, setValue] = useState(JSON.stringify(definition.defaultConfig));
      return <><PluginConfigEditor definition={definition} value={value} onChange={setValue} /><output>{value}</output></>;
    }
    render(<Controlled />);
    const longitude = screen.getByRole("textbox", { name: "Longitude field" });
    fireEvent.change(longitude, { target: { value: "" } });
    expect(longitude).toHaveValue("");
    expect(longitude).toHaveAttribute("placeholder", "Default: longitude");
    fireEvent.change(longitude, { target: { value: "lng" } });
    expect(longitude).toHaveValue("lng");
    expect(screen.getByRole("status")).toHaveTextContent('"longitude": "lng"');
  });
  it("edits typed settings without discarding advanced configuration", () => {
    registerDefaultWidgetPlugins();
    const onChange = vi.fn();
    render(<PluginConfigEditor definition={getWidgetDefinition("plugin", "threshold-gauge")}
      value={'{"display":"segmented","label":"Memory","showThresholds":true}'} onChange={onChange} />);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Segments" }), { target: { value: "36" } });
    expect(JSON.parse(onChange.mock.calls.at(-1)![0])).toEqual({ display: "segmented", label: "Memory", showThresholds: true, segments: 36 });
    fireEvent.click(screen.getByRole("switch", { name: "Show threshold labels" }));
    expect(JSON.parse(onChange.mock.calls.at(-1)![0]).showThresholds).toBe(false);
  });
  it("retains invalid JSON for recovery without replacing it from guided controls", () => {
    registerDefaultWidgetPlugins();
    const onChange = vi.fn();
    render(<PluginConfigEditor definition={getWidgetDefinition("plugin", "threshold-gauge")}
      value={'{"display":'} onChange={onChange} />);
    expect(screen.getByRole("spinbutton", { name: "Segments" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Correct the configuration JSON");
    fireEvent.click(screen.getByText("Advanced configuration"));
    expect(screen.getByRole("textbox", { name: "Plugin configuration" })).toHaveValue('{"display":');
    expect(onChange).not.toHaveBeenCalled();
  });
  it("gives new widgets independent defaults and validates bounded meter settings", () => {
    registerDefaultWidgetPlugins();
    const definition = getWidgetDefinition("plugin", "threshold-gauge")!;
    const first = newWidget("plugin", [], [], definition), second = newWidget("plugin", [], [], definition);
    first.config!.segments = 40;
    expect(second.config?.segments).toBe(24);
    expect(gaugeConfigSchema.safeParse({ display: "segmented", segments: 61 }).success).toBe(false);
    expect(gaugeConfigSchema.safeParse({ display: "radial", showThresholds: false }).success).toBe(true);
  });
});

describe("capacity meter presentation", () => {
  const widget: Widget = { id: "memory", title: "Memory", type: "plugin", pluginId: "threshold-gauge", dataKind: "metrics", providerId: "p", query: "memory", unit: "%", layout: { x: 0, y: 0, w: 3, h: 3 }, options: { min: 0, max: 100, decimals: 2 } };
  const result = (value: number | null) => ({ series: [{ name: "host", labels: { node: "omega-01" }, points: [{ timestamp: 1000, value: 12 }, { timestamp: 2000, value }] }] });
  it("renders only measured progress in a segmented meter, including a partial segment", () => {
    const { container } = render(<ThresholdGauge widget={{ ...widget, config: { display: "segmented", segments: 10 } }} result={result(25)} />);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "25");
    const filled = container.querySelectorAll('[data-filled="true"]');
    expect(filled).toHaveLength(3);
    expect(Number((filled[2] as HTMLElement).style.getPropertyValue("--meter-fraction"))).toBeCloseTo(0.5);
    expect(screen.getByText("25.00")).toBeInTheDocument();
  });
  it("shows a radial scale without converting missing latest data into an old value", () => {
    const { rerender, container } = render(<ThresholdGauge widget={{ ...widget, config: { display: "radial" } }} result={result(125)} />);
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuetext", "125%");
    expect(container.querySelector('[stroke-dasharray="100 100"]')).not.toBeNull();
    rerender(<ThresholdGauge widget={{ ...widget, config: { display: "radial" } }} result={result(null)} />);
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(screen.getByText("Unknown · latest sample has no finite value")).toBeInTheDocument();
    expect(container.querySelector('[stroke-dasharray]')).toBeNull();
  });
});

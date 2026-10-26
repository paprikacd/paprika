import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { formatMetric, formatMetricDetails } from "./chart-data";
import { WidgetVisualization } from "./charts";
import { TooltipSubWidget } from "./tooltip-widgets";
import { WidgetEditor } from "./widget-editor";
import { TooltipEditor } from "./tooltip-editor";
import type { TooltipView, Widget } from "./schema";

const widget: Widget = { id: "signal", title: "Signal", type: "stat", providerId: "metrics", query: "up", unit: "ms", layout: { x: 0, y: 0, w: 4, h: 4 } };
const series = { name: "api", labels: { service: "api" }, points: [{ timestamp: 1000, value: -12.345678 }, { timestamp: 2000, value: 0 }, { timestamp: 3000, value: 12.345678 }] };
const providers = [{ id: "metrics", name: "Metrics", type: "prometheus" as const, capabilities: ["metrics" as const] }];

describe("configured numeric precision", () => {
  it.each([0, 2, 4])("formats %i places including zero, negatives, large numbers and percent units", (decimals) => {
    expect(formatMetric(12.345678, "ms", false, decimals)).toBe(`${(12.345678).toFixed(decimals)} ms`);
    expect(formatMetricDetails(-12.345678, "%", decimals)).toBe(`${(-12.345678).toFixed(decimals)}%`);
    expect(formatMetric(0, "", false, decimals)).toBe((0).toFixed(decimals));
    expect(formatMetricDetails(1234.5678, "ms", decimals)).toBe(`${new Intl.NumberFormat("en", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(1234.5678)} ms`);
    expect(formatMetricDetails(NaN, "ms", decimals)).toBe("—");
    expect(formatMetric(Infinity, "ms", false, decimals)).toBe("—");
  });

  it("keeps Auto details exact and safely handles invalid host-supplied precision", () => {
    expect(formatMetricDetails(0.123456789, "ms")).toBe("0.123456789 ms");
    for (const decimals of [NaN, Infinity, -Infinity]) {
      expect(formatMetric(12.345678, "", false, decimals)).toBe("12.35");
      expect(formatMetricDetails(12.345678, "", decimals)).toBe("12.345678");
    }
    expect(formatMetric(12.345678, "", false, -1)).toBe("12");
    expect(formatMetric(12.345678, "", false, 2.9)).toBe("12.35");
  });

  for (const type of ["stat", "table", "heatmap"] as const)
    it.each([0, 2, 4])(`uses %i places in ${type} tooltip details while retaining raw observation bindings`, (decimals) => {
      const selected = vi.fn();
      render(<WidgetVisualization widget={{ ...widget, type, options: { decimals } }} result={{ series: [series] }} onContextChange={selected} />);
      const trigger = screen.getByRole("button", { name: type === "stat" ? /Inspect value for/ : type === "table" ? /Inspect series/ : /^api:/ });
      fireEvent.focus(trigger);
      const reading = screen.getByRole("tooltip").querySelector("[data-metric-value]");
      expect(reading).toHaveTextContent(`${(12.345678).toFixed(decimals)} ms`);
      expect(reading).toHaveAttribute("data-metric-value", "12.345678");
      if (type === "table") {
        expect(screen.getByRole("tooltip")).toHaveTextContent(`Minimum: ${(-12.345678).toFixed(decimals)} ms`);
      }
      if (selected.mock.calls.length) expect(selected.mock.calls.at(-1)?.[0].value).toBe(12.345678);
    });

  it.each([0, 2, 4])("uses %i places for trace tooltip duration", (decimals) => {
    render(<WidgetVisualization widget={{ ...widget, type: "traces", options: { decimals } }} result={{ traces: [{ traceId: "abc", service: "api", operation: "GET", status: "ok", durationMs: 12.345678, startTime: 1000 }] }} />);
    fireEvent.focus(screen.getByRole("button", { name: "Inspect trace abc" }));
    expect(screen.getByRole("tooltip").querySelector("[data-metric-value]")).toHaveTextContent(`${(12.345678).toFixed(decimals)} ms`);
  });

  it.each([0, 2, 4])("uses %i places independently in tooltip single values and history summaries", (decimals) => {
    const view = render(<TooltipSubWidget view={{ type: "stat", decimals }} series={series} unit="ms" />);
    expect(view.container.querySelector('[data-metric-value="12.345678"]')).toHaveTextContent(`${(12.345678).toFixed(decimals)}ms`);
    view.rerender(<TooltipSubWidget view={{ type: "timeseries", decimals }} series={series} unit="ms" />);
    expect(view.container.querySelector("[data-history-min]")).toHaveTextContent(`${(-12.345678).toFixed(decimals)} ms`);
    expect(view.container.querySelector("[data-history-max]")).toHaveTextContent(`${(12.345678).toFixed(decimals)} ms`);
    expect(view.container.querySelector("[data-history-min]")).toHaveAttribute("data-history-min", "-12.345678");
  });

  it("updates tooltip detail precision live, shares it with Style, and restores Auto", () => {
    let current: Widget = { ...widget, type: "heatmap" };
    function Host() {
      const [value, setValue] = useState(current);
      current = value;
      return <WidgetEditor widget={value} providers={providers} onApply={setValue} onClose={vi.fn()} onDuplicate={vi.fn()} onDelete={vi.fn()} onMove={vi.fn()} />;
    }
    render(<Host />);
    fireEvent.click(screen.getByRole("tab", { name: "Tooltips" }));
    for (const decimals of [0, 2, 4]) {
      fireEvent.change(screen.getByLabelText("Details decimal places"), { target: { value: String(decimals) } });
      expect(current.options?.decimals).toBe(decimals);
    }
    fireEvent.click(screen.getByRole("tab", { name: "Style" }));
    expect(screen.getByLabelText("Decimal places")).toHaveValue(4);
    fireEvent.change(screen.getByLabelText("Decimal places"), { target: { value: "" } });
    expect(current.options?.decimals).toBeUndefined();
  });

  it("lets tooltip sub-widget precision be set to zero or reset independently", () => {
    let current: TooltipView | undefined = { type: "stat", decimals: 4 };
    function Host() {
      const [value, setValue] = useState(current);
      current = value;
      return <TooltipEditor view={value} providers={providers} onChange={setValue} pluginConfig="{}" onPluginConfigChange={vi.fn()} />;
    }
    render(<Host />);
    fireEvent.change(screen.getByLabelText("Tooltip decimal places"), { target: { value: "0" } });
    expect(current?.decimals).toBe(0);
    fireEvent.change(screen.getByLabelText("Tooltip decimal places"), { target: { value: "" } });
    expect(current?.decimals).toBeUndefined();
    expect(within(screen.getByRole("group", { name: "Tooltip widget" })).getByText(/Decimal places apply to this tooltip widget/)).toBeVisible();
  });
});

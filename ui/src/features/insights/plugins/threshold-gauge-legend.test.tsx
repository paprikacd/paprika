import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThresholdGauge, registerDefaultWidgetPlugins } from "./threshold-gauge";
import type { QueryResult, Widget } from "../schema";

registerDefaultWidgetPlugins();
afterEach(() => cleanup());

// A bound or marker keeps its own value: a reading far above the thresholds must not pick a scale that rounds them away.
const base = (decimals?: number): Widget => ({
  id: "latency", title: "Latency", type: "plugin", pluginId: "threshold-gauge", providerId: "p", dataKind: "metrics",
  query: "latency", unit: "ms", layout: { x: 0, y: 0, w: 6, h: 4 },
  options: { min: 0, max: 10000, decimals, thresholds: [{ value: 200, status: "warning", label: "Warning" }, { value: 500, status: "critical", label: "Critical" }] },
});
const reading = (value: number): QueryResult => ({ series: [{ name: "api", labels: {}, points: [{ timestamp: 1000, value }] }] });

function legendText(container: HTMLElement) {
  return container.querySelector("[data-gauge-legend]")?.textContent ?? "";
}

describe("gauge legend keeps each threshold bound at its own value", () => {
  it("does not round the 200 ms and 500 ms markers to zero when the reading is above one second", () => {
    const { container } = render(<ThresholdGauge widget={base(0)} result={reading(12000)} />);
    // The axis (0 to 10,000 ms) is shown in seconds, so each marker keeps its value at the widened precision.
    const text = legendText(container);
    expect(text).toContain("Warning 0.2 s");
    // 500 ms is 0.5 s: zero authored decimals would read it "1 s", so the bound keeps its exact short form.
    expect(text).toContain("Critical 0.5 s");
    expect(text).not.toMatch(/Warning 0 s|Critical 0 s|Critical 1 s/);
  });

  it("keeps the markers at Auto precision too", () => {
    const { container } = render(<ThresholdGauge widget={base()} result={reading(12000)} />);
    const text = legendText(container);
    expect(text).toContain("Warning 0.2 s");
    expect(text).toContain("Critical 0.5 s");
  });
});

describe("gauge bounds that are neighbours on the axis never print alike", () => {
  const pair = (decimals: number | undefined, thresholds: { value: number; status: "warning" | "critical"; label: string }[]): Widget => ({
    id: "latency", title: "Latency", type: "plugin", pluginId: "threshold-gauge", providerId: "p", dataKind: "metrics",
    query: "latency", unit: "ms", layout: { x: 0, y: 0, w: 6, h: 4 },
    options: { min: 0, max: 1500, decimals, thresholds },
  });
  it("reads a 500 ms and a 1000 ms threshold as distinct bounds at zero decimals", () => {
    const widget = pair(0, [{ value: 500, status: "warning", label: "Elevated" }, { value: 1000, status: "critical", label: "Critical" }]);
    const { container } = render(<ThresholdGauge widget={widget} result={reading(1200)} />);
    const text = legendText(container);
    expect(text).toContain("Elevated 0.5 s");
    expect(text).toContain("Critical 1 s");
    expect(text).not.toContain("Elevated 1 s");
  });
  it("reads 1200 and 1400 ms as 1.2 s and 1.4 s at zero decimals, not 1 s twice", () => {
    const widget = pair(0, [{ value: 1200, status: "warning", label: "Elevated" }, { value: 1400, status: "critical", label: "Critical" }]);
    const { container } = render(<ThresholdGauge widget={widget} result={reading(1300)} />);
    const text = legendText(container);
    expect(text).toContain("Elevated 1.2 s");
    expect(text).toContain("Critical 1.4 s");
    expect(text).not.toMatch(/Elevated 1 s|Critical 1 s/);
  });
});

describe("gauge bounds without a reading read against their axis", () => {
  it("keeps two thresholds that differ past the printed places from reading alike", () => {
    const widget: Widget = {
      id: "ratio", title: "Ratio", type: "plugin", pluginId: "threshold-gauge", providerId: "p", dataKind: "metrics",
      query: "ratio", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 },
      options: { min: 0, max: 3, decimals: 0, thresholds: [{ value: 2.0000004, status: "warning", label: "A" }, { value: 2.0000001, status: "critical", label: "B" }] },
    };
    const { container } = render(<ThresholdGauge widget={widget} result={{ series: [{ name: "ratio", labels: {}, points: [{ timestamp: 1000, value: null }] }] }} />);
    const text = legendText(container);
    expect(text).toContain("A 2.00000");
    expect(text).toContain("B 2.00000");
  });
});

describe("gauge legend and panel bounds for a byte reading far above a small axis", () => {
  const bytes = (decimals?: number): Widget => ({
    id: "disk", title: "Disk", type: "plugin", pluginId: "threshold-gauge", providerId: "p", dataKind: "metrics",
    query: "disk", unit: "bytes", layout: { x: 0, y: 0, w: 6, h: 4 },
    options: { min: 0, max: 100, decimals, thresholds: [{ value: 70, status: "warning", label: "Elevated" }, { value: 90, status: "critical", label: "Critical" }] },
  });
  for (const decimals of [undefined, 0, 3]) {
    it(`keeps the 70 and 90 bytes bounds at their own value at decimals ${decimals ?? "unset"}`, () => {
      const { container } = render(<ThresholdGauge widget={bytes(decimals)} result={reading(296303060975000)} />);
      const text = legendText(container);
      expect(text).toMatch(/Elevated 70(\.0+)? bytes/);
      expect(text).toMatch(/Critical 90(\.0+)? bytes/);
      expect(text).not.toMatch(/e[-+]?\d|0\.0{4,}/);
      expect(text).not.toContain("TiB");
    });
  }
  it("writes the band label on the same scale as the Scale line, so one panel never prints a quantity in two units", () => {
    const { getByRole, getByText } = render(<ThresholdGauge widget={base(undefined)} result={reading(12000)} />);
    fireEvent.focus(getByRole("button", { name: /Inspect value for Latency:/ }));
    const tooltip = getByRole("tooltip");
    expect(tooltip).toHaveTextContent("≥ 0.5 s");
    expect(tooltip).not.toHaveTextContent("500 ms");
    expect(getByText(/Scale: 0 s to 10 s/)).toBeInTheDocument();
  });
});

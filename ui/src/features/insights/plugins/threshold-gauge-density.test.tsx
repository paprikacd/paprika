import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryResult, Widget } from "../schema";
import { ThresholdGauge } from "./threshold-gauge";

afterEach(cleanup);

const widget: Widget = {
  id: "freshness", title: "Freshness by source", type: "plugin", pluginId: "threshold-gauge",
  providerId: "metrics", dataKind: "metrics", query: "freshness", unit: "s",
  layout: { x: 8, y: 3, w: 4, h: 6 },
  config: { display: "linear", orientation: "horizontal", seriesMode: "all", maxSeries: 5, showThresholds: true, showStatus: true },
  options: { min: 0, max: 60, decimals: 2, showLegend: true, thresholds: [
    { value: 0, color: "#12cba1", label: "OK" },
    { value: 30, color: "#f1b841", label: "Delayed" },
    { value: 60, color: "#e95352", label: "Critical" },
  ] },
};
const names = ["brandbrain", "market-sync", "prometheus", "shorted-api", "tempo"];
const resultFor = (values: (number | null)[]): QueryResult => ({
  series: values.map((value, index) => ({
    name: names[index], labels: { source: names[index] }, points: [{ timestamp: 1000, value }],
  })),
});

describe("content-led horizontal gauge banks", () => {
  it("keeps the five readings, exact selection identity and authored 0–60 scale", () => {
    const values = [6.81, 45.12, 3.88, 7.4, 5.22];
    const select = vi.fn();
    const { container } = render(<ThresholdGauge widget={widget} result={resultFor(values)} onContextChange={select} />);
    expect(container.querySelector('[data-gauge-bank-layout="rows"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-gauge-legend]')).toHaveLength(1);
    expect(container.querySelector('[data-gauge-legend]')).toHaveTextContent("Scale 0.00 s – 60.00 s");
    expect(container.querySelector('[data-gauge-legend]')).toHaveTextContent("Delayed 30.00 s");
    const meters = screen.getAllByRole("meter");
    meters.forEach((meter, index) => {
      expect(meter).toHaveAttribute("aria-valuemin", "0");
      expect(meter).toHaveAttribute("aria-valuemax", "60");
      expect(meter).toHaveAttribute("aria-valuenow", String(values[index]));
      expect(Number(meter.getAttribute("data-gauge-progress"))).toBeCloseTo(values[index] / 60);
    });
    expect([...container.querySelectorAll('[data-gauge-status]')].map(node => node.textContent)).toEqual(["OK", "Delayed", "OK", "OK", "OK"]);
    fireEvent.focus(screen.getByRole("button", { name: /Select signal for Freshness by source: market-sync:/ }));
    expect(select).toHaveBeenLastCalledWith({ series: "market-sync", labels: { source: "market-sync" }, value: 45.12 });
  });

  it("does not round across the delayed boundary or treat missing values as zero", () => {
    const { container } = render(<ThresholdGauge widget={widget} result={resultFor([0, 29.999, 30, 60, null])} />);
    expect([...container.querySelectorAll('[data-gauge-status]')].map(node => node.textContent)).toEqual(["OK", "OK", "Delayed", "Critical", "Unknown"]);
    expect(screen.getAllByRole("meter")).toHaveLength(4);
    expect(container.querySelector('[data-gauge-series="tempo"]')).toHaveTextContent("No data");
  });

  it.each([
    { display: "radial", orientation: "horizontal", seriesMode: "all" },
    { display: "linear", orientation: "vertical", seriesMode: "all" },
    { display: "linear", orientation: "horizontal", seriesMode: "first" },
  ])("does not apply row-bank legend geometry to %o", config => {
    const { container } = render(<ThresholdGauge widget={{ ...widget, config }} result={resultFor([6.81])} />);
    expect(container.querySelector('[data-gauge-bank-layout="rows"]')).toBeNull();
    expect(container.querySelector('[data-gauge-legend-layout="rows"]')).toBeNull();
  });

  it("scopes density to horizontal banks and retains narrow/coarse touch targets", () => {
    const css = readFileSync(join(process.cwd(), "src/features/insights/plugins/capacity-meter.module.css"), "utf8");
    const rowBank = css.match(/\.bank\[data-gauge-bank-orientation="horizontal"\] \{([^}]+)\}/)?.[1];
    expect(rowBank).toContain("flex: 0 1 auto");
    expect(rowBank).toContain("grid-auto-rows: minmax(32px, max-content)");
    expect(rowBank).toContain("align-content: start");
    expect(rowBank).toContain("gap: 8px 12px");
    expect(rowBank).not.toContain("space-evenly");
    expect(css).toContain('@container insight-widget (max-width: 300px)');
    expect(css).toContain('@media (max-width: 600px) { .bank[data-gauge-bank-orientation="horizontal"] .reading.reading.reading { min-height: 44px; } }');
    expect(css).toMatch(/@media \(pointer: coarse\)[^}]+min-height: 44px/);
  });
});

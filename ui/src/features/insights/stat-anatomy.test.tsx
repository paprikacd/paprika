import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DashboardWindowProvider } from "./dashboard-window";
import { WidgetVisualization } from "./charts";
import { WidgetAttentionContext, widgetAttention } from "./widget-attention";
import type { QueryResult, Widget } from "./schema";

afterEach(cleanup);
const base = { id: "rate", title: "Error ratio", type: "stat", providerId: "p", query: "q", unit: "%", layout: { x: 0, y: 0, w: 3, h: 2 } } as const;
const one = (value: number, timestamp = 1_000_000): QueryResult => ({ series: [{ name: "api", labels: {}, points: [{ timestamp, value }] }] });
const widgetWith = (options: Widget["options"]) => ({ ...base, options }) as unknown as Widget;

describe("stat status chip", () => {
  it("names a warning band with its glyph, label and status word, and is not interactive", () => {
    const { container } = render(<WidgetVisualization widget={widgetWith({ thresholds: [{ value: 0, status: "ok" }, { value: 1, status: "warning", label: "Elevated" }] })} result={one(1.6)} />);
    const chip = container.querySelector('[data-stat-chip="warning"]');
    expect(chip).toHaveAttribute("data-status", "warning");
    expect(chip).toHaveTextContent("Elevated");
    expect(chip?.querySelector('[aria-hidden="true"]')).toHaveTextContent("!");
    // The status word is announced once, even when a custom label is shown.
    expect(chip?.textContent).toContain("Warning: ");
    expect(chip?.querySelector("button, a, [role]")).toBeNull();
  });

  it("uses the status word when a critical band has no label", () => {
    const { container } = render(<WidgetVisualization widget={widgetWith({ thresholds: [{ value: 0, status: "ok" }, { value: 5, status: "critical" }] })} result={one(7)} />);
    expect(container.querySelector('[data-stat-chip="critical"]')).toHaveTextContent("Critical");
  });

  it("shows no chip for the normal band, or for an ok or informational band", () => {
    const { container, rerender } = render(<WidgetVisualization widget={widgetWith({ thresholds: [{ value: 0, status: "ok", label: "Healthy" }] })} result={one(2)} />);
    expect(container.querySelector("[data-stat-chip]")).toBeNull();
    rerender(<WidgetVisualization widget={widgetWith({ thresholds: [{ value: 0, status: "ok" }, { value: 1, status: "info", label: "Note" }] })} result={one(2)} />);
    expect(container.querySelector("[data-stat-chip]")).toBeNull();
  });

  it("gives a legacy colour-only band above the first a dot and its label, with the value still in ink", () => {
    const { container } = render(<WidgetVisualization widget={widgetWith({ thresholds: [{ value: 0, color: "#008866" }, { value: 40, color: "#dd8800", label: "Hot" }] })} result={one(42.34)} />);
    const band = container.querySelector('[data-stat-chip="band"]');
    expect(band).toHaveTextContent("Hot");
    expect(band?.querySelector('[aria-hidden="true"]')).toHaveStyle({ background: "#dd8800" });
    expect(container.querySelector("[data-metric-value]")?.getAttribute("style") ?? "").not.toContain("color");
  });

  it("gives an unlabelled colour-only band a bound as its label", () => {
    const { container } = render(<WidgetVisualization widget={widgetWith({ thresholds: [{ value: 0, color: "#008866" }, { value: 40, color: "#dd8800" }] })} result={one(42)} />);
    expect(container.querySelector('[data-stat-chip="band"]')).toHaveTextContent("≥ 40");
  });

  it("keeps the first colour-only band unlabelled, as the normal state", () => {
    const { container } = render(<WidgetVisualization widget={widgetWith({ thresholds: [{ value: 0, color: "#008866", label: "Fine" }, { value: 40, color: "#dd8800" }] })} result={one(3)} />);
    expect(container.querySelector("[data-stat-chip]")).toBeNull();
  });

  it("keeps an authored text colour on the reading when one is set", () => {
    const { container } = render(<WidgetVisualization widget={widgetWith({ textColor: "#112233", thresholds: [{ value: 0, status: "critical" }] })} result={one(3)} />);
    expect(container.querySelector("[data-metric-value]")).toHaveStyle({ color: "#112233" });
  });

  it("takes the verdict of the tile that renders it, and evaluates its own otherwise", () => {
    const widget = widgetWith({ thresholds: [{ value: 0, status: "ok" }, { value: 1, status: "warning", label: "From tile" }] });
    const tile = widgetAttention(widget, one(2), undefined, undefined);
    const { container } = render(<WidgetAttentionContext.Provider value={tile}><WidgetVisualization widget={widget} result={one(2)} /></WidgetAttentionContext.Provider>);
    expect(container.querySelector('[data-stat-chip="warning"]')).toHaveTextContent("From tile");
  });
});

describe("stat trend and freshness", () => {
  it("replaces the flat trend of a constant history with Steady", () => {
    const { container } = render(<WidgetVisualization widget={{ ...base, options: { showSparkline: true } } as never} result={{ series: [{ name: "slo", labels: {}, points: [{ timestamp: 1, value: 99.9 }, { timestamp: 2, value: 99.9 }, { timestamp: 3, value: 99.9 }] }] }} />);
    expect(screen.getByText("Steady")).toHaveAttribute("data-stat-steady");
    expect(container.querySelector("[data-stat-sparkline]")).toBeNull();
  });

  it("draws the trend when the history moves, and never calls one sample steady", () => {
    const { container, rerender } = render(<WidgetVisualization widget={{ ...base, options: { showSparkline: true } } as never} result={{ series: [{ name: "api", labels: {}, points: [{ timestamp: 1, value: 1 }, { timestamp: 2, value: 2 }] }] }} />);
    expect(container.querySelector("[data-stat-sparkline]")).not.toBeNull();
    expect(screen.queryByText("Steady")).toBeNull();
    rerender(<WidgetVisualization widget={{ ...base, options: { showSparkline: true } } as never} result={one(5)} />);
    expect(screen.queryByText("Steady")).toBeNull();
  });

  it("orders the anatomy as reading, status chip, then the latest valid sample's time", () => {
    const { container } = render(
      <DashboardWindowProvider value={{ rangeEnd: 1_000_000 }}>
        <WidgetVisualization widget={widgetWith({ thresholds: [{ value: 0, status: "critical", label: "Breached" }] })} result={one(7)} />
      </DashboardWindowProvider>,
    );
    const figure = container.querySelector("[data-stat-figure]");
    expect(figure?.children[0]).toHaveAttribute("data-metric-value");
    expect(figure?.children[1]).toHaveAttribute("data-stat-chip", "critical");
    const meta = container.querySelector("[data-stat-reading] > [class*='statMeta']");
    expect(meta?.textContent).toContain("Latest valid sample");
    expect(figure?.nextElementSibling).toBe(meta);
  });
});

describe("heatmap critical frame", () => {
  it("frames only critical cells", () => {
    const series = [
      { name: "down", labels: {}, points: [{ timestamp: 1, value: 0 }] },
      { name: "up", labels: {}, points: [{ timestamp: 1, value: 1 }] },
    ];
    const { container } = render(<WidgetVisualization widget={{ ...base, type: "heatmap", options: { thresholds: [{ value: 0, status: "critical", label: "Unhealthy" }, { value: 1, status: "warning", label: "Degraded" }, { value: 2, status: "ok", label: "Healthy" }] } } as never} result={{ series }} />);
    const cells = [...container.querySelectorAll("[data-heatmap-cell]")];
    expect(cells.map(cell => cell.getAttribute("data-status-stroke"))).toEqual(["critical", null]);
    expect(cells[0].getAttribute("style") ?? "").toContain("--status-stroke-color");
  });
});

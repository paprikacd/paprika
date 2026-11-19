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
    expect(screen.getByRole("img", { name: "Threshold Hot" })).toHaveStyle({ background: "#dd8800" });
    expect(container.querySelector("[data-metric-value]")?.getAttribute("style") ?? "").not.toContain("color");
  });

  it("names an unlabelled colour-only band above the first with its threshold value, in its hue, with the reading still in ink", () => {
    const { container } = render(<WidgetVisualization widget={widgetWith({ thresholds: [{ value: 0, color: "#008866" }, { value: 80, color: "#dd8800" }] })} result={one(85.2)} />);
    const band = container.querySelector('[data-stat-chip="band"]');
    expect(band).toHaveTextContent("≥ 80%");
    expect(screen.getByRole("img", { name: "Threshold ≥ 80%" })).toHaveStyle({ background: "#dd8800" });
    // The visible value is hidden from assistive technology, which already hears the name once from the dot.
    expect(container.querySelector('[data-stat-chip="band"] [aria-hidden="true"]')).toHaveTextContent("≥ 80%");
    expect(container.querySelector("[data-metric-value]")?.getAttribute("style") ?? "").not.toContain("color");
  });

  it("keeps the decimals of the widget in the unlabelled band's value, as the reading has them", () => {
    const { container } = render(<WidgetVisualization widget={widgetWith({ decimals: 2, thresholds: [{ value: 0, color: "#008866" }, { value: 80, color: "#dd8800" }] })} result={one(85.2)} />);
    expect(container.querySelector('[data-stat-chip="band"]')).toHaveTextContent("≥ 80.00%");
    expect(screen.getByRole("img", { name: "Threshold ≥ 80.00%" })).toBeInTheDocument();
  });

  it("gives the full band name as the chip's title, so a truncated value on a narrow card can be read", () => {
    const { container } = render(<WidgetVisualization widget={widgetWith({ thresholds: [{ value: 0, color: "#008866" }, { value: 80, color: "#dd8800" }] })} result={one(85.2)} />);
    expect(container.querySelector('[data-stat-chip="band"]')).toHaveAttribute("title", "Threshold ≥ 80%");
  });

  it("shows the first unlabelled band as its dot alone, named below the next threshold, with no value text", () => {
    const { container } = render(<WidgetVisualization widget={widgetWith({ thresholds: [{ value: 0, color: "#008866" }, { value: 40, color: "#dd8800", label: "Hot" }] })} result={one(10)} />);
    const band = container.querySelector('[data-stat-chip="band"]');
    expect(band).not.toBeNull();
    expect(band?.textContent).toBe("");
    expect(screen.getByRole("img", { name: "Threshold below 40%" })).toHaveStyle({ background: "#008866" });
  });

  it("keeps the widget's decimals in the first band's name, as in the value", () => {
    render(<WidgetVisualization widget={widgetWith({ decimals: 2, thresholds: [{ value: 0, color: "#008866" }, { value: 40, color: "#dd8800", label: "Hot" }] })} result={one(10)} />);
    expect(screen.getByRole("img", { name: "Threshold below 40.00%" })).toBeInTheDocument();
  });

  it("names a lone colour-only band by the reading's side of it, not as a bare \"≥\" that a lower reading contradicts", () => {
    const { container, rerender } = render(<WidgetVisualization widget={widgetWith({ thresholds: [{ value: 50, color: "#dd8800" }] })} result={one(10)} />);
    expect(screen.getByRole("img", { name: "Threshold below 50%" })).toBeInTheDocument();
    expect(container.querySelector('[data-stat-chip="band"]')).toHaveAttribute("title", "Threshold below 50%");
    rerender(<WidgetVisualization widget={widgetWith({ thresholds: [{ value: 50, color: "#dd8800" }] })} result={one(60)} />);
    expect(screen.getByRole("img", { name: "Threshold from 50%" })).toBeInTheDocument();
  });

  it("names a lone band at 0 without the \"≥ 0%\" noise", () => {
    render(<WidgetVisualization widget={widgetWith({ thresholds: [{ value: 0, color: "#008866" }] })} result={one(10)} />);
    expect(screen.getByRole("img", { name: "Threshold from 0%" })).toBeInTheDocument();
  });

  it("shows a labelled colour-only band wherever it sits, so a low-is-bad scale is labelled too", () => {
    const widget = widgetWith({ thresholds: [{ value: 0, color: "#e8554e", label: "Exhausted" }, { value: 25, color: "#f2b236", label: "Low" }, { value: 60, color: "#20cba3", label: "Healthy" }] });
    const { container, rerender } = render(<WidgetVisualization widget={widget} result={one(10)} />);
    expect(container.querySelector('[data-stat-chip="band"]')).toHaveTextContent("Exhausted");
    rerender(<WidgetVisualization widget={widget} result={one(70)} />);
    expect(container.querySelector('[data-stat-chip="band"]')).toHaveTextContent("Healthy");
  });

  it("names a stale sample in the chip slot, with its full sentence for screen readers", () => {
    const { container } = render(
      <DashboardWindowProvider value={{ rangeEnd: 1_000_000 + 6 * 60_000 }}>
        <WidgetVisualization widget={widgetWith({ staleAfterSeconds: 60 })} result={one(3)} />
      </DashboardWindowProvider>,
    );
    expect(container.querySelector("[data-stale-observation]")).toHaveTextContent("Stale · 6 min");
    expect(screen.getByText("Last valid sample: 6 min before range end.")).toBeInTheDocument();
  });

  it("keeps an authored text colour on the reading when one is set", () => {
    const { container } = render(<WidgetVisualization widget={widgetWith({ textColor: "#112233", thresholds: [{ value: 0, status: "critical" }] })} result={one(3)} />);
    expect(container.querySelector("[data-metric-value]")).toHaveStyle({ color: "#112233" });
  });

  it("takes the verdict of the tile that renders it, and evaluates its own otherwise", () => {
    const widget = widgetWith({ thresholds: [{ value: 0, status: "ok" }, { value: 1, status: "warning", label: "From tile" }] });
    const tile = widgetAttention(widget, { result: one(2) });
    const { container } = render(<WidgetAttentionContext.Provider value={tile}><WidgetVisualization widget={widget} result={one(2)} /></WidgetAttentionContext.Provider>);
    expect(container.querySelector('[data-stat-chip="warning"]')).toHaveTextContent("From tile");
  });
});

describe("stat trend and freshness", () => {
  it("never calls a history with a missing sample steady, because the gap is part of the trend", () => {
    const { container } = render(<WidgetVisualization widget={{ ...base, options: { showSparkline: true } } as never} result={{ series: [{ name: "slo", labels: {}, points: [{ timestamp: 1, value: 99.9 }, { timestamp: 2, value: null }, { timestamp: 3, value: 99.9 }] }] }} />);
    expect(screen.queryByText("Steady")).toBeNull();
    expect(container.querySelector("[data-stat-sparkline]")).not.toBeNull();
  });

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
    const reading = figure?.children[0];
    expect(reading?.children[0]).toHaveAttribute("data-metric-value");
    expect(reading?.children[1]).toHaveAttribute("data-stat-chip", "critical");
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

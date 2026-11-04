import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetVisualization } from "./charts";
import type { Widget } from "./schema";

afterEach(cleanup);

const widget: Widget = {
  id: "accounts",
  title: "New accounts",
  type: "stat",
  providerId: "prom",
  query: "accounts",
  unit: "events",
  color: "#c77d1e",
  layout: { x: 0, y: 0, w: 4, h: 2 },
  options: { decimals: 0, showSparkline: true },
};
// A cumulative count: the latest valid sample is 13, which the reading keeps showing.
const series = {
  name: "accounts",
  labels: { tenant: "all" },
  points: [
    { timestamp: 1000, value: 5 },
    { timestamp: 2000, value: 8 },
    { timestamp: 3000, value: 13 },
  ],
};

/** A pointer event as a browser delivers it for the history plot, with a mouse or touch type. */
function pointer(target: Element, type: string, clientX: number, pointerType = "mouse") {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY: 60 });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  fireEvent(target, event);
}

function historyPlot() {
  return screen.getByRole("img", { name: "History for New accounts" });
}

describe("single value reading", () => {
  it("is plain text: no button, pressed state, highlight or tooltip through hover, focus or click", () => {
    const { container } = render(<WidgetVisualization widget={{ ...widget, options: { decimals: 0 } }} result={{ series: [series] }} />);
    const reading = container.querySelector("[data-metric-value]")!;
    const before = reading.outerHTML;
    fireEvent.pointerEnter(reading);
    fireEvent.pointerOver(reading);
    fireEvent.focus(reading);
    fireEvent.click(reading);
    expect(reading.outerHTML).toBe(before);
    expect(reading).toHaveTextContent("13events");
    expect(reading.closest("button")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.innerHTML).not.toMatch(/observationTrigger|aria-pressed/);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("hovering a history sample inspects that sample while the reading keeps the latest value and colour", () => {
    const { container } = render(<WidgetVisualization widget={widget} result={{ series: [series] }} />);
    const plot = historyPlot();
    vi.spyOn(plot, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 50, 240, 64));
    const reading = container.querySelector("[data-metric-value]")!;
    const before = reading.outerHTML;
    pointer(plot, "pointermove", 101);
    expect(plot).toHaveAttribute("data-stat-selected-time", "1000");
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("5 events");
    expect(tooltip).toHaveTextContent("Recorded sample");
    expect(tooltip.querySelector("time")).toHaveAttribute("datetime", "1970-01-01T00:00:01.000Z");
    expect(reading.outerHTML).toBe(before);
    expect(reading).toHaveAttribute("data-metric-value", "13");
  });

  it("opens the latest sample on focus, and the arrow keys step to earlier samples without moving the reading", () => {
    const { container } = render(<WidgetVisualization widget={widget} result={{ series: [series] }} />);
    const plot = historyPlot();
    fireEvent.focus(plot);
    expect(screen.getByRole("tooltip")).toHaveTextContent("13 events");
    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    expect(plot).toHaveAttribute("data-stat-selected-time", "2000");
    expect(screen.getByRole("tooltip")).toHaveTextContent("8 events");
    expect(container.querySelector("[data-metric-value]")).toHaveAttribute("data-metric-value", "13");
  });

  it("pins with Enter, releases with a second Enter, and closes with Escape", () => {
    render(<WidgetVisualization widget={widget} result={{ series: [series] }} />);
    const plot = historyPlot();
    fireEvent.focus(plot);
    fireEvent.keyDown(plot, { key: "Enter" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Pinned");
    fireEvent.keyDown(plot, { key: "Enter" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Move to inspect");
    fireEvent.keyDown(plot, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("touch taps pin the sample under the finger", () => {
    render(<WidgetVisualization widget={widget} result={{ series: [series] }} />);
    const plot = historyPlot();
    vi.spyOn(plot, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 50, 240, 64));
    pointer(plot, "pointerdown", 101, "touch");
    pointer(plot, "pointerup", 101, "touch");
    expect(screen.getByRole("tooltip")).toHaveTextContent("5 events");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Pinned");
  });

  it("marks the selected sample with a ring on its drawn point", () => {
    render(<WidgetVisualization widget={widget} result={{ series: [series] }} />);
    const plot = historyPlot();
    fireEvent.focus(plot);
    expect(plot.querySelector("[data-stat-ring]")).toHaveAttribute("d", "M239,4h0");
    expect(plot.querySelector("[data-stat-ring-core]")).toHaveAttribute("d", "M239,4h0");
    fireEvent.keyDown(plot, { key: "Home" });
    expect(plot.querySelector("[data-stat-ring]")).toHaveAttribute("d", "M1,60h0");
    expect(plot.querySelector("[data-stat-cursor] line")).toHaveAttribute("x1", "1");
  });

  it("offers no tooltip for a single value without a history, and keeps its extra series plain", () => {
    const { container } = render(
      <WidgetVisualization
        widget={{ ...widget, options: { decimals: 0 } }}
        result={{ series: [series, { name: "worker", labels: {}, points: [{ timestamp: 3000, value: 2 }] }] }}
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    const reading = container.querySelector("[data-metric-value]")!;
    fireEvent.pointerEnter(reading);
    fireEvent.focus(reading);
    fireEvent.click(reading);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByText("worker").closest("button")).toBeNull();
    expect(screen.getByText("worker")).toBeInTheDocument();
  });

  it("reports drilldown context from the history when it is focused, never from the reading", () => {
    const changed = vi.fn();
    const { container } = render(<WidgetVisualization widget={widget} result={{ series: [series] }} onContextChange={changed} />);
    const reading = container.querySelector("[data-metric-value]")!;
    fireEvent.focus(reading);
    fireEvent.click(reading);
    expect(changed).not.toHaveBeenCalled();
    fireEvent.focus(historyPlot());
    expect(changed).toHaveBeenLastCalledWith({ series: "accounts", labels: { tenant: "all" }, value: 13 });
  });
});

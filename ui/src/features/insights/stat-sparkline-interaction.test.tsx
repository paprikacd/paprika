import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatSparkline } from "./stat-sparkline";
import type { Widget } from "./schema";

vi.mock("./observation-tooltip", () => ({ ObservationTooltip: ({ children }: { children: React.ReactNode }) => <div role="tooltip">{children}</div> }));
vi.mock("./metric-tooltip-content", () => ({ MetricDetails: ({ point }: { point: { value: number | null; timestamp: number } }) => <span>{point.value === null ? "No data" : String(point.value)} at {point.timestamp}</span> }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const widget: Widget = { id: "s", title: "Rate", type: "stat", providerId: "p", query: "rate", unit: "req/s", layout: { x: 0, y: 0, w: 3, h: 1 }, options: { showSparkline: true } };
const series = { name: "api", labels: {}, points: [{ timestamp: 1000, value: 5 }, { timestamp: 2000, value: null }, { timestamp: 3000, value: 8 }] };

describe("stat history scrub", () => {
  it("supports exact missing samples, keyboard navigation, pin, and Escape", () => {
    render(<StatSparkline widget={widget} series={series} name="api" unit="req/s" />);
    const svg = screen.getByRole("img");
    expect(svg).toHaveAttribute("tabindex", "0");
    fireEvent.focus(svg);
    expect(screen.getByRole("tooltip")).toHaveTextContent("8 at 3000");
    fireEvent.keyDown(svg, { key: "ArrowLeft" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("No data at 2000");
    expect(svg).toHaveAttribute("data-stat-selected-time", "2000");
    expect(svg).not.toHaveAttribute("data-stat-selected-value");
    fireEvent.keyDown(svg, { key: "Enter" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Pinned");
    fireEvent.keyDown(svg, { key: "Home" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("5 at 1000");
    fireEvent.keyDown(svg, { key: "End" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("8 at 3000");
    fireEvent.keyDown(svg, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
  it("scrubs original samples by time, including omitted/missing points, and touch pins one exact sample", () => {
    const dense = { ...series, points: Array.from({ length: 1000 }, (_, i) => ({ timestamp: 1000 + i, value: i === 500 ? null : i })) };
    render(<StatSparkline widget={widget} series={dense} name="api" unit="req/s" />);
    const svg = screen.getByRole("img");
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 50, 240, 64));
    const pointer = (type: string, x: number, kind: string) => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 60 });
      Object.defineProperty(event, "pointerType", { value: kind });
      fireEvent(svg, event);
    };
    expect(Number(svg.getAttribute("data-rendered-samples"))).toBeLessThan(1000);
    pointer("pointermove", 100 + 1 + 500 / 999 * 238, "mouse");
    expect(svg).toHaveAttribute("data-stat-selected-time", "1500");
    expect(screen.getByRole("tooltip")).toHaveTextContent("No data at 1500");
    pointer("pointerdown", 101, "touch");
    pointer("pointerup", 101, "touch");
    expect(screen.getByRole("tooltip")).toHaveTextContent("0 at 1000");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Pinned");
    pointer("pointermove", 339, "mouse");
    expect(svg).toHaveAttribute("data-stat-selected-time", "1000");
    pointer("pointerdown", 101, "touch");
    pointer("pointerup", 101, "touch");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    pointer("pointerdown", 101, "touch");
    pointer("pointermove", 140, "touch");
    pointer("pointerup", 140, "touch");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
  it("invalidates pinned history on data or configuration revision and leaves static uses inert", () => {
    const { rerender } = render(<StatSparkline widget={widget} series={series} name="api" unit="req/s" />);
    fireEvent.focus(screen.getByRole("img"));
    fireEvent.keyDown(screen.getByRole("img"), { key: "Enter" });
    rerender(<StatSparkline widget={{ ...widget, title: "Changed" }} series={series} name="api" unit="req/s" />);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("img"), { key: "End" });
    fireEvent.keyDown(screen.getByRole("img"), { key: "Enter" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Pinned");
    rerender(<StatSparkline widget={widget} series={{ ...series, points: [...series.points, { timestamp: 4000, value: 10 }] }} name="api" unit="req/s" />);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    rerender(<StatSparkline series={series} name="api" unit="req/s" />);
    expect(screen.getByRole("img")).not.toHaveAttribute("tabindex");
    fireEvent.focus(screen.getByRole("img"));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    rerender(<StatSparkline widget={{ ...widget, options: { showTooltip: false } }} series={series} name="api" unit="req/s" />);
    expect(screen.getByRole("img")).not.toHaveAttribute("data-stat-interactive");
  });
});

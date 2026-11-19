import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetVisualization } from "./charts";
import type { Series } from "./chart-data";
import type { QueryResult, Widget } from "./schema";

afterEach(cleanup);

// Two generated names, so the visible labels use their short form: the component.
const metric = (component: string, value: number | null): Series => ({
  name: `paprika_demo_component_up{cluster="omega", component="${component}"}`,
  labels: { __name__: "paprika_demo_component_up", cluster: "omega", component },
  points: [{ timestamp: Date.UTC(2026, 0, 1, 0, 0), value }],
});
const result: QueryResult = { series: [metric("database", 40.4), metric("frontend", 12)] };
const base: Widget = {
  id: "health",
  title: "Component health",
  type: "heatmap",
  providerId: "prom",
  query: "up",
  unit: "%",
  layout: { x: 0, y: 0, w: 6, h: 4 },
  options: {},
};

describe("built-in heatmap accessible names and status", () => {
  it("names each cell with the short name its tooltip heads with, not the full series identity", () => {
    render(<WidgetVisualization widget={base} result={result} />);
    expect(screen.getByRole("button", { name: /^database: 40\.4/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /paprika_demo_component_up/ })).not.toBeInTheDocument();
  });
  it("shows a matched threshold that names a status as a status chip in the tooltip", () => {
    const widget: Widget = { ...base, options: { thresholds: [{ value: 0, color: "#00aa00", status: "ok", label: "Healthy" }, { value: 30, color: "#cc0000", status: "critical", label: "Critical" }] } };
    render(<WidgetVisualization widget={widget} result={result} />);
    fireEvent.click(screen.getByRole("button", { name: /database/ }));
    const tip = screen.getByRole("tooltip");
    expect(tip.querySelector("[data-status]")).toHaveAttribute("data-status", "critical");
    expect(within(tip).getByText("Critical")).toBeInTheDocument();
  });
});

describe("built-in heatmap threshold ranges", () => {
  it("reads 1200 and 1400 ms as 1.2 s and 1.4 s at zero decimals, each band with its own bound", () => {
    const widget: Widget = { ...base, unit: "ms", options: { decimals: 0, thresholds: [{ value: 0, color: "#00aa00", status: "ok", label: "OK" }, { value: 1200, color: "#cc8800", status: "warning", label: "Elevated" }, { value: 1400, color: "#cc0000", status: "critical", label: "Critical" }] } };
    const { getByLabelText } = render(<WidgetVisualization widget={widget} result={{ series: [metric("database", 1300)] }} />);
    const legend = getByLabelText("Heatmap thresholds");
    expect(legend).toHaveTextContent("Below 1.2 s");
    expect(legend).toHaveTextContent("≥ 1.2 s and < 1.4 s");
    expect(legend).toHaveTextContent("≥ 1.4 s");
    expect(legend).not.toHaveTextContent(/≥ 1 s|Below 1 s/);
  });
});

describe("built-in heatmap tooltip content", () => {
  it("honours the Tooltips settings: title, value caption, decimals and unit", () => {
    const widget: Widget = { ...base, options: { tooltipTitle: "Custom CPU title", tooltipValueLabel: "Busy share", tooltipDecimals: 3, tooltipShowUnit: false } };
    render(<WidgetVisualization widget={widget} result={result} />);
    fireEvent.click(screen.getByRole("button", { name: /database/ }));
    const tip = screen.getByRole("tooltip");
    expect(within(tip).getByText("Custom CPU title", { selector: "strong" })).toBeInTheDocument();
    expect(within(tip).getByText("Busy share")).toBeInTheDocument();
    expect(tip.querySelector("[data-metric-value]")).toHaveTextContent(/^40\.400$/);
  });

  it("heads the panel with the short series name and keeps the full identity in Source details", () => {
    render(<WidgetVisualization widget={base} result={result} />);
    fireEvent.click(screen.getByRole("button", { name: /database/ }));
    const tip = screen.getByRole("tooltip");
    expect(within(tip).getByText("database", { selector: "strong" })).toBeInTheDocument();
    expect(tip).not.toHaveTextContent(/^paprika_demo_component_up\{/);
    expect(tip.querySelector("details")).toHaveTextContent("paprika_demo_component_up{cluster=\"omega\", component=\"database\"}");
  });

  it("keeps the pinning instructions in the footer, not in the header", () => {
    render(<WidgetVisualization widget={base} result={result} />);
    fireEvent.click(screen.getByRole("button", { name: /database/ }));
    const tip = screen.getByRole("tooltip");
    const header = tip.querySelector("[class*='tooltipHeader']")!;
    const instructions = tip.querySelector("[data-tooltip-instructions]")!;
    expect(header.contains(instructions)).toBe(false);
    expect(instructions.closest("[class*='tooltipFooter']")).not.toBeNull();
  });

  it("says plainly that a cell without a finite latest value has no data", () => {
    render(<WidgetVisualization widget={base} result={{ series: [metric("database", null), metric("frontend", 12)] }} />);
    fireEvent.click(screen.getByRole("button", { name: /database/ }));
    expect(screen.getByRole("tooltip").querySelector("[data-metric-value]")).toHaveAttribute("data-metric-value", "missing");
    expect(screen.getByRole("tooltip")).toHaveTextContent("No data");
  });

  it("keeps one tab stop in the built-in heatmap and moves focus with the arrow keys", () => {
    const many: QueryResult = { series: Array.from({ length: 6 }, (_, index) => metric(`c${index}`, index)) };
    render(<WidgetVisualization widget={base} result={many} />);
    const cells = Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-heatmap-cell]"));
    expect(cells.filter(cell => cell.tabIndex === 0)).toHaveLength(1);
    cells[0].focus();
    fireEvent.keyDown(cells[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(cells[1]);
    expect(cells[1].tabIndex).toBe(0);
    expect(cells[0].tabIndex).toBe(-1);
    fireEvent.keyDown(cells[1], { key: "ArrowDown" });
    // ArrowDown moves by one row of the grid, which is more than one cell wide.
    expect(cells.indexOf(document.activeElement as HTMLButtonElement)).toBeGreaterThan(1);
  });

  it("does not reopen a preview when Escape returns focus to the cell that owns the pinned panel", () => {
    render(<WidgetVisualization widget={base} result={result} />);
    const cell = screen.getByRole("button", { name: /database/ });
    cell.focus();
    fireEvent.click(cell);
    const tooltip = screen.getByRole("tooltip");
    const summary = within(tooltip).getByText("Source details");
    summary.focus();
    fireEvent.keyDown(summary, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(cell);
  });

  it("opens no preview or pin when the widget turns its tooltip off, and still selects the cell", () => {
    const select = vi.fn();
    render(<WidgetVisualization widget={{ ...base, options: { showTooltip: false } }} result={result} onContextChange={select} />);
    const cell = screen.getByRole("button", { name: /database/ });
    fireEvent.pointerEnter(cell, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.click(cell);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(cell).not.toHaveAttribute("aria-pressed", "true");
    expect(select).toHaveBeenCalled();
  });

  it("keeps a hovered preview open after Escape returns focus to its cell, until the focus leaves", () => {
    vi.useFakeTimers();
    try {
      render(<WidgetVisualization widget={base} result={result} />);
      const cell = screen.getByRole("button", { name: /database/ });
      cell.focus();
      fireEvent.click(cell);
      const summary = within(screen.getByRole("tooltip")).getByText("Source details");
      summary.focus();
      fireEvent.keyDown(summary, { key: "Escape" });
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      expect(document.activeElement).toBe(cell);
      // The cell still has focus, so the hover preview it opens must hold after the pointer leaves.
      fireEvent.pointerEnter(cell, { pointerType: "mouse" });
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
      fireEvent.pointerLeave(cell);
      act(() => { vi.advanceTimersByTime(400); });
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

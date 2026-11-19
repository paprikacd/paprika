import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryResult, Widget } from "../schema";
import { uptimeObservations, UTC_DAY } from "./uptime-observations";
import { UptimeCalendar, UptimeTimeline, defaultThresholds } from "./uptime-views";

afterEach(cleanup);
const base = Date.UTC(2024, 1, 28);
const thresholds = [{ value: 0, color: "#d34040", label: "Down" }, { value: 1, color: "#168447", label: "Up" }];
const series: NonNullable<QueryResult["series"]>[number] = { name: "api", labels: { service: "api" }, points: [
  { timestamp: base + 3600000, value: 1 }, { timestamp: base + 2 * 3600000, value: 0 },
  { timestamp: base + UTC_DAY + 3600000, value: null },
  { timestamp: base + 3 * UTC_DAY + 3600000, value: 1 },
] };
const widget: Widget = { id: "uptime", title: "Service history", type: "plugin", pluginId: "uptime-calendar", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, options: { thresholds } };

describe("legend bounds", () => {
  it("prints each threshold bound at the widget's decimal places, and in Auto without float noise", () => {
    const bounded = (decimals?: number): Widget => ({ ...widget, options: { thresholds: [{ value: 0.1 + 0.2, color: "#168447" }], ...(decimals === undefined ? {} : { decimals }) } });
    const { unmount } = render(<UptimeTimeline widget={bounded(2)} result={{ series: [series] }} />);
    expect(screen.getByText("≥ 0.30")).toBeInTheDocument();
    unmount();
    const auto = render(<UptimeTimeline widget={bounded()} result={{ series: [series] }} />);
    expect(screen.getByText("≥ 0.3")).toBeInTheDocument();
    expect(screen.queryByText(/0\.30000000/)).not.toBeInTheDocument();
    auto.unmount();
  });
});

describe("status legend bounds", () => {
  it("prints an unlabelled status threshold's bound at the widget's decimals on the status chip too", () => {
    const chip: Widget = { ...widget, options: { thresholds: [{ value: 0.1 + 0.2, color: "#168447", status: "critical" }], decimals: 2 } };
    render(<UptimeTimeline widget={chip} result={{ series: [series] }} />);
    expect(screen.getByRole("group", { name: "Recorded day legend" })).toHaveTextContent("≥ 0.30");
    expect(screen.getByRole("group", { name: "Recorded day legend" })).not.toHaveTextContent("0.30000000");
  });
});

describe("daily observed state", () => {
  it("keeps changes, missing days and leap day distinct without inferring uptime", () => {
    const data = uptimeObservations([series], thresholds, 90, 1);
    expect(data.rows[0].days.map(day => day.kind)).toEqual(["mixed", "unknown", "unknown", "observed"]);
    expect(data.rows[0].days.map(day => new Date(day.day * UTC_DAY).toISOString().slice(0,10))).toEqual(["2024-02-28", "2024-02-29", "2024-03-01", "2024-03-02"]);
    expect(data.rows[0].days[0].count).toBe(2);
    expect(data.rows[0].days[1].missing).toBe(1);
    expect(data.rows[0].days[2].count).toBe(0);
    expect(data.rows[0].days[3].color).toBe("#168447");
  });
  it("bounds long time ranges and series without averaging or inventing days outside the observations", () => {
    const older = { ...series, points: [{ timestamp: base, value: 1 }, { timestamp: base + 400 * UTC_DAY, value: 0 }] };
    const data = uptimeObservations([older, series], thresholds, 90, 1);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].days).toHaveLength(90);
    expect(data.truncatedDays).toBe(true);
    expect(data.truncatedSeries).toBe(true);
    expect(data.rows[0].days[0].kind).toBe("unknown");
    expect(data.rows[0].days.at(-1)?.label).toBe("Down");
  });
  it.each([UptimeCalendar, UptimeTimeline])("renders interactive recorded-day views without fabricated percentages", component => {
    const select = vi.fn();
    const { container } = render(component({ widget, result: { series: [series] }, onContextChange: select }));
    expect(screen.getByText("Not a measured uptime percentage")).toBeInTheDocument();
    const cells = [...container.querySelectorAll<HTMLButtonElement>("[data-uptime-key]")];
    expect(cells).toHaveLength(4);
    expect(cells.filter(cell => cell.tabIndex === 0)).toHaveLength(1);
    fireEvent.focus(cells[0]);
    fireEvent.keyDown(cells[0], { key: "ArrowRight" });
    expect(cells[1]).toHaveFocus();
    fireEvent.click(cells[0]);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Mixed or incomplete observations");
    expect(screen.getByRole("tooltip")).toHaveTextContent("2 recorded samples");
    expect(select).toHaveBeenLastCalledWith({ labels: { service: "api" }, value: 0, series: "api" });
    fireEvent.click(cells[2]);
    expect(screen.getByRole("tooltip")).toHaveTextContent("No recorded value");
    expect(select).toHaveBeenLastCalledWith({ labels: { service: "api" }, value: null, series: "api" });
  });
  it.each([UptimeCalendar, UptimeTimeline])("closes a hovered day after the pointer leaves, even while another day keeps focus", component => {
    vi.useFakeTimers();
    try {
      const { container } = render(component({ widget, result: { series: [series] } }));
      const cells = [...container.querySelectorAll<HTMLButtonElement>("[data-uptime-key]")];
      act(() => cells[0].focus());
      fireEvent.pointerEnter(cells[2], { pointerType: "mouse" });
      expect(screen.getByRole("tooltip")).toHaveTextContent("No recorded value");
      fireEvent.pointerLeave(cells[2]);
      act(() => { vi.advanceTimersByTime(200); });
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      expect(cells[0]).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([UptimeCalendar, UptimeTimeline])("heads a pinned day with its series, not the widget title", component => {
    const { container } = render(component({ widget, result: { series: [series] } }));
    fireEvent.click(container.querySelector<HTMLButtonElement>("[data-uptime-key]")!);
    expect(within(screen.getByRole("tooltip")).getByText("api", { selector: "strong" })).toBeInTheDocument();
  });
  it.each([UptimeCalendar, UptimeTimeline])("keeps a pinned day open with its refreshed reading, and releases it when the day leaves", component => {
    const { container, rerender } = render(component({ widget, result: { series: [series] } }));
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-uptime-key="0-3"]')!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("1 recorded sample");
    const refreshed = { ...series, points: [...series.points, { timestamp: base + 3 * UTC_DAY + 7200000, value: 0 }] };
    rerender(component({ widget, result: { series: [refreshed] } }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("2 recorded samples");
    expect(container.querySelector('[data-uptime-key="0-3"]')).toHaveAttribute("aria-pressed", "true");
    rerender(component({ widget, result: { series: [{ ...series, points: series.points.slice(0, 2) }] } }));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
  it("honors UTC day boundaries rather than the browser's local DST day", () => {
    const data = uptimeObservations([{ ...series, points: [{ timestamp: Date.parse("2024-03-10T23:59:00Z"), value: 1 }, { timestamp: Date.parse("2024-03-11T00:01:00Z"), value: 1 }] }], thresholds, 90, 1);
    expect(data.rows[0].days.map(day => new Date(day.day * UTC_DAY).toISOString().slice(0,10))).toEqual(["2024-03-10", "2024-03-11"]);
  });
  it("paints an authored hex band exactly as written", () => {
    const observed = { ...series, points: [{ timestamp: base, value: 0 }] };
    const { container } = render(<UptimeCalendar widget={{ ...widget, options: { thresholds } }} result={{ series: [observed] }} />);
    const cell = container.querySelector<HTMLButtonElement>("[data-uptime-key]");
    expect(cell).toHaveAttribute("style", expect.stringContaining("background-color: #d34040"));
  });
  it.each([UptimeCalendar, UptimeTimeline])("defaults missing thresholds to up/down states while preserving unknown samples", component => {
    const entry = { ...series, points: [{ timestamp: base, value: 0 }, { timestamp: base + UTC_DAY, value: 1 }, { timestamp: base + 2 * UTC_DAY, value: null }] };
    const { container } = render(component({ widget: { ...widget, options: {} }, result: { series: [entry] } }));
    const cells = [...container.querySelectorAll<HTMLButtonElement>("[data-uptime-key]")];
    expect(cells[0]).toHaveAttribute("aria-label", expect.stringContaining("Down"));
    // jsdom drops a var() background; the default bands are checked structurally, and a hex override is checked in the DOM.
    expect(defaultThresholds).toEqual([{ value: 0, status: "critical", label: "Down" }, { value: 1, status: "ok", label: "Up" }]);
    expect(cells[1]).toHaveAttribute("aria-label", expect.stringContaining("Up"));
    expect(cells[1]).toHaveAttribute("aria-label", expect.stringContaining("Up"));
    expect(cells[2]).toHaveAttribute("data-uptime-state", "unknown");
    expect(screen.getByRole("group", { name: "Recorded day legend" })).toHaveTextContent("Down");
  });
});

describe("status cues on recorded days", () => {
  const statusThresholds = [{ value: 0, status: "critical" as const, label: "Down" }, { value: 1, status: "warning" as const, label: "Degraded" }, { value: 2, status: "ok" as const, label: "Up" }];
  const days = (values: (number | null)[]): NonNullable<QueryResult["series"]>[number] => ({ name: "api", labels: { service: "api" }, points: values.map((value, index) => ({ timestamp: base + index * UTC_DAY + 3600000, value })) });
  it("strokes warning days 1 px and critical days 2 px, with a glyph chip in the legend, and never hatches a status", () => {
    const { container } = render(<UptimeTimeline widget={{ ...widget, pluginId: "uptime-timeline", options: { thresholds: statusThresholds } }} result={{ series: [days([0, 1, 2])] }} />);
    const observed = [...container.querySelectorAll<HTMLElement>('[data-uptime-state="observed"]')];
    expect(observed.map(cell => cell.getAttribute("data-status-stroke"))).toEqual(["critical", "warning", null]);
    expect(container.querySelector('[role="group"][aria-label="Recorded day legend"]')!.querySelectorAll("[data-status]")).toHaveLength(3);
    expect(observed[0].className).not.toMatch(/mixed|unknown/);
  });
  it("ships status-named defaults rather than hex", () => {
    expect(defaultThresholds.map(threshold => [threshold.status, threshold.color])).toEqual([["critical", undefined], ["ok", undefined]]);
  });
  it("leaves hex-only days without a stroke or glyph", () => {
    const { container } = render(<UptimeTimeline widget={{ ...widget, pluginId: "uptime-timeline", options: { thresholds } }} result={{ series: [days([0, 1])] }} />);
    expect(container.querySelector("[data-status-stroke]")).toBeNull();
    expect(container.querySelector("[data-status]")).toBeNull();
  });
});

describe("uptime pin after the window moves", () => {
  it("keeps the pinned day pressed, and only that day, when a refresh shifts the days by one", () => {
    const days = (offset: number) => ({ series: [{ name: "api", labels: { service: "api" }, points: [0, 1, 2, 3].map(index => ({ timestamp: base + (offset + index) * UTC_DAY + 3600000, value: 1 })) }] });
    const widgetWith = { ...widget, pluginId: "uptime-timeline", config: { maxDays: 7 } };
    const dayNumber = Math.floor(base / UTC_DAY);
    const { container, rerender } = render(<UptimeTimeline widget={widgetWith} result={days(0)} />);
    const pinned = container.querySelector<HTMLButtonElement>(`[data-uptime-day="${dayNumber + 1}"]`)!;
    fireEvent.click(pinned);
    expect(pinned).toHaveAttribute("aria-pressed", "true");
    rerender(<UptimeTimeline widget={widgetWith} result={days(1)} />);
    const after = container.querySelector<HTMLButtonElement>(`[data-uptime-day="${dayNumber + 1}"]`)!;
    expect(after).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector<HTMLButtonElement>(`[data-uptime-day="${dayNumber + 2}"]`)).toHaveAttribute("aria-pressed", "false");
  });
});

describe("uptime tooltip identity", () => {
  const generated: NonNullable<QueryResult["series"]>[number] = { name: 'paprika_demo_probe_up{cluster="omega", service="checkout"}', labels: { __name__: "paprika_demo_probe_up", cluster: "omega", service: "checkout" }, points: [{ timestamp: base + 3600000, value: 1 }] };
  it("names a lone generated series by its preferred label in cells and the row head", () => {
    const { container } = render(<UptimeTimeline widget={widget} result={{ series: [generated] }} />);
    const cell = container.querySelector<HTMLButtonElement>('[data-uptime-key="0-0"]')!;
    expect(cell.getAttribute("aria-label")).toMatch(/^checkout · /);
    expect(cell.getAttribute("aria-label")).not.toContain("paprika_demo_probe_up");
  });
  it("pins the row that was clicked when two series share a name", () => {
    const first = { ...series, name: "api", labels: { instance: "a" } };
    const second = { ...series, name: "api", labels: { instance: "b" } };
    const select = vi.fn();
    const { container } = render(<UptimeTimeline widget={widget} result={{ series: [first, second] }} onContextChange={select} />);
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-uptime-key="1-0"]')!);
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ labels: { instance: "b" } }));
    expect(container.querySelector('[data-uptime-key="1-0"]')).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector('[data-uptime-key="0-0"]')).toHaveAttribute("aria-pressed", "false");
  });
});

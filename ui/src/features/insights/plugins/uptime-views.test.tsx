import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryResult, Widget } from "../schema";
import { uptimeObservations, UTC_DAY } from "./uptime-observations";
import { UptimeCalendar, UptimeTimeline } from "./uptime-views";

afterEach(cleanup);
const base = Date.UTC(2024, 1, 28);
const thresholds = [{ value: 0, color: "#d34040", label: "Down" }, { value: 1, color: "#168447", label: "Up" }];
const series: NonNullable<QueryResult["series"]>[number] = { name: "api", labels: { service: "api" }, points: [
  { timestamp: base + 3600000, value: 1 }, { timestamp: base + 2 * 3600000, value: 0 },
  { timestamp: base + UTC_DAY + 3600000, value: null },
  { timestamp: base + 3 * UTC_DAY + 3600000, value: 1 },
] };
const widget: Widget = { id: "uptime", title: "Service history", type: "plugin", pluginId: "uptime-calendar", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, options: { thresholds } };

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
  it("honors UTC day boundaries rather than the browser's local DST day", () => {
    const data = uptimeObservations([{ ...series, points: [{ timestamp: Date.parse("2024-03-10T23:59:00Z"), value: 1 }, { timestamp: Date.parse("2024-03-11T00:01:00Z"), value: 1 }] }], thresholds, 90, 1);
    expect(data.rows[0].days.map(day => new Date(day.day * UTC_DAY).toISOString().slice(0,10))).toEqual(["2024-03-10", "2024-03-11"]);
  });
  it.each([UptimeCalendar, UptimeTimeline])("defaults missing thresholds to up/down states while preserving unknown samples", component => {
    const entry = { ...series, points: [{ timestamp: base, value: 0 }, { timestamp: base + UTC_DAY, value: 1 }, { timestamp: base + 2 * UTC_DAY, value: null }] };
    const { container } = render(component({ widget: { ...widget, options: {} }, result: { series: [entry] } }));
    const cells = [...container.querySelectorAll<HTMLButtonElement>("[data-uptime-key]")];
    expect(cells[0]).toHaveAttribute("aria-label", expect.stringContaining("Down"));
    expect(cells[0]).toHaveStyle({ backgroundColor: "#e34b4b" });
    expect(cells[1]).toHaveAttribute("aria-label", expect.stringContaining("Up"));
    expect(cells[1]).toHaveStyle({ backgroundColor: "#36b96b" });
    expect(cells[2]).toHaveAttribute("data-uptime-state", "unknown");
    expect(screen.getByRole("group", { name: "Recorded day legend" })).toHaveTextContent("Down");
  });
});

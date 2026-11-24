import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChartDataInspector } from "./chart-data-inspector";
import { DashboardTimeZoneProvider } from "./dashboard-time-zone";
import type { Widget } from "./schema";
import type { Series } from "./chart-renderer-shared";

const base = { id: "signal", title: "Signal", type: "timeseries", providerId: "metrics", query: "up", layout: { x: 0, y: 0, w: 4, h: 4 } } as const;

function inspect(widget: Partial<Widget>, values: (number | null)[], start = 1000) {
  const series = {
    name: "api",
    labels: { service: "api" },
    points: values.map((value, index) => ({ timestamp: start + index * 1000, value })),
  } as Series;
  const view = render(
    <DashboardTimeZoneProvider timeZone="UTC">
      <ChartDataInspector widget={{ ...base, ...widget } as Widget} series={[series]} />
    </DashboardTimeZoneProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Inspect chart data for Signal" }));
  const dialog = screen.getByRole("dialog");
  const cells = (column: number) => Array.from(dialog.querySelectorAll(`tbody tr td:nth-child(${column})`), (cell) => cell.textContent ?? "");
  return { view, dialog, values: () => cells(2), times: () => cells(1) };
}

describe("widget data inspector numbers", () => {
  it("shows float noise as three significant figures when decimals are unset", () => {
    const { values, view } = inspect({ unit: "" }, [43.2420159848]);
    expect(values()).toEqual(["43.2"]);
    view.unmount();
  });

  it("honours an explicit decimals setting on the same value", () => {
    const one = inspect({ unit: "", options: { decimals: 1 } }, [43.2420159848]);
    expect(one.values()).toEqual(["43.2"]);
    one.view.unmount();
    const two = inspect({ unit: "", options: { decimals: 2 } }, [43.2420159848]);
    expect(two.values()).toEqual(["43.24"]);
    two.view.unmount();
  });

  it("scales the unit before choosing digits in Auto, and keeps the unit with the value", () => {
    const auto = inspect({ unit: "ms" }, [1234.5678]);
    expect(auto.values()).toEqual(["1.23 s"]);
    auto.view.unmount();
    const fixed = inspect({ unit: "ms", options: { decimals: 1 } }, [1234.5678]);
    expect(fixed.values()).toEqual(["1.2 s"]);
    fixed.view.unmount();
  });

  it("keeps whole numbers whole and groups unit-less counts", () => {
    const { values, view } = inspect({ unit: "", options: { decimals: 2 } }, [18432, 5]);
    expect(values()).toEqual(["18,432", "5"]);
    view.unmount();
  });

  it("shows no digit run beyond three significant figures in Auto", () => {
    const { values, view } = inspect({ unit: "%" }, [0.1 + 0.2, 296303060975 / 1e9, 7.191875000000073]);
    for (const text of values()) expect(text).not.toMatch(/\.\d{4,}/);
    view.unmount();
  });

  it("prints exact values only behind the Exact values toggle", () => {
    const { dialog, values, view } = inspect({ unit: "" }, [43.2420159848]);
    expect(values()).toEqual(["43.2"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Exact values" }));
    expect(values()).toEqual(["43.2420159848"]);
    view.unmount();
  });

  it("formats timestamps in the dashboard time zone, not as ISO text", () => {
    const start = Date.UTC(2026, 0, 15, 0, 0, 0);
    const { times, view, dialog } = inspect({ unit: "" }, [1], start);
    expect(times()[0]).toMatch(/Jan 15, 2026, 00:00:00/);
    expect(times()[0]).not.toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    expect(dialog.querySelector("time")?.getAttribute("datetime")).toBe("2026-01-15T00:00:00.000Z");
    view.unmount();
  });
});

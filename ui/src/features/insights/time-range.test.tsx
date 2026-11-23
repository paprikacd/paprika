import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeRangeControl, customRangeLabels } from "./time-range";
import { resolveDashboardTimeZone } from "./dashboard-time-zone";
import type { Dashboard } from "./schema";

afterEach(() => cleanup());

const dashboard: Dashboard = {
  schemaVersion: 1,
  id: "edge",
  title: "Edge Watch",
  timeRange: "1h",
  refreshInterval: 0,
  widgets: [],
};

describe("time range control focus", () => {
  it("keeps the calendar button beside the select by default", () => {
    render(<TimeRangeControl dashboard={dashboard} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Choose custom time range" })).toBeInTheDocument();
  });

  it("drops the calendar button and returns focus to the select when the popover closes", () => {
    render(<TimeRangeControl dashboard={dashboard} onChange={vi.fn()} customButton={false} />);
    expect(screen.queryByRole("button", { name: "Choose custom time range" })).not.toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: "Time range" });
    fireEvent.click(select);
    fireEvent.click(screen.getByRole("option", { name: "Custom range…" }));
    const popover = screen.getByRole("region", { name: "Custom time range" });
    expect(popover).toBeInTheDocument();
    fireEvent.keyDown(popover, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Custom time range" })).not.toBeInTheDocument();
    expect(select).toHaveFocus();
  });

  it("returns focus to the select after Close time range", () => {
    render(<TimeRangeControl dashboard={dashboard} onChange={vi.fn()} customButton={false} />);
    const select = screen.getByRole("combobox", { name: "Time range" });
    fireEvent.click(select);
    fireEvent.click(screen.getByRole("option", { name: "Custom range…" }));
    fireEvent.click(screen.getByRole("button", { name: "Close time range" }));
    expect(select).toHaveFocus();
  });

  it("returns focus to the calendar button when it closes the popover", () => {
    render(<TimeRangeControl dashboard={dashboard} onChange={vi.fn()} />);
    const calendar = screen.getByRole("button", { name: "Choose custom time range" });
    fireEvent.click(calendar);
    fireEvent.click(screen.getByRole("button", { name: "Close time range" }));
    expect(calendar).toHaveFocus();
  });
});

describe("custom range labels", () => {
  const now = new Date("2026-11-23T03:00:00Z");

  it("collapses a same-day range into one date", () => {
    const { compact } = customRangeLabels({ from: "2026-11-07T00:00:00Z", to: "2026-11-07T06:00:00Z" }, "UTC", now);
    expect(compact.match(/Nov/g)).toHaveLength(1);
    expect(compact).not.toMatch(/2026/);
  });

  it("names both days of a range that crosses days", () => {
    const { compact } = customRangeLabels({ from: "2026-11-07T00:00:00Z", to: "2026-11-09T06:00:00Z" }, "UTC", now);
    expect(compact).toContain("Nov 7");
    expect(compact).toContain("Nov 9");
  });

  it("adds the year only when an end falls outside the current year", () => {
    expect(customRangeLabels({ from: "2025-12-30T00:00:00Z", to: "2026-01-02T00:00:00Z" }, "UTC", now).compact).toMatch(/2025/);
    expect(customRangeLabels({ from: "2026-11-07T00:00:00Z", to: "2026-11-09T00:00:00Z" }, "UTC", now).compact).not.toMatch(/2026/);
  });

  it("keeps the time zone out of the compact label and puts its name in the full label", () => {
    const { compact, full } = customRangeLabels({ from: "2026-11-07T00:00:00Z", to: "2026-11-07T06:00:00Z" }, "Australia/Melbourne", now);
    expect(compact).not.toMatch(/GMT|AEDT|AEST/);
    expect(full).toMatch(/GMT\+11|AEDT/);
    expect(full.length).toBeGreaterThan(compact.length);
  });
});

describe("custom range in the trigger", () => {
  const custom: Dashboard = { ...dashboard, customTimeRange: { from: "2026-11-07T00:00:00.000Z", to: "2026-11-07T06:00:00.000Z" } };

  it("shows the compact range in the select, the full range as its title, and no separate summary", () => {
    render(<TimeRangeControl dashboard={custom} onChange={vi.fn()} />);
    const select = screen.getByRole("combobox", { name: "Time range" });
    const { compact, full } = customRangeLabels(custom.customTimeRange!, resolveDashboardTimeZone(custom.timeZone), new Date());
    // Raw text, not toHaveTextContent: the label holds narrow spaces that jest-dom's normaliser would collapse.
    expect(select.textContent).toContain(compact);
    expect(select).toHaveAttribute("title", full);
    expect([...document.querySelectorAll("*")].filter((element) => element.children.length === 0 && element.textContent === compact)).toHaveLength(1);
  });
});

describe("reset to the saved window", () => {
  it("offers Reset only when a handler is given, and names the saved range", () => {
    const onReset = vi.fn();
    const { rerender } = render(<TimeRangeControl dashboard={dashboard} onChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Reset time range/ })).not.toBeInTheDocument();
    rerender(<TimeRangeControl dashboard={dashboard} onChange={vi.fn()} onReset={onReset} resetLabel="Last 1 hour" />);
    fireEvent.click(screen.getByRole("button", { name: "Reset time range to Last 1 hour" }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("falls back to a plain name when no saved label is given", () => {
    render(<TimeRangeControl dashboard={dashboard} onChange={vi.fn()} onReset={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Reset time range" })).toHaveTextContent("Reset");
  });
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeRangeControl } from "./time-range";
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

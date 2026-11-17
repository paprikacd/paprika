import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChartEvents } from "./chart-events";
import { DashboardTimeZoneProvider } from "./dashboard-time-zone";

afterEach(cleanup);

describe("recorded chart context", () => {
  it("returns focus to the disclosure on Escape without changing recorded bounds", () => {
    const events = [{ timestamp: "2026-11-08T03:04:00Z", endTimestamp: "2026-11-08T03:09:00Z", label: "Queue saturation" }];
    render(<DashboardTimeZoneProvider timeZone="Australia/Melbourne"><ChartEvents events={events} /></DashboardTimeZoneProvider>);
    const disclosure = screen.getByRole("group", { name: "Chart events" }) as HTMLDetailsElement;
    const summary = disclosure.querySelector("summary")!;
    disclosure.open = true;
    const list = screen.getByRole("list", { name: "Recorded chart events" });
    list.focus();
    fireEvent.keyDown(list, { key: "Escape" });
    expect(disclosure.open).toBe(false);
    expect(summary).toHaveFocus();
    expect([...disclosure.querySelectorAll("time")].map(time => time.dateTime)).toEqual([events[0].timestamp, events[0].endTimestamp]);
    expect(disclosure).toHaveTextContent("unclassified");
  });

  it("does not offer an empty disclosure", () => {
    render(<ChartEvents events={[]} />);
    expect(screen.queryByRole("group", { name: "Chart events" })).not.toBeInTheDocument();
  });
});

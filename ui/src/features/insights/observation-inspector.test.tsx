import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Series } from "./chart-data";
import { DashboardTimeZoneProvider } from "./dashboard-time-zone";
import { ObservationInspector, type ObservationInspectorProps } from "./observation-inspector";
import type { Widget } from "./schema";

afterEach(cleanup);

const series: Series[] = [
  { name: "api", labels: { service: "api", region: "eu" }, points: [{ timestamp: 1000, value: 12.345 }, { timestamp: 2000, value: 13 }, { timestamp: 3000, value: 14 }] },
  { name: "worker", labels: { service: "worker" }, points: [{ timestamp: 1000, value: 4 }, { timestamp: 2000, value: null }, { timestamp: 3000, value: null }] },
  { name: "db", labels: {}, points: [{ timestamp: 1000, value: 9 }, { timestamp: 1500, value: 8 }] },
];

function inspector(props: Partial<ObservationInspectorProps> = {}) {
  const handlers = { onPin: vi.fn(), onClose: vi.fn() };
  const view = render(<DashboardTimeZoneProvider timeZone="UTC">
    <ObservationInspector series={series} selectedSeriesIndex={0} timestamp={1000} unit="ms" pinned={false} colors={["#2867b9", "#53876a", "#977017"]} {...handlers} {...props} />
  </DashboardTimeZoneProvider>);
  return { ...view, ...handlers };
}

describe("observation inspector", () => {
  it("states the exact value of every series at the inspected time", () => {
    const { container } = inspector({ timestamp: 1000 });
    const rows = Array.from(container.querySelectorAll("[data-observation-state]"));
    expect(rows.map((row) => row.getAttribute("data-observation-state"))).toEqual(["observed", "observed", "observed"]);
    expect(rows[0].querySelector("strong")).toHaveTextContent("12.345 ms");
    expect(rows[1].querySelector("strong")).toHaveTextContent("4 ms");
  });

  it("says when a series has no sample at the time, or a missing one, rather than showing a neighbour", () => {
    const { container, rerender } = inspector({ timestamp: 2000 });
    const states = () => Array.from(container.querySelectorAll("[data-observation-state]")).map((row) => row.getAttribute("data-observation-state"));
    expect(states()).toEqual(["observed", "missing", "absent"]);
    expect(container.querySelector('[data-observation-state="missing"] strong')).toHaveTextContent("Missing observation");
    expect(container.querySelector('[data-observation-state="absent"] strong')).toHaveTextContent("No sample at this time");
    rerender(<DashboardTimeZoneProvider timeZone="UTC">
      <ObservationInspector series={[{ ...series[2], points: [{ timestamp: 1000, value: 1 }, { timestamp: 1000, value: 2 }] }]} selectedSeriesIndex={0} timestamp={1000} unit="" pinned={false} colors={["#2867b9"]} onPin={() => {}} onClose={() => {}} />
    </DashboardTimeZoneProvider>);
    expect(screen.getByText("Multiple observations")).toBeInTheDocument();
  });

  it("pins and closes through its own controls", () => {
    const { onPin, onClose } = inspector({ pinned: false });
    fireEvent.click(screen.getByRole("button", { name: "Pin observation" }));
    expect(onPin).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close observation" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reflects a pinned observation in its heading and pin state", () => {
    inspector({ pinned: true });
    expect(screen.getByText("Pinned observation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unpin observation" })).toHaveAttribute("aria-pressed", "true");
  });

  it("follows the widget's tooltip options for the title, unit and decimals, as MetricDetails does", () => {
    const widget = { id: "lat", title: "Latency", type: "timeseries", providerId: "p", query: "q", unit: "ms", layout: { x: 0, y: 0, w: 6, h: 4 }, options: { tooltipTitle: "Request latency", tooltipShowUnit: false, tooltipDecimals: 1 } } as Widget;
    const { container } = inspector({ widget, timestamp: 1000 });
    expect(screen.getByText("Request latency")).toBeInTheDocument();
    const first = container.querySelector('[data-observation-state="observed"]') as HTMLElement;
    expect(first.querySelector("strong")).toHaveTextContent(/^12\.3$/);
  });

  it("states the window bounds in the dashboard's time zone", () => {
    const { container } = inspector({ window: { start: 1000, end: 3000 }, timestamp: 2000 });
    expect(container.querySelector("[data-inspection-start]")).toHaveAttribute("data-inspection-start", "1000");
    expect(screen.getByText("Chart window history")).toBeInTheDocument();
    expect(screen.getByText(/Jan 01, 1970, 00:00:01\.000 UTC – Jan 01, 1970, 00:00:03\.000 UTC/)).toBeInTheDocument();
    const time = container.querySelector("time") as HTMLTimeElement;
    expect(time).toHaveAttribute("dateTime", "1970-01-01T00:00:02.000Z");
  });

  it("lists the exact observations in a table named by its caption", () => {
    inspector({ timestamp: 1000 });
    const table = screen.getByRole("table", { name: "Exact observations at the selected timestamp" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByRole("rowheader", { name: "api" })).toBeInTheDocument();
  });

  it("appends host actions after the readings", () => {
    inspector({ children: <button type="button">Open trace</button> });
    expect(screen.getByRole("button", { name: "Open trace" })).toBeInTheDocument();
  });

  it("keeps the history drawings out of the accessibility tree, since the readings carry their meaning", () => {
    const { container } = inspector({ timestamp: 1000 });
    const histories = container.querySelectorAll("svg");
    expect(histories.length).toBeGreaterThan(0);
    histories.forEach((svg) => expect(svg).toHaveAttribute("aria-hidden", "true"));
  });

  it("explains an empty result rather than inventing a time", () => {
    inspector({ series: [], timestamp: 1000 });
    expect(screen.getByText("No timestamped observations")).toBeInTheDocument();
  });
});

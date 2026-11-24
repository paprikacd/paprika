import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardWindowProvider } from "./dashboard-window";
import type { QueryResult, Widget } from "./schema";
import { DirectionalTraffic, StackedTimeseries } from "./plugins/rich-metrics-view";
import { SmallMultiples } from "./plugins/small-multiples";

// Each chart family puts its actions in the one footer row, in the fixed order, as native buttons a keyboard can reach.
const points = (values: number[], start: number) => values.map((value, i) => ({ timestamp: start + i * 1000, value }));
const traffic: QueryResult = { series: [
  { name: "in", labels: { direction: "inbound" }, points: points([4, 6, 8], 4000) },
  { name: "out", labels: { direction: "outbound" }, points: points([2, 3, 4], 4000) },
] };
const base = { providerId: "metrics", query: "up", unit: "req/s", layout: { x: 0, y: 0, w: 8, h: 5 } };
const directional: Widget = { ...base, id: "traffic", title: "Traffic", type: "plugin", pluginId: "directional-traffic", dataKind: "metrics", config: { maxPoints: 24 } };

function actionLabels(row: Element) {
  return within(row as HTMLElement).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);
}

describe("footer actions by chart family", () => {
  it.each([
    ["directional traffic", <DirectionalTraffic key="d" widget={directional} result={traffic} />],
    ["stacked time series", <StackedTimeseries key="s" widget={{ ...directional, pluginId: "stacked-timeseries" }} result={traffic} />],
  ])("%s offers Compare window, then Inspect data", (_, chart) => {
    const { container } = render(<DashboardWindowProvider value={{}}>{chart}</DashboardWindowProvider>);
    const rows = container.querySelectorAll("[data-chart-actions]");
    expect(rows).toHaveLength(1);
    expect(actionLabels(rows[0])).toEqual(["Compare window for Traffic", "Inspect chart data for Traffic"]);
    const inspect = screen.getByRole("button", { name: "Inspect chart data for Traffic" });
    inspect.focus();
    expect(inspect).toHaveFocus();
    fireEvent.click(inspect);
    // The dialog lists the recorded samples of the first series.
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("in");
    expect(dialog).toHaveTextContent("8");
  });

  it("small multiples offers Inspect data in its footer", () => {
    const widget: Widget = { ...base, id: "hosts", title: "Host trends", type: "plugin", pluginId: "small-multiples", dataKind: "metrics", unit: "%", config: { columns: 2, maxSeries: 2, maxPoints: 8 } };
    const { container } = render(<SmallMultiples widget={widget} result={traffic} />);
    const row = container.querySelector("[data-chart-actions]");
    expect(row).not.toBeNull();
    expect(actionLabels(row!)).toEqual(["Inspect chart data for Host trends"]);
  });

  it("embedded charts draw no action row", () => {
    const { container } = render(<DashboardWindowProvider value={{}}><DirectionalTraffic widget={directional} result={traffic} embedded /></DashboardWindowProvider>);
    expect(container.querySelector("[data-chart-actions]")).toBeNull();
  });
});

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DashboardWindowProvider } from "../dashboard-window";
import type { QueryResult, Widget } from "../schema";
import { DirectionalTraffic, StackedTimeseries } from "./rich-metrics";

const points = (values: (number | null)[], start: number) => values.map((value, i) => ({ timestamp: start + i * 1000, value }));
const current: QueryResult = { series: [
  { name: "in", labels: { direction: "inbound" }, points: points([4, 6, 8], 4000) },
  { name: "out", labels: { direction: "outbound" }, points: points([2, 3, 4], 4000) },
] };
const previous: QueryResult = { series: [
  { name: "in", labels: { direction: "inbound" }, points: points([1, null, 3], 2000) },
  { name: "out", labels: { direction: "outbound" }, points: points([2, 3, 4], 2000) },
] };
const widget: Widget = { id: "signal", title: "Traffic", providerId: "metrics", query: "up", type: "plugin", pluginId: "directional-traffic", dataKind: "metrics", unit: "req/s", config: { maxPoints: 24 }, layout: { x: 0, y: 0, w: 8, h: 5 } };

describe("rich metric previous-period overlay", () => {
  it.each([false, true])("renders recorded prior boundaries, gaps and original inspection for directional=%s", async directional => {
    const fetch = vi.fn(async () => previous);
    const component = directional ? <DirectionalTraffic widget={widget} result={current} /> : <StackedTimeseries widget={{ ...widget, pluginId: "stacked-timeseries" }} result={current} />;
    const { container, rerender } = render(<DashboardWindowProvider value={{ previous: fetch }}>{component}</DashboardWindowProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Compare window for Traffic" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare previous period" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Overlay previous period" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Overlay previous period" }));
    const prior = screen.getByRole("group", { name: "Previous period overlay" });
    expect(prior).toHaveTextContent(directional ? "Previous directions" : "Previous stacked boundaries");
    expect(container.querySelectorAll("[data-prior-path]").length).toBeGreaterThan(0);
    expect(container.querySelector("[data-prior-path]")).toHaveAttribute("stroke-dasharray", "5 4");
    const matching = prior.querySelector("[data-prior-original-first]")!;
    expect(Number(matching.getAttribute("data-prior-aligned-first")) - Number(matching.getAttribute("data-prior-original-first"))).toBe(2000);
    fireEvent.click(screen.getByRole("button", { name: "Inspect chart data for Traffic · Previous period" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("1970");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /close/i }));
    fireEvent.click(screen.getByRole("button", { name: "Reset chart zoom" }));
    expect(screen.queryByRole("group", { name: "Previous period overlay" })).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    rerender(<DashboardWindowProvider value={{ previous: fetch }}>{directional ? <DirectionalTraffic widget={widget} result={{ series: [] }} /> : <StackedTimeseries widget={{ ...widget, pluginId: "stacked-timeseries" }} result={{ series: [] }} />}</DashboardWindowProvider>);
    expect(screen.queryByRole("group", { name: "Previous period overlay" })).not.toBeInTheDocument();
  });

  it("disables incomplete previous stacks instead of showing a fabricated total", async () => {
    const fetch = vi.fn(async () => ({ series: [previous.series![0]] }));
    render(<DashboardWindowProvider value={{ previous: fetch }}><StackedTimeseries widget={{ ...widget, pluginId: "stacked-timeseries" }} result={current} /></DashboardWindowProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Compare window for Traffic" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare previous period" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Overlay previous period" })).toBeDisabled());
    expect(screen.getByRole("status")).toHaveTextContent("requires every displayed series to match uniquely");
  });

  it("discloses negative previous traffic observations omitted from an otherwise valid overlay", async () => {
    const mixed: QueryResult = { series: [
      { name: "in", labels: { direction: "inbound" }, points: points([1, -2], 2000) },
      { name: "out", labels: { direction: "outbound" }, points: points([2, 3], 2000) },
    ] };
    render(<DashboardWindowProvider value={{ previous: vi.fn(async () => mixed) }}><DirectionalTraffic widget={widget} result={current} /></DashboardWindowProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Compare window for Traffic" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare previous period" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Overlay previous period" })).toBeEnabled());
    expect(screen.getByText(/Latest valid recorded samples/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Overlay previous period" }));
    expect(screen.getByText("Previous period: 1 negative traffic observation omitted")).toBeInTheDocument();
  });

  it("keeps an explicit reset when a selected window has only missing observations", () => {
    const missing: QueryResult = { series: [{ name: "in", labels: { direction: "inbound" }, points: points([3, null, null], 1000) }] };
    render(<DirectionalTraffic widget={widget} result={missing} />);
    fireEvent.click(screen.getByRole("button", { name: "Compare window for Traffic" }));
    fireEvent.change(screen.getByRole("slider", { name: "Window start" }), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Zoom chart to window" }));
    expect(screen.getByRole("status")).toHaveTextContent("No recorded observations in this window");
    fireEvent.click(screen.getByRole("button", { name: "Reset chart zoom" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("labels a prior-only overlay when the current window contains no complete observations", async () => {
    const missing: QueryResult = { series: [{ name: "in", labels: { direction: "inbound" }, points: points([3, null, null], 1000) }] };
    const earlier: QueryResult = { series: [{ name: "in", labels: { direction: "inbound" }, points: [{ timestamp: 1000, value: 2 }] }] };
    render(<DashboardWindowProvider value={{ previous: vi.fn(async () => earlier) }}><DirectionalTraffic widget={widget} result={missing} /></DashboardWindowProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Compare window for Traffic" }));
    fireEvent.change(screen.getByRole("slider", { name: "Window start" }), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Compare previous period" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Overlay previous period" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Overlay previous period" }));
    expect(screen.getByRole("status")).toHaveTextContent("No complete current observations in this window; dashed lines show the previous period.");
    expect(screen.getByRole("group", { name: "Previous period overlay" })).toBeInTheDocument();
  });

  it("drops a previous overlay immediately when the provider result changes", async () => {
    const fetch = vi.fn(async () => previous), value = { previous: fetch };
    const { rerender } = render(<DashboardWindowProvider value={value}><DirectionalTraffic widget={widget} result={current} /></DashboardWindowProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Compare window for Traffic" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare previous period" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Overlay previous period" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Overlay previous period" }));
    expect(screen.getByRole("group", { name: "Previous period overlay" })).toBeInTheDocument();
    const next = { series: current.series!.map(entry => ({ ...entry, points: [...entry.points] })) };
    rerender(<DashboardWindowProvider value={value}><DirectionalTraffic widget={widget} result={next} /></DashboardWindowProvider>);
    expect(screen.queryByRole("group", { name: "Previous period overlay" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset chart zoom" })).not.toBeInTheDocument();
  });
});

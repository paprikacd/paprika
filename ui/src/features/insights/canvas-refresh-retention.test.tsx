import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { DashboardCanvas, type WidgetResultSnapshot } from "./canvas";
import type { Dashboard, QueryResult } from "./schema";

// The container width is a test input, so a breakpoint crossing can swap the stacked and grid layouts (canvas.tsx).
const viewport = vi.hoisted(() => ({ width: 1200 }));
vi.mock("react-grid-layout", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useContainerWidth: () => ({ width: viewport.width, containerRef: { current: null }, mounted: true }),
  verticalCompactor: {},
}));

const dashboard: Dashboard = {
  schemaVersion: 1, id: "refresh", title: "Refresh", timeRange: "1h", refreshInterval: 30,
  widgets: [{ id: "requests", title: "Requests", type: "timeseries", providerId: "prom", query: "requests", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 } }],
};
const providers = [{ id: "prom", name: "Prometheus", type: "prometheus" as const, capabilities: ["metrics" as const] }];
// Samples end one minute before `end` (3600 s), so a refresh to 3630 s adds no stale tail. The plot's x geometry
// then depends only on the data, which is what the refresh assertions compare. The y domain is fitted to the data,
// so a shape change (not a shift) is what moves the line.
const series = (values: number[] = [1, 2, 3, 4]): QueryResult => ({
  series: [{ name: "requests", labels: {}, points: values.map((value, index) => ({ timestamp: 3_540_000 - (values.length - 1 - index) * 60_000, value })) }],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const plotted = (container: HTMLElement) => container.querySelector("svg.ts-chart");
const line = (container: HTMLElement) => container.querySelector('g.ts-chart__line path[stroke-width="1.8"]')?.getAttribute("d") ?? null;

afterEach(() => {
  viewport.width = 1200;
  vi.unstubAllGlobals();
  cleanup();
});

describe("refreshing a dashboard", () => {
  it("keeps the chart mounted through a time-window change: no placeholder, no second draw-in, and the data updates", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    let calls = 0;
    const later = deferred<QueryResult>();
    const fetcher = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve(series()) : later.promise;
    });
    const canvas = { dashboard, active: true, providers, fetcher, editing: false, onSelect: vi.fn(), onLayout: vi.fn() };
    const { container, rerender } = render(<DashboardCanvas {...canvas} end={3600} />);
    await waitFor(() => expect(plotted(container)).not.toBeNull());
    await waitFor(() => expect(container.querySelector("[data-chart-entering]")).toBeNull(), { timeout: 2_000 });
    const chart = plotted(container);
    const before = line(container);
    expect(before).not.toBeNull();

    // The refresh tick: insights-app moves `end` forward.
    rerender(<DashboardCanvas {...canvas} end={3630} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    // While it is in flight: the same chart, the last result, no placeholder, no announcement, a busy frame.
    expect(plotted(container)).toBe(chart);
    expect(line(container)).toBe(before);
    expect(container.querySelector("[data-loading-family]")).toBeNull();
    expect(screen.queryByRole("status", { name: "Loading widget" })).toBeNull();
    expect(screen.queryByText("Querying data source…")).toBeNull();
    expect(container.querySelector("[data-chart-entering]")).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();

    await act(async () => later.resolve(series([4, 1, 3, 2])));
    await waitFor(() => expect(line(container)).not.toBe(before));
    expect(plotted(container)).toBe(chart);
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.querySelector("[data-chart-entering]")).toBeNull();
  });

  it("a breakpoint remount shows the last result at once, with no placeholder and no second draw-in", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const fetcher = vi.fn(async () => series());
    const canvas = { dashboard, active: true, providers, fetcher, editing: false, onSelect: vi.fn(), onLayout: vi.fn() };
    const { container, rerender } = render(<DashboardCanvas {...canvas} end={3600} />);
    await waitFor(() => expect(plotted(container)).not.toBeNull());
    await waitFor(() => expect(container.querySelector("[data-chart-entering]")).toBeNull(), { timeout: 2_000 });
    const chart = plotted(container);
    const before = line(container);

    // Narrowing below the wide breakpoint moves every tile into the stacked layout, which remounts them.
    viewport.width = 500;
    rerender(<DashboardCanvas {...canvas} end={3600} />);
    expect(container.querySelector('[data-layout-mode="stacked"]')).not.toBeNull();
    expect(plotted(container)).not.toBe(chart);
    expect(line(container)).toBe(before);
    expect(container.querySelector("[data-loading-family]")).toBeNull();
    expect(container.querySelector("[data-chart-entering]")).toBeNull();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it("returning to the view shows the last result at once, with no placeholder and no second draw-in", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const fetcher = vi.fn(async () => series());
    const canvas = { dashboard, providers, fetcher, editing: false, onSelect: vi.fn(), onLayout: vi.fn() };
    const { container, rerender } = render(<DashboardCanvas {...canvas} active end={3600} />);
    await waitFor(() => expect(plotted(container)).not.toBeNull());
    await waitFor(() => expect(container.querySelector("[data-chart-entering]")).toBeNull(), { timeout: 2_000 });
    const before = line(container);

    rerender(<DashboardCanvas {...canvas} active={false} end={3600} />);
    expect(plotted(container)).toBeNull();
    rerender(<DashboardCanvas {...canvas} active end={3600} />);
    expect(plotted(container)).not.toBeNull();
    expect(line(container)).toBe(before);
    expect(container.querySelector("[data-loading-family]")).toBeNull();
    expect(container.querySelector("[data-chart-entering]")).toBeNull();
  });

  it("keeps a failed widget's alert in place through an automatic refresh, and marks it busy rather than re-inserting it", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    let calls = 0;
    const retry = deferred<QueryResult>();
    const fetcher = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("Provider unavailable")) : retry.promise;
    });
    const canvas = { dashboard, active: true, providers, fetcher, editing: false, onSelect: vi.fn(), onLayout: vi.fn() };
    const { container, rerender } = render(<DashboardCanvas {...canvas} end={3600} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Provider unavailable");

    rerender(<DashboardCanvas {...canvas} end={3630} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert")).toBe(alert);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();

    await act(async () => retry.reject(new Error("Provider unavailable")));
    expect(screen.getByRole("alert")).toBe(alert);
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("reports only the selected widget's latest result to the host, with the fetcher it came from", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const fetcher = vi.fn(async () => series());
    const onQueryResult = vi.fn<(snapshot: WidgetResultSnapshot) => void>();
    const canvas = { dashboard, active: true, providers, fetcher, editing: false, onSelect: vi.fn(), onLayout: vi.fn(), onQueryResult };
    const { rerender } = render(<DashboardCanvas {...canvas} end={3600} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(onQueryResult).not.toHaveBeenCalled();

    rerender(<DashboardCanvas {...canvas} selected="requests" end={3600} />);
    await waitFor(() => expect(onQueryResult).toHaveBeenLastCalledWith(expect.objectContaining({ widgetId: "requests", fetcher, result: series() })));
  });
});

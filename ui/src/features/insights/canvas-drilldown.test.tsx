import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Dashboard, Drilldown, QueryResult, Widget } from "./schema";
import { DashboardCanvas } from "./canvas";
import { WidgetVisualization } from "./charts";
import { registerWidgetPlugin } from "./widget-registry";
import { contextKey, metricContext } from "./widget-context";
import type { DrilldownContext } from "./drilldown";
import { SavedQueryLibraryProvider } from "./saved-query-context";

const query = vi.hoisted(() => ({
  data: {} as QueryResult,
  enabled: false,
  error: null as string | null,
}));
vi.mock("./query", () => ({
  useWidgetQuery: (_: Widget, options: { enabled: boolean }) => {
    query.enabled = options.enabled;
    return { data: query.data, loading: false, error: query.error };
  },
}));
vi.mock("react-grid-layout", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useContainerWidth: () => ({
    width: 1200,
    containerRef: { current: null },
    mounted: true,
  }),
  verticalCompactor: {},
}));
const link: Drilldown = {
  id: "service",
  title: "Service dashboard",
  dashboardId: "service-dashboard",
  bindings: [{ variable: "service", source: "label", value: "service" }],
};
const widget: Widget = {
  id: "requests",
  title: "Requests",
  type: "table",
  providerId: "prom",
  query: "requests",
  unit: "req/s",
  layout: { x: 0, y: 0, w: 6, h: 4 },
  drilldowns: [link],
};
const series = (name: string, value: number) => ({
  name,
  labels: { service: name },
  points: [{ timestamp: 1000, value }],
});
function Canvas({
  current = widget,
  dashboardId = "overview",
  active = true,
  onDrilldown = vi.fn(),
}: {
  current?: Widget;
  dashboardId?: string;
  active?: boolean;
  onDrilldown?: (link: Drilldown, context: DrilldownContext) => void;
}) {
  const dashboard: Dashboard = {
    schemaVersion: 1,
    id: dashboardId,
    title: "Overview",
    timeRange: "1h",
    refreshInterval: 0,
    widgets: [current],
  };
  return (
    <DashboardCanvas
      dashboard={dashboard}
      active={active}
      providers={[
        {
          id: "prom",
          name: "Prometheus",
          type: "prometheus",
          capabilities: ["metrics"],
        },
      ]}
      fetcher={vi.fn()}
      end={3600}
      editing={false}
      onSelect={vi.fn()}
      onLayout={vi.fn()}
      onDrilldown={onDrilldown}
    />
  );
}
const openMenu = () =>
  fireEvent.click(
    screen.getByRole("button", {
      name: "Open related dashboard from Requests",
    }),
  );
afterEach(() => {
  query.error = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("signal-specific dashboard drilldowns", () => {
  it("waits for the saved-query library without flashing an error, then exposes genuine failures", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const saved = { ...widget, queryRef: { id: "saved-requests" } };
    query.data = {};
    query.error = "Loading the saved-query library…";
    const view = (loading: boolean, error?: string) => <SavedQueryLibraryProvider queries={[]} variables={[]} values={{}} loading={loading} error={error}><Canvas current={saved} /></SavedQueryLibraryProvider>;
    const { rerender } = render(view(true));
    expect(query.enabled).toBe(false);
    expect(screen.getByRole("status", { name: "Loading widget" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    query.error = null;
    query.data = { series: [series("api", 12)] };
    rerender(view(false));
    expect(query.enabled).toBe(true);
    expect(screen.queryByRole("status", { name: "Loading widget" })).not.toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveTextContent("api");
    expect(screen.getByRole("table")).toHaveTextContent("12");
    query.error = "Saved-query service is unavailable";
    rerender(view(false, query.error));
    expect(screen.getByRole("alert")).toHaveTextContent(query.error);
  });

  it("keeps direct provider queries enabled while the unrelated saved-query library loads", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    query.data = {};
    render(<SavedQueryLibraryProvider queries={[]} variables={[]} values={{}} loading><Canvas /></SavedQueryLibraryProvider>);
    expect(query.enabled).toBe(true);
    expect(screen.queryByRole("status", { name: "Loading widget" })).not.toBeInTheDocument();
  });

  it("uses the latest batched visibility observation when a responsive layout moves a tile", () => {
    let notify: IntersectionObserverCallback;
    let observed: Element;
    const disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { notify = callback; }
      observe(target: Element) { observed = target; }
      disconnect = disconnect;
    });
    query.data = {};
    const { rerender, unmount } = render(<Canvas />);
    const report = (...states: boolean[]) => act(() => notify(states.map((isIntersecting, time) => ({ target: observed, isIntersecting, time } as IntersectionObserverEntry)), {} as IntersectionObserver));
    expect(query.enabled).toBe(false);
    // Chromium can batch the old desktop position and the final mobile one.
    report(false, true);
    expect(query.enabled).toBe(true);
    report(true, false);
    expect(query.enabled).toBe(false);
    report();
    expect(query.enabled).toBe(false);
    report(true);
    expect(query.enabled).toBe(true);
    rerender(<Canvas active={false} />);
    expect(query.enabled).toBe(false);
    rerender(<Canvas active />);
    expect(query.enabled).toBe(true);
    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
  it("keeps the measured canvas attached when switching dashboards and resets pinned chart cursors", () => {
    query.data = {
      series: [{
        ...series("api", 7),
        points: [{ timestamp: 1000, value: 7 }, { timestamp: 2000, value: 9 }],
      }],
    };
    const current: Widget = { ...widget, type: "timeseries", drilldowns: undefined };
    const { container, rerender } = render(<Canvas current={current} />);
    const measuredCanvas = screen.getByTestId("dashboard-canvas");
    const firstChart = screen.getByRole("img", { name: "Requests" });
    act(() => firstChart.focus());
    fireEvent.keyDown(firstChart, { key: "Enter" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Pinned");
    expect(container.querySelector('[data-chart-cursor-source="requests"]')).not.toBeNull();

    rerender(<Canvas dashboardId="next-overview" current={{ ...current, id: "errors", title: "Errors" }} />);

    // useContainerWidth observes this exact node. Remounting it beneath an
    // unchanged hook leaves the observer on a detached, zero-width element.
    expect(screen.getByTestId("dashboard-canvas")).toBe(measuredCanvas);
    expect(measuredCanvas.isConnected).toBe(true);
    expect(screen.queryByRole("article", { name: "Requests" })).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Errors" })).toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(container.querySelector("[data-chart-cursor-time]")).toBeNull();

    const nextChart = screen.getByRole("img", { name: "Errors" });
    act(() => nextChart.focus());
    fireEvent.keyDown(nextChart, { key: "Enter" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Pinned");
    expect(container.querySelector('[data-chart-cursor-source="errors"]')).not.toBeNull();
  });

  it.each([
    "Saved query “missing” is unavailable. Choose a saved query or switch to a custom query.",
    "Saved query “Trace query” does not provide metrics. Choose a compatible query.",
  ])(
    "shows the authoritative saved-query failure instead of its dormant provider error: %s",
    (error) => {
      query.data = {};
      query.error = error;
      render(
        <Canvas
          current={{
            ...widget,
            type: "stat",
            providerId: "prom",
            queryRef: { id: "missing" },
          }}
        />,
      );
      expect(screen.getByRole("alert")).toHaveTextContent(error);
      expect(
        screen.queryByText(/Provider.*not configured/),
      ).not.toBeInTheDocument();
    },
  );
  it("retains an actionable provider error for a custom query whose provider is missing", () => {
    query.data = {};
    render(<Canvas current={{ ...widget, providerId: "missing-provider" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Provider “missing-provider” is not configured.",
    );
  });

  it("pauses hidden dashboard queries and removes pinned tooltip portals until the workspace returns", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    query.data = { series: [series("api", 7)] };
    const current: Widget = {
      ...widget,
      type: "heatmap",
      options: { tooltipView: { type: "table", source: { type: "widget" } } },
    };
    const { rerender } = render(<Canvas current={current} />);
    fireEvent.click(screen.getByRole("button", { name: /api:/ }));
    expect(screen.getByRole("tooltip")).toBeVisible();
    expect(query.enabled).toBe(true);
    rerender(<Canvas current={current} active={false} />);
    expect(query.enabled).toBe(false);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    rerender(<Canvas current={current} />);
    expect(query.enabled).toBe(true);
    expect(screen.getByRole("button", { name: /api:/ })).toBeVisible();
  });

  it("does not guess a table series and uses the focused row's labels", () => {
    query.data = { series: [series("api", 7), series("worker", 12)] };
    const navigate = vi.fn();
    render(<Canvas onDrilldown={navigate} />);
    openMenu();
    expect(
      screen.getByRole("menuitem", { name: /Service dashboard/ }),
    ).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    const worker = screen.getByText("worker").closest("tr")!;
    fireEvent.focus(worker);
    openMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Service dashboard/ }),
    );
    expect(navigate).toHaveBeenCalledWith(link, {
      series: "worker",
      labels: { service: "worker" },
      value: 12,
    });
  });
  it("automatically supplies only a single series and keeps missing heatmap values missing", () => {
    const readings = series("api", 7);
    readings.points.push({ timestamp: 2000, value: null as unknown as number });
    query.data = { series: [readings] };
    const navigate = vi.fn();
    const valueLink: Drilldown = {
      ...link,
      bindings: [{ variable: "reading", source: "value" }],
    };
    const { rerender } = render(
      <Canvas
        current={{ ...widget, type: "stat", drilldowns: [valueLink] }}
        onDrilldown={navigate}
      />,
    );
    openMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Service dashboard/ }),
    );
    expect(navigate.mock.calls[0][1]).toMatchObject({
      series: "api",
      value: 7,
    });
    rerender(
      <Canvas
        current={{ ...widget, type: "heatmap", drilldowns: [valueLink] }}
        onDrilldown={navigate}
      />,
    );
    openMenu();
    expect(
      screen.getByRole("menuitem", { name: /Service dashboard/ }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("menuitem", { name: /Service dashboard/ }),
    ).toHaveTextContent("no finite value");
  });
  it("offers an explicit series picker and resolves refreshed values by labels rather than row order", () => {
    query.data = { series: [series("api", 7), series("worker", 12)] };
    const current = { ...widget, type: "stat" as const };
    const navigate = vi.fn();
    const { rerender } = render(
      <Canvas current={current} onDrilldown={navigate} />,
    );
    fireEvent.click(
      screen.getByRole("combobox", { name: "Series for Requests" }),
    );
    fireEvent.click(screen.getByRole("option", { name: /worker/ }));
    query.data = { series: [series("worker", 23), series("api", 8)] };
    rerender(<Canvas current={current} onDrilldown={navigate} />);
    openMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Service dashboard/ }),
    );
    expect(navigate).toHaveBeenLastCalledWith(
      link,
      expect.objectContaining({ series: "worker", value: 23 }),
    );
    rerender(
      <Canvas
        current={{ ...current, query: "another_metric" }}
        onDrilldown={navigate}
      />,
    );
    openMenu();
    expect(
      screen.getByRole("menuitem", { name: /Service dashboard/ }),
    ).toHaveAttribute("aria-disabled", "true");
  });
  it("publishes heatmap cell context even when labels, values, and tooltips are hidden", () => {
    const changed = vi.fn();
    render(
      <WidgetVisualization
        widget={{
          ...widget,
          type: "heatmap",
          options: { showLabels: false, showValues: false, showTooltip: false },
        }}
        result={{ series: [series("api", 0), series("worker", 1)] }}
        onContextChange={changed}
      />,
    );
    fireEvent.focus(screen.getByRole("button", { name: /worker:/ }));
    expect(changed).toHaveBeenLastCalledWith({
      series: "worker",
      labels: { service: "worker" },
      value: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: /api:/ }));
    expect(changed).toHaveBeenLastCalledWith({
      series: "api",
      labels: { service: "api" },
      value: 0,
    });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
  it("passes context events through trusted plugin renderers", () => {
    const changed = vi.fn();
    const context = { series: "custom", labels: { service: "api" }, value: 14 };
    const unregister = registerWidgetPlugin({
      id: "context-test",
      label: "Test",
      description: "Test context",
      dataKind: "metrics",
      render: ({ onContextChange }) => (
        <button onClick={() => onContextChange?.(context)}>
          Choose custom signal
        </button>
      ),
    });
    try {
      render(
        <WidgetVisualization
          widget={{
            ...widget,
            type: "plugin",
            pluginId: "context-test",
            dataKind: "metrics",
          }}
          result={{ series: [series("api", 7)] }}
          onContextChange={changed}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Choose custom signal" }),
      );
      expect(changed).toHaveBeenCalledWith(context);
    } finally {
      unregister();
    }
  });
  it("emits trace identity and duration on a row click", () => {
    const changed = vi.fn();
    render(
      <WidgetVisualization
        widget={{ ...widget, type: "traces" }}
        result={{
          traces: [
            {
              traceId: "trace-1",
              service: "api",
              operation: "GET /orders",
              durationMs: 18,
              startTime: 1000,
              status: "ok",
            },
          ],
        }}
        onContextChange={changed}
      />,
    );
    fireEvent.click(within(screen.getByRole("table")).getByText("GET /orders"));
    expect(changed).toHaveBeenCalledWith({
      series: "api · GET /orders",
      labels: {
        service: "api",
        operation: "GET /orders",
        status: "ok",
        traceId: "trace-1",
      },
      value: 18,
    });
  });
  it("honors a plugin's explicit context ahead of the automatic single-series fallback", () => {
    query.data = { series: [series("api", 7)] };
    const navigate = vi.fn();
    const custom = {
      series: "derived",
      labels: { service: "derived-api" },
      value: 14,
    };
    const unregister = registerWidgetPlugin({
      id: "derived-context-test",
      label: "Derived test",
      description: "A derived signal",
      dataKind: "metrics",
      render: ({ onContextChange }) => (
        <button onClick={() => onContextChange?.(custom)}>
          Choose derived signal
        </button>
      ),
    });
    try {
      render(
        <Canvas
          current={{
            ...widget,
            type: "plugin",
            pluginId: "derived-context-test",
            dataKind: "metrics",
          }}
          onDrilldown={navigate}
        />,
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Choose derived signal" }),
      );
      openMenu();
      fireEvent.click(
        screen.getByRole("menuitem", { name: /Service dashboard/ }),
      );
      expect(navigate).toHaveBeenCalledWith(link, custom);
    } finally {
      unregister();
    }
  });
  it("keeps canonical label identity and the same displayed series name", () => {
    const entry = {
      name: "",
      labels: { __name__: "up", service: "api" },
      points: [
        { timestamp: 1000, value: 0 },
        { timestamp: 2000, value: 1 },
      ],
    };
    expect(metricContext(entry, 0)).toEqual({
      series: "__name__=up, service=api",
      labels: entry.labels,
      value: 1,
    });
    expect(contextKey({ labels: { b: "2", a: "1" }, series: "api" })).toBe(
      contextKey({ labels: { a: "1", b: "2" }, series: "api" }),
    );
  });

  it("keeps a plugin's derived and missing observations authoritative even when raw labels and names match", () => {
    query.data = { series: [series("api", 7)] };
    const navigate = vi.fn();
    const valueLink: Drilldown = {
      ...link,
      bindings: [{ variable: "reading", source: "value" }],
    };
    const current: Widget = {
      ...widget,
      type: "plugin",
      pluginId: "matching-context-test",
      dataKind: "metrics",
      drilldowns: [valueLink],
    };
    const unregister = registerWidgetPlugin({
      id: "matching-context-test",
      label: "Matching context",
      description: "Derived same-series observations",
      dataKind: "metrics",
      render: ({ onContextChange }) => (
        <>
          <button
            onClick={() =>
              onContextChange?.({
                series: "api",
                labels: { service: "api" },
                value: 14,
              })
            }
          >
            Choose derived reading
          </button>
          <button
            onClick={() =>
              onContextChange?.({
                series: "api",
                labels: { service: "api" },
                value: null,
              })
            }
          >
            Choose unknown reading
          </button>
        </>
      ),
    });
    try {
      const { rerender } = render(
        <Canvas current={current} onDrilldown={navigate} />,
      );
      openMenu();
      expect(
        screen.getByRole("menuitem", { name: /Service dashboard/ }),
      ).toHaveAttribute("aria-disabled", "true");
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      fireEvent.click(
        screen.getByRole("button", { name: "Choose derived reading" }),
      );
      openMenu();
      fireEvent.click(
        screen.getByRole("menuitem", { name: /Service dashboard/ }),
      );
      expect(navigate).toHaveBeenLastCalledWith(valueLink, {
        series: "api",
        labels: { service: "api" },
        value: 14,
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Choose unknown reading" }),
      );
      openMenu();
      expect(
        screen.getByRole("menuitem", { name: /Service dashboard/ }),
      ).toHaveAttribute("aria-disabled", "true");
      expect(
        screen.getByRole("menuitem", { name: /Service dashboard/ }),
      ).toHaveTextContent("no finite value");
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      fireEvent.click(
        screen.getByRole("button", { name: "Choose derived reading" }),
      );
      query.data = { series: [series("api", 9)] };
      rerender(<Canvas current={current} onDrilldown={navigate} />);
      openMenu();
      expect(
        screen.getByRole("menuitem", { name: /Service dashboard/ }),
      ).toHaveAttribute("aria-disabled", "true");
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      fireEvent.click(
        screen.getByRole("button", { name: "Choose derived reading" }),
      );
      rerender(
        <Canvas
          current={{ ...current, config: { multiplier: 3 } }}
          onDrilldown={navigate}
        />,
      );
      openMenu();
      expect(
        screen.getByRole("menuitem", { name: /Service dashboard/ }),
      ).toHaveAttribute("aria-disabled", "true");
    } finally {
      unregister();
    }
  });
});

it("adapts custom-dark widget headings and descriptions while retaining explicit text choices", () => {
  query.data = { series: [series("api", 7)] };
  const dark = {
    ...widget,
    description: "Traffic volume",
    options: { background: "#111111" },
  };
  const { rerender } = render(<Canvas current={dark} />);
  expect(screen.getByRole("article", { name: "Requests" })).toHaveStyle({
    color: "#ffffff",
  });
  expect(screen.getByRole("heading", { name: "Requests" })).toHaveStyle({
    color: "#ffffff",
  });
  expect(screen.getByText("Traffic volume")).toHaveStyle({ color: "#ffffff" });
  rerender(
    <Canvas
      current={{ ...dark, options: { ...dark.options, textColor: "#ffcc88" } }}
    />,
  );
  expect(screen.getByRole("heading", { name: "Requests" })).toHaveStyle({
    color: "#ffcc88",
  });
});

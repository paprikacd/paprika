import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetVisualization } from "./charts";
import {
  MAX_TOOLTIP_POINTS,
  TooltipSubWidget,
  buildTooltipContext,
  getTooltipRenderer,
  getTooltipRenderers,
  registerTooltipRenderer,
  type TooltipRendererContext,
} from "./tooltip-widgets";
import type { Series } from "./chart-data";
import type { TooltipView, Widget, Provider, QueryResult } from "./schema";
import { TooltipQueryProvider } from "./tooltip-query";
import {
  registerWidgetPlugin,
  type WidgetRendererProps,
} from "./widget-registry";
import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge";

const disposers: Array<() => void> = [];
afterEach(() => {
  cleanup();
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const view: TooltipView = { type: "timeseries" };
const series: Series = {
  name: "api",
  labels: { service: "api", region: "west" },
  points: [
    { timestamp: 1000, value: -3.123456789 },
    { timestamp: 2000, value: null },
    { timestamp: 3000, value: 0 },
    { timestamp: 4000, value: null },
  ],
};
const widget: Widget = {
  id: "health",
  title: "Health",
  type: "heatmap",
  providerId: "prom",
  query: "up",
  unit: "req/s",
  layout: { x: 0, y: 0, w: 6, h: 4 },
  options: { tooltipView: view },
};

describe("bounded tooltip rendering", () => {
  it("reuses the full parent widget result without requests, preserves legacy hovered-series behavior and updates with the parent", async () => {
    const fetcher = vi.fn();
    const other: Series = {
      name: "worker",
      labels: { service: "worker" },
      points: [{ timestamp: 4000, value: 99 }],
    };
    const result = { series: [series, other] };
    const host = (data: QueryResult, reuse = true) => (
      <TooltipQueryProvider
        fetcher={fetcher}
        providers={[]}
        start={1}
        end={10}
        step={1}
      >
        <WidgetVisualization
          widget={{
            ...widget,
            options: {
              tooltipView: {
                type: "table",
                ...(reuse ? { source: { type: "widget" as const } } : {}),
              },
            },
          }}
          result={data}
        />
      </TooltipQueryProvider>
    );
    const { rerender } = render(host(result));
    fireEvent.focus(screen.getByRole("button", { name: /api.*No data/ }));
    let child = within(screen.getByRole("tooltip")).getByRole("table");
    expect(within(child).getByText("worker")).toBeVisible();
    expect(within(child).getAllByText("99 req/s")[0]).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
    expect(Object.isFrozen(result.series)).toBe(false);
    expect(Object.isFrozen(other.points[0])).toBe(false);
    rerender(
      host({
        series: [
          series,
          { ...other, points: [{ timestamp: 5000, value: 101 }] },
        ],
      }),
    );
    fireEvent.focus(screen.getByRole("button", { name: /api.*No data/ }));
    child = within(screen.getByRole("tooltip")).getByRole("table");
    expect(within(child).getAllByText("101 req/s")[0]).toBeVisible();
    expect(within(child).queryAllByText("99 req/s")).toHaveLength(0);
    rerender(host(result, false));
    fireEvent.focus(screen.getByRole("button", { name: /api.*No data/ }));
    child = within(screen.getByRole("tooltip")).getByRole("table");
    expect(within(child).queryByText("worker")).not.toBeInTheDocument();
    await act(async () => {});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves the complete sample range, exact summary, latest null and immutable isolated data", () => {
    const samples = Array.from({ length: 10000 }, (_, timestamp) => ({
      timestamp,
      value:
        timestamp % 97 === 0
          ? null
          : timestamp === 5245
            ? -10000
            : timestamp === 8301
              ? 9000
              : timestamp % 10,
    }));
    samples[0] = { timestamp: 0, value: 0 };
    samples[samples.length - 1] = { timestamp: 9999, value: null };
    const original = structuredClone(samples);
    const context = buildTooltipContext(
      { ...series, points: [...samples, { timestamp: 1e100, value: 99999 }] },
      view,
      "ms",
    );
    expect(context.points.length).toBeLessThanOrEqual(MAX_TOOLTIP_POINTS);
    expect(context.points[0]).toEqual(samples[0]);
    expect(context.points.at(-1)).toEqual(samples.at(-1));
    expect(context.summary).toMatchObject({
      sampleCount: 10000,
      start: 0,
      end: 9999,
      min: -10000,
      max: 9000,
      latest: { timestamp: 9999, value: null },
    });
    expect(context.points).toContainEqual({ timestamp: 5245, value: -10000 });
    expect(context.points).toContainEqual({ timestamp: 8301, value: 9000 });
    context.points.forEach((point, index) => {
      if (
        !index ||
        point.value === null ||
        context.points[index - 1].value === null
      )
        return;
      expect(
        samples
          .slice(context.points[index - 1].timestamp + 1, point.timestamp)
          .some((sample) => sample.value === null),
      ).toBe(false);
    });
    expect(samples).toEqual(original);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.points)).toBe(true);
    expect(Object.isFrozen(context.points[0])).toBe(true);
    expect(context.labels).not.toBe(series.labels);
    expect(context).not.toHaveProperty("fetcher");
    expect(context).not.toHaveProperty("onContextChange");
  });

  it("renders a static accessible chart with visible isolated zero/negative observations and full-opacity labels", () => {
    const { container } = render(
      <TooltipSubWidget view={view} series={series} unit="req/s" />,
    );
    const chart = screen.getByRole("img", { name: "api time series" });
    expect(chart).toHaveAttribute("tabindex", "-1");
    expect(chart).toHaveAccessibleDescription(
      /Minimum -3.123456789 req\/s.*Maximum 0 req\/s.*2 missing samples/,
    );
    expect(chart.querySelectorAll("circle").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector("[data-history-min]")).toHaveTextContent(
      "-3.123456789 req/s",
    );
    expect(container.querySelector("[data-history-max]")).toHaveTextContent(
      "0 req/s",
    );
    expect(container.querySelector("time")).toHaveAttribute(
      "datetime",
      "1970-01-01T00:00:01.000Z",
    );
    expect(container.querySelectorAll("time")[1]).toHaveAttribute(
      "datetime",
      "1970-01-01T00:00:04.000Z",
    );
    for (const label of chart.querySelectorAll("text")) {
      expect(label).toHaveAttribute("opacity", "1");
      expect(label).not.toHaveAttribute("fill-opacity");
    }
    fireEvent.pointerMove(chart, { clientX: 100, clientY: 30 });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("supports all permitted sizes and axis/grid switches, singleton and all-null states", () => {
    const { container, rerender } = render(
      <TooltipSubWidget
        view={{ ...view, height: 120, showAxis: false, showGrid: false }}
        series={{ ...series, points: [{ timestamp: 1000, value: 0 }] }}
        unit="%"
      />,
    );
    let chart = screen.getByRole("img");
    expect(chart.getAttribute("viewBox")?.split(" ")[3]).toBe("120");
    expect(chart.querySelectorAll("text")).toHaveLength(0);
    expect(chart.querySelectorAll("circle").length).toBeGreaterThanOrEqual(1);
    expect(chart.querySelectorAll("[stroke-dasharray]")).toHaveLength(0);
    rerender(
      <TooltipSubWidget
        view={{ ...view, height: 200 }}
        series={series}
        unit="%"
      />,
    );
    chart = screen.getByRole("img");
    expect(chart.getAttribute("viewBox")?.split(" ")[3]).toBe("200");
    expect(chart.querySelectorAll("text").length).toBeGreaterThan(0);
    expect(chart.querySelectorAll("[stroke-dasharray]").length).toBeGreaterThan(
      0,
    );
    rerender(
      <TooltipSubWidget
        view={view}
        series={{
          ...series,
          points: [
            { timestamp: 1000, value: null },
            { timestamp: 2000, value: NaN },
          ],
        }}
        unit="%"
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(
      screen.getByText("No finite observations in this time range."),
    ).toBeInTheDocument();
    expect(container.textContent).toContain("2 missing samples");
    expect(container.querySelector("[data-history-min]")).toBeNull();
  });

  it("registers trusted late renderers with stable snapshots, bounds their input and isolates failures", () => {
    const before = getTooltipRenderers();
    expect(getTooltipRenderers()).toBe(before);
    const custom = { type: "test-tooltip" } as unknown as TooltipView;
    const { rerender } = render(
      <TooltipSubWidget view={custom} series={series} unit="ms" />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("unavailable");
    let received: TooltipRendererContext | undefined;
    let dispose: () => void;
    act(() => {
      dispose = registerTooltipRenderer({
        id: "test-tooltip",
        label: "Test",
        render: ({ context }) => {
          received = context;
          return <p>Trusted: {context.name}</p>;
        },
      });
      disposers.push(dispose);
    });
    expect(screen.getByText("Trusted: api")).toBeInTheDocument();
    expect(received?.height).toBe(160);
    expect(getTooltipRenderer("test-tooltip")?.label).toBe("Test");
    expect(getTooltipRenderers()).not.toBe(before);
    expect(() =>
      registerTooltipRenderer({
        id: "timeseries",
        label: "Duplicate",
        render: () => null,
      }),
    ).toThrow("already registered");
    expect(() =>
      registerTooltipRenderer({
        id: "../unsafe",
        label: "Unsafe",
        render: () => null,
      }),
    ).toThrow("identifiers");
    act(() => dispose!());
    expect(screen.getByRole("status")).toHaveTextContent("unavailable");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    disposers.push(
      registerTooltipRenderer({
        id: "broken-tooltip",
        label: "Broken",
        render: () => {
          throw new Error("broken");
        },
      }),
    );
    rerender(
      <TooltipSubWidget
        view={{ type: "broken-tooltip" } as unknown as TooltipView}
        series={series}
        unit="ms"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Observation details are still shown",
    );
    rerender(<TooltipSubWidget view={view} series={series} unit="ms" />);
    expect(screen.getByRole("img")).toBeInTheDocument();
  });

  it("prevents recursive sub-widgets while leaving the parent observation available", () => {
    disposers.push(
      registerTooltipRenderer({
        id: "recursive-tooltip",
        label: "Recursive",
        render: () => (
          <TooltipSubWidget view={view} series={series} unit="ms" />
        ),
      }),
    );
    render(
      <TooltipSubWidget
        view={{ type: "recursive-tooltip" } as unknown as TooltipView}
        series={series}
        unit="ms"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("unavailable");
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("heatmap tooltip sub-widget integration", () => {
  it("shows only hovered-series history while retaining latest-null details, hover persistence, focus and pinning", () => {
    vi.useFakeTimers();
    const selected = vi.fn();
    render(
      <WidgetVisualization
        widget={widget}
        result={{
          series: [
            series,
            {
              name: "worker",
              labels: { service: "worker" },
              points: [{ timestamp: 1000, value: 77 }],
            },
          ],
        }}
        onContextChange={selected}
      />,
    );
    const cell = screen.getByRole("button", { name: /^api: No data/ });
    fireEvent.pointerEnter(cell, { pointerType: "mouse" });
    let tip = screen.getByRole("tooltip");
    expect(
      within(tip).getByRole("img", { name: "api time series" }),
    ).toBeInTheDocument();
    expect(
      tip.querySelector('[data-metric-value="missing"]'),
    ).toHaveTextContent("No data");
    expect(tip.querySelector("[data-history-max]")).toHaveTextContent(
      "0 req/s",
    );
    expect(tip).not.toHaveTextContent("77 req/s");
    const parentTimestamp = within(tip)
      .getByText("Latest sample", { exact: true })
      .parentElement!.querySelector("time")!;
    const childWidget = tip.querySelector(
      '[data-tooltip-widget="timeseries"]',
    )!;
    const interactionHint = within(tip).getByText("Click or tap to keep open");
    expect(
      parentTimestamp.compareDocumentPosition(childWidget) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      childWidget.compareDocumentPosition(interactionHint) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(selected).not.toHaveBeenCalled();
    fireEvent.pointerLeave(cell);
    fireEvent.pointerEnter(tip);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole("tooltip")).toBe(tip);
    fireEvent.click(cell);
    expect(cell).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(cell, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(cell);
    tip = screen.getByRole("tooltip");
    expect(within(tip).getByRole("img")).toBeInTheDocument();
    expect(selected).toHaveBeenLastCalledWith({
      series: "api",
      labels: series.labels,
      value: null,
    });
    fireEvent.click(cell);
    fireEvent.click(cell);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerEnter(screen.getByRole("button", { name: /^worker:/ }), {
      pointerType: "mouse",
    });
    expect(
      screen.getByRole("img", { name: "worker time series" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "api time series" })).toBeNull();
  });

  it("keeps existing details as the default, suppresses all content when disabled, and follows refreshed history", () => {
    const result = { series: [series] };
    const { rerender } = render(
      <WidgetVisualization
        widget={{ ...widget, options: {} }}
        result={result}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^api:/ }));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
    rerender(<WidgetVisualization widget={widget} result={result} />);
    expect(
      screen.getByRole("img", { name: "api time series" }),
    ).toBeInTheDocument();
    rerender(
      <WidgetVisualization
        widget={widget}
        result={{
          series: [{ ...series, points: [{ timestamp: 5000, value: 999 }] }],
        }}
      />,
    );
    expect(
      screen.getByRole("tooltip").querySelector("[data-history-max]"),
    ).toHaveTextContent("999 req/s");
    rerender(
      <WidgetVisualization
        widget={{
          ...widget,
          options: { ...widget.options, showTooltip: false },
        }}
        result={result}
      />,
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^api:/ }));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("shared embedded tooltip renderers", () => {
  const providers: Provider[] = [
    {
      id: "prom",
      name: "Metrics",
      type: "prometheus",
      capabilities: ["metrics"],
    },
    { id: "tempo", name: "Traces", type: "tempo", capabilities: ["traces"] },
  ];
  const finite = {
    ...series,
    points: [
      { timestamp: 1000, value: 0 },
      { timestamp: 2000, value: -12.3456 },
    ],
  };
  const queryView = (type: TooltipView["type"]): TooltipView => ({
    type,
    source: {
      type: "query",
      providerId: type === "traces" ? "tempo" : "prom",
      query: "value{service={{service}}}",
      bindings: [{ variable: "service", label: "service" }],
    },
    ...(type === "plugin"
      ? { pluginId: "threshold-gauge", dataKind: "metrics" as const }
      : {}),
  });
  function Host({
    view,
    result = { series: [finite] },
  }: {
    view: TooltipView;
    result?: QueryResult;
  }) {
    return (
      <TooltipQueryProvider
        fetcher={async () => result}
        providers={providers}
        start={1000}
        end={2000}
        step={15}
      >
        <TooltipSubWidget
          view={view}
          series={finite}
          unit="req/s"
          color="#336699"
        />
      </TooltipQueryProvider>
    );
  }
  it.each(["timeseries", "bar", "stat", "table", "heatmap", "plugin"] as const)(
    "embeds %s without nested inspector, tooltip, selection or editing controls",
    (type) => {
      registerDefaultWidgetPlugins();
      const { container } = render(
        <TooltipSubWidget
          view={{
            type,
            height: 320,
            showAxis: false,
            showGrid: false,
            showLegend: false,
            decimals: 3,
            unit: "ms",
            title: "Child details",
            ...(type === "plugin"
              ? { pluginId: "threshold-gauge", dataKind: "metrics" }
              : {}),
          }}
          series={finite}
          unit="req/s"
        />,
      );
      expect(
        screen.getByRole("region", { name: "Child details" }),
      ).toHaveAttribute("data-tooltip-widget", type);
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByRole("tooltip")).toBeNull();
      if (type === "timeseries" || type === "bar") {
        const svg = container.querySelector("svg")!;
        expect(svg).toHaveAttribute("tabindex", "-1");
        expect(svg.querySelectorAll("text")).toHaveLength(0);
        expect(svg.querySelectorAll("line[stroke-dasharray]")).toHaveLength(0);
      }
      if (type === "stat")
        expect(
          container.querySelector('[data-metric-value="-12.3456"]'),
        ).toHaveTextContent("-12.346ms");
      if (type === "plugin")
        expect(screen.getByRole("meter")).toHaveAttribute(
          "aria-valuetext",
          "-12.3456 ms",
        );
    },
  );
  it.each([
    "timeseries",
    "bar",
    "stat",
    "table",
    "traces",
    "heatmap",
    "plugin",
  ] as const)(
    "renders queried %s data and compatible controls using the shared renderer",
    async (type) => {
      registerDefaultWidgetPlugins();
      const result: QueryResult =
        type === "traces"
          ? {
              traces: [
                {
                  traceId: "trace-1",
                  service: "worker",
                  operation: "Process payment",
                  durationMs: 123.456,
                  startTime: 2000,
                  status: "ok",
                },
              ],
            }
          : {
              series: [
                finite,
                {
                  name: "worker",
                  labels: { service: "worker" },
                  points: [{ timestamp: 1000, value: 222 }],
                },
              ],
            };
      const { container } = render(
        <Host
          view={{
            ...queryView(type),
            showAxis: false,
            showGrid: false,
            showLegend: false,
            title: "Queried data",
          }}
          result={result}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByRole("region", { name: "Queried data" }),
        ).toHaveAttribute("aria-busy", "false"),
      );
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.queryByRole("tooltip")).toBeNull();
      if (type === "traces")
        expect(
          screen.getByRole("table", { name: "Queried data" }),
        ).toHaveTextContent("Process payment");
      if (type === "table")
        expect(
          screen.getByRole("table", { name: "Queried data" }),
        ).toHaveTextContent("worker");
      if (type === "timeseries" || type === "bar")
        expect(
          container.querySelector("svg")?.querySelectorAll("text"),
        ).toHaveLength(0);
    },
  );
  it.each(["timeseries", "bar"] as const)(
    "describes exact queried %s observations, units, labels and latest null when axes and legends are hidden",
    async (type) => {
      const result = {
        series: [
          {
            ...finite,
            points: [...finite.points, { timestamp: 3000, value: null }],
          },
          {
            name: "worker",
            labels: { service: "worker" },
            points: [{ timestamp: 3000, value: 0 }],
          },
        ],
      };
      render(
        <Host
          view={{
            ...queryView(type),
            showAxis: false,
            showLegend: false,
            unit: "ms",
          }}
          result={result}
        />,
      );
      const chart = await screen.findByRole("img");
      expect(chart).toHaveAccessibleDescription(
        /api \(service: api, region: west\)\. Latest sample: No data at 1970-01-01T00:00:03.000Z/,
      );
      expect(chart).toHaveAccessibleDescription(
        /worker \(service: worker\)\. Latest sample: 0 ms at 1970-01-01T00:00:03.000Z/,
      );
      if (type === "bar")
        expect(chart).toHaveAccessibleDescription(
          /Latest valid sample used by bar: -12.3456 ms at 1970-01-01T00:00:02.000Z/,
        );
      expect(chart.querySelectorAll("text")).toHaveLength(0);
      expect(screen.queryByRole("button")).toBeNull();
    },
  );
  it("preserves latest finite and latest-null semantics after bounding, without freezing source data", () => {
    const points = Array.from({ length: 10000 }, (_, timestamp) => ({
      timestamp,
      value:
        timestamp > 9000 ? null : timestamp === 9000 ? 3.14159 : timestamp % 10,
    }));
    const sourceResult = { series: [{ ...series, points }] };
    const context = buildTooltipContext(
      series,
      { type: "stat" },
      "ms",
      undefined,
      sourceResult,
    );
    expect(context.points.length).toBeLessThanOrEqual(MAX_TOOLTIP_POINTS);
    expect(context.points).toContainEqual({ timestamp: 9000, value: 3.14159 });
    expect(context.points.at(-1)).toEqual({ timestamp: 9999, value: null });
    expect(Object.isFrozen(sourceResult)).toBe(false);
    expect(Object.isFrozen(points)).toBe(false);
    expect(Object.isFrozen(points[0])).toBe(false);
    expect(Object.isFrozen(points[9000])).toBe(false);
    const { container, rerender } = render(
      <TooltipSubWidget
        view={{ type: "stat" }}
        series={sourceResult.series[0]}
        unit="ms"
      />,
    );
    expect(
      container.querySelector('[data-metric-value="3.14159"]'),
    ).toBeInTheDocument();
    registerDefaultWidgetPlugins();
    rerender(
      <TooltipSubWidget
        view={{
          type: "plugin",
          pluginId: "threshold-gauge",
          dataKind: "metrics",
        }}
        series={sourceResult.series[0]}
        unit="ms"
      />,
    );
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByText("No data")).toBeInTheDocument();
  });
  it("passes a bounded frozen result and sanitized config to trusted plugins with embedded mode and no selection callback", async () => {
    let received: WidgetRendererProps | undefined;
    disposers.push(
      registerWidgetPlugin({
        id: "tooltip-probe",
        label: "Probe",
        description: "Test",
        dataKind: "metrics",
        render: (props) => {
          received = props;
          return <p>Plugin output</p>;
        },
      }),
    );
    const config = { label: "Safe label" };
    const result = {
      series: Array.from({ length: 15 }, (_, index) => ({
        ...finite,
        name: `service-${index}`,
      })),
    };
    render(
      <Host
        view={{ ...queryView("plugin"), pluginId: "tooltip-probe", config }}
        result={result}
      />,
    );
    await screen.findByText("Plugin output");
    expect(received?.embedded).toBe(true);
    expect(received?.onContextChange).toBeUndefined();
    expect(received?.result.series).toHaveLength(12);
    expect(Object.isFrozen(received?.result)).toBe(true);
    expect(received?.widget).not.toHaveProperty("drilldowns");
    expect(received?.widget.options?.showTooltip).toBe(false);
    expect(received?.widget.options).not.toHaveProperty("tooltipView");
    expect(received?.widget.query).toBe("tooltip-data");
    expect(received?.widget.providerId).toBe("tooltip-data");
    expect(Object.isFrozen(config)).toBe(false);
    expect(screen.getByText(/Showing 12 of 15 series/)).toBeInTheDocument();
  });
  it("bounds trace results independently and reports truncation without freezing the provider response", async () => {
    const traces = Array.from({ length: 103 }, (_, index) => ({
      traceId: `trace-${index}`,
      service: "api",
      operation: `Operation ${index}`,
      durationMs: index,
      startTime: index * 1000,
      status: "ok",
    }));
    const result = { traces, truncated: true };
    const context = buildTooltipContext(
      series,
      queryView("traces"),
      "",
      undefined,
      result,
    );
    expect(context.result.traces).toHaveLength(100);
    expect(context.totalTraces).toBe(103);
    expect(Object.isFrozen(context.result.traces?.[0])).toBe(true);
    expect(Object.isFrozen(traces[0])).toBe(false);
    render(<Host view={queryView("traces")} result={result} />);
    await screen.findByText(/Showing 100 of 103 traces/);
    expect(
      screen.getByText(/Provider result limit reached/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Operation 102")).toBeNull();
  });
  it("retains parent details while retrying a provider failure and never offers retry for missing bindings", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("Upstream unavailable"))
      .mockResolvedValue({ series: [finite] });
    const child = { ...queryView("stat"), title: "Query result" };
    const { rerender } = render(
      <TooltipQueryProvider
        fetcher={fetcher}
        providers={providers}
        start={1000}
        end={2000}
        step={15}
      >
        <WidgetVisualization
          widget={{ ...widget, options: { tooltipView: child } }}
          result={{ series: [finite] }}
        />
      </TooltipQueryProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^api:/ }));
    const tip = screen.getByRole("tooltip");
    await within(tip).findByText("Upstream unavailable");
    expect(
      tip.querySelector('[data-metric-value="-12.3456"]'),
    ).toBeInTheDocument();
    fireEvent.click(
      within(tip).getByRole("button", { name: "Retry tooltip query" }),
    );
    await waitFor(() => expect(within(tip).queryByRole("alert")).toBeNull());
    await waitFor(() =>
      expect(
        tip.querySelectorAll('[data-metric-value="-12.3456"]'),
      ).toHaveLength(2),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    rerender(
      <TooltipQueryProvider
        fetcher={fetcher}
        providers={providers}
        start={1000}
        end={2000}
        step={15}
      >
        <TooltipSubWidget
          view={child}
          series={{ ...finite, labels: {} }}
          unit="ms"
        />
      </TooltipQueryProvider>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("no label");
    expect(
      screen.queryByRole("button", { name: "Retry tooltip query" }),
    ).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

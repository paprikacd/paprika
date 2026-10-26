import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downsamplePoints,
  formatMetric,
  resolveChartDomain,
  thresholdForValue,
  WidgetVisualization,
} from "./charts";
import type { QueryResult, Widget } from "./schema";
import { contrastRatio } from "./appearance";
import {
  contrastText,
  balancedHeatmapColumns,
  heatmapTooltipSizeLimit,
  placeHeatmapTooltip,
  responsiveChartTicks,
  formatTimeTick,
  latestPoint,
} from "./chart-renderers";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const widget: Widget = {
  id: "latency",
  title: "API latency",
  type: "timeseries",
  providerId: "prometheus",
  query: "latency",
  unit: "ms",
  layout: { x: 0, y: 0, w: 6, h: 4 },
};
const result: QueryResult = {
  series: [
    {
      name: "api",
      labels: { service: "api" },
      points: [
        { timestamp: 1000, value: 5 },
        { timestamp: 2000, value: null },
        { timestamp: 3000, value: 12 },
      ],
    },
  ],
};

describe("bounded chart data", () => {
  it("preserves short spikes, negative troughs, endpoints and input order", () => {
    const points = Array.from({ length: 50_000 }, (_, index) => ({
      timestamp: index,
      value: index === 13_417 ? 10_000 : index === 31_741 ? -10_000 : 8,
    }));
    const snapshot = points.map((point) => ({ ...point }));
    const sampled = downsamplePoints(points, 480);
    expect(sampled.length).toBeLessThanOrEqual(480);
    expect(sampled[0]).toEqual(points[0]);
    expect(sampled.at(-1)).toEqual(points.at(-1));
    expect(sampled).toContainEqual(points[13_417]);
    expect(sampled).toContainEqual(points[31_741]);
    expect(
      sampled.every(
        (point, index) =>
          index === 0 || point.timestamp > sampled[index - 1].timestamp,
      ),
    ).toBe(true);
    expect(points).toEqual(snapshot);
  });

  it("keeps missing samples as gaps instead of connecting across them", () => {
    const points = Array.from({ length: 1000 }, (_, timestamp) => ({
      timestamp,
      value: timestamp === 450 ? null : 8,
    }));
    expect(downsamplePoints(points, 100)).toContainEqual({
      timestamp: 450,
      value: null,
    });
    expect(
      downsamplePoints([
        { timestamp: 0, value: NaN },
        { timestamp: 1, value: Infinity },
        { timestamp: NaN, value: 4 },
      ]),
    ).toEqual([
      { timestamp: 0, value: null },
      { timestamp: 1, value: null },
    ]);
    for (const maximum of [2, 3, 4, 5, 31, 100])
      expect(downsamplePoints(points, maximum).length).toBeLessThanOrEqual(
        maximum,
      );
  });

  it("formats non-finite values honestly and maintains small decimals", () => {
    expect(formatMetric(NaN)).toBe("—");
    expect(formatMetric(12.5, "ms")).toBe("12.5 ms");
    expect(formatMetric(0.0000123, "req/s")).toBe("0.0000123 req/s");
    expect(formatMetric(99.95, "%")).toBe("99.95%");
    expect(formatMetric(12.3, "ms", false, 3)).toBe("12.300 ms");
    expect(formatMetric(0.12, "", false, 0)).toBe("0");
  });

  it("excludes out-of-range dates consistently and labels multiday axes with dates", () => {
    const points = [
      { timestamp: 0, value: -5 },
      { timestamp: 1e100, value: 999 },
      { timestamp: -1e100, value: -999 },
    ];
    expect(downsamplePoints(points)).toEqual([{ timestamp: 0, value: -5 }]);
    const series = { name: "api", labels: {}, points };
    expect(latestPoint(series)).toEqual({ timestamp: 0, value: -5 });
    expect(resolveChartDomain([series], { max: 10 })).toEqual([-5, 10]);
    expect(formatTimeTick(1e100, 100)).toBe("—");
    expect(formatTimeTick(1_700_000_000_000, 7 * 86_400_000)).toMatch(/Nov/);
    expect(formatTimeTick(1_700_000_000_000, 3_600_000)).not.toMatch(/Nov/);
  });

  it("uses inclusive threshold boundaries and respects explicit chart bounds", () => {
    const thresholds = [
      { value: 0, color: "#ff0000" },
      { value: 1, color: "#008800" },
    ];
    expect(thresholdForValue(-1, thresholds)?.color).toBe("#ff0000");
    expect(thresholdForValue(1, thresholds)?.color).toBe("#008800");
    expect(thresholdForValue(NaN, thresholds)).toBeUndefined();
    expect(resolveChartDomain(result.series!, {})).toBeUndefined();
    expect(resolveChartDomain(result.series!, { min: 0, max: 100 })).toEqual([
      0, 100,
    ]);
    expect(resolveChartDomain(result.series!, { max: 20 })).toEqual([5, 20]);
    expect(resolveChartDomain(result.series!, { min: 20 })).toEqual([20, 22]);
  });

  it("reduces axis density for narrow and short plots without removing all ticks", () => {
    expect(responsiveChartTicks(260, 90)).toEqual({ x: 2, y: 2 });
    expect(responsiveChartTicks(500, 180)).toEqual({ x: 5, y: 3 });
    expect(responsiveChartTicks(1200, 500)).toEqual({ x: 6, y: 4 });
  });

  it("balances heatmap rows across desktop, tablet and mobile widths", () => {
    expect(balancedHeatmapColumns(6, 1200)).toBe(6);
    expect(balancedHeatmapColumns(6, 724)).toBe(3);
    expect(balancedHeatmapColumns(6, 300)).toBe(2);
    expect(balancedHeatmapColumns(6, 180)).toBe(1);
    expect(balancedHeatmapColumns(6, 320, false)).toBe(6);
    expect(balancedHeatmapColumns(7, 724)).toBe(4);
    expect(balancedHeatmapColumns(100, 724)).toBe(5);
    expect(balancedHeatmapColumns(0, 0)).toBe(1);
  });

  it("flips and clamps heatmap tooltips inside narrow and offset visual viewports", () => {
    const size = { width: 296, height: 400 };
    const position = placeHeatmapTooltip(
      { left: 270, right: 310, top: 650, bottom: 700 },
      size,
      {
        width: 320,
        height: 720,
      },
    );
    expect(position).toEqual({ left: 12, top: 240, placement: "top" });
    const shifted = placeHeatmapTooltip(
      { left: 0, right: 50, top: 0, bottom: 50 },
      { width: 200, height: 300 },
      { width: 320, height: 500, left: 50, top: 100 },
    );
    expect(shifted.left).toBeGreaterThanOrEqual(62);
    expect(shifted.top).toBeGreaterThanOrEqual(112);
    expect(shifted.left + 200).toBeLessThanOrEqual(358);
    expect(shifted.top + 300).toBeLessThanOrEqual(588);
    const anchor = { left: 12, right: 308, top: 160, bottom: 320 };
    const limits = heatmapTooltipSizeLimit(anchor, { width: 320, height: 720 });
    expect(limits).toEqual({ width: 296, height: 378 });
    const fitted = placeHeatmapTooltip(anchor, limits, {
      width: 320,
      height: 720,
    });
    expect(fitted.top).toBeGreaterThan(anchor.bottom);
    expect(fitted.top + limits.height).toBeLessThanOrEqual(708);
  });
});

describe("widget visualizations", () => {
  it("renders a real TanStack chart with an accessible name", () => {
    const { container } = render(
      <WidgetVisualization widget={widget} result={result} />,
    );
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(screen.getByLabelText("API latency")).toBeInTheDocument();
    expect(screen.getByText("api")).toBeInTheDocument();
  });

  it("uses the most recent valid sample even when samples arrive out of order", () => {
    render(
      <WidgetVisualization
        widget={{ ...widget, type: "stat" }}
        result={{
          series: [
            {
              name: "api",
              labels: {},
              points: [
                { timestamp: 3000, value: 14 },
                { timestamp: 4000, value: null },
                { timestamp: 1000, value: 5 },
              ],
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("14")).toBeInTheDocument();
    expect(screen.getByText("ms")).toBeInTheDocument();
  });

  it("renders comparable latest/min/max values from the complete series", () => {
    render(
      <WidgetVisualization
        widget={{ ...widget, type: "table" }}
        result={result}
      />,
    );
    const row = screen.getByRole("row", { name: "api 12 ms 5 ms 12 ms" });
    expect(within(row).getAllByText("12 ms")).toHaveLength(2);
  });

  it("retains all-null table identities and ignores invalid-date values when calculating ranges", () => {
    const { rerender } = render(
      <WidgetVisualization
        widget={{ ...widget, type: "table" }}
        result={{
          series: [
            {
              name: "missing",
              labels: {},
              points: [{ timestamp: 1, value: null }],
            },
          ],
        }}
      />,
    );
    expect(
      screen.getByRole("row", { name: "missing — — —" }),
    ).toBeInTheDocument();
    rerender(
      <WidgetVisualization
        widget={{ ...widget, type: "table" }}
        result={{
          series: [
            {
              name: "api",
              labels: {},
              points: [
                { timestamp: 0, value: -5 },
                { timestamp: 2, value: 0 },
                { timestamp: 1e100, value: 1000 },
              ],
            },
          ],
        }}
      />,
    );
    expect(
      screen.getByRole("row", { name: "api 0 ms -5 ms 0 ms" }),
    ).toBeInTheDocument();
  });

  it.each(["timeseries", "bar"] as const)(
    "keeps %s truncation notices visible without a legend",
    (type) => {
      render(
        <WidgetVisualization
          widget={{ ...widget, type, options: { showLegend: false } }}
          result={{
            series: Array.from({ length: 13 }, (_, index) => ({
              name: `service-${index}`,
              labels: {},
              points: [{ timestamp: 1000, value: index }],
            })),
          }}
        />,
      );
      expect(screen.getByRole("status")).toHaveTextContent(
        "First 12 of 13 series",
      );
    },
  );

  it("does not silently retarget a pinned heatmap tooltip after a series reorder", () => {
    const api = {
      name: "api",
      labels: { service: "api" },
      points: [{ timestamp: 1000, value: 0 }],
    };
    const worker = {
      name: "worker",
      labels: { service: "worker" },
      points: [{ timestamp: 1000, value: 1 }],
    };
    const current: Widget = { ...widget, type: "heatmap" };
    const { rerender } = render(
      <WidgetVisualization
        widget={current}
        result={{ series: [api, worker] }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^api:/ }));
    expect(
      within(screen.getByRole("tooltip")).getByText("api", {
        selector: "strong",
      }),
    ).toBeInTheDocument();
    rerender(
      <WidgetVisualization
        widget={current}
        result={{ series: [worker, api] }}
      />,
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^worker:/ }));
    expect(
      within(screen.getByRole("tooltip")).getByText("worker", {
        selector: "strong",
      }),
    ).toBeInTheDocument();
  });

  it("preserves zero trace duration and full timestamp semantics without crashing on invalid dates", () => {
    const { container } = render(
      <WidgetVisualization
        widget={{ ...widget, type: "traces" }}
        result={{
          traces: [
            {
              traceId: "zero",
              service: "api",
              operation: "zero duration",
              durationMs: 0,
              startTime: 0,
              status: "ok",
            },
            {
              traceId: "invalid",
              service: "api",
              operation: "bad timestamp",
              durationMs: 1,
              startTime: 1e100,
              status: "unknown",
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("0 ms")).toBeInTheDocument();
    expect(container.querySelector("time")).toHaveAttribute(
      "datetime",
      "1970-01-01T00:00:00.000Z",
    );
    expect(
      screen.getByRole("row", { name: /bad timestamp/ }),
    ).toHaveTextContent("—");
    expect(container.querySelector('[style="width: 0%;"]')).toBeInTheDocument();
  });

  it("displays trace identity, service, operation, duration and actual status", () => {
    render(
      <WidgetVisualization
        widget={{ ...widget, type: "traces" }}
        result={{
          traces: [
            {
              traceId: "abc123",
              service: "checkout",
              operation: "POST /orders",
              durationMs: 132.5,
              startTime: 1000,
              status: "error",
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("checkout")).toBeInTheDocument();
    expect(screen.getByText("POST /orders")).toBeInTheDocument();
    expect(screen.getByText("132.5 ms")).toBeInTheDocument();
    expect(screen.getByText("error")).toBeInTheDocument();
  });

  it("distinguishes loading, empty and failed queries", () => {
    const { rerender } = render(
      <WidgetVisualization widget={widget} loading />,
    );
    expect(screen.getByRole("status")).toHaveAccessibleName("Loading widget");
    rerender(<WidgetVisualization widget={widget} result={{ series: [] }} />);
    expect(screen.getByText("No data in this time range")).toBeInTheDocument();
    rerender(
      <WidgetVisualization widget={widget} error="Provider timed out" />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Provider timed out");
  });

  it("renders configured chart labels, decimals and area while allowing the legend to be hidden", () => {
    const { container } = render(
      <WidgetVisualization
        widget={{
          ...widget,
          options: {
            display: "area",
            xAxisLabel: "Time",
            yAxisLabel: "Response time",
            decimals: 2,
            min: 0,
            max: 100,
            lineWidth: 3,
            fillOpacity: 0.3,
            curve: "step",
            showLegend: false,
            showGrid: false,
            showTooltip: false,
          },
        }}
        result={result}
      />,
    );
    expect(screen.getByText("Time")).toBeInTheDocument();
    expect(screen.getByText("Response time")).toBeInTheDocument();
    expect(screen.getByText("100.00 ms")).toBeInTheDocument();
    expect(screen.queryByText("api")).not.toBeInTheDocument();
    expect(
      container.querySelector('path[fill-opacity="0.3"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('path[stroke-width="3"]'),
    ).toBeInTheDocument();
  });

  it("colors actual heatmap values against thresholds and keeps a missing latest scrape unknown", () => {
    const heatmapResult: QueryResult = {
      series: [
        {
          name: "healthy-api",
          labels: { region: "west" },
          points: [{ timestamp: 1000, value: 1 }],
        },
        {
          name: "failed-worker",
          labels: {},
          points: [{ timestamp: 1000, value: 0 }],
        },
        {
          name: "missing-job",
          labels: {},
          points: [
            { timestamp: 1000, value: 1 },
            { timestamp: 2000, value: null },
          ],
        },
      ],
    };
    const { rerender } = render(
      <WidgetVisualization
        widget={{
          ...widget,
          type: "heatmap",
          unit: "",
          options: { decimals: 1 },
        }}
        result={heatmapResult}
      />,
    );
    const healthy = screen.getByRole("button", {
      name: "healthy-api: 1.0 · Healthy",
    });
    expect(healthy).toHaveStyle({ background: "#53876a" });
    expect(
      screen.getByRole("button", { name: "failed-worker: 0.0 · Unhealthy" }),
    ).toHaveStyle({
      background: "#b64a3a",
    });
    expect(
      screen.getByRole("button", { name: "missing-job: No data" }),
    ).toHaveStyle({
      background: "#e6e9e0",
    });
    fireEvent.focus(healthy);
    expect(screen.getByRole("tooltip")).toHaveTextContent("region: west");
    rerender(
      <WidgetVisualization
        widget={{
          ...widget,
          type: "heatmap",
          options: {
            showTooltip: false,
            showLegend: false,
            thresholds: [{ value: 0, color: "#ffffff", label: "All" }],
          },
        }}
        result={heatmapResult}
      />,
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Heatmap thresholds"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "healthy-api: 1 ms · All" }),
    ).toHaveStyle({
      background: "#ffffff",
      color: "#27332e",
    });
  });

  it("bounds heatmap rendering and describes a single threshold honestly", () => {
    render(
      <WidgetVisualization
        widget={{
          ...widget,
          type: "heatmap",
          options: { thresholds: [{ value: 0, color: "#111111" }] },
        }}
        result={{
          series: Array.from({ length: 150 }, (_, index) => ({
            name: `host-${index}`,
            labels: {},
            points: [{ timestamp: 1, value: index }],
          })),
        }}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(100);
    expect(screen.getByText("All values")).toBeInTheDocument();
    expect(screen.getByText(/First 100 of 150/)).toBeInTheDocument();
  });

  it.each([
    [true, true, "api12 ms"],
    [false, true, "12 ms"],
    [true, false, "api"],
    [false, false, ""],
  ] as const)(
    "independently shows heatmap labels=%s and values=%s while retaining accessible names",
    (showLabels, showValues, visibleText) => {
      render(
        <WidgetVisualization
          widget={{
            ...widget,
            type: "heatmap",
            options: { showLabels, showValues, showLegend: false },
          }}
          result={result}
        />,
      );
      const cell = screen.getByRole("button", { name: "api: 12 ms · Healthy" });
      expect(cell.textContent).toBe(visibleText);
      expect(cell).toHaveAccessibleName("api: 12 ms · Healthy");
    },
  );

  it("portals complete sample details outside clipped tiles and supports focus, Escape, pin and outside dismissal", () => {
    const timestamp = "2026-10-20T12:34:56.789Z";
    const labels = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `label${index}`,
        `value${index}`,
      ]),
    );
    const { container } = render(
      <WidgetVisualization
        widget={{
          ...widget,
          type: "heatmap",
          unit: "req/s",
          options: {
            decimals: 2,
            showLabels: false,
            showValues: false,
            thresholds: [
              { value: 0, color: "#aa0000", label: "Below target" },
              { value: 1, color: "#008800", label: "Healthy" },
            ],
          },
        }}
        result={{
          series: [
            {
              name: "worker-west",
              labels,
              points: [
                { timestamp: Date.parse(timestamp), value: 0.123456789 },
              ],
            },
          ],
        }}
      />,
    );
    const cell = screen.getByRole("button", {
      name: "worker-west: 0.12 req/s · Below target",
    });
    fireEvent.focus(cell);
    const tip = screen.getByRole("tooltip");
    expect(container.contains(tip)).toBe(false);
    expect(cell).toHaveAttribute("aria-describedby", tip.id);
    expect(within(tip).getByText("0.12 req/s")).toHaveAttribute(
      "data-metric-value",
      "0.123456789",
    );
    expect(within(tip).getByText("Below 1 req/s")).toBeInTheDocument();
    expect(within(tip).getByText("value11")).toBeInTheDocument();
    expect(tip.querySelector("time")).toHaveAttribute("datetime", timestamp);
    Object.defineProperties(tip, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 600 },
    });
    expect(fireEvent.keyDown(cell, { key: "PageDown" })).toBe(false);
    expect(tip.scrollTop).toBe(80);
    fireEvent.keyDown(cell, { key: "End" });
    expect(tip.scrollTop).toBe(500);
    fireEvent.keyDown(cell, { key: "PageUp" });
    expect(tip.scrollTop).toBe(420);
    fireEvent.keyDown(cell, { key: "Home" });
    expect(tip.scrollTop).toBe(0);
    fireEvent.keyDown(cell, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.click(cell);
    expect(cell).toHaveAttribute("aria-pressed", "true");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.click(cell);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.click(cell);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("keeps hovered details open while the pointer crosses into the panel, then dismisses after leaving", () => {
    vi.useFakeTimers();
    render(
      <WidgetVisualization
        widget={{ ...widget, type: "heatmap" }}
        result={result}
      />,
    );
    const cell = screen.getByRole("button", { name: "api: 12 ms · Healthy" });
    fireEvent.pointerEnter(cell, { pointerType: "mouse" });
    const tip = screen.getByRole("tooltip");
    fireEvent.pointerLeave(cell);
    act(() => vi.advanceTimersByTime(100));
    fireEvent.pointerEnter(tip);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.pointerLeave(tip);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});

describe("accessible observation inspection", () => {
  it("keeps all retained line segments on one side of missing intervals", () => {
    const points = Array.from({ length: 1000 }, (_, timestamp) => ({
      timestamp,
      value: timestamp % 17 === 0 ? null : Math.sin(timestamp) * 100,
    }));
    for (const maximum of [2, 3, 4, 5, 31, 100, 480]) {
      const sampled = downsamplePoints(points, maximum);
      expect(sampled.length).toBeLessThanOrEqual(maximum);
      sampled.forEach((point, index) => {
        if (!index || point.value === null || sampled[index - 1].value === null)
          return;
        expect(
          points
            .slice(sampled[index - 1].timestamp + 1, point.timestamp)
            .some((candidate) => candidate.value === null),
        ).toBe(false);
      });
    }
  });

  it("draws isolated observations on both sides of a null gap", () => {
    const { container } = render(
      <WidgetVisualization widget={widget} result={result} />,
    );
    expect(
      container.querySelectorAll("svg circle").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it.each(["stat", "table"] as const)(
    "makes %s exact values, full labels and timestamps keyboard and touch readable",
    (type) => {
      const changed = vi.fn();
      render(
        <WidgetVisualization
          widget={{ ...widget, type, options: { decimals: 2 } }}
          result={{
            series: [
              {
                name: "long-api-service",
                labels: { service: "api", region: "west-long-label" },
                points: [{ timestamp: 1234, value: 0.123456789 }],
              },
            ],
          }}
          onContextChange={changed}
        />,
      );
      const trigger = screen.getByRole("button", {
        name: type === "stat" ? /Inspect value for/ : /Inspect series/,
      });
      fireEvent.focus(trigger);
      expect(changed).toHaveBeenLastCalledWith({
        series: "long-api-service",
        labels: { service: "api", region: "west-long-label" },
        value: 0.123456789,
      });
      const tip = screen.getByRole("tooltip");
      expect(tip).toHaveTextContent("west-long-label");
      expect(tip.querySelector("[data-metric-value]")).toHaveAttribute(
        "data-metric-value",
        "0.123456789",
      );
      expect(tip.querySelector("time")).toHaveAttribute(
        "datetime",
        "1970-01-01T00:00:01.234Z",
      );
      fireEvent.keyDown(trigger, { key: "Escape" });
      expect(screen.queryByRole("tooltip")).toBeNull();
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(trigger);
      expect(screen.queryByRole("tooltip")).toBeNull();
    },
  );

  it("makes full trace identity and exact duration inspectable and rejects negative durations", () => {
    const changed = vi.fn();
    const trace = {
      traceId: "full-trace-identifier-abcdef",
      service: "full-service",
      operation: "long-operation-name",
      status: "error",
      durationMs: 0.123456789,
      startTime: 1234,
    };
    const { rerender } = render(
      <WidgetVisualization
        widget={{ ...widget, type: "traces", options: { decimals: 2 } }}
        result={{ traces: [trace] }}
        onContextChange={changed}
      />,
    );
    fireEvent.focus(
      screen.getByRole("button", { name: `Inspect trace ${trace.traceId}` }),
    );
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent(trace.traceId);
    expect(tip).toHaveTextContent(trace.operation);
    expect(tip.querySelector("[data-metric-value]")).toHaveAttribute(
      "data-metric-value",
      "0.123456789",
    );
    expect(tip.querySelector("time")).toHaveAttribute(
      "datetime",
      "1970-01-01T00:00:01.234Z",
    );
    rerender(
      <WidgetVisualization
        widget={{ ...widget, type: "traces" }}
        result={{ traces: [{ ...trace, durationMs: -1 }] }}
        onContextChange={changed}
      />,
    );
    fireEvent.focus(
      screen.getByRole("button", { name: `Inspect trace ${trace.traceId}` }),
    );
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: null }),
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent("No data");
  });

  it("offers paginated exact historical data even when hover tooltips are disabled, and follows refreshed results", () => {
    const points = Array.from({ length: 27 }, (_, index) => ({
      timestamp: 1000 + index,
      value: index === 1 ? null : index + 0.123456789,
    }));
    const selected = vi.fn();
    const chartWidget = {
      ...widget,
      options: { showTooltip: false, decimals: 2 },
    };
    const { rerender } = render(
      <WidgetVisualization
        widget={chartWidget}
        result={{
          series: [
            { name: "api", labels: { service: "api-full-label" }, points },
          ],
        }}
        onContextChange={selected}
      />,
    );
    const opener = screen.getByRole("button", {
      name: "Inspect chart data for API latency",
    });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "API latency data" });
    expect(dialog).toHaveTextContent("api-full-label");
    expect(within(dialog).getByText("0.123456789 ms")).toBeInTheDocument();
    expect(within(dialog).getByText("No data")).toBeInTheDocument();
    expect(within(dialog).getAllByRole("row")).toHaveLength(26);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Next observations" }),
    );
    expect(within(dialog).getAllByRole("row")).toHaveLength(3);
    expect(dialog).toHaveTextContent("26.123456789 ms");
    expect(selected).not.toHaveBeenCalled();
    rerender(
      <WidgetVisualization
        widget={chartWidget}
        result={{
          series: [
            {
              name: "other",
              labels: { service: "other" },
              points: [{ timestamp: 0, value: 999 }],
            },
            { name: "api", labels: { service: "api-full-label" }, points },
          ],
        }}
        onContextChange={selected}
      />,
    );
    expect(
      within(dialog).getByRole("combobox", { name: "Data series" }),
    ).toHaveTextContent("api");
    expect(dialog).toHaveTextContent("26.123456789 ms");
    expect(dialog).not.toHaveTextContent("999 ms");
    rerender(
      <WidgetVisualization
        widget={chartWidget}
        result={{
          series: [
            {
              name: "api",
              labels: { service: "api-fresh-label" },
              points: [{ timestamp: 5000, value: 99.123456789 }],
            },
          ],
        }}
        onContextChange={selected}
      />,
    );
    expect(dialog).toHaveTextContent("api-fresh-label");
    expect(dialog).toHaveTextContent("99.123456789 ms");
    expect(dialog).not.toHaveTextContent("26.123456789 ms");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close data" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("inspects bar latest-valid values and adapts default text on dark backgrounds", () => {
    const { container } = render(
      <WidgetVisualization
        widget={{ ...widget, type: "bar", options: { background: "#111111" } }}
        result={result}
      />,
    );
    expect(container.firstElementChild).toHaveStyle({ color: "#ffffff" });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Inspect chart data for API latency",
      }),
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Latest valid sample per series");
    expect(within(dialog).getAllByRole("row")).toHaveLength(2);
    expect(dialog).toHaveTextContent("12 ms");
    expect(dialog).not.toHaveTextContent("5 ms");
  });
});

it("uses an actually readable foreground for midtone heatmap colors", () => {
  for (const background of [
    "#4c8466",
    "#bd5745",
    "#53876a",
    "#b64a3a",
    "#ffffff",
    "#000000",
  ]) {
    expect(
      contrastRatio(contrastText(background), background),
    ).toBeGreaterThanOrEqual(4.5);
  }
});

it.each(["timeseries", "bar"] as const)(
  "keeps %s ticks and configured axis titles at full contrast",
  (type) => {
    const { container } = render(
      <WidgetVisualization
        widget={{
          ...widget,
          type,
          options: {
            xAxisLabel: "Elapsed time",
            yAxisLabel: "Latency",
            textColor: "#123456",
          },
        }}
        result={result}
      />,
    );
    const chart = container.querySelector("svg")!;
    const text = [...chart.querySelectorAll("text")];
    const titles = text.filter((label) =>
      ["Elapsed time", "Latency"].includes(label.textContent ?? ""),
    );
    expect(titles).toHaveLength(2);
    expect(text.length).toBeGreaterThan(2);
    for (const label of text) {
      expect(label).toHaveAttribute("opacity", "1");
      expect(label).not.toHaveAttribute("fill-opacity");
      expect(label).toHaveAttribute("fill", "#123456");
    }
    for (const title of titles) expect(title).toHaveAttribute("opacity", "1");
  },
);

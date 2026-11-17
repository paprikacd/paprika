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
import chartStyles from "./charts.module.css";
import { TooltipWidgetDataProvider } from "./tooltip-widget-data";
import { DashboardTimeZoneProvider } from "./dashboard-time-zone";
import {
  DEFAULT_HEATMAP_THRESHOLDS,
  contrastText,
  balancedHeatmapColumns,
  heatmapTooltipSizeLimit,
  placeHeatmapTooltip,
  responsiveChartTicks,
  chartYAxisLayout,
  formatTimeTick,
  latestPoint,
  EmptyState,
} from "./chart-renderers";
import {
  bandLabelWidth,
  fittingBandLabel,
  isolatedPlotPoints,
  plotTimeDomain,
  sampleCadence,
  seriesCoverage,
  seriesGaps,
  uncoveredIntervals,
  withGapBreaks,
} from "./chart-data";

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
  it("reserves room for high precision axis ticks and states longer units once", () => {
    const short = chartYAxisLayout([0, 23], "req/s", 2);
    expect(short.separateUnit).toBe(true);
    expect(short.left).toBeGreaterThanOrEqual(54);
    expect(chartYAxisLayout([-1234.56789], "%", 8).left).toBeGreaterThan(short.left);
    expect(chartYAxisLayout([1], "ms", 2, "Latency").left).toBeGreaterThan(chartYAxisLayout([1], "ms", 2).left);
  });
  it("remeasures the plot immediately when the footer changes its size", () => {
    const observers: Array<{ callback: ResizeObserverCallback; element?: Element }> = [];
    class TestResizeObserver {
      entry: { callback: ResizeObserverCallback; element?: Element };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback };
        observers.push(this.entry);
      }
      observe(element: Element) { this.entry.element = element; }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    try {
      const { container } = render(<WidgetVisualization widget={widget} result={result} />);
      const plot = container.querySelector(`.${chartStyles.plot}`)!;
      const observer = observers.find(entry => entry.element === plot)!;
      expect(observer).toBeDefined();
      const bounds = vi.spyOn(plot, "getBoundingClientRect");
      act(() => observer.callback([], {} as ResizeObserver));
      expect(bounds).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("explains when a selected zoom window contains no finite observations", () => {
    const sparse: QueryResult = { series: [{ name: "api", labels: {}, points: [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: null }, { timestamp: 3000, value: null }, { timestamp: 4000, value: 4 }] }] };
    render(<WidgetVisualization widget={widget} result={sparse} />);
    fireEvent.click(screen.getByRole("button", { name: /Compare window for API latency/ }));
    fireEvent.change(screen.getByRole("slider", { name: "Window start" }), { target: { value: "1" } });
    fireEvent.change(screen.getByRole("slider", { name: "Window end" }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Zoom chart to window" }));
    expect(screen.getByRole("status")).toHaveTextContent("No recorded observations in this window");
    fireEvent.click(screen.getByRole("button", { name: "Reset chart zoom" }));
    expect(screen.queryByText(/No recorded observations in this window/)).not.toBeInTheDocument();
  });
  it("reserves a separate renderer area when a result is truncated", () => {
    const { container } = render(<WidgetVisualization widget={widget} result={{ ...result, truncated: true }} />);
    const notice = screen.getByText("Provider response may be incomplete. Narrow the query or check the data source.");
    const content = container.querySelector(`.${chartStyles.visualizationContent}`);
    expect(notice.parentElement).toHaveClass(chartStyles.visualization);
    expect(content?.parentElement).toBe(notice.parentElement);
    expect(content).toContainElement(screen.getByRole("list", { name: "Latest values by series" }));
  });
  it("distinguishes an incomplete empty response from a complete empty result and preserves zero", () => {
    const { rerender } = render(<WidgetVisualization widget={widget} result={{ series: [], truncated: true }} />);
    expect(screen.getByText("No observations returned")).toBeInTheDocument();
    expect(screen.getByText(/provider response may be incomplete/i)).toBeInTheDocument();
    expect(screen.queryByText("No data in this time range")).not.toBeInTheDocument();
    rerender(<WidgetVisualization widget={widget} result={{ series: [] }} />);
    expect(screen.getByText("No data in this time range")).toBeInTheDocument();
    rerender(<WidgetVisualization widget={{ ...widget, type: "stat" }} result={{ series: [{ name: "api", labels: {}, points: [{ timestamp: 1000, value: 0 }] }], truncated: true }} />);
    expect(screen.getByText("Provider response may be incomplete. Narrow the query or check the data source.")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });
  it("keeps a status-banded stat reading in ink; the status chip carries the band", () => {
    const result = { series: [{ name: "api", labels: {}, points: [{ timestamp: 1000, value: 0 }] }] };
    const { container, rerender } = render(<WidgetVisualization widget={{ ...widget, type: "stat", options: { thresholds: [{ value: 0, status: "ok" }] } }} result={result} />);
    // The reading takes no band colour; an ok band names nothing, so it shows no chip either.
    expect(container.querySelector("[data-metric-value]")?.getAttribute("style") ?? "").not.toContain("color");
    expect(container.querySelector("[data-stat-chip]")).toBeNull();
    // A hex override tints the chip and the trend, never the reading: the reading stays in ink.
    rerender(<WidgetVisualization widget={{ ...widget, type: "stat", options: { thresholds: [{ value: 0, status: "ok", color: "#20cba3" }] } }} result={result} />);
    expect(container.querySelector("[data-metric-value]")?.getAttribute("style") ?? "").not.toContain("color");
  });
  it("reports an incomplete empty records frame inside a registered renderer", () => {
    render(<TooltipWidgetDataProvider kind="records" result={{ records: { columns: [], rows: [], truncated: true } }}><EmptyState /></TooltipWidgetDataProvider>);
    expect(screen.getByText("No observations returned")).toBeInTheDocument();
    expect(screen.getByText(/incomplete response/)).toBeInTheDocument();
  });
  it.each(["timeseries", "bar"] as const)("states long units once beside %s axes while retaining exact inspection units", (type) => {
    const { container } = render(<WidgetVisualization widget={{ ...widget, type, unit: "connections" }} result={result} />);
    expect(container.querySelector("[data-chart-axis-unit]")).toHaveTextContent("connections");
    const ticks = [...container.querySelectorAll('[data-ts-key^="y-tick-label:"]')].map(node => node.textContent);
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.every(value => /^[-+\d.,KM]+$/.test(value ?? ""))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Inspect chart data for API latency" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("12 connections");
  });

  it("shares one compact footer for the series legend and data inspection without losing the data dialog", () => {
    const { container } = render(<WidgetVisualization widget={widget} result={result} />);
    const footer = container.querySelector("[data-chart-footer]")!;
    expect(footer).toContainElement(screen.getByRole("list", { name: "Latest values by series" }));
    const inspect = screen.getByRole("button", { name: "Inspect chart data for API latency" });
    expect(footer).toContainElement(inspect);
    expect(container.querySelectorAll("[data-chart-footer]")).toHaveLength(1);
    fireEvent.click(inspect);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent("api");
  });

  it("keeps data inspection available in the same footer when legends are disabled", () => {
    const { container } = render(<WidgetVisualization widget={{ ...widget, type: "bar", options: { showLegend: false } }} result={result} />);
    const footer = container.querySelector("[data-chart-footer]")!;
    expect(footer).toContainElement(screen.getByRole("button", { name: "Inspect chart data for API latency" }));
    expect(screen.queryByText("Latest valid sample per series")).not.toBeInTheDocument();
  });

  it("keeps legend values and timestamps tied to the latest valid original sample", () => {
    const response: QueryResult = {
      series: [
        {
          name: "api",
          labels: { service: "api" },
          points: [
            { timestamp: 5000, value: 0 },
            { timestamp: 1000, value: 12 },
            { timestamp: 6000, value: null },
            { timestamp: 1e100, value: 999 },
          ],
        },
        { name: "worker", labels: {}, points: [{ timestamp: 6000, value: null }] },
      ],
    };
    const host = (data: QueryResult) => <WidgetVisualization widget={{ ...widget, options: { decimals: 2 } }} result={data} />;
    const { rerender } = render(host(response));
    const legend = screen.getByRole("list", { name: "Latest values by series" });
    const value = within(legend).getByLabelText("api, latest valid sample: 0.00 ms at 1970-01-01T00:00:05.000Z");
    expect(value).toHaveTextContent("0.00 ms");
    expect(value).toHaveAttribute("data-legend-timestamp", "5000");
    expect(within(legend).getByLabelText("worker: no valid sample")).toHaveTextContent("—");
    rerender(host({ series: [{ ...response.series![0], points: [{ timestamp: 7000, value: 9.876 }] }] }));
    expect(within(legend).getByLabelText("api, latest valid sample: 9.88 ms at 1970-01-01T00:00:07.000Z")).toHaveTextContent("9.88 ms");
    expect(within(legend).queryByText("0.00 ms")).not.toBeInTheDocument();
    expect(within(legend).queryByLabelText("worker: no valid sample")).not.toBeInTheDocument();
  });

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

  it("keeps an isolated observation that bucket extremes would drop, so a band split keeps its dot", () => {
    // Review repro: 2000 samples at 1 s. Samples 900..999 are missing except 950 s, whose value sits between the extremes.
    // The plot samples the gap-broken series, so the missing run is one synthetic break on each side of 950 s.
    const points = Array.from({ length: 2000 }, (_, index) => index + 1)
      .filter((second) => !(second >= 900 && second < 1000) || second === 950)
      .map((second) => ({ timestamp: second * 1000, value: second === 950 ? 5 : (second % 7) + (second % 3) }));
    const plotted = downsamplePoints(withGapBreaks(points, sampleCadence(points)));
    expect(plotted.length).toBeLessThanOrEqual(480);
    expect(plotted).toContainEqual({ timestamp: 950_000, value: 5 });
    expect(plotted[0]).toEqual(points[0]);
    expect(plotted.at(-1)).toEqual(points.at(-1));
    expect(
      plotted.every(
        (point, index) => index === 0 || point.timestamp > plotted[index - 1].timestamp,
      ),
    ).toBe(true);
  });

  it("keeps the budget when every observation is isolated, spreads the kept dots across the range, and keeps both ends", () => {
    const points = Array.from({ length: 2000 }, (_, index) => ({
      timestamp: index * 1000,
      value: index % 2 === 0 ? index % 9 : null,
    }));
    const sampled = downsamplePoints(points);
    expect(sampled.length).toBeLessThanOrEqual(480);
    expect(sampled[0]).toEqual(points[0]);
    expect(sampled.at(-1)).toEqual(points.at(-1));
    const dots = sampled
      .filter((point) => point.value !== null)
      .map((point) => point.timestamp);
    expect(dots[0]).toBe(0);
    expect(dots.at(-1)).toBeGreaterThan(1_900_000);
  });

  it("never exceeds the maximum, whatever mix of gaps, isolated observations and spikes it is given", () => {
    // A fixed linear congruential generator keeps the mixes reproducible from run to run.
    let seed = 7;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 12; trial++) {
      const points = Array.from({ length: 700 }, (_, index) => ({
        timestamp: index * 1000,
        value: random() < 0.4 ? null : Math.round(random() * 100),
      }));
      for (const maximum of [3, 5, 31, 100, 480]) {
        const sampled = downsamplePoints(points, maximum);
        expect(sampled.length).toBeLessThanOrEqual(maximum);
        expect(sampled[0]).toEqual(points[0]);
        expect(sampled.at(-1)).toEqual(points.at(-1));
      }
    }
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
  it("updates KPI sample times with the dashboard zone and retains the exact instant", () => {
    const timestamp = Date.parse("2026-11-09T01:00:00.000Z");
    const response = { series: [{ name: "api", labels: {}, points: [{ timestamp, value: 12 }] }] };
    const view = (timeZone: string) => <DashboardTimeZoneProvider timeZone={timeZone}><WidgetVisualization widget={{ ...widget, type: "stat" }} result={response} /></DashboardTimeZoneProvider>;
    const { container, rerender } = render(view("UTC"));
    expect(container.querySelector("time")).toHaveTextContent("01:00 UTC");
    expect(container.querySelector("time")).toHaveAttribute("datetime", "2026-11-09T01:00:00.000Z");
    rerender(view("America/New_York"));
    expect(container.querySelector("time")).toHaveTextContent("20:00 EST");
    expect(container.querySelector("time")).toHaveAttribute("datetime", "2026-11-09T01:00:00.000Z");
  });
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
    expect(screen.getByText("133 ms")).toBeInTheDocument();
    expect(screen.getByText("error")).toBeInTheDocument();
  });

  it.each([
    ["ok", "success"],
    [" OK ", "success"],
    ["success", "success"],
    ["succeeded", "success"],
    ["STATUS_CODE_OK", "success"],
    ["error", "error"],
    ["FAILED", "error"],
    ["failure", "error"],
    ["STATUS_CODE_ERROR", "error"],
    ["unknown", "neutral"],
    ["", "neutral"],
    ["unset", "neutral"],
    ["pending", "neutral"],
    ["not_ok", "neutral"],
    ["no-error", "neutral"],
    ["failure pending", "neutral"],
  ] as const)("uses an honest %s trace-status tone (%s)", (status, tone) => {
    render(
      <WidgetVisualization
        widget={{ ...widget, type: "traces" }}
        result={{
          traces: [{
            traceId: "status-test",
            service: "checkout",
            operation: "POST /orders",
            durationMs: 12,
            startTime: 1000,
            status,
          }],
        }}
      />,
    );
    const row = screen.getByRole("row", { name: /POST \/orders/ });
    const label = within(row).getAllByRole("cell")[2].querySelector("span")!;
    expect(label.textContent).toBe(status || "Unknown");
    const statusClasses = {
      success: chartStyles.statusSuccess,
      error: chartStyles.statusError,
      neutral: chartStyles.statusNeutral,
    };
    expect(label).toHaveClass(statusClasses[tone]);
    for (const [other, className] of Object.entries(statusClasses)) {
      if (other !== tone) expect(label).not.toHaveClass(className);
    }
    const bar = row.querySelector(`.${chartStyles.traceBar}`)!;
    expect(bar.classList.contains(chartStyles.traceSuccess)).toBe(
      tone === "success",
    );
    expect(bar.classList.contains(chartStyles.traceError)).toBe(
      tone === "error",
    );
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
    // fillOpacity now sets the top stop of the area's gradient, which fades to transparent at the baseline.
    const fill = container.querySelector("g.ts-chart__area path")!.getAttribute("fill")!;
    expect(document.getElementById(fill.replace(/^url\(#(.+)\)$/, "$1"))!.querySelector("stop")).toHaveAttribute("stop-opacity", "0.3");
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
    // jsdom drops a var() background, so the status band is checked through its on-fill ink and the default bands' statuses.
    expect(DEFAULT_HEATMAP_THRESHOLDS.map(({ status }) => status)).toEqual(["critical", "ok"]);
    expect(healthy).toHaveAttribute("style", expect.stringContaining("color: var(--gamma-status-ok-on)"));
    expect(
      screen.getByRole("button", { name: "failed-worker: 0.0 · Unhealthy" }),
    ).toHaveAttribute("style", expect.stringContaining("color: var(--gamma-status-critical-on)"));
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
    vi.useFakeTimers();
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
    const pinned = screen.getByRole("tooltip");
    fireEvent.blur(cell, { relatedTarget: pinned });
    act(() => vi.advanceTimersByTime(200));
    expect(cell).toHaveAttribute("aria-pressed", "true");
    expect(pinned).toBeInTheDocument();
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
          widget={{ ...widget, type, options: type === "stat" ? { decimals: 2, showSparkline: true } : { decimals: 2 } }}
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
      // A single value is inspected through its history; a table through its series buttons.
      const trigger =
        type === "stat"
          ? screen.getByRole("img", { name: "History for API latency" })
          : screen.getByRole("button", { name: /Inspect series/ });
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
      if (type === "stat") {
        // The history pins with Enter and closes with Escape; the reading itself is not a control.
        fireEvent.keyDown(trigger, { key: "Enter" });
        expect(screen.getByRole("tooltip")).toHaveTextContent("Pinned");
        fireEvent.keyDown(trigger, { key: "Escape" });
        expect(screen.queryByRole("tooltip")).toBeNull();
      } else {
        fireEvent.click(trigger);
        expect(trigger).toHaveAttribute("aria-pressed", "true");
        fireEvent.click(trigger);
        expect(screen.queryByRole("tooltip")).toBeNull();
      }
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

describe("time-series gap helpers", () => {
  // [seconds, value] samples; a null value is an explicit missing sample.
  const samples = (pairs: [number, number | null][]) =>
    pairs.map(([seconds, value]) => ({ timestamp: seconds * 1000, value }));

  it("takes the lower median of positive steps between observed samples, and none below three", () => {
    expect(sampleCadence(samples([[0, 1], [1, 1]]))).toBeNull();
    expect(sampleCadence(samples([[0, 1], [1, 1], [2, 1]]))).toBe(1000);
    // Steps of 1, 2, 3 and 4 s: the lower median is 2 s.
    expect(sampleCadence(samples([[0, 1], [1, 1], [3, 1], [6, 1], [10, 1]]))).toBe(2000);
    // An explicit null is not an observed sample, so the steps are 3, 3 and 4 s.
    expect(sampleCadence(samples([[0, 1], [1, null], [3, 1], [6, 1], [10, 1]]))).toBe(3000);
  });

  it("reports explicit null runs as gaps even without a cadence, and steps beyond 1.5 cadence", () => {
    expect(seriesGaps(samples([[0, 1], [1, null], [2, 1]]), null)).toEqual([{ from: 0, to: 2000 }]);
    const steady = samples([[1, 1], [2, 1], [3, 1], [7, 1], [8, 1]]);
    expect(seriesGaps(steady, 1000)).toEqual([{ from: 3000, to: 7000 }]);
    expect(seriesCoverage(steady, 1000)).toEqual([
      { from: 1000, to: 2000 },
      { from: 2000, to: 3000 },
      { from: 7000, to: 8000 },
    ]);
    // Exactly 1.5 cadence is not a gap.
    expect(seriesGaps(samples([[0, 1], [1.5, 1]]), 1000)).toEqual([]);
  });

  it("adds a null break at the midpoint of inferred gaps only, never where an explicit null already breaks the line", () => {
    const steady = samples([[1, 1], [2, 1], [3, 1], [7, 1], [8, 1]]);
    expect(withGapBreaks(steady, 1000).map((point) => [point.timestamp, point.value])).toEqual([
      [1000, 1],
      [2000, 1],
      [3000, 1],
      [5000, null],
      [7000, 1],
      [8000, 1],
    ]);
    const explicit = samples([[1, 1], [2, 1], [3, null], [7, 1], [8, 1]]);
    expect(withGapBreaks(explicit, 1000)).toEqual(explicit);
  });

  it("finds only the time that no series covers, and nothing in a zero-width domain", () => {
    const sparse = seriesCoverage(samples([[1, 1], [2, 1], [3, 1], [7, 1], [8, 1]]), 1000);
    const dense = seriesCoverage(samples([[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1]]), 1000);
    expect(uncoveredIntervals([sparse], [1000, 8000])).toEqual([{ from: 3000, to: 7000 }]);
    expect(uncoveredIntervals([sparse, dense], [1000, 8000])).toEqual([]);
    expect(uncoveredIntervals([[]], [1000, 4000])).toEqual([{ from: 1000, to: 4000 }]);
    expect(uncoveredIntervals([sparse], [8000, 8000])).toEqual([]);
  });

  it("pads a single instant the way TanStack pads a single value, and keeps a real span unchanged", () => {
    expect(plotTimeDomain(1000, 5000)).toEqual([1000, 5000]);
    expect(plotTimeDomain(0, 0)).toEqual([-1, 1]);
    const [start, end] = plotTimeDomain(1_000_000, 1_000_000);
    expect(start).toBeLessThan(1_000_000);
    expect(end).toBeGreaterThan(1_000_000);
  });

  it("covers an isolated observation with a zero-width instant, so the holes either side of it stay apart", () => {
    // Review repro: samples at 1, 2, 3, 10, 20, 21 and 22 s. The sample at 10 s has no covered neighbour.
    const isolated = samples([[1, 5], [2, 6], [3, 7], [10, 8], [20, 9], [21, 9], [22, 9]]);
    const coverage = seriesCoverage(isolated, sampleCadence(isolated));
    expect(coverage).toContainEqual({ from: 10000, to: 10000 });
    expect(uncoveredIntervals([coverage], [1000, 22000])).toEqual([
      { from: 3000, to: 10000 },
      { from: 10000, to: 20000 },
    ]);
    // A lone observation covers only its own instant.
    expect(uncoveredIntervals([seriesCoverage(samples([[5, 1]]), null)], [1000, 9000])).toEqual([
      { from: 1000, to: 5000 },
      { from: 5000, to: 9000 },
    ]);
    // An instant outside the domain covers nothing inside it.
    expect(uncoveredIntervals([[{ from: 30000, to: 30000 }]], [1000, 9000])).toEqual([{ from: 1000, to: 9000 }]);
  });

  it("gives a dot only to an observation that no plotted neighbour reaches, and keeps every plotted time", () => {
    const plotted = withGapBreaks(samples([[1, 5], [2, 6], [3, 7], [10, 8], [20, 9], [21, 9]]), 1000);
    const dots = isolatedPlotPoints(plotted);
    expect(dots).toHaveLength(plotted.length);
    expect(dots.map((point) => [point.timestamp, point.value]).filter(([, value]) => value !== null)).toEqual([[10000, 8]]);
    // A pair of neighbours, and a run, draw their own segments, so none of their points needs a dot.
    expect(isolatedPlotPoints(samples([[1, 1], [2, 2], [3, 3]])).every((point) => point.value === null)).toBe(true);
  });

  it("estimates a band label at 5.8px per character plus 8px of padding, unless a measure answers for the text", () => {
    expect(bandLabelWidth("No samples")).toBeCloseTo(66, 5);
    expect(bandLabelWidth("No samples since 11:48")).toBeCloseTo(135.6, 5);
    expect(bandLabelWidth("")).toBeCloseTo(8, 5);
    expect(bandLabelWidth("No samples", () => 60)).toBe(68);
    expect(bandLabelWidth("No samples", () => undefined)).toBeCloseTo(66, 5);
  });

  it("picks the first label that fits a band, so the full label wins whenever both fit", () => {
    const labels = ["No samples since 11:48", "No samples"];
    expect(fittingBandLabel(labels, 136)).toBe(labels[0]);
    expect(fittingBandLabel(labels, 135)).toBe(labels[1]);
    expect(fittingBandLabel(labels, 65)).toBeUndefined();
    // At 6px per character the full label is 140px and the short one 68px.
    const sixPerCharacter = (text: string) => text.length * 6;
    expect(fittingBandLabel(labels, 137, sixPerCharacter)).toBe(labels[1]);
    expect(fittingBandLabel(labels, 140, sixPerCharacter)).toBe(labels[0]);
  });
});

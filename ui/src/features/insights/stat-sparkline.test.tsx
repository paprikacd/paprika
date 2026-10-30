import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetVisualization } from "./charts";
import { TooltipSubWidget } from "./tooltip-widgets";
import { TooltipQueryProvider } from "./tooltip-query";
import { boundHistoryPoints, type Series } from "./chart-data";
import type { Widget, TooltipView, Provider } from "./schema";

afterEach(cleanup);

const widget: Widget = {
  id: "requests",
  title: "Requests",
  type: "stat",
  providerId: "prom",
  query: "requests",
  unit: "req/s",
  color: "#336699",
  layout: { x: 0, y: 0, w: 3, h: 2 },
};
const series: Series = {
  name: "api",
  labels: { service: "api" },
  points: [
    { timestamp: 5000, value: null },
    { timestamp: 1000, value: -7.25 },
    { timestamp: 2000, value: null },
    { timestamp: 3000, value: 10 },
    { timestamp: 4000, value: 0 },
  ],
};

describe("optional single-value history", () => {
  it("warns when the newest returned observation is missing while preserving the last valid zero", () => {
    const { rerender, container } = render(<WidgetVisualization widget={{ ...widget, options: { showSparkline: true, sparklinePlacement: "side" } }} result={{ series: [series] }} />);
    expect(container.querySelector('[data-metric-value="0"]')).toHaveTextContent("0req/s");
    expect(screen.getByRole("status")).toHaveTextContent("Last valid · latest missing");
    rerender(<WidgetVisualization widget={widget} result={{ series: [{ ...series, points: [...series.points, { timestamp: 6000, value: 4 }] }] }} />);
    expect(screen.queryByText(/Last valid · latest missing/)).not.toBeInTheDocument();
  });

  it("uses the last observation at a duplicate latest timestamp, without treating zero as missing", () => {
    const points = [{ timestamp: 1000, value: 2 }, { timestamp: 3000, value: null }, { timestamp: 3000, value: 0 }];
    const { rerender } = render(<WidgetVisualization widget={widget} result={{ series: [{ ...series, points }] }} />);
    expect(screen.queryByText(/Last valid · latest missing/)).not.toBeInTheDocument();
    rerender(<WidgetVisualization widget={widget} result={{ series: [{ ...series, points: [...points, { timestamp: 3000, value: null }] }] }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Last valid · latest missing");
  });
  it("keeps the original stat unchanged unless its sparkline is explicitly enabled", () => {
    const { rerender, container } = render(
      <WidgetVisualization widget={widget} result={{ series: [series] }} />,
    );
    expect(
      container.querySelector('[data-metric-value="0"]'),
    ).toHaveTextContent("0req/s");
    expect(screen.queryByRole("img")).toBeNull();
    rerender(
      <WidgetVisualization
        widget={{ ...widget, options: { showSparkline: false } }}
        result={{ series: [series] }}
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();
    rerender(
      <WidgetVisualization
        widget={{ ...widget, options: { showSparkline: true } }}
        result={{ series: [series] }}
      />,
    );
    expect(
      screen.getByRole("img", { name: "History for Requests" }),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-metric-value="0"]'),
    ).toHaveTextContent("0req/s");
  });

  it("offers a side placement while preserving the selected series and latest value", () => {
    const { container } = render(<WidgetVisualization widget={{ ...widget, options: { showSparkline: true, sparklinePlacement: "side" } }} result={{ series: [series] }} />);
    const summary = container.querySelector("[data-stat-summary]");
    expect(summary).toHaveAttribute("data-sparkline-placement", "side");
    expect(summary?.querySelector('[data-metric-value="0"]')).toHaveTextContent("0req/s");
    expect(screen.getByRole("img", { name: "History for Requests" })).toHaveAttribute("data-sample-count", "5");
  });

  it("renders the actual latest value against its explicit bar scale and thresholds", () => {
    const result = { series: [{ ...series, points: [{ timestamp: 1000, value: 75 }] }] };
    const options = { showStatBar: true, min: 0, max: 100, thresholds: [{ value: 0, color: "#00aa55" }, { value: 70, color: "#ee9900" }] };
    const { rerender } = render(<WidgetVisualization widget={{ ...widget, options }} result={result} />);
    const meter = screen.getByRole("meter", { name: "Requests value on configured scale" });
    expect(meter).toHaveAttribute("aria-valuenow", "75");
    expect(meter).toHaveAttribute("data-stat-bar-fraction", "0.75");
    expect(meter.firstElementChild).toHaveStyle({ width: "75%", backgroundColor: "#ee9900" });
    rerender(<WidgetVisualization widget={{ ...widget, options }} result={{ series: [{ ...series, points: [{ timestamp: 1000, value: 120 }] }] }} />);
    expect(meter).toHaveAttribute("aria-valuenow", "100");
    expect(meter).toHaveAttribute("data-stat-bar-value", "120");
    expect(meter).toHaveAttribute("aria-valuetext", expect.stringContaining("120 req/s (outside configured scale)"));
    expect(meter.firstElementChild).toHaveStyle({ width: "100%" });
    rerender(<WidgetVisualization widget={{ ...widget, options: { ...options, min: -1e308, max: 1e308 } }} result={{ series: [{ ...series, points: [{ timestamp: 1000, value: 0 }] }] }} />);
    expect(meter).toHaveAttribute("data-stat-bar-fraction", "0.5");
  });

  it("plots the displayed series only, with gaps, exact ranges, zero, and an honest missing tail", () => {
    const other: Series = {
      name: "worker",
      labels: {},
      points: [{ timestamp: 8000, value: 999 }],
    };
    const { container } = render(
      <WidgetVisualization
        widget={{ ...widget, options: { showSparkline: true } }}
        result={{ series: [series, other] }}
      />,
    );
    const svg = screen.getByRole("img", { name: "History for Requests" });
    expect(svg).toHaveAttribute("data-history-start", "1000");
    expect(svg).toHaveAttribute("data-history-end", "5000");
    expect(svg).toHaveAttribute("data-history-min", "-7.25");
    expect(svg).toHaveAttribute("data-history-max", "10");
    expect(svg).toHaveAttribute("data-latest-valid-time", "4000");
    expect(svg).toHaveAccessibleDescription(/5 samples; 2 missing/);
    expect(svg).toHaveAccessibleDescription(
      /Displayed latest valid sample: 0 req\/s at 1970-01-01T00:00:04.000Z/,
    );
    expect(svg).toHaveAccessibleDescription(
      /Latest observation is missing at 1970-01-01T00:00:05.000Z/,
    );
    expect(
      svg.querySelector("path[data-stat-trend]")?.getAttribute("d")?.match(/M/g),
    ).toHaveLength(2);
    expect(
      svg.querySelector("path[data-stat-area]")?.getAttribute("d")?.match(/M/g),
    ).toHaveLength(2);
    // The historical plot remains a translucent backdrop for the primary value.
    const strokeOpacity = Number(svg.querySelector("path[data-stat-trend]")?.getAttribute("stroke-opacity"));
    expect(strokeOpacity).toBeGreaterThan(0);
    expect(strokeOpacity).toBeLessThan(1);
    expect(svg.parentElement).toHaveAttribute("data-stat-summary");
    expect(svg.parentElement?.querySelector("[data-stat-reading] [data-metric-value]")).toBeInTheDocument();
    expect(
      svg.querySelector('[data-stat-point][data-sample-value="-7.25"]'),
    ).toBeInTheDocument();
    expect(
      svg.querySelector('[data-stat-point][data-sample-value="0"]'),
    ).toBeInTheDocument();
    expect(svg).toHaveStyle({ color: "#336699" });
    expect(svg.querySelectorAll("text")).toHaveLength(0);
    expect(svg).toHaveAttribute("tabindex", "0");
    expect(
      container.querySelector('[data-metric-value="0"]'),
    ).toBeInTheDocument();
    expect(screen.getByText("999 req/s")).toBeInTheDocument();
  });

  it("retains short spikes and gaps within the rendering budget without mutating shared points", () => {
    const points = Array.from({ length: 10_000 }, (_, timestamp) => ({
      timestamp,
      value:
        timestamp > 9990 || timestamp === 4500
          ? null
          : timestamp === 2345
            ? 1000
            : timestamp === 6789
              ? -2000
              : 8,
    }));
    const frozen = points.map((point) => Object.freeze(point));
    const bounded = boundHistoryPoints(frozen);
    expect(bounded.length).toBeLessThanOrEqual(240);
    expect(bounded).toContainEqual(points[2345]);
    expect(bounded).toContainEqual(points[6789]);
    expect(bounded).toContainEqual(points[4500]);
    expect(bounded).toContainEqual(points[9990]);
    expect(bounded.at(-1)).toEqual(points.at(-1));
    expect(bounded[0]).not.toBe(frozen[0]);
    render(
      <WidgetVisualization
        widget={{ ...widget, options: { showSparkline: true } }}
        result={{ series: [{ ...series, points: frozen }] }}
      />,
    );
    const svg = screen.getByRole("img");
    expect(
      Number(svg.getAttribute("data-rendered-samples")),
    ).toBeLessThanOrEqual(240);
    expect(svg).toHaveAttribute("data-sample-count", "10000");
    expect(svg).toHaveAccessibleDescription(/Trend reduced to/);
    expect(
      svg.querySelector('[data-stat-point][data-sample-time="9990"]'),
    ).toBeInTheDocument();
  });

  it.each([0, -7.25])(
    "shows a visible singleton mark for %s, and leaves all-null results empty",
    (value) => {
      const { rerender } = render(
        <WidgetVisualization
          widget={{ ...widget, options: { showSparkline: true } }}
          result={{
            series: [{ ...series, points: [{ timestamp: 1000, value }] }],
          }}
        />,
      );
      const svg = screen.getByRole("img");
      const marker = svg.querySelector("[data-stat-point]");
      expect(marker).toHaveAttribute("d", "M120,32h0");
      expect(marker).toHaveAttribute("vector-effect", "non-scaling-stroke");
      expect(marker).toHaveAttribute("stroke-width", "4");
      expect(marker).toHaveAttribute("stroke-linecap", "round");
      expect(marker).toHaveAttribute(
        "data-sample-value",
        String(value),
      );
      rerender(
        <WidgetVisualization
          widget={{ ...widget, options: { showSparkline: true } }}
          result={{
            series: [{ ...series, points: [{ timestamp: 1000, value: null }] }],
          }}
        />,
      );
      expect(screen.queryByRole("img")).toBeNull();
      expect(
        screen.getByText("No data in this time range"),
      ).toBeInTheDocument();
    },
  );

  it("keeps constant and extreme finite values within the plot without invalid coordinates", () => {
    const { rerender } = render(
      <WidgetVisualization
        widget={{ ...widget, options: { showSparkline: true } }}
        result={{
          series: [
            {
              ...series,
              points: [
                { timestamp: 0, value: 2 },
                { timestamp: 10, value: 2 },
              ],
            },
          ],
        }}
      />,
    );
    expect(screen.getByRole("img").querySelector("path[data-stat-trend]")).toHaveAttribute(
      "d",
      "M1,32L239,32",
    );
    rerender(
      <WidgetVisualization
        widget={{ ...widget, options: { showSparkline: true } }}
        result={{
          series: [
            {
              ...series,
              points: [
                { timestamp: 0, value: -1e308 },
                { timestamp: 10, value: 1e308 },
              ],
            },
          ],
        }}
      />,
    );
    expect(screen.getByRole("img").querySelector("path[data-stat-trend]")).toHaveAttribute(
      "d",
      "M1,60L239,4",
    );
  });

  it("forwards tooltip presentation without adding nested interactions or changing the latest-valid stat", () => {
    const { container, rerender } = render(
      <TooltipSubWidget
        view={{ type: "stat", showSparkline: true, decimals: 2 }}
        series={series}
        point={{ timestamp: 1000, value: -7.25 }}
        unit="ms"
      />,
    );
    expect(
      screen.getByRole("img", { name: "History for api" }),
    ).toHaveAttribute("data-history-end", "5000");
    expect(
      container.querySelector('[data-metric-value="0"]'),
    ).toHaveTextContent("0.00ms");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();
    rerender(
      <TooltipSubWidget
        view={{ type: "stat", showSparkline: false }}
        series={series}
        unit="ms"
      />,
    );
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("uses queried history and toggles the sparkline without refetching", async () => {
    const fetcher = vi.fn(async () => ({ series: [series] }));
    const providers: Provider[] = [
      {
        id: "prom",
        name: "Prometheus",
        type: "prometheus",
        capabilities: ["metrics"],
      },
    ];
    const view: TooltipView = {
      type: "stat",
      source: { type: "query", providerId: "prom", query: "requests" },
    };
    function Host({ enabled }: { enabled: boolean }) {
      return (
        <TooltipQueryProvider
          fetcher={fetcher}
          providers={providers}
          start={0}
          end={10}
          step={1}
        >
          <TooltipSubWidget
            view={{ ...view, showSparkline: enabled }}
            series={{
              name: "parent",
              labels: {},
              points: [{ timestamp: 1, value: 999 }],
            }}
            unit="req/s"
          />
        </TooltipQueryProvider>
      );
    }
    const { rerender, container } = render(<Host enabled={false} />);
    await waitFor(() =>
      expect(
        container.querySelector('[data-metric-value="0"]'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("img")).toBeNull();
    rerender(<Host enabled />);
    expect(
      await screen.findByRole("img", { name: "History for api" }),
    ).toHaveAttribute("data-history-max", "10");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

it("keeps a one-track background stat's saved geometry, precise value, unit and missing-tail disclosure", () => {
  const compact: Widget = { ...widget, layout: { x: 3, y: 0, w: 3, h: 1 }, options: { showSparkline: true, sparklinePlacement: "background" } };
  const before = JSON.stringify(compact);
  const { container, rerender } = render(<WidgetVisualization widget={compact} result={{ series: [series] }} />);
  expect(container.querySelector("[data-stat-summary]")).toHaveAttribute("data-sparkline-placement", "background");
  expect(container.querySelector('[data-metric-value="0"]')).toHaveTextContent("0req/s");
  expect(screen.getByRole("button", { name: "Inspect value for Requests" })).toBeEnabled();
  expect(screen.getByRole("status")).toHaveTextContent("Last valid · latest missing");
  expect(screen.getByRole("img")).toHaveAccessibleDescription(/1970-01-01T00:00:04.000Z/);
  rerender(<WidgetVisualization widget={compact} result={{ series: [{ ...series, points: [{ timestamp: 5000, value: null }] }] }} />);
  expect(container.querySelector("[data-metric-value]")).toBeNull();
  expect(container.querySelector("[data-widget-state-frame]")).toHaveTextContent("No data in this time range");
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(JSON.stringify(compact)).toBe(before);
});

 it("measures compact failed-query and loading states without losing retry", () => {
  const retry = vi.fn();
  const { container, rerender } = render(<WidgetVisualization widget={widget} error="Fixture failure" onRetry={retry} />);
  expect(container.querySelector("[data-widget-state-frame]")).toHaveTextContent("Query failed");
  expect(screen.getByRole("button", { name: "Retry query for Requests" })).toBeEnabled();
  rerender(<WidgetVisualization widget={widget} loading />);
  expect(container.querySelector("[data-widget-state-frame]")).toContainElement(screen.getByRole("status", { name: "Loading widget" }));
});

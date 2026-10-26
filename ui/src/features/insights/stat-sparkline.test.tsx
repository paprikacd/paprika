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
      screen.getByRole("img", { name: "History for api" }),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-metric-value="0"]'),
    ).toHaveTextContent("0req/s");
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
    const svg = screen.getByRole("img", { name: "History for api" });
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
    expect(svg.querySelector("path[data-stat-trend]")).toHaveAttribute("stroke-opacity", "0.38");
    expect(svg.querySelector("stop")).toHaveAttribute("stop-opacity", "0.16");
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
    expect(svg).not.toHaveAttribute("tabindex");
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
      "M4,32L236,32",
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
      "M4,60L236,4",
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

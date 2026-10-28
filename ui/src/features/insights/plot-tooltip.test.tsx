import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetVisualization } from "./charts";
import { placePlotTooltip } from "./chart-renderers";
import { TooltipQueryProvider } from "./tooltip-query";
import type { Provider, QueryResult, TooltipView, Widget } from "./schema";
import type { Series } from "./chart-data";

const providers: Provider[] = [
  {
    id: "metrics",
    type: "prometheus",
    capabilities: ["metrics"],
    name: "Metrics",
  },
];
const series: Series[] = [
  {
    name: "api",
    labels: { service: 'api"west\\node\n{{literal}}' },
    points: [
      { timestamp: 1000.25, value: -7.25 },
      { timestamp: 2000.5, value: 0 },
      { timestamp: 3000, value: 32 },
    ],
  },
  {
    name: "worker",
    labels: { service: "worker" },
    points: [
      { timestamp: 1000.5, value: 41 },
      { timestamp: 2000.75, value: 42 },
      { timestamp: 3000, value: null },
    ],
  },
];
const tooltipView: TooltipView = {
  type: "stat",
  source: {
    type: "query",
    providerId: "metrics",
    query: "metric{service={{service}},signal={{series}}} > {{value}} @ {{at}}",
    bindings: [
      { variable: "service", label: "service" },
      { variable: "series", field: "series" },
      { variable: "value", field: "value" },
      { variable: "at", field: "timestamp" },
    ],
  },
};
const widget: Widget = {
  id: "host",
  title: "Historical observations",
  type: "timeseries",
  providerId: "metrics",
  query: "metric",
  unit: "ms",
  layout: { x: 0, y: 0, w: 6, h: 4 },
  options: { tooltipView },
};
const result: QueryResult = { series };
const child: QueryResult = {
  series: [
    { name: "Child", labels: {}, points: [{ timestamp: 1000, value: 111 }] },
  ],
};
function Host({
  value = widget,
  response = result,
  fetcher = async () => child,
  onContextChange,
}: {
  value?: Widget;
  response?: QueryResult;
  fetcher?: (request: unknown, signal: AbortSignal) => Promise<QueryResult>;
  onContextChange?: () => void;
}) {
  return (
    <TooltipQueryProvider
      fetcher={fetcher}
      providers={providers}
      start={0}
      end={10}
      step={1}
    >
      <WidgetVisualization
        widget={value}
        result={response}
        onContextChange={onContextChange}
      />
    </TooltipQueryProvider>
  );
}

function hoverLine(chart: HTMLElement, lineIndex: number, fraction = 0.5, offsetY = 0) {
  const [x, y, width, height] = chart
    .getAttribute("viewBox")!
    .split(" ")
    .map(Number);
  vi.spyOn(chart, "getBoundingClientRect").mockReturnValue(
    new DOMRect(x, y, width, height),
  );
  const line = chart.querySelectorAll('path[stroke-width="1.8"]')[lineIndex];
  const coordinates = [
    ...line.getAttribute("d")!.matchAll(/[ML]([\d.e+-]+),([\d.e+-]+)/g),
  ];
  expect(coordinates.length).toBeGreaterThanOrEqual(2);
  const clientX =
    Number(coordinates[0][1]) * (1 - fraction) +
    Number(coordinates[1][1]) * fraction;
  const clientY =
    Number(coordinates[0][2]) * (1 - fraction) +
    Number(coordinates[1][2]) * fraction + offsetY;
  fireEvent(
    chart,
    new MouseEvent("pointermove", { clientX, clientY, bubbles: true }),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("point and row tooltip hosts", () => {
  it.each([true, false])("chooses the nearby lower series outside the narrow stroke hit target (rich tooltip: %s)", async (rich) => {
    const fetcher = vi.fn().mockResolvedValue(child);
    render(
      <Host
        value={{
          ...widget,
          options: { tooltipView: rich ? tooltipView : undefined, min: 0, max: 100 },
        }}
        response={{
          series: [
            {
              name: "api",
              labels: { service: "api" },
              points: [{ timestamp: 0, value: 90 }, { timestamp: 100, value: 90 }],
            },
            {
              name: "worker",
              labels: { service: "worker" },
              points: [{ timestamp: 0, value: 10 }, { timestamp: 100, value: 10 }],
            },
          ],
        }}
        fetcher={fetcher}
      />,
    );
    hoverLine(screen.getByRole("img", { name: widget.title }), 1, 0.05, 6);
    const tip = await screen.findByRole(rich ? "tooltip" : "status");
    expect(tip).toHaveTextContent("worker");
    if (rich) {
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      expect(fetcher.mock.calls[0][0].query).toBe(
        'metric{service="worker",signal="worker"} > 10 @ 0',
      );
    }
  });
  it.each(["line", "area"] as const)("hits a sparse %s segment instead of another series with a nearer timestamp", async (display) => {
    const fetcher = vi.fn().mockResolvedValue(child);
    render(
      <Host
        value={{
          ...widget,
          options: { tooltipView, display, min: 0, max: 100 },
        }}
        response={{
          series: [
            {
              name: "api",
              labels: { service: "api" },
              points: [
                { timestamp: 0, value: 10 },
                { timestamp: 100, value: 10 },
              ],
            },
            {
              name: "worker",
              labels: { service: "worker" },
              points: [
                { timestamp: 50, value: 90 },
                { timestamp: 100, value: 90 },
              ],
            },
          ],
        }}
        fetcher={fetcher}
      />,
    );
    hoverLine(screen.getByRole("img", { name: widget.title }), 0, 0.45);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls[0][0]).toMatchObject({
      query: 'metric{service="api",signal="api"} > 10 @ 0',
    });
    expect(
      screen.getByRole("tooltip").querySelector('[data-observation-value="10"]'),
    ).toBeInTheDocument();
  });

  it("inspects the visible lower line through an overlapping area fill in a details-only chart", async () => {
    render(
      <Host
        value={{ ...widget, options: { display: "area", min: 0, max: 100 } }}
        response={{
          series: [
            {
              name: "api",
              labels: {},
              points: [
                { timestamp: 0, value: 10 },
                { timestamp: 100, value: 10 },
              ],
            },
            {
              name: "worker",
              labels: {},
              points: [
                { timestamp: 0, value: 90 },
                { timestamp: 100, value: 90 },
              ],
            },
          ],
        }}
      />,
    );
    hoverLine(screen.getByRole("img", { name: widget.title }), 0);
    const tip = await screen.findByRole("status");
    expect(tip).toHaveTextContent("api");
    expect(tip).toHaveTextContent("10 ms");
    expect(tip).not.toHaveTextContent("worker");
  });

  it.each(["line", "area"] as const)("visits each %s observation once with exact values and fractional timestamps through real keyboard navigation without changing dashboard drilldown selection", async (display) => {
    const fetcher = vi.fn().mockResolvedValue(child);
    const selected = vi.fn();
    render(
      <Host
        value={{ ...widget, options: { tooltipView, display } }}
        fetcher={fetcher}
        onContextChange={selected}
      />,
    );
    const chart = screen.getByRole("img", { name: widget.title });
    act(() => chart.focus());
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls[0][0]).toMatchObject({
      query: `metric{service=${JSON.stringify(series[0].labels.service)},signal="api"} > -7.25 @ 1.00025`,
    });
    let tip = screen.getByRole("tooltip");
    expect(
      tip.querySelector('[data-observation-timestamp="1000.25"]'),
    ).toBeInTheDocument();
    expect(chart).toHaveAttribute("aria-describedby", tip.id);
    expect(within(tip).getByText("Selected observation")).toBeInTheDocument();
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1][0]).toMatchObject({
      query: 'metric{service="worker",signal="worker"} > 41 @ 1.0005',
    });
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(fetcher.mock.calls[2][0]).toMatchObject({
      query: `metric{service=${JSON.stringify(series[0].labels.service)},signal="api"} > 0 @ 2.0005`,
    });
    tip = screen.getByRole("tooltip");
    expect(
      tip.querySelector('[data-observation-value="0"]'),
    ).toBeInTheDocument();
    expect(selected).not.toHaveBeenCalled();
    fireEvent.keyDown(chart, { key: "Enter" });
    expect(
      screen.getByText("Pinned · select again to close"),
    ).toBeInTheDocument();
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    expect(fetcher.mock.calls[3][0]).toMatchObject({
      query: 'metric{service="worker",signal="worker"} > 42 @ 2.00075',
    });
    expect(
      screen.getByText("Pinned · select again to close"),
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole("tooltip")
        .querySelector('[data-observation-value="42"]'),
    ).toBeInTheDocument();
    fireEvent.keyDown(chart, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
  it("hits a historical plotted coordinate with the pointer, survives transfer into its portal and supports tap pin/unpin", async () => {
    const fetcher = vi.fn().mockResolvedValue(child);
    render(<Host fetcher={fetcher} />);
    const chart = screen.getByRole("img", { name: widget.title });
    vi.spyOn(chart, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 500, 180),
    );
    const line = chart.querySelector('path[stroke-width="1.8"]');
    expect(line).not.toBeNull();
    const coordinates = line!
      .getAttribute("d")!
      .match(/^M([\d.e+-]+),([\d.e+-]+)/)!;
    expect(coordinates).not.toBeNull();
    const clientX = Number(coordinates[1]),
      clientY = Number(coordinates[2]);
    fireEvent(
      chart,
      new MouseEvent("pointermove", { clientX, clientY, bubbles: true }),
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls[0][0].query).toContain("> -7.25 @ 1.00025");
    const tip = screen.getByRole("tooltip");
    fireEvent(
      chart.closest(".ts-chart-surface")!,
      new MouseEvent("pointerleave", { relatedTarget: tip }),
    );
    fireEvent.pointerEnter(tip);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    expect(screen.getByRole("tooltip")).toBe(tip);
    fireEvent(
      chart,
      new MouseEvent("pointerdown", { clientX, clientY, bubbles: true }),
    );
    fireEvent.click(chart, { clientX, clientY });
    expect(
      screen.getByText("Pinned · select again to close"),
    ).toBeInTheDocument();
    fireEvent.pointerLeave(tip);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    expect(screen.getByRole("tooltip")).toBe(tip);
    fireEvent(
      chart,
      new MouseEvent("pointerdown", { clientX, clientY, bubbles: true }),
    );
    fireEvent.click(chart, { clientX, clientY });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps isolated samples visible and visits each once across null gaps in an area chart", async () => {
    const fetcher = vi.fn().mockResolvedValue(child);
    render(
      <Host
        value={{ ...widget, options: { tooltipView, display: "area" } }}
        response={{
          series: [{
            name: "api",
            labels: { service: "api" },
            points: [
              { timestamp: 1000, value: 10 },
              { timestamp: 2000, value: null },
              { timestamp: 3000, value: 20 },
            ],
          }],
        }}
        fetcher={fetcher}
      />,
    );
    const chart = screen.getByRole("img", { name: widget.title });
    expect(chart.querySelectorAll(".ts-chart__line circle")).toHaveLength(2);
    act(() => chart.focus());
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls[0][0].query).toContain("> 10 @ 1");
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1][0].query).toContain("> 20 @ 3");
    expect(
      screen.getByRole("tooltip").querySelector('[data-observation-value="20"]'),
    ).toBeInTheDocument();
  });
  it("visits both series at shared timestamps once when area and line paint the same observations", async () => {
    const fetcher = vi.fn().mockResolvedValue(child);
    render(
      <Host
        value={{ ...widget, options: { tooltipView, display: "area" } }}
        response={{
          series: [
            {
              name: "api",
              labels: { service: "api" },
              points: [{ timestamp: 1000, value: 10 }, { timestamp: 2000, value: 11 }],
            },
            {
              name: "worker",
              labels: { service: "worker" },
              points: [{ timestamp: 1000, value: 90 }, { timestamp: 2000, value: 91 }],
            },
          ],
        }}
        fetcher={fetcher}
      />,
    );
    const chart = screen.getByRole("img", { name: widget.title });
    act(() => chart.focus());
    // At a shared timestamp TanStack visits the upper line, then the lower one.
    for (const [index, [name, value, at]] of [
      ["worker", 90, 1],
      ["api", 10, 1],
      ["worker", 91, 2],
      ["api", 11, 2],
    ].entries()) {
      if (index > 0) fireEvent.keyDown(chart, { key: "ArrowRight" });
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(index + 1));
      expect(fetcher.mock.calls[index][0].query).toBe(
        `metric{service="${name}",signal="${name}"} > ${value} @ ${at}`,
      );
    }
  });
  it("invalidates a pinned point on a result refresh and aborts its pending child query", async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(() => new Promise<QueryResult>(() => {}));
    const { rerender } = render(<Host fetcher={fetcher} />);
    const chart = screen.getByRole("img", { name: widget.title });
    act(() => chart.focus());
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(chart, { key: "Enter" });
    const signal: AbortSignal = fetcher.mock.calls[0][1];
    rerender(
      <Host fetcher={fetcher} response={{ series: structuredClone(series) }} />,
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(signal.aborted).toBe(true);
  });
  it("uses a bar's exact latest-valid observation and preserves null-tail context without selecting a dashboard series", async () => {
    const fetcher = vi.fn().mockResolvedValue(child);
    const selected = vi.fn();
    render(
      <Host
        value={{ ...widget, type: "bar" }}
        fetcher={fetcher}
        onContextChange={selected}
      />,
    );
    const chart = screen.getByRole("img", { name: widget.title });
    act(() => chart.focus());
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1][0]).toMatchObject({
      query: 'metric{service="worker",signal="worker"} > 42 @ 2.00075',
    });
    const tip = screen.getByRole("tooltip");
    expect(
      tip.querySelector('[data-observation-value="42"]'),
    ).toBeInTheDocument();
    expect(tip.querySelector("time")).toHaveAttribute(
      "datetime",
      "1970-01-01T00:00:02.000Z",
    );
    expect(selected).not.toHaveBeenCalled();
  });
  it("opens metric row subviews through the existing details control, using the exact row sample", async () => {
    const fetcher = vi.fn().mockResolvedValue(child);
    render(<Host value={{ ...widget, type: "table" }} fetcher={fetcher} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect series worker" }),
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls[0][0]).toMatchObject({
      query: 'metric{service="worker",signal="worker"} > 42 @ 2.00075',
    });
    const tip = screen.getByRole("tooltip");
    expect(
      tip.querySelector('[data-tooltip-widget="stat"]'),
    ).toBeInTheDocument();
    expect(tip.querySelector('[data-metric-value="42"]')).toBeInTheDocument();
    const parentTimestamp = within(tip)
      .getByText("Latest valid sample", { exact: true })
      .parentElement!.querySelector("time")!;
    const childWidget = tip.querySelector('[data-tooltip-widget="stat"]')!;
    expect(parentTimestamp).toBeInTheDocument();
    expect(
      parentTimestamp.compareDocumentPosition(childWidget) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
  it("opens a metric table row from any cell hover and respects Escape without changing row selection", async () => {
    const fetcher = vi.fn().mockResolvedValue(child);
    const selected = vi.fn();
    render(
      <Host
        value={{ ...widget, type: "table" }}
        fetcher={fetcher}
        onContextChange={selected}
      />,
    );
    const row = screen
      .getByRole("button", { name: "Inspect series worker" })
      .closest("tr")!;
    fireEvent.pointerEnter(row);
    await screen.findByRole("tooltip");
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls[0][0].query).toContain("> 42 @ 2.00075");
    expect(selected).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
  it("uses the displayed fallback name for an unnamed second series", async () => {
    const fetcher = vi.fn().mockResolvedValue(child);
    const sourceView: TooltipView = {
      type: "stat",
      source: {
        type: "query",
        providerId: "metrics",
        query: "metric{series={{series}}} > {{value}}",
        bindings: [
          { variable: "series", field: "series" },
          { variable: "value", field: "value" },
        ],
      },
    };
    render(
      <Host
        value={{
          ...widget,
          type: "table",
          options: { tooltipView: sourceView },
        }}
        response={{
          series: series.map((entry) => ({ ...entry, name: "", labels: {} })),
        }}
        fetcher={fetcher}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect series Series 2" }),
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls[0][0].query).toBe(
      'metric{series="Series 2"} > 42',
    );
    expect(
      screen.getByRole("region", { name: "Series 2 details" }),
    ).toBeInTheDocument();
  });
  it("never invents a latest observation for an empty metric row or missing heatmap sample", async () => {
    const fetcher = vi.fn().mockResolvedValue(child);
    const { rerender } = render(
      <Host
        value={{ ...widget, type: "table" }}
        fetcher={fetcher}
        response={{
          series: [{ name: "empty", labels: { service: "empty" }, points: [] }],
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Inspect series empty" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("no finite value");
    expect(fetcher).not.toHaveBeenCalled();
    rerender(<Host value={{ ...widget, type: "heatmap" }} fetcher={fetcher} />);
    fireEvent.click(screen.getByRole("button", { name: /^worker: No data/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("no finite value");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps details-only charts and disabled tooltip views free of child queries", () => {
    const fetcher = vi.fn().mockResolvedValue(child);
    const { rerender } = render(
      <Host value={{ ...widget, options: {} }} fetcher={fetcher} />,
    );
    act(() => screen.getByRole("img", { name: widget.title }).focus());
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    rerender(
      <Host
        value={{ ...widget, options: { tooltipView, showTooltip: false } }}
        fetcher={fetcher}
      />,
    );
    fireEvent.keyDown(screen.getByRole("img", { name: widget.title }), {
      key: "ArrowRight",
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("plot tooltip placement", () => {
  it("keeps vertical movement between lines clear by preferring the side of the sample", () => {
    const position = placePlotTooltip(
      { left: 337, right: 343, top: 495, bottom: 501 },
      { width: 330, height: 463 },
      { width: 1920, height: 1080 },
    );
    expect(position.placement).toBe("right");
    expect(position.left).toBe(359);
    expect(position.top).toBe(266.5);
  });

  it("flips left near the viewport edge and clamps height within an offset viewport", () => {
    const position = placePlotTooltip(
      { left: 950, right: 956, top: 700, bottom: 706 },
      { width: 330, height: 463 },
      { width: 1000, height: 700, left: 50, top: 100 },
    );
    expect(position).toEqual({ left: 604, top: 325, placement: "left" });
    expect(position.left + 330).toBeLessThan(950);
  });

  it("falls back to the existing vertical placement when neither side has room", () => {
    const position = placePlotTooltip(
      { left: 157, right: 163, top: 490, bottom: 496 },
      { width: 296, height: 300 },
      { width: 320, height: 720 },
    );
    expect(position).toEqual({ left: 12, top: 180, placement: "top" });
  });
});

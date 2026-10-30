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
import { ObservationDetails, ObservationTooltip, outsideTooltipWidthLimit, placeClearOutsideWidgetTooltip, placeOutsideWidgetTooltip, placePlotTooltip, tooltipOverlapsOtherWidget } from "./chart-renderers";
import { TooltipQueryProvider } from "./tooltip-query";
import type { Provider, QueryResult, TooltipView, Widget } from "./schema";
import type { Series } from "./chart-data";
import { ChartCursorProvider } from "./chart-cursor";
import { GammaActionMenu } from "./gamma/action-menu";
import { WidgetDrilldownProvider } from "./widget-drilldown";

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
  onDrilldown,
}: {
  value?: Widget;
  response?: QueryResult;
  fetcher?: (request: unknown, signal: AbortSignal) => Promise<QueryResult>;
  onContextChange?: () => void;
  onDrilldown?: Parameters<typeof WidgetDrilldownProvider>[0]["open"];
}) {
  return (
    <TooltipQueryProvider
      fetcher={fetcher}
      providers={providers}
      start={0}
      end={10}
      step={1}
    >
      <WidgetDrilldownProvider open={onDrilldown}><WidgetVisualization
        widget={value}
        result={response}
        onContextChange={onContextChange}
      /></WidgetDrilldownProvider>
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("point and row tooltip hosts", () => {
  it("places value details outside their owning widget by default", () => {
    vi.stubGlobal("innerWidth", 1024); vi.stubGlobal("innerHeight", 768);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.widgetId === "owner") return new DOMRect(100, 200, 500, 250);
      if (this.getAttribute("role") === "tooltip") return new DOMRect(0, 0, 200, 100);
      return new DOMRect(200, 250, 20, 20);
    });
    render(<article data-widget-id="owner"><ObservationDetails label="Inspect value" details={<span>Selected sample</span>}>12</ObservationDetails></article>);
    fireEvent.focus(screen.getByRole("button", { name: "Inspect value" }));
    const tooltip = screen.getByRole("tooltip");
    expect(Number.parseFloat(tooltip.style.left)).toBeGreaterThanOrEqual(610);
  });
  it("places a built-in heatmap cell outside its owning widget", () => {
    vi.stubGlobal("innerWidth", 1024); vi.stubGlobal("innerHeight", 768);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.widgetId === "owner") return new DOMRect(100, 200, 500, 250);
      if (this.getAttribute("role") === "tooltip") return new DOMRect(0, 0, 200, 100);
      return new DOMRect(200, 250, 20, 20);
    });
    render(<article data-widget-id="owner"><Host value={{ ...widget, type: "heatmap", options: {} }} /></article>);
    fireEvent.focus(screen.getByRole("button", { name: /api:/ }));
    const tooltip = screen.getByRole("tooltip");
    expect(Number.parseFloat(tooltip.style.left)).toBeGreaterThanOrEqual(610);
  });
  it("measures the full inspector before choosing a placement when its previous height was constrained", () => {
    vi.stubGlobal("innerWidth", 1384);
    vi.stubGlobal("innerHeight", 726);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.widgetId === "owner") return new DOMRect(99, 394, 602, 256);
      if (this.dataset.widgetId === "other") return new DOMRect(349, 82, 343, 240);
      if (this.dataset.obstacle === "one") return new DOMRect(1077, 425, 153, 224);
      if (this.dataset.obstacle === "two") return new DOMRect(50, 518, 944, 104);
      if (this.id === "expanding-tooltip") return new DOMRect(0, 0, 159, Math.min(550, Number.parseFloat(this.style.maxHeight) || 114));
      return new DOMRect(109, 404, 10, 10);
    });
    render(<><article data-widget-id="owner"><button>Point</button></article><article data-widget-id="other">Other</article><div data-tooltip-obstacle data-obstacle="one" /><div data-tooltip-obstacle data-obstacle="two" /></>);
    render(<ObservationTooltip id="expanding-tooltip" anchor={screen.getByRole("button", { name: "Point" })} avoidWidget onDismiss={() => {}} onEnter={() => {}} onLeave={() => {}}>Long loaded details</ObservationTooltip>);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveAttribute("data-placement", "top");
    expect(Number.parseFloat(tooltip.style.maxHeight)).toBeLessThanOrEqual(372);
    expect(Number.parseFloat(tooltip.style.top) + tooltip.getBoundingClientRect().height).toBeLessThanOrEqual(384);
  });
  it("repositions async content even when a prior height cap prevents a resize", async () => {
    vi.stubGlobal("innerWidth", 1384);
    vi.stubGlobal("innerHeight", 726);
    let naturalHeight = 114;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.widgetId === "owner") return new DOMRect(99, 394, 602, 256);
      if (this.dataset.widgetId === "other") return new DOMRect(349, 82, 343, 240);
      if (this.dataset.obstacle === "one") return new DOMRect(1077, 425, 153, 224);
      if (this.dataset.obstacle === "two") return new DOMRect(50, 518, 944, 104);
      if (this.id === "async-tooltip") return new DOMRect(0, 0, 159, Math.min(naturalHeight, Number.parseFloat(this.style.maxHeight) || 114));
      return new DOMRect(109, 404, 10, 10);
    });
    render(<><article data-widget-id="owner"><button>Point</button></article><article data-widget-id="other">Other</article><div data-tooltip-obstacle data-obstacle="one" /><div data-tooltip-obstacle data-obstacle="two" /></>);
    const props = { id: "async-tooltip", anchor: screen.getByRole("button", { name: "Point" }), avoidWidget: true, onDismiss: () => {}, onEnter: () => {}, onLeave: () => {} };
    const { rerender } = render(<ObservationTooltip {...props}>Loading</ObservationTooltip>);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveAttribute("data-placement", "right");
    naturalHeight = 550;
    rerender(<ObservationTooltip {...props}>Loaded additional results</ObservationTooltip>);
    await waitFor(() => expect(tooltip).toHaveAttribute("data-placement", "top"));
    expect(Number.parseFloat(tooltip.style.maxHeight)).toBeLessThanOrEqual(372);
  });
  it("identifies when a tooltip covers a neighboring widget without treating a shared edge as an overlap", () => {
    const { container } = render(<><article data-widget-id="source"><button>Point</button></article><article data-widget-id="neighbor">Next chart</article></>);
    const source = container.querySelector('[data-widget-id="source"]')!;
    const neighbor = container.querySelector('[data-widget-id="neighbor"]')!;
    vi.spyOn(neighbor, "getBoundingClientRect").mockReturnValue(new DOMRect(400, 100, 200, 200));
    expect(tooltipOverlapsOtherWidget({ left: 320, right: 410, top: 120, bottom: 180 }, source)).toBe(true);
    expect(tooltipOverlapsOtherWidget({ left: 310, right: 400, top: 120, bottom: 180 }, source)).toBe(false);
    expect(tooltipOverlapsOtherWidget({ left: 410, right: 500, top: 300, bottom: 350 }, source)).toBe(false);
  });
  it("lets the pointer reach a covered neighboring widget until the tooltip is pinned", async () => {
    let neighborLeft = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.widgetId === "owner") return new DOMRect(10, 100, 400, 300);
      if (this.dataset.widgetId === "neighbor") return neighborLeft === 0 ? new DOMRect(0, 0, 1024, 768) : new DOMRect(neighborLeft, 100, 200, 300);
      if (this.id === "cross-widget-preview") return new DOMRect(0, 0, 200, 120);
      return new DOMRect(100, 150, 20, 20);
    });
    render(<><article data-widget-id="owner"><button>Point</button></article><article data-widget-id="neighbor">Next chart</article></>);
    const anchor = screen.getByRole("button", { name: "Point" });
    const props = { id: "cross-widget-preview", anchor, avoidWidget: true, onDismiss: () => {}, onEnter: () => {}, onLeave: () => {} };
    const { rerender } = render(<ObservationTooltip {...props}>Preview</ObservationTooltip>);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveAttribute("data-tooltip-overlaps-other-widget", "true");
    expect(tooltip).toHaveStyle({ pointerEvents: "none" });
    rerender(<ObservationTooltip {...props} pinned>Preview</ObservationTooltip>);
    expect(tooltip).not.toHaveStyle({ pointerEvents: "none" });
    rerender(<ObservationTooltip {...props}>Preview</ObservationTooltip>);
    neighborLeft = 800;
    fireEvent.scroll(window);
    await waitFor(() => expect(tooltip).not.toHaveAttribute("data-tooltip-overlaps-other-widget"));
    expect(tooltip).not.toHaveStyle({ pointerEvents: "none" });
  });
  it("lets a pinned mobile inspector be minimized and restored without losing its details", async () => {
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("innerHeight", 800);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-tooltip-obstacle")) return new DOMRect(0, 0, 390, 230);
      if (this.dataset.widgetId === "owner") return new DOMRect(20, 240, 350, 300);
      if (this.dataset.widgetId === "neighbor") return new DOMRect(20, 550, 350, 250);
      if (this.id === "mobile-inspector") return this.dataset.inspectorMinimized ? new DOMRect(0, 0, 160, 38) : new DOMRect(0, 0, 300, 180);
      return new DOMRect(100, 300, 20, 20);
    });
    render(<><header data-tooltip-obstacle>Filters</header><article data-widget-id="owner"><button>Point</button></article><article data-widget-id="neighbor">Next chart</article></>);
    const anchor = screen.getByRole("button", { name: "Point" });
    const dismiss = vi.fn();
    render(<ObservationTooltip id="mobile-inspector" anchor={anchor} avoidWidget pinned onDismiss={dismiss} onEnter={() => {}} onLeave={() => {}}><span>Recorded 42 at 10:00</span></ObservationTooltip>);
    const tip = screen.getByRole("tooltip");
    await screen.findByRole("button", { name: "Minimize inspector" });
    const details = screen.getByText("Recorded 42 at 10:00");
    fireEvent.click(screen.getByRole("button", { name: "Minimize inspector" }));
    expect(tip).toHaveAttribute("data-inspector-minimized", "true");
    expect(details).not.toBeVisible();
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show inspector details" }));
    expect(screen.getByText("Recorded 42 at 10:00")).toBe(details);
    expect(details).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Minimize inspector" }));
    const close = screen.getByRole("button", { name: "Close inspector" });
    close.focus();
    fireEvent.click(close);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(anchor).toHaveFocus();
  });
  it("lets hover events reach dashboard controls if a constrained inspector must cover them", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-tooltip-obstacle")) return new DOMRect(0, 0, 1024, 170);
      if (this.dataset.widgetId === "owner") return new DOMRect(0, 180, 1024, 580);
      if (this.id === "over-controls") return new DOMRect(0, 0, 200, 120);
      return new DOMRect(400, 250, 20, 20);
    });
    render(<><header data-tooltip-obstacle><button>Dashboard filters</button></header><article data-widget-id="owner"><button>Point</button></article></>);
    const anchor = screen.getByRole("button", { name: "Point" });
    const props = { id: "over-controls", anchor, avoidWidget: true, onDismiss: () => {}, onEnter: () => {}, onLeave: () => {} };
    const { rerender } = render(<ObservationTooltip {...props}>Preview</ObservationTooltip>);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveAttribute("data-tooltip-overlaps-controls", "true");
    expect(tooltip).toHaveStyle({ pointerEvents: "none" });
    rerender(<ObservationTooltip {...props} pinned>Preview</ObservationTooltip>);
    expect(tooltip).not.toHaveStyle({ pointerEvents: "none" });
  });
  it("closes an open dashboard menu before dismissing a pinned observation on Escape", () => {
    const dismiss = vi.fn();
    render(<><button>Chart point</button><GammaActionMenu label="Related dashboards" items={[{ id: "overview", label: "Overview", onSelect: vi.fn() }]} /></>);
    const anchor = screen.getByRole("button", { name: "Chart point" });
    render(<ObservationTooltip id="pinned-chart" anchor={anchor} pinned onDismiss={dismiss} onEnter={() => {}} onLeave={() => {}}>Pinned observation</ObservationTooltip>);
    const trigger = screen.getByRole("button", { name: "Related dashboards" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const item = screen.getByRole("menuitem", { name: "Overview" });
    expect(item).toHaveFocus();
    fireEvent.keyDown(item, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
  it("dismisses a hover preview when focus moves to another chart, while preserving a pinned panel", () => {
    const dismiss = vi.fn();
    render(<><button>First chart</button><button>Other chart</button></>);
    const anchor = screen.getByRole("button", { name: "First chart" });
    const other = screen.getByRole("button", { name: "Other chart" });
    const props = { id: "focus-preview", anchor, onDismiss: dismiss, onEnter: () => {}, onLeave: () => {} };
    const { rerender } = render(<ObservationTooltip {...props}><button>Panel action</button></ObservationTooltip>);
    fireEvent.focusIn(anchor);
    fireEvent.focusIn(screen.getByRole("button", { name: "Panel action" }));
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent.focusIn(other);
    expect(dismiss).toHaveBeenCalledTimes(1);
    rerender(<ObservationTooltip {...props} pinned><button>Panel action</button></ObservationTooltip>);
    fireEvent.focusIn(other);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
  it("dismisses a lingering hover card without swallowing Escape from another chart", () => {
    const dismiss = vi.fn(), ownKey = vi.fn(), otherKey = vi.fn();
    render(<><button onKeyDown={ownKey}>Hovered chart</button><button onKeyDown={otherKey}>Focused chart</button></>);
    const anchor = screen.getByRole("button", { name: "Hovered chart" });
    render(<ObservationTooltip id="lingering" anchor={anchor} onDismiss={dismiss} onEnter={() => {}} onLeave={() => {}}>Observation</ObservationTooltip>);
    fireEvent.keyDown(screen.getByRole("button", { name: "Focused chart" }), { key: "Escape" });
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(otherKey).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(anchor, { key: "Escape" });
    expect(dismiss).toHaveBeenCalledTimes(2);
    expect(ownKey).not.toHaveBeenCalled();
  });
  it("only sends an exact historical observation to links after deliberate activation", async () => {
    const selected = vi.fn();
    const value: Widget = { ...widget, options: {}, drilldowns: [{ id: "related", title: "Related", dashboardId: "other", bindings: [{ variable: "service", source: "label", value: "service" }] }] };
    render(<Host value={value} onContextChange={selected} />);
    const chart = screen.getByRole("img", { name: value.title });
    act(() => chart.focus());
    expect(selected).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Use sample for dashboard links" })).not.toBeInTheDocument();
    fireEvent.keyDown(chart, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Use sample for dashboard links" }));
    expect(selected).toHaveBeenCalledExactlyOnceWith({ series: "api", labels: series[0].labels, value: -7.25, timestamp: 1000.25 });
  });
  it("pins details without a child query and shares the exact timestamp with sibling charts", async () => {
    const fetcher = vi.fn().mockResolvedValue(child);
    const { container, rerender } = render(<ChartCursorProvider>
      <Host value={{ ...widget, options: { decimals: 2 } }} fetcher={fetcher} />
      <Host value={{ ...widget, id: "sibling", title: "Sibling", options: {} }} />
    </ChartCursorProvider>);
    const chart = screen.getByRole("img", { name: widget.title });
    act(() => chart.focus());
    expect(screen.getByRole("tooltip")).toHaveTextContent("-7.25 ms");
    expect(container.querySelectorAll('[data-chart-cursor-time="1000.25"]')).toHaveLength(2);
    fireEvent.keyDown(chart, { key: "Enter" });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Pinned");
    fireEvent.pointerLeave(chart);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Pinned");
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.keyDown(chart, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(container.querySelectorAll("[data-chart-cursor-time]")).toHaveLength(0);
    act(() => chart.blur());
    act(() => chart.focus());
    fireEvent.keyDown(chart, { key: "Enter" });
    rerender(<ChartCursorProvider>
      <Host value={{ ...widget, options: { decimals: 2 } }} response={{ series: structuredClone(series) }} fetcher={fetcher} />
      <Host value={{ ...widget, id: "sibling", title: "Sibling", options: {} }} />
    </ChartCursorProvider>);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(container.querySelectorAll("[data-chart-cursor-time]")).toHaveLength(0);
  });
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
    const tip = await screen.findByRole("tooltip");
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
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("api");
    expect(tip).toHaveTextContent("10 ms");
    expect(tip.querySelector('[data-observation-series="api"]')).toBeInTheDocument();
    expect(tip).toHaveTextContent("Other plotted series at this time");
    expect(tip).toHaveTextContent("worker");
  });

  it("compares only plotted series at the selected exact timestamp", async () => {
    render(<Host value={{ ...widget, options: { decimals: 2 } }} response={{ series: [
      { name: "selected", labels: {service:"api"}, points: [{ timestamp: 1000, value: 10 }, { timestamp: 2000, value: 20 }] },
      { name: "same time", labels: {}, points: [{ timestamp: 1000, value: 42.125 }, { timestamp: 2000, value: 50 }] },
      { name: "different time", labels: {}, points: [{ timestamp: 1001, value: 99 }, { timestamp: 2001, value: 101 }] },
    ] }} />);
    hoverLine(screen.getByRole("img", { name: widget.title }), 0, 0);
    const tip = await screen.findByRole("tooltip");
    expect(tip.querySelector('[data-observation-series="selected"]')).toBeInTheDocument();
    expect(tip).toHaveTextContent("same time");
    expect(tip).toHaveTextContent("42.13 ms");
    expect(tip).not.toHaveTextContent("different time");
    const timestamp = tip.querySelector("time[datetime]");
    const selected = tip.querySelector('[data-metric-value="10"]');
    const peer = tip.querySelector('[data-peer-series="same time"]');
    const labels = tip.querySelector("dl");
    expect(timestamp).toHaveAttribute("datetime", "1970-01-01T00:00:01.000Z");
    expect(timestamp!.compareDocumentPosition(selected!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(selected!.compareDocumentPosition(peer!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(peer!.compareDocumentPosition(labels!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(labels).toHaveTextContent("service: api");
  });

  it("allows inspecting all coincident series when the preview is truncated", async () => {
    render(<Host value={{ ...widget, options: {} }} response={{ series: Array.from({ length: 8 }, (_, i) => ({
      name: `series-${i}`, labels: {}, points: [{ timestamp: 1000, value: i }, { timestamp: 2000, value: i }],
    })) }} />);
    const chart = screen.getByRole("img", { name: widget.title });
    act(() => chart.focus());
    const tip = await screen.findByRole("tooltip");
    expect(tip.querySelectorAll("[data-peer-series]")).toHaveLength(5);
    fireEvent.click(within(tip).getByRole("button", { name: "Show 2 more plotted series" }));
    expect(tip.querySelectorAll("[data-peer-series]")).toHaveLength(7);
    fireEvent.click(within(tip).getByRole("button", { name: "Show fewer plotted series" }));
    expect(tip.querySelectorAll("[data-peer-series]")).toHaveLength(5);
  });

  it("opens a configured dashboard directly from a pinned exact observation", async () => {
    const open = vi.fn();
    const link = { id: "trace-link", title: "View service traces", dashboardId: "traces", carryTimeRange: true, bindings: [{ variable: "service", source: "label" as const, value: "service" }] };
    render(<Host value={{ ...widget, options: {}, drilldowns: [link] }} onDrilldown={open} />);
    const chart = screen.getByRole("img", { name: widget.title });
    act(() => chart.focus());
    await screen.findByRole("tooltip");
    expect(screen.queryByRole("button", { name: "View service traces" })).toBeNull();
    fireEvent.keyDown(chart, { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "View service traces" }));
    expect(open).toHaveBeenCalledExactlyOnceWith(link, { series: "api", labels: series[0].labels, value: -7.25, timestamp: 1000.25 });
  });

  it("keeps the pinned observation and its drilldown context stable when the pointer crosses another line", async () => {
    const open = vi.fn();
    const link = { id: "trace-link", title: "View service traces", dashboardId: "traces", bindings: [{ variable: "service", source: "label" as const, value: "service" }] };
    render(<Host value={{ ...widget, options: {}, drilldowns: [link] }} onDrilldown={open} />);
    const chart = screen.getByRole("img", { name: widget.title });
    act(() => chart.focus());
    await screen.findByRole("tooltip");
    fireEvent.keyDown(chart, { key: "Enter" });
    const tip = await screen.findByRole("tooltip");
    expect(tip.querySelector('[data-observation-series="api"]')).toBeInTheDocument();
    hoverLine(chart, 1, 0.8);
    expect(tip.querySelector('[data-observation-series="api"]')).toBeInTheDocument();
    fireEvent.click(within(tip).getByRole("button", { name: "View service traces" }));
    expect(open).toHaveBeenCalledExactlyOnceWith(link, { series: "api", labels: series[0].labels, value: -7.25, timestamp: 1000.25 });
  });

  it("explains unavailable observation bindings and never navigates", async () => {
    const open = vi.fn();
    const link = { id: "trace-link", title: "View service traces", dashboardId: "traces", bindings: [{ variable: "service", source: "label" as const, value: "missing" }] };
    render(<Host value={{ ...widget, options: {}, drilldowns: [link] }} onDrilldown={open} />);
    const chart = screen.getByRole("img", { name: widget.title });
    act(() => chart.focus());
    await screen.findByRole("tooltip");
    fireEvent.keyDown(chart, { key: "Enter" });
    expect(await screen.findByRole("button", { name: "View service traces" })).toBeDisabled();
    expect(screen.getByText(/missing/i)).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
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
    expect(screen.getByRole("tooltip")).toHaveTextContent("Selected observation");
    expect(screen.getByRole("tooltip").querySelector("[data-tooltip-widget]")).toBeNull();
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
  it("portals inside an open native dialog so the inspector remains above its top layer", () => {
    const dialog = document.createElement("dialog"), anchor = document.createElement("button");
    dialog.setAttribute("open", ""); dialog.appendChild(anchor); document.body.appendChild(dialog);
    const dismiss = vi.fn();
    const { unmount } = render(<ObservationTooltip id="dialog-observation" anchor={anchor} avoidWidget onDismiss={dismiss} onEnter={() => {}} onLeave={() => {}}>Observation</ObservationTooltip>);
    try {
      const panel = screen.getByRole("tooltip");
      expect(panel.parentElement).toBe(dialog);
      fireEvent.pointerDown(panel);
      expect(dismiss).not.toHaveBeenCalled();
      fireEvent.keyDown(anchor, { key: "Escape" });
      expect(dismiss).toHaveBeenCalledTimes(1);
    } finally { unmount(); dialog.remove(); }
  });
  it("places a chart inspector outside the widget and flips at viewport edges", () => {
    const widget = { left: 100, right: 600, top: 100, bottom: 400 };
    const anchor = { left: 300, right: 306, top: 220, bottom: 226 };
    expect(placeOutsideWidgetTooltip(widget, anchor, { width: 240, height: 250 }, { width: 1000, height: 700 }))
      .toMatchObject({ left: 610, placement: "right", overlapsWidget: false });
    expect(placeOutsideWidgetTooltip({ ...widget, left: 400, right: 900 }, anchor, { width: 240, height: 250 }, { width: 1000, height: 700 }))
      .toMatchObject({ left: 150, placement: "left", overlapsWidget: false });
  });
  it("uses an unobstructed part of the outside gutter before covering another widget", () => {
    const widget = { left: 200, right: 600, top: 100, bottom: 400 };
    const anchor = { left: 300, right: 306, top: 220, bottom: 226 };
    const size = { width: 240, height: 250 }, viewport = { width: 1000, height: 700 };
    const obstacle = { left: 610, right: 900, top: 100, bottom: 350 };
    const result = placeClearOutsideWidgetTooltip(widget, anchor, size, viewport, [obstacle]);
    expect(result.overlapsWidget).toBe(false);
    expect(result.top >= obstacle.bottom || result.top + size.height <= obstacle.top || result.left >= obstacle.right || result.left + size.width <= obstacle.left).toBe(true);
    expect(result.top + size.height).toBeLessThanOrEqual(viewport.height - 12);
    expect(placeClearOutsideWidgetTooltip(widget, anchor, size, viewport, [])).toEqual(placeOutsideWidgetTooltip(widget, anchor, size, viewport));
  });
  it("keeps dashboard controls reachable before preferring another panel", () => {
    const widget = { left: 12, right: 378, top: 240, bottom: 650 };
    const anchor = { left: 180, right: 186, top: 360, bottom: 366 };
    const controls = { left: 0, right: 390, top: 0, bottom: 220, weight: 8 };
    const neighbor = { left: 12, right: 378, top: 660, bottom: 844 };
    const result = placeClearOutsideWidgetTooltip(widget, anchor, { width: 330, height: 100 }, { width: 390, height: 844 }, [controls, neighbor]);
    expect(result).toMatchObject({ placement: "bottom", overlapsWidget: false });
    expect(result.top).toBeGreaterThanOrEqual(controls.bottom);
  });
  it("narrows a tooltip to use a viable side gutter before covering another part of the chart", () => {
    const viewport = { width: 1000, height: 700 };
    const widget = { left: 50, right: 700, top: 50, bottom: 600 };
    const width = outsideTooltipWidthLimit(widget, viewport);
    expect(width).toBe(278);
    expect(placeOutsideWidgetTooltip(widget, widget, { width, height: 250 }, viewport))
      .toMatchObject({ left: 710, placement: "right", overlapsWidget: false });
    // When neither side is usable, keep a readable width for above/below.
    expect(outsideTooltipWidthLimit({ left: 100, right: 900 }, viewport)).toBe(976);
    expect(outsideTooltipWidthLimit({ left: 400, right: 1100 }, { ...viewport, left: 50 })).toBe(328);
  });
  it("keeps a pinned observation open when focus moves into its details", async () => {
    render(<ObservationDetails label="Inspect value" details={<button>Details action</button>}>42</ObservationDetails>);
    const trigger = screen.getByRole("button", { name: "Inspect value" });
    fireEvent.focus(trigger);
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-pressed", "true");
    const action = screen.getByRole("button", { name: "Details action" });
    fireEvent.blur(trigger, { relatedTarget: action });
    fireEvent.focus(action, { relatedTarget: trigger });
    expect(trigger).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Pinned · tap again to close")).toBeInTheDocument();
    fireEvent.keyDown(action, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Pinned · tap again to close")).not.toBeInTheDocument());
  });
  it("replaces another transient tooltip when scrolling introduces a new hover target, but keeps pinned details", () => {
    render(<>
      <ObservationDetails label="First value" details={<span>First details</span>}>1</ObservationDetails>
      <ObservationDetails label="Second value" details={<span>Second details</span>}>2</ObservationDetails>
    </>);
    const first = screen.getByRole("button", { name: "First value" });
    const second = screen.getByRole("button", { name: "Second value" });
    fireEvent.focus(first);
    expect(screen.getByText("First details")).toBeInTheDocument();
    fireEvent.pointerEnter(second);
    expect(screen.queryByText("First details")).not.toBeInTheDocument();
    expect(screen.getByText("Second details")).toBeInTheDocument();
    fireEvent.pointerLeave(second);
    fireEvent.focus(first);
    fireEvent.click(first);
    expect(first).toHaveAttribute("aria-pressed", "true");
    fireEvent.pointerEnter(second);
    expect(screen.getByText("First details")).toBeInTheDocument();
    expect(screen.getByText("Second details")).toBeInTheDocument();
  });
  it("uses free space above or below full-width widgets and bounds small screens", () => {
    const widget = { left: 10, right: 310, top: 250, bottom: 500 }, anchor = { left: 140, right: 146, top: 300, bottom: 306 };
    const position = placeOutsideWidgetTooltip(widget, anchor, { width: 296, height: 400 }, { width: 320, height: 700 });
    expect(position).toMatchObject({ left: 12, top: 12, placement: "top", maxHeight: 228, overlapsWidget: false });
    const below = placeOutsideWidgetTooltip({ ...widget, top: 30, bottom: 250 }, anchor, { width: 296, height: 400 }, { width: 320, height: 700 });
    expect(below).toMatchObject({ left: 12, top: 260, placement: "bottom", maxHeight: 428, overlapsWidget: false });
  });
  it("marks full-viewport overlap for a pointer-transparent hover fallback", () => {
    const widget = { left: 0, right: 320, top: 0, bottom: 700 };
    const anchor = { left: 100, right: 106, top: 350, bottom: 356 };
    const result = placeOutsideWidgetTooltip(widget, anchor, { width: 296, height: 220 }, { width: 320, height: 700 });
    expect(result.overlapsWidget).toBe(true);
    expect(result.left).toBeGreaterThanOrEqual(12);
    expect(result.top).toBeGreaterThanOrEqual(12);
  });
  it("keeps a pinned inspector inside an offset viewport after its widget scrolls offscreen", () => {
    for (const widget of [
      { left: -500, right: -20, top: 100, bottom: 450 },
      { left: 1100, right: 1500, top: 100, bottom: 450 },
      { left: 50, right: 1000, top: -600, bottom: -50 },
      { left: 50, right: 1000, top: 900, bottom: 1400 },
    ]) {
      const position = placeOutsideWidgetTooltip(widget, widget, { width: 300, height: 250 }, { width: 900, height: 700, left: 50, top: 100 });
      expect(position.left).toBeGreaterThanOrEqual(62);
      expect(position.left + 300).toBeLessThanOrEqual(938);
      expect(position.top).toBeGreaterThanOrEqual(112);
      expect(position.top + 250).toBeLessThanOrEqual(788);
    }
  });
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

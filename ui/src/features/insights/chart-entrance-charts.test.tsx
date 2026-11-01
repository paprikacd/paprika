import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WidgetVisualization } from "./charts";
import { CHART_REVEAL_MS } from "./chart-entrance";
import { EmbeddedWidgetProvider } from "./widget-presentation";
import type { QueryResult, Widget } from "./schema";

const timeseries: Widget = { id: "latency", title: "API latency", type: "timeseries", providerId: "prometheus", query: "latency", unit: "ms", layout: { x: 0, y: 0, w: 6, h: 4 } };
const bars: Widget = { ...timeseries, id: "by-service", title: "Latest by service", type: "bar" };
// Two series of four samples. The second is half the first, so the two lines and areas have different geometry.
const response = (scale: number): QueryResult => ({
  series: [
    { name: "api", labels: { service: "api" }, points: [1, 2, 3, 4].map((value, index) => ({ timestamp: 1000 + index * 1000, value: value * scale })) },
    { name: "worker", labels: { service: "worker" }, points: [1, 2, 3, 4].map((value, index) => ({ timestamp: 1000 + index * 1000, value: (value * scale) / 2 })) },
  ],
});

// The plot wrapper that holds the TanStack host, where data-chart-entering is set.
const plotOf = (container: HTMLElement) => container.querySelector("svg.ts-chart")!.closest(".ts-chart-host")!.parentElement!;

function stubReducedMotion(reduce: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: reduce && query === "(prefers-reduced-motion: reduce)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as MediaQueryList);
}

// Points the pointer at the first line's midpoint, as the plot-tooltip tests do.
function hoverLine(chart: SVGSVGElement, lineIndex = 0, fraction = 0.5) {
  const [x, y, width, height] = chart.getAttribute("viewBox")!.split(" ").map(Number);
  vi.spyOn(chart, "getBoundingClientRect").mockReturnValue(new DOMRect(x, y, width, height));
  const line = chart.querySelectorAll('path[stroke-width="1.8"]')[lineIndex];
  const coordinates = [...line.getAttribute("d")!.matchAll(/[ML]([\d.e+-]+),([\d.e+-]+)/g)];
  const clientX = Number(coordinates[0][1]) * (1 - fraction) + Number(coordinates[1][1]) * fraction;
  const clientY = Number(coordinates[0][2]) * (1 - fraction) + Number(coordinates[1][2]) * fraction;
  fireEvent(chart, new MouseEvent("pointermove", { clientX, clientY, bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
  stubReducedMotion(false);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("one-time draw-in on the time-series and bar charts", () => {
  it("draws a time series in once, on its first render", () => {
    const { container } = render(<WidgetVisualization widget={timeseries} result={response(1)} />);
    const plot = plotOf(container);
    expect(plot).toHaveAttribute("data-chart-entering");
    act(() => vi.advanceTimersByTime(CHART_REVEAL_MS + 100));
    expect(plot).not.toHaveAttribute("data-chart-entering");
  });

  it("does not replay the draw-in when the result refreshes while the widget stays mounted", () => {
    const { container, rerender } = render(<WidgetVisualization widget={timeseries} result={response(1)} />);
    const plot = plotOf(container);
    act(() => vi.advanceTimersByTime(300));
    rerender(<WidgetVisualization widget={timeseries} result={response(3)} />);
    expect(plotOf(container)).toBe(plot);
    expect(plot).toHaveAttribute("data-chart-entering");
    act(() => vi.advanceTimersByTime(CHART_REVEAL_MS + 100 - 300));
    expect(plot).not.toHaveAttribute("data-chart-entering");
    rerender(<WidgetVisualization widget={timeseries} result={response(5)} />);
    act(() => vi.advanceTimersByTime(CHART_REVEAL_MS));
    expect(plot).not.toHaveAttribute("data-chart-entering");
  });

  it("changes no geometry while it draws in: the chart markup is the same during and after the reveal", () => {
    const { container } = render(<WidgetVisualization widget={timeseries} result={response(1)} />);
    const drawing = container.querySelector("svg.ts-chart")!.outerHTML;
    act(() => vi.advanceTimersByTime(CHART_REVEAL_MS + 100));
    expect(container.querySelector("svg.ts-chart")!.outerHTML).toBe(drawing);
  });

  it("is off under reduced motion: the marks are never marked for a clip", () => {
    stubReducedMotion(true);
    const { container } = render(<WidgetVisualization widget={timeseries} result={response(1)} />);
    expect(plotOf(container)).not.toHaveAttribute("data-chart-entering");
  });

  it("is off inside a data-motion=\"reduced\" scope", () => {
    const { container } = render(<div data-motion="reduced"><WidgetVisualization widget={timeseries} result={response(1)} /></div>);
    expect(plotOf(container)).not.toHaveAttribute("data-chart-entering");
  });

  it("is off for an embedded sub-widget", () => {
    const { container } = render(<EmbeddedWidgetProvider><WidgetVisualization widget={timeseries} result={response(1)} /></EmbeddedWidgetProvider>);
    expect(plotOf(container)).not.toHaveAttribute("data-chart-entering");
  });

  it("draws bars in once as well", () => {
    const { container } = render(<WidgetVisualization widget={bars} result={response(1)} />);
    const plot = plotOf(container);
    expect(plot).toHaveAttribute("data-chart-entering");
    act(() => vi.advanceTimersByTime(CHART_REVEAL_MS + 100));
    expect(plot).not.toHaveAttribute("data-chart-entering");
  });
});

describe("area fills", () => {
  it("fills each series with a native gradient from its colour at the top to transparent at the baseline", () => {
    const { container } = render(<WidgetVisualization widget={{ ...timeseries, options: { display: "area" } }} result={response(1)} />);
    const areas = [...container.querySelectorAll("g.ts-chart__area path")];
    const lines = [...container.querySelectorAll('g.ts-chart__line path[stroke-width="1.8"]')];
    expect(areas).toHaveLength(2);
    areas.forEach((area, index) => {
      const gradient = document.getElementById(area.getAttribute("fill")!.replace(/^url\(#(.+)\)$/, "$1"))!;
      expect(gradient.localName).toBe("linearGradient");
      expect(gradient.getAttribute("y1")).toBe("0%");
      expect(gradient.getAttribute("y2")).toBe("100%");
      const [top, baseline] = [...gradient.querySelectorAll("stop")];
      expect(top).toHaveAttribute("stop-opacity", "0.28");
      expect(baseline).toHaveAttribute("stop-opacity", "0");
      expect(top.getAttribute("stop-color")).toBe(lines[index].getAttribute("stroke"));
      expect(baseline.getAttribute("stop-color")).toBe(top.getAttribute("stop-color"));
    });
  });

  it("takes the top stop's opacity from fillOpacity", () => {
    const { container } = render(<WidgetVisualization widget={{ ...timeseries, options: { display: "area", fillOpacity: 0.5 } }} result={response(1)} />);
    const fill = container.querySelector("g.ts-chart__area path")!.getAttribute("fill")!;
    expect(document.getElementById(fill.replace(/^url\(#(.+)\)$/, "$1"))!.querySelector("stop")).toHaveAttribute("stop-opacity", "0.5");
  });

  it("draws no gradient for a line chart", () => {
    const { container } = render(<WidgetVisualization widget={timeseries} result={response(1)} />);
    expect(container.querySelectorAll("linearGradient")).toHaveLength(0);
  });

  it("keeps the line at 1.8px, the stroke the hover tests pin", () => {
    const { container } = render(<WidgetVisualization widget={{ ...timeseries, options: { display: "area" } }} result={response(1)} />);
    expect(container.querySelectorAll('g.ts-chart__line path[stroke-width="1.8"]')).toHaveLength(2);
  });
});

describe("focus styling", () => {
  it("shows no focus guide until a point is focused", () => {
    const { container } = render(<WidgetVisualization widget={timeseries} result={response(1)} />);
    expect(container.querySelector(".ts-chart__crosshair-rule")).toBeNull();
  });

  it("draws the focused point as a 4px ring in the surface colour, with a dashed 1px guide at its x", () => {
    const { container } = render(<WidgetVisualization widget={timeseries} result={response(1)} />);
    const chart = container.querySelector<SVGSVGElement>("svg.ts-chart")!;
    hoverLine(chart);
    const rings = [...chart.querySelectorAll(".ts-chart__focus-layer--default circle")];
    expect(rings.length).toBeGreaterThan(0);
    for (const ring of rings) {
      expect(ring).toHaveAttribute("r", "4");
      expect(ring).toHaveAttribute("stroke-width", "2");
      expect(ring).toHaveAttribute("fill", "var(--widget-background, var(--gamma-bg))");
    }
    const guide = chart.querySelector(".ts-chart__crosshair-rule--x")!;
    expect(guide).toHaveAttribute("stroke", "var(--gamma-chart-axis, var(--gamma-muted, #52636f))");
    expect(guide).toHaveAttribute("stroke-dasharray", "3 3");
    expect(guide).toHaveAttribute("stroke-width", "1");
    expect(chart.querySelectorAll(".ts-chart__crosshair-rule--y")).toHaveLength(0);
  });
});

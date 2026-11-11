import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetVisualization } from "./charts";
import { resolveTimeSeriesDomain } from "./time-series-chart";
import { calendarTickLabel, calendarTicks } from "./chart-presentation";
import { axisUnitIsCaption } from "./chart-renderer-shared";
import { observedRuns, type Point } from "./chart-data";
import { DashboardTimeZoneProvider } from "./dashboard-time-zone";
import chartStyles from "./charts.module.css";
import type { QueryResult, Widget } from "./schema";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const timeseries: Widget = { id: "latency", title: "API latency", type: "timeseries", providerId: "prom", query: "latency", unit: "ms", layout: { x: 0, y: 0, w: 6, h: 4 } };
const bars: Widget = { ...timeseries, id: "by-service", title: "Latest by service", type: "bar" };
const HOUR = 3_600_000;
/** Samples at whole seconds, as [seconds, value]. A null value is an explicit missing sample. */
const seriesOf = (name: string, samples: [number, number | null][]): QueryResult["series"] => [
  { name, labels: { service: name }, points: samples.map(([seconds, value]) => ({ timestamp: seconds * 1000, value })) },
];
const at = (iso: string) => Date.parse(iso);
/** Hourly samples from 14:00Z to 17:00Z on 3 October 2026: Melbourne's clocks move forward at 16:00Z that day. */
const melbourneDay: QueryResult = { series: [{ name: "load", labels: {}, points: [14, 15, 16, 17].map((hour) => ({ timestamp: Date.UTC(2026, 9, 3, hour), value: hour - 13 })) }] };
const gapped: QueryResult = { series: seriesOf("api", [[1, 5], [2, 6], [3, 7], [7, 8], [8, 9]]) };
const small: QueryResult = { series: seriesOf("api", [[1, 5], [2, 6], [3, 7]]) };
const axisText = (container: HTMLElement) => [...container.querySelectorAll("text")].map((node) => node.textContent ?? "");
const plotOf = (container: HTMLElement) => container.querySelector<HTMLElement>(`.${chartStyles.plot}`)!;
const chartOf = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-prior-overlay], [data-chart-window-start]") ?? container.querySelector<HTMLElement>(`.${chartStyles.chart}`)!;
const fillGradient = (path: Element) => {
  const id = path.getAttribute("fill")!.replace(/^url\(#(.+)\)$/, "$1");
  const gradient = document.getElementById(id)!;
  return [...gradient.querySelectorAll("stop")].map((stop) => {
    const raw = stop.getAttribute("offset")!;
    return { offset: raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw), opacity: Number(stop.getAttribute("stop-opacity")) };
  });
};

describe("gridlines on the time axis", () => {
  it("draws no vertical gridlines by default, and one at each x tick when asked", () => {
    const plain = render(<WidgetVisualization widget={timeseries} result={melbourneDay} />);
    expect(plain.container.querySelectorAll('[data-ts-key^="x-grid"]')).toHaveLength(0);
    cleanup();
    const { container } = render(<WidgetVisualization widget={{ ...timeseries, options: { gridX: true } }} result={melbourneDay} />);
    const vertical = [...container.querySelectorAll('[data-ts-key^="x-grid"]')];
    expect(vertical.length).toBeGreaterThan(1);
    for (const line of vertical) {
      expect(line.getAttribute("x1")).toBe(line.getAttribute("x2"));
      expect(line).toHaveAttribute("stroke", "var(--gamma-chart-grid, var(--gamma-border, #e4ebed))");
    }
  });

  it("turns off every gridline, vertical included, when showGrid is false", () => {
    const { container } = render(<WidgetVisualization widget={{ ...timeseries, options: { gridX: true, showGrid: false } }} result={melbourneDay} />);
    expect(container.querySelectorAll('[data-ts-key^="x-grid"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-ts-key^="y-grid"]')).toHaveLength(0);
  });
});

describe("calendar time axis", () => {
  it("labels the ticks in the dashboard zone, and shows no hour that Melbourne's spring-forward night does not have", () => {
    const { container } = render(
      <DashboardTimeZoneProvider timeZone="Australia/Melbourne">
        <WidgetVisualization widget={{ ...timeseries, options: { timeAxis: "calendar" } }} result={melbourneDay} />
      </DashboardTimeZoneProvider>,
    );
    const labels = axisText(container);
    // 14:00Z is local midnight (AEST); 16:00Z reads 03:00 AEDT, so 02:00 never appears.
    expect(labels).toEqual(expect.arrayContaining(["Oct 4", "01:00", "03:00", "04:00"]));
    expect(labels).not.toContain("02:00");
  });

  it("reads the same instants on the dashboard's own zone, not the viewer's", () => {
    const { container } = render(
      <DashboardTimeZoneProvider timeZone="UTC">
        <WidgetVisualization widget={{ ...timeseries, options: { timeAxis: "calendar" } }} result={melbourneDay} />
      </DashboardTimeZoneProvider>,
    );
    expect(axisText(container)).toEqual(expect.arrayContaining(["14:00", "15:00", "16:00", "17:00"]));
  });

  it("places a tick at its true instant: the spacing between two midnights reflects the 23-hour day", () => {
    const ticks = calendarTicks(at("2026-10-02T14:00:00Z"), at("2026-10-06T00:00:00Z"), 4, "Australia/Melbourne");
    const gaps = ticks.slice(1).map((tick, index) => (tick.value - ticks[index].value) / HOUR);
    expect(gaps).toEqual([24, 23, 24]);
    expect(ticks.map((tick) => calendarTickLabel(tick, "Australia/Melbourne"))).toEqual(["Oct 3", "Oct 4", "Oct 5", "Oct 6"]);
  });

  it("uses New York's own spring-forward night, which has no 02:00 either", () => {
    const ticks = calendarTicks(at("2026-03-08T05:00:00Z"), at("2026-03-08T10:00:00Z"), 6, "America/New_York");
    const labels = ticks.map((tick) => calendarTickLabel(tick, "America/New_York"));
    expect(labels).toEqual(["Mar 8", "01:00", "03:00", "04:00", "05:00", "06:00"]);
    expect(ticks[2].value - ticks[1].value).toBe(HOUR);
  });
});

describe("axis unit", () => {
  it("captions a unit longer than three characters by default, and keeps a short one in the ticks", () => {
    const long = render(<WidgetVisualization widget={{ ...timeseries, unit: "req/s" }} result={small} />);
    expect(long.container.querySelector("[data-chart-axis-unit]")).toHaveTextContent("req/s");
    cleanup();
    const short = render(<WidgetVisualization widget={timeseries} result={small} />);
    expect(short.container.querySelector("[data-chart-axis-unit]")).toBeNull();
  });

  it("moves a unit into the tick labels when asked, and captions a short unit when asked", () => {
    const ticks = render(<WidgetVisualization widget={{ ...timeseries, unit: "req/s", options: { axisUnit: "ticks" } }} result={small} />);
    expect(ticks.container.querySelector("[data-chart-axis-unit]")).toBeNull();
    expect(axisText(ticks.container).some((label) => label.includes("req/s"))).toBe(true);
    cleanup();
    const caption = render(<WidgetVisualization widget={{ ...timeseries, options: { axisUnit: "caption" } }} result={small} />);
    expect(caption.container.querySelector("[data-chart-axis-unit]")).toHaveTextContent("ms");
  });

  it("applies the same override to bar charts", () => {
    const { container } = render(<WidgetVisualization widget={{ ...bars, options: { axisUnit: "caption" } }} result={small} />);
    expect(container.querySelector("[data-chart-axis-unit]")).toHaveTextContent("ms");
  });

  it("decides captions from the mode and the unit alone", () => {
    expect(axisUnitIsCaption("req/s")).toBe(true);
    expect(axisUnitIsCaption("ms")).toBe(false);
    expect(axisUnitIsCaption("ms", "caption")).toBe(true);
    expect(axisUnitIsCaption("req/s", "ticks")).toBe(false);
    expect(axisUnitIsCaption("", "caption")).toBe(false);
  });
});

describe("reference lines and the zero line", () => {
  it("draws a labelled guide in the threshold style, and keeps its value inside the y range", () => {
    const { container } = render(<WidgetVisualization widget={{ ...timeseries, options: { referenceLines: [{ value: 50, label: "Target", color: "#c08a2b" }] } }} result={small} />);
    const guide = screen.getByRole("img", { name: "Target: 50.0 ms" });
    expect(guide).toHaveAttribute("data-reference-value", "50");
    expect((guide as HTMLElement).style.borderColor).toBe("#c08a2b");
    const top = parseFloat((guide as HTMLElement).style.top);
    expect(top).toBeGreaterThan(0);
    expect(top).toBeLessThan(180);
    expect(container.querySelectorAll("[data-reference-value]")).toHaveLength(1);
  });

  it("labels an unlabelled reference line with its value, in the warning colour by default", () => {
    render(<WidgetVisualization widget={{ ...timeseries, options: { referenceLines: [{ value: 50 }] } }} result={small} />);
    const guide = screen.getByRole("img", { name: "Reference: 50.0 ms" });
    expect(guide).toHaveTextContent("50.0 ms");
    expect((guide as HTMLElement).style.borderColor).toBe("var(--gamma-warning)");
  });

  it("adds the zero line only when asked, and places the domain so that zero is in view", () => {
    const off = render(<WidgetVisualization widget={timeseries} result={small} />);
    expect(off.container.querySelector("[data-zero-line]")).toBeNull();
    cleanup();
    const { container } = render(<WidgetVisualization widget={{ ...timeseries, options: { showZeroLine: true } }} result={small} />);
    expect(container.querySelector("[data-zero-line]")).not.toBeNull();
  });

  it("includes reference values and zero in the automatic domain, so none is clipped", () => {
    const [min, max] = resolveTimeSeriesDomain(small.series!, { referenceLines: [{ value: 50 }] })!;
    expect(max).toBeGreaterThan(50);
    expect(min).toBeLessThan(5);
    const [zeroMin] = resolveTimeSeriesDomain(small.series!, { showZeroLine: true })!;
    expect(zeroMin).toBeLessThanOrEqual(0);
    expect(resolveTimeSeriesDomain(small.series!, {})).toBeUndefined();
  });
});

describe("plot insets", () => {
  it("moves the no-sample band through the same horizontal mapping as the plot's insets", () => {
    const { container } = render(<WidgetVisualization widget={{ ...timeseries, options: { plotInsetLeft: 100, plotInsetRight: 40 } }} result={gapped} />);
    const band = container.querySelector<HTMLElement>("[data-no-sample-band]")!;
    // The data runs from 1s to 8s over a 360px plot that starts 100px in: 3s sits 2000/7000 of the way along.
    expect(parseFloat(band.style.left)).toBeCloseTo(100 + (2000 / 7000) * 360, 1);
    expect(parseFloat(band.style.width)).toBeCloseTo((4000 / 7000) * 360, 1);
  });

  it("keeps the default inset on the y-axis side when no inset is set", () => {
    const { container } = render(<WidgetVisualization widget={timeseries} result={gapped} />);
    const band = container.querySelector<HTMLElement>("[data-no-sample-band]")!;
    // The default left gutter is 54px and the right is 12px, so the plot is 434px wide.
    expect(parseFloat(band.style.left)).toBeCloseTo(54 + (2000 / 7000) * 434, 1);
  });
});

describe("drag brush", () => {
  const rect = (element: HTMLElement) => vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 180));
  const pointer = (clientX: number, buttons = 0) => ({ clientX, clientY: 60, button: 0, buttons, isPrimary: true, pointerId: 1, pointerType: "mouse" });

  it("sets the window from a drag across the plot, and reports the selected span", async () => {
    const { container } = render(<WidgetVisualization widget={timeseries} result={gapped} />);
    const chart = chartOf(container), plot = plotOf(container);
    rect(plot);
    fireEvent.pointerDown(plot, pointer(100));
    fireEvent.pointerMove(plot, pointer(300, 1));
    await waitFor(() => expect(container.querySelector("[data-time-brush-selection]")).not.toBeNull());
    fireEvent.pointerUp(plot, pointer(300));
    expect(container.querySelector("[data-time-brush-selection]")).toBeNull();
    const start = Number(chart.getAttribute("data-chart-window-start")), end = Number(chart.getAttribute("data-chart-window-end"));
    // Plot x runs from 54px to 488px over 1s..8s; 100px and 300px are 46/434 and 246/434 of the way along.
    expect(start).toBeCloseTo(1000 + (46 / 434) * 7000, -1);
    expect(end).toBeCloseTo(1000 + (246 / 434) * 7000, -1);
  });

  it("treats a movement under six pixels as a click, and selects nothing", async () => {
    const { container } = render(<WidgetVisualization widget={timeseries} result={gapped} />);
    const plot = plotOf(container);
    rect(plot);
    fireEvent.pointerDown(plot, pointer(100));
    fireEvent.pointerMove(plot, pointer(104, 1));
    fireEvent.pointerUp(plot, pointer(104));
    expect(container.querySelector("[data-time-brush-selection]")).toBeNull();
    expect(chartOf(container)).not.toHaveAttribute("data-chart-window-start");
  });

  it("cancels an active drag on Escape, and the release that follows selects nothing", async () => {
    const { container } = render(<WidgetVisualization widget={timeseries} result={gapped} />);
    const plot = plotOf(container);
    rect(plot);
    fireEvent.pointerDown(plot, pointer(100));
    fireEvent.pointerMove(plot, pointer(300, 1));
    await waitFor(() => expect(container.querySelector("[data-time-brush-selection]")).not.toBeNull());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(container.querySelector("[data-time-brush-selection]")).toBeNull());
    fireEvent.pointerUp(plot, pointer(300));
    expect(chartOf(container)).not.toHaveAttribute("data-chart-window-start");
  });

  it("keeps the Compare window dialog as the non-drag path to the same window", () => {
    const { container } = render(<WidgetVisualization widget={timeseries} result={gapped} />);
    fireEvent.click(screen.getByRole("button", { name: /Compare window for API latency/ }));
    fireEvent.change(screen.getByRole("slider", { name: "Window start" }), { target: { value: "1" } });
    fireEvent.change(screen.getByRole("slider", { name: "Window end" }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Zoom chart to window" }));
    expect(chartOf(container)).toHaveAttribute("data-chart-window-start");
  });
});

describe("zero-anchored area gradients", () => {
  const areaPaths = (container: HTMLElement) => [...container.querySelectorAll("g.ts-chart__area path")];
  const area = (points: [number, number | null][], options: Record<string, unknown> = {}) =>
    render(<WidgetVisualization widget={{ ...timeseries, options: { display: "area", ...options } }} result={{ series: seriesOf("api", points) }} />);

  it("fades a positive series from its colour at the top to transparent at the zero line", () => {
    const { container } = area([[1, 1], [2, 4], [3, 2]]);
    const [path] = areaPaths(container);
    expect(fillGradient(path)).toEqual([{ offset: 0, opacity: 0.28 }, { offset: 1, opacity: 0 }]);
  });

  it("fades a negative series from transparent at zero to its colour at the bottom", () => {
    const { container } = area([[1, -1], [2, -4]]);
    expect(fillGradient(areaPaths(container)[0])).toEqual([{ offset: 0, opacity: 0 }, { offset: 1, opacity: 0.28 }]);
  });

  it("places the zero line within a series that crosses it", () => {
    // Highest 3 and lowest -1: zero is three quarters of the way down the fill.
    const { container } = area([[1, 3], [2, -1], [3, 2]]);
    const stops = fillGradient(areaPaths(container)[0]);
    expect(stops).toHaveLength(3);
    expect(stops[0]).toEqual({ offset: 0, opacity: 0.28 });
    expect(stops[1].offset).toBeCloseTo(0.75, 6);
    expect(stops[1].opacity).toBe(0);
    expect(stops[2]).toEqual({ offset: 1, opacity: 0.28 });
  });

  it("anchors each run of a gapped series on its own zero line, not the whole series'", () => {
    // The first run is positive, so it fades to zero at its bottom. The second crosses zero: 2 / (2 + 1) = 2/3 down.
    const { container } = area([[1, 3], [2, null], [3, 2], [4, -1]]);
    const paths = areaPaths(container);
    expect(paths).toHaveLength(2);
    expect(fillGradient(paths[0])).toEqual([{ offset: 0, opacity: 0.28 }, { offset: 1, opacity: 0 }]);
    const second = fillGradient(paths[1]);
    expect(second).toHaveLength(3);
    expect(second[1].offset).toBeCloseTo(2 / 3, 3);
  });

  it("takes the top opacity from fillOpacity, and defaults it to 0.28", () => {
    const defaulted = area([[1, 1], [2, 2]]);
    expect(fillGradient(defaulted.container.querySelector("g.ts-chart__area path")!)[0].opacity).toBe(0.28);
    cleanup();
    const overridden = area([[1, 1], [2, 2]], { fillOpacity: 0.5 });
    expect(fillGradient(overridden.container.querySelector("g.ts-chart__area path")!)[0].opacity).toBe(0.5);
  });
});

describe("observed runs", () => {
  it("splits a series at its missing values into the runs that each keep their own fill", () => {
    const points = [{ timestamp: 1, value: 1 }, { timestamp: 2, value: 2 }, { timestamp: 3, value: null }, { timestamp: 4, value: 4 }, { timestamp: 5, value: Number.NaN }] as Point[];
    expect(observedRuns(points).map((run) => run.map((point) => point.timestamp))).toEqual([[1, 2], [4]]);
    expect(observedRuns([])).toEqual([]);
  });
});

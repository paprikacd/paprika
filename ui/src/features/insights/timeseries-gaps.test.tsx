import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WidgetVisualization } from "./charts";
import { ChartCursorProvider } from "./chart-cursor";
import { dateTimeFormat, fullDateTimeFormat } from "./chart-data";
import { DashboardWindowProvider } from "./dashboard-window";
import type { QueryResult, Widget } from "./schema";
import { EmbeddedWidgetProvider } from "./widget-presentation";

afterEach(cleanup);

type Series = NonNullable<QueryResult["series"]>[number];
const widget: Widget = { id: "requests", title: "Requests", type: "timeseries", providerId: "metrics", query: "requests", unit: "req", layout: { x: 0, y: 0, w: 6, h: 4 } };
/** Samples as [seconds, value]. A null value is an explicit missing sample. */
function line(name: string, samples: [number, number | null][]): Series {
  return { name, labels: { service: name }, points: samples.map(([seconds, value]) => ({ timestamp: seconds * 1000, value })) };
}
const plot = (...series: Series[]): QueryResult => ({ series });
const gapped = plot(line("api", [[1, 5], [2, 6], [3, 7], [7, 8], [8, 9]]));
const chartNamed = (title = widget.title) => screen.getByRole("img", { name: title });
const segments = (chart: Element) => [...chart.querySelectorAll('path[stroke-width="1.8"]')];
/** Vertex x positions of a rendered line segment, in SVG pixels. */
const xs = (path: Element) => [...path.getAttribute("d")!.matchAll(/[ML]([\d.e+-]+),/g)].map((match) => Number(match[1]));

describe("time-series gaps", () => {
  it("ends the line at an inferred gap and hatches the interval between its observed neighbours", () => {
    const { container } = render(<WidgetVisualization widget={widget} result={gapped} />);
    const [before, after] = segments(chartNamed());
    expect(segments(chartNamed())).toHaveLength(2);
    const band = container.querySelector<HTMLElement>("[data-no-sample-band]")!;
    expect(band).toHaveAttribute("data-from", "3000");
    expect(band).toHaveAttribute("data-to", "7000");
    expect(band).toHaveAttribute("role", "img");
    expect(band).toHaveAttribute("aria-label", `No samples from ${fullDateTimeFormat.format(new Date(3000))} to ${fullDateTimeFormat.format(new Date(7000))}`);
    expect(band).toHaveTextContent("No samples");
    expect(band.style.top).toBe("10px");
    expect(band.style.bottom).toBe("29px");
    // The band starts where the first segment ends and stops where the second begins: one x mapping for both.
    const left = parseFloat(band.style.left);
    expect(left).toBeCloseTo(xs(before).at(-1)!, 0);
    expect(left + parseFloat(band.style.width)).toBeCloseTo(xs(after)[0], 0);
  });

  it("treats an explicit null run as a gap between its observed neighbours", () => {
    const { container } = render(<WidgetVisualization widget={widget} result={plot(line("api", [[1, 5], [2, 6], [3, null], [4, null], [5, 8], [6, 9]]))} />);
    const bands = container.querySelectorAll("[data-no-sample-band]");
    expect(bands).toHaveLength(1);
    expect(bands[0]).toHaveAttribute("data-from", "2000");
    expect(bands[0]).toHaveAttribute("data-to", "5000");
    expect(segments(chartNamed())).toHaveLength(2);
  });

  it("breaks only the line of the series with the gap, and draws no band while another series covers that time", () => {
    const steady = line("steady", [[1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [8, 4]]);
    const { container } = render(<WidgetVisualization widget={widget} result={plot(line("api", [[1, 5], [2, 6], [3, 7], [7, 8], [8, 9]]), steady)} />);
    expect(container.querySelectorAll("[data-no-sample-band]")).toHaveLength(0);
    expect(segments(chartNamed())).toHaveLength(3);
  });

  it("marks a stale tail only for a complete result whose latest sample is older than two expected intervals", () => {
    const current = plot(line("api", [[1, 5], [2, 6], [3, 7], [4, 8], [5, 9]]));
    const view = (rangeEnd: number, result: QueryResult = current) => (
      <DashboardWindowProvider value={{ rangeEnd }}>
        <WidgetVisualization widget={widget} result={result} />
      </DashboardWindowProvider>
    );
    const { container, rerender } = render(view(20_000));
    const tail = container.querySelector<HTMLElement>("[data-stale-tail]")!;
    expect(tail).toHaveAttribute("data-from", "5000");
    expect(tail).toHaveAttribute("data-to", "20000");
    expect(tail).toHaveAttribute("aria-label", `No samples after ${fullDateTimeFormat.format(new Date(5000))}`);
    expect(within(tail).getByText(/No samples since/)).toBeInTheDocument();
    expect(screen.getByText(`Latest sample ${dateTimeFormat.format(new Date(5000))}, before the end of the range.`)).toBeInTheDocument();
    // The line stops where the tail starts, on the same extended time domain.
    expect(parseFloat(tail.style.left)).toBeCloseTo(xs(segments(chartNamed())[0]).at(-1)!, 0);
    // 1.5 s after the last sample is within two 1 s intervals, so nothing is stale yet.
    rerender(view(6_500));
    expect(container.querySelector("[data-stale-tail]")).toBeNull();
    // A truncated result may simply be missing the samples, so it never claims staleness.
    rerender(view(20_000, { ...current, truncated: true }));
    expect(container.querySelector("[data-stale-tail]")).toBeNull();
    expect(screen.queryByText(/before the end of the range/)).toBeNull();
  });

  it("keeps synthetic break points out of the legend, the data inspector and keyboard focus", () => {
    render(<WidgetVisualization widget={widget} result={gapped} />);
    const legend = screen.getByRole("list", { name: "Latest values by series" });
    expect(within(legend).getByLabelText(`api, latest valid sample: 9 req at ${new Date(8000).toISOString()}`)).toHaveAttribute("data-legend-timestamp", "8000");
    const chart = chartNamed();
    act(() => chart.focus());
    for (let step = 0; step < 3; step++) fireEvent.keyDown(chart, { key: "ArrowRight" });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.querySelector('[data-observation-timestamp="7000"]')).toBeInTheDocument();
    expect(document.querySelector('[data-observation-timestamp="5000"]')).toBeNull();
    act(() => chart.blur());
    fireEvent.click(screen.getByRole("button", { name: "Inspect chart data for Requests" }));
    const dialog = screen.getByRole("dialog", { name: "Requests data" });
    expect(within(dialog).getByText(new Date(7000).toISOString())).toBeInTheDocument();
    expect(within(dialog).queryByText(new Date(5000).toISOString())).toBeNull();
  });

  it("keeps the broken line but draws no bands inside embedded widgets", () => {
    const { container } = render(<EmbeddedWidgetProvider><WidgetVisualization widget={widget} result={gapped} /></EmbeddedWidgetProvider>);
    expect(container.querySelector("[data-no-sample-band]")).toBeNull();
    expect(segments(chartNamed())).toHaveLength(2);
  });

  it("places a shared cursor at each chart's own x for the same instant, whatever each chart's time span", () => {
    const short = line("short", [[1, 5], [2, 6], [3, 7], [4, 8], [5, 9]]);
    const long = line("long", Array.from({ length: 10 }, (_, index) => [index + 1, index + 1] as [number, number]));
    const { container } = render(
      <ChartCursorProvider>
        <WidgetVisualization widget={{ ...widget, id: "short", title: "Short" }} result={plot(short)} />
        <WidgetVisualization widget={{ ...widget, id: "long", title: "Long" }} result={plot(long)} />
      </ChartCursorProvider>,
    );
    const chart = chartNamed("Short");
    act(() => chart.focus());
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    const cursors = [...container.querySelectorAll<HTMLElement>('[data-chart-cursor-time="3000"]')];
    expect(cursors).toHaveLength(2);
    expect(parseFloat(cursors[0].style.left)).toBeCloseTo(xs(segments(chartNamed("Short"))[0])[2], 0);
    expect(parseFloat(cursors[1].style.left)).toBeCloseTo(xs(segments(chartNamed("Long"))[0])[2], 0);
  });
});

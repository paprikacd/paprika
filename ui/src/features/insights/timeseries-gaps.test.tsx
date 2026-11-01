import { readFileSync } from "node:fs";
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
/** The body of the first `prelude { … }` block, matching nested braces. */
function cssBlock(css: string, prelude: string) {
  const start = css.indexOf(prelude);
  expect(start, prelude).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index++) {
    if (css[index] === "{") depth++;
    else if (css[index] === "}" && --depth === 0) return css.slice(open + 1, index);
  }
  throw new Error(`Unclosed block: ${prelude}`);
}
/** The declarations of the first rule whose selector is exactly `selector`. */
function cssRule(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`(?:^|[\\s}])${escaped}\\s*\\{([^}]*)\\}`, "m"))?.[1] ?? "";
}

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

  // Review repro: samples at 1, 2, 3, 10, 20, 21 and 22 s. The sample at 10 s is isolated.
  const isolated = plot(line("api", [[1, 5], [2, 6], [3, 7], [10, 8], [20, 9], [21, 9], [22, 9]]));
  const intervalItems = (container: HTMLElement) => [...container.querySelectorAll("[data-gap-intervals] li")].map((item) => item.textContent);

  it("splits the hole at an isolated sample, so two bands replace one band across it", () => {
    const { container } = render(<WidgetVisualization widget={widget} result={isolated} />);
    const bands = [...container.querySelectorAll<HTMLElement>("[data-no-sample-band]")];
    expect(bands.map((band) => [band.getAttribute("data-from"), band.getAttribute("data-to")])).toEqual([["3000", "10000"], ["10000", "20000"]]);
    expect(bands[0]).toHaveAttribute("aria-label", `No samples from ${fullDateTimeFormat.format(new Date(3000))} to ${fullDateTimeFormat.format(new Date(10000))}`);
    expect(bands[1]).toHaveAttribute("aria-label", `No samples from ${fullDateTimeFormat.format(new Date(10000))} to ${fullDateTimeFormat.format(new Date(20000))}`);
    const intervals = container.querySelector<HTMLElement>("[data-gap-intervals]")!;
    expect(within(intervals).getByText("No samples in 2 intervals")).toBeInTheDocument();
    expect(intervalItems(container)).toEqual([
      `${dateTimeFormat.format(new Date(3000))}–${dateTimeFormat.format(new Date(10000))}`,
      `${dateTimeFormat.format(new Date(10000))}–${dateTimeFormat.format(new Date(20000))}`,
    ]);
  });

  it("draws a dot on the isolated sample only, never on every sample of the series", () => {
    const { container } = render(<WidgetVisualization widget={widget} result={isolated} />);
    const chart = chartNamed();
    const dots = chart.querySelectorAll("circle");
    expect(dots).toHaveLength(1);
    // The dot sits on the isolated sample's own x, which is the single-sample segment in the middle.
    expect(Number(dots[0].getAttribute("cx"))).toBeCloseTo(xs(segments(chart)[1])[0], 0);
    expect(container.querySelectorAll("[data-no-sample-band]")).toHaveLength(2);
  });

  it("keeps one dot for one isolated sample in a long series, not one per sample", () => {
    const samples: [number, number | null][] = [];
    for (let second = 0; second < 100; second++) samples.push([second, second % 7]);
    samples.push([110, 3]);
    for (let second = 120; second < 200; second++) samples.push([second, second % 5]);
    render(<WidgetVisualization widget={widget} result={plot(line("api", samples))} />);
    expect(chartNamed().querySelectorAll("circle")).toHaveLength(1);
  });

  it("visits each observation exactly once from the keyboard, including the isolated one", () => {
    render(<WidgetVisualization widget={widget} result={isolated} />);
    const chart = chartNamed();
    const observed = () => screen.queryByRole("tooltip")?.querySelector("[data-observation-timestamp]")?.getAttribute("data-observation-timestamp") ?? null;
    act(() => chart.focus());
    const visited = [observed()];
    for (let step = 0; step < 6; step++) {
      fireEvent.keyDown(chart, { key: "ArrowRight" });
      visited.push(observed());
    }
    expect(visited).toEqual(["1000", "2000", "3000", "10000", "20000", "21000", "22000"]);
  });

  it("draws no bands and no stale tail for a truncated result, and says the gaps are not shown", () => {
    const truncated = { ...gapped, truncated: true };
    const view = (result: QueryResult) => (
      <DashboardWindowProvider value={{ rangeEnd: 20_000 }}>
        <WidgetVisualization widget={widget} result={result} />
      </DashboardWindowProvider>
    );
    const { container, rerender } = render(view(truncated));
    expect(container.querySelector("[data-no-sample-band]")).toBeNull();
    expect(container.querySelector("[data-stale-tail]")).toBeNull();
    expect(screen.getByText("Gaps not shown: the provider result was truncated")).toBeInTheDocument();
    rerender(view(gapped));
    expect(container.querySelectorAll("[data-no-sample-band]")).toHaveLength(1);
    expect(screen.queryByText("Gaps not shown: the provider result was truncated")).toBeNull();
  });

  it("decides where data is missing from every series in the result, not only the first twelve plotted", () => {
    // Twelve plotted series that report one sample each, then a thirteenth that covers the 3-7 s gap.
    const others = Array.from({ length: 11 }, (_, index) => line(`steady-${index}`, [[1, 1]]));
    const covering = line("cover", Array.from({ length: 8 }, (_, index) => [index + 1, 1] as [number, number]));
    const { container } = render(<WidgetVisualization widget={widget} result={plot(line("api", [[1, 5], [2, 6], [3, 7], [7, 8], [8, 9]]), ...others, covering)} />);
    expect(screen.getByText(/First 12 of 13 series/)).toBeInTheDocument();
    expect(container.querySelectorAll("[data-no-sample-band]")).toHaveLength(0);
  });

  it("takes the stale tail's last sample from every series in the result", () => {
    const others = Array.from({ length: 11 }, (_, index) => line(`steady-${index}`, [[1, 1]]));
    const late = line("late", Array.from({ length: 9 }, (_, index) => [index + 1, 1] as [number, number]));
    const { container } = render(
      <DashboardWindowProvider value={{ rangeEnd: 20_000 }}>
        <WidgetVisualization widget={widget} result={plot(line("api", [[1, 5], [2, 6], [3, 7], [4, 8], [5, 9]]), ...others, late)} />
      </DashboardWindowProvider>,
    );
    const tail = container.querySelector<HTMLElement>("[data-stale-tail]")!;
    expect(tail).toHaveAttribute("data-from", "9000");
    expect(screen.getByText(`Latest sample ${dateTimeFormat.format(new Date(9000))}, before the end of the range.`)).toBeInTheDocument();
  });

  it("lists the stale tail with the other no-sample intervals", () => {
    const view = (
      <DashboardWindowProvider value={{ rangeEnd: 20_000 }}>
        <WidgetVisualization widget={widget} result={plot(line("api", [[1, 5], [2, 6], [3, 7], [4, 8], [5, 9]]))} />
      </DashboardWindowProvider>
    );
    const { container } = render(view);
    const intervals = container.querySelector<HTMLElement>("[data-gap-intervals]")!;
    expect(within(intervals).getByText("No samples in 1 interval")).toBeInTheDocument();
    expect(intervalItems(container)).toEqual([`${dateTimeFormat.format(new Date(5000))}–${dateTimeFormat.format(new Date(20000))}, after the latest sample`]);
  });

  it("keeps the dot of an isolated sample that downsampling would otherwise drop, so every band split still has its dot", () => {
    // Review repro: 2000 samples at 1 s. Samples 900..999 are missing except 950 s, whose value sits between the extremes.
    const samples: [number, number | null][] = [];
    for (let second = 1; second <= 2000; second++) {
      if (second >= 900 && second < 1000 && second !== 950) continue;
      samples.push([second, second === 950 ? 5 : (second % 7) + (second % 3)]);
    }
    const { container } = render(<WidgetVisualization widget={widget} result={plot(line("api", samples))} />);
    const bands = [...container.querySelectorAll<HTMLElement>("[data-no-sample-band]")];
    expect(bands.map((band) => [band.getAttribute("data-from"), band.getAttribute("data-to")])).toEqual([["899000", "950000"], ["950000", "1000000"]]);
    expect(chartNamed().querySelectorAll("circle")).toHaveLength(1);
  });

  it("draws a no-sample label only on a band at least as wide as the label, and keeps the band's times in its aria-label either way", () => {
    // Samples at 1-20 s and 35-100 s leave a 15 s hole, about 66px in a 434px plot: wider than the old 56px rule, but
    // narrower than the 74px that "No samples" needs, so it must not be labelled.
    const narrowSamples: [number, number][] = [
      ...Array.from({ length: 20 }, (_, index) => [index + 1, 5] as [number, number]),
      ...Array.from({ length: 66 }, (_, index) => [index + 35, 5] as [number, number]),
    ];
    const narrow = render(<WidgetVisualization widget={widget} result={plot(line("api", narrowSamples))} />);
    const narrowBand = narrow.container.querySelector<HTMLElement>("[data-no-sample-band]")!;
    // "No samples" is estimated at 74px (10 characters at 6.6px, plus 8px of padding).
    expect(parseFloat(narrowBand.style.width)).toBeLessThan(74);
    expect(within(narrowBand).queryByText("No samples")).toBeNull();
    expect(narrowBand).toHaveAttribute("aria-label", `No samples from ${fullDateTimeFormat.format(new Date(20000))} to ${fullDateTimeFormat.format(new Date(35000))}`);
    narrow.unmount();
    // The 3-7 s hole in the shared fixture is wide enough for its label.
    const { container } = render(<WidgetVisualization widget={widget} result={gapped} />);
    const wideBand = container.querySelector<HTMLElement>("[data-no-sample-band]")!;
    expect(parseFloat(wideBand.style.width)).toBeGreaterThanOrEqual(74);
    expect(within(wideBand).getByText("No samples")).toBeInTheDocument();
  });

  it("omits the stale tail's label when the tail is too narrow to hold it, and keeps the tail in its aria-label and interval list", () => {
    // A 30 s tail after 1-100 s of samples is about 101px in a 434px plot. The label needs about 153px, so it is clipped
    // and must be left out. The tail keeps its aria-label and its interval entry.
    const samples = Array.from({ length: 100 }, (_, index) => [index + 1, 5] as [number, number]);
    const { container } = render(
      <DashboardWindowProvider value={{ rangeEnd: 130_000 }}>
        <WidgetVisualization widget={widget} result={plot(line("api", samples))} />
      </DashboardWindowProvider>,
    );
    const tail = container.querySelector<HTMLElement>("[data-stale-tail]")!;
    // "No samples since 00:01" is estimated at 153px (22 characters), so the 101px tail cannot hold it.
    expect(parseFloat(tail.style.width)).toBeLessThan(153.2);
    expect(within(tail).queryByText(/No samples since/)).toBeNull();
    expect(tail).toHaveAttribute("aria-label", `No samples after ${fullDateTimeFormat.format(new Date(100_000))}`);
    expect(intervalItems(container)).toEqual([`${dateTimeFormat.format(new Date(100_000))}–${dateTimeFormat.format(new Date(130_000))}, after the latest sample`]);
  });

  it("closes an open interval list with Escape and returns focus to its summary", () => {
    const { container } = render(<WidgetVisualization widget={widget} result={isolated} />);
    const details = container.querySelector<HTMLDetailsElement>("[data-gap-intervals]")!;
    const summary = within(details).getByText("No samples in 2 intervals");
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    fireEvent.keyDown(within(details).getByRole("list", { name: "No-sample intervals" }), { key: "Escape" });
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);
  });
});

describe("time-series footer layout", () => {
  it("floats the open interval list above the footer, so the footer and the plot keep their height whether it is open or closed", () => {
    const { container } = render(<WidgetVisualization widget={widget} result={plot(line("api", [[1, 5], [2, 6], [3, 7], [10, 8], [20, 9], [21, 9], [22, 9]]))} />);
    const details = container.querySelector<HTMLElement>("[data-gap-intervals]")!;
    expect(within(details).getByRole("list", { name: "No-sample intervals" })).toHaveAttribute("data-gap-list");
    expect(details.closest("[data-chart-footer]")).not.toBeNull();
    // happy-dom measures no layout, so the claim is checked against the stylesheet: the list is out of flow, and the
    // plot sizes itself from the footer's in-flow height, which the list no longer contributes to.
    const css = readFileSync("src/features/insights/charts.module.css", "utf8");
    const list = cssRule(css, ".gapDetails > ul");
    expect(list).toMatch(/position:\s*absolute;/);
    expect(list).toMatch(/bottom:\s*calc\(100% \+ 4px\);/);
    expect(list).toMatch(/max-height:\s*96px;/);
    expect(list).toMatch(/overflow:\s*auto;/);
    expect(list).toMatch(/background:\s*var\(--gamma-surface,/);
    expect(list).toMatch(/border:\s*1px solid var\(--gamma-border,/);
    expect(list).toMatch(/box-shadow:\s*var\(--gamma-shadow-mid\);/);
    expect(cssRule(css, ".chartFooter")).toMatch(/position:\s*relative;/);
    expect(cssRule(css, ".chartFooter")).toMatch(/flex-shrink:\s*0;/);
    expect(cssRule(css, ".chart")).toMatch(/height:\s*100%;/);
    expect(cssRule(css, ".plot")).toMatch(/flex:\s*1;/);
  });

  it("lets narrow footers wrap the notices and the disclosure onto full rows above the action buttons", () => {
    const css = readFileSync("src/features/insights/charts.module.css", "utf8");
    const narrow = cssBlock(css, "@container insight-widget (max-width: 480px)");
    expect(narrow).toMatch(/\.chartFooter\s*\{[^}]*flex-wrap:\s*wrap;/);
    expect(narrow).toMatch(/\.chartFooter > \.notice,\s*\.chartFooter > \.gapDetails\s*\{[^}]*flex:\s*1 1 100%;/);
  });
});

describe("threshold guide labels", () => {
  const guided: Widget = { id: "requests", title: "Requests", type: "timeseries", providerId: "metrics", query: "requests", unit: "req", layout: { x: 0, y: 0, w: 6, h: 4 } };
  const samples = Array.from({ length: 9 }, (_, index) => ({ timestamp: (index + 1) * 1000, value: index + 1 }));

  it("sets each label at the left end of its line, dropping it below only when no room is left above", () => {
    const configured = { ...guided, options: { thresholds: [{ value: 9, color: "#b64a3a", label: "Ceiling" }, { value: 4, color: "#53876a", label: "Target" }] } };
    render(<WidgetVisualization widget={configured} result={{ series: [{ name: "api", labels: {}, points: samples }] }} />);
    const ceiling = screen.getByRole("img", { name: "Ceiling: 9 req" });
    const target = screen.getByRole("img", { name: "Target: 4 req" });
    // The ceiling sits within 16px of the plot top, so its label moves below the line.
    expect(ceiling).toHaveAttribute("data-label-placement", "below");
    expect(target).toHaveAttribute("data-label-placement", "above");
    expect(within(ceiling).getByText("Ceiling")).toBeInTheDocument();
    expect(within(target).getByText("Target")).toBeInTheDocument();
  });
});

describe("time-series styling tokens", () => {
  it("falls back to the light theme's muted and ink tokens, so an unthemed chart keeps the same contrast", () => {
    // Vitest runs from ui/, the same way insights-theme.test.tsx reads the theme file.
    const css = readFileSync("src/features/insights/charts.module.css", "utf8");
    const theme = readFileSync("src/features/insights/gamma/gamma-theme.module.css", "utf8");
    const lightToken = (name: string) => theme.match(new RegExp(`${name}: (#[0-9a-fA-F]{6});`))?.[1].toLowerCase();
    const fallbacks = (name: string) => new Set([...css.matchAll(new RegExp(`var\\(--gamma-${name}, (#[0-9a-fA-F]{6})\\)`, "g"))].map((match) => match[1].toLowerCase()));
    expect(fallbacks("muted")).toEqual(new Set([lightToken("--gamma-muted")]));
    expect(fallbacks("ink")).toEqual(new Set([lightToken("--gamma-ink")]));
    expect(css).not.toMatch(/#626e65|#697c73|#27332e/);
  });

  it("falls back to the light theme's border and chart grid values in the renderer's gridlines", () => {
    const source = readFileSync("src/features/insights/chart-renderers.tsx", "utf8");
    const theme = readFileSync("src/features/insights/gamma/gamma-theme.module.css", "utf8");
    const lightToken = (name: string) => theme.match(new RegExp(`${name}: (#[0-9a-fA-F]{6});`))?.[1].toLowerCase();
    // The theme's grid fallback ends in the light border; the two gridline strokes end in the light chart grid.
    expect(source).toContain(`grid: "var(--gamma-chart-grid, var(--gamma-border, ${lightToken("--gamma-border")}))",`);
    const strokes = [...source.matchAll(/stroke: "var\(--gamma-chart-grid, var\(--gamma-border, (#[0-9a-fA-F]{6})\)\)"/g)].map((match) => match[1].toLowerCase());
    expect(strokes).toEqual([lightToken("--gamma-chart-grid"), lightToken("--gamma-chart-grid")]);
  });
});

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetVisualization } from "./charts";
import { BuiltinWidgetRenderer } from "./chart-renderers";
import { EmbeddedWidgetProvider } from "./widget-presentation";
import type { QueryResult, Widget } from "./schema";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const widget: Widget = {
  id: "capacity",
  title: "Pod capacity",
  type: "bar",
  providerId: "metrics",
  query: "capacity",
  unit: "%",
  layout: { x: 0, y: 0, w: 6, h: 4 },
};

/** One series per pod; `null` is a sample with no value, so `[null]` has no valid sample. */
function podSeries(name: string, values: Array<number | null>) {
  return {
    name,
    labels: { pod: name },
    points: values.map((value, index) => ({ timestamp: 1000 * (index + 1), value })),
  };
}

const barRect = (container: HTMLElement, key: string) =>
  container.querySelector(`g[data-ts-key="${key}"] rect`);
/** Horizontal centre of a bar or placeholder, to compare with its band's tick label. */
const centre = (rect: Element) => Number(rect.getAttribute("x")) + Number(rect.getAttribute("width")) / 2;
/** The plot area: the clip rectangle TanStack draws around the marks. */
const plotArea = (container: HTMLElement) =>
  container.querySelector('defs[data-ts-key="marks:clip-defs"] rect')!;
const yTickLabels = (container: HTMLElement) =>
  [...container.querySelectorAll('text[data-ts-key^="y-tick-label:"]')].map((node) => node.textContent);

describe("bar chart series with no valid sample", () => {
  it.each([
    { position: "first", names: ["worker", "api", "db"] },
    { position: "middle", names: ["api", "worker", "db"] },
    { position: "last", names: ["api", "db", "worker"] },
  ])("keeps every series in its own band in series order when the empty series is $position", ({ names }) => {
    const { container } = render(
      <WidgetVisualization widget={widget} result={{ series: names.map((name) => podSeries(name, name === "worker" ? [null] : [5])) }} />,
    );
    const ticks = [...container.querySelectorAll('text[data-ts-key^="x-tick-label:"]')];
    expect(ticks.map((node) => node.textContent)).toEqual(names);
    const centres = ticks.map((node) => Number(node.getAttribute("x")));
    // Valid bars are centred on their own tick, and the placeholder on the empty series' tick.
    const bars = [...container.querySelectorAll('g[data-ts-key="bar-y-0"] rect')];
    expect(bars).toHaveLength(2);
    bars.forEach((bar, index) => {
      const name = names.filter((candidate) => candidate !== "worker")[index];
      expect(centre(bar)).toBeCloseTo(centres[names.indexOf(name)], 1);
    });
    expect(centre(barRect(container, "no-data")!)).toBeCloseTo(centres[names.indexOf("worker")], 1);
  });

  it("lists the empty series in the legend with No data and draws no bar for it", () => {
    const { container } = render(
      <WidgetVisualization widget={widget} result={{ series: [podSeries("api", [5, 10]), podSeries("worker", [null])] }} />,
    );
    expect(container.querySelectorAll('g[data-ts-key="bar-y-0"] rect')).toHaveLength(1);
    const legend = screen.getByRole("list", { name: "Latest values by category" });
    const empty = within(legend).getByRole("listitem", { name: /worker/ });
    expect(empty).toHaveAttribute("data-no-data-series", "worker");
    expect(empty).toHaveTextContent("No data");
    expect(within(legend).getByRole("listitem", { name: /api/ })).toHaveTextContent("10.0%");
  });

  it("never focuses the empty slot: keyboard navigation visits only the valid bars", () => {
    render(
      <WidgetVisualization widget={widget} result={{ series: [podSeries("api", [5, 10]), podSeries("worker", [null]), podSeries("db", [4])] }} />,
    );
    const chart = screen.getByRole("img", { name: widget.title });
    const observed = () => screen.getByRole("tooltip").querySelector("[data-observation-series]")?.getAttribute("data-observation-series");
    act(() => chart.focus());
    const visited = [observed()];
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    visited.push(observed());
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    visited.push(observed());
    expect(visited).toEqual(["api", "db", "api"]);
  });

  /** Points at the centre of one series' slot, at mid-height of a 500x180 chart. */
  const hoverSlot = (name: string) => {
    const { container } = render(
      <WidgetVisualization widget={widget} result={{ series: [podSeries("api", [5, 10]), podSeries("worker", [null]), podSeries("db", [4])] }} />,
    );
    const chart = screen.getByRole("img", { name: widget.title });
    vi.spyOn(chart, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 180));
    const clientX = Number([...container.querySelectorAll('text[data-ts-key^="x-tick-label:"]')].find((node) => node.textContent === name)?.getAttribute("x"));
    fireEvent.pointerMove(chart, { clientX, clientY: 90 });
  };

  it("shows the tooltip of a valid bar when the pointer is over its slot", () => {
    hoverSlot("api");
    expect(screen.getByRole("tooltip").querySelector("[data-observation-series]")).toHaveAttribute("data-observation-series", "api");
  });

  it("shows no tooltip when the pointer is over the empty slot", () => {
    hoverSlot("worker");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it.each([
    { presentation: "with an axis", showAxis: true, values: [7] },
    { presentation: "without an axis", showAxis: false, values: [7] },
    { presentation: "with an axis, negative", showAxis: true, values: [-7] },
    { presentation: "without an axis, mixed signs", showAxis: false, values: [7, -3] },
  ])("keeps the y domain TanStack chooses without the empty series, $presentation", ({ showAxis, values }) => {
    // At 300px TanStack nices to 4 ticks with an axis and 5 without one, so a value of 7 gets domains [0, 8] and [0, 7].
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 500, 300));
    const host = (result: QueryResult) => {
      const chart = <WidgetVisualization widget={widget} result={result} />;
      return showAxis ? chart : <EmbeddedWidgetProvider showAxis={false}>{chart}</EmbeddedWidgetProvider>;
    };
    const valid = values.map((value, index) => podSeries(`pod-${index}`, [value]));
    const plain = render(host({ series: valid }));
    const withEmpty = render(host({ series: [...valid, podSeries("worker", [null])] }));
    const geometry = (container: HTMLElement) =>
      [...container.querySelectorAll('g[data-ts-key="bar-y-0"] rect')].map((rect) => [rect.getAttribute("y"), rect.getAttribute("height")]);
    expect(geometry(plain.container)).toHaveLength(values.length);
    expect(geometry(withEmpty.container)).toEqual(geometry(plain.container));
    expect(yTickLabels(withEmpty.container)).toEqual(yTickLabels(plain.container));
    expect(barRect(withEmpty.container, "no-data")).toHaveAttribute("height", plotArea(withEmpty.container).getAttribute("height"));
  });

  it("draws a hatched placeholder over the full plot height in the empty slot", () => {
    const { container } = render(
      <WidgetVisualization widget={widget} result={{ series: [podSeries("api", [10]), podSeries("db", [4]), podSeries("worker", [null])] }} />,
    );
    const placeholder = barRect(container, "no-data")!;
    const plot = plotArea(container);
    expect(placeholder).toHaveAttribute("y", plot.getAttribute("y"));
    expect(placeholder).toHaveAttribute("height", plot.getAttribute("height"));
    expect(Number(placeholder.getAttribute("height"))).toBeGreaterThan(0);
    // The highest valid bar (10) sets the domain top, which is where the placeholder starts.
    expect(barRect(container, "bar-y-0")).toHaveAttribute("y", plot.getAttribute("y"));
    expect(placeholder.getAttribute("fill")).toMatch(/^url\(#.+-hatch\)$/);
    const pattern = document.getElementById(placeholder.getAttribute("fill")!.slice(5, -1));
    expect(pattern?.tagName.toLowerCase()).toBe("pattern");
    // The hatch SVG renders after the chart, so the chart is still the first SVG in the widget.
    expect(container.querySelector("svg")).toHaveAttribute("role", "img");
  });

  it("keeps an explicit axis range and still spans the empty slot's full height", () => {
    const { container } = render(
      <WidgetVisualization widget={{ ...widget, options: { min: 0, max: 20 } }} result={{ series: [podSeries("api", [10]), podSeries("worker", [null])] }} />,
    );
    const plot = plotArea(container);
    const half = Number(plot.getAttribute("height")) / 2;
    expect(Math.abs(Number(barRect(container, "bar-y-0")!.getAttribute("height")) - half)).toBeLessThan(0.5);
    expect(barRect(container, "no-data")).toHaveAttribute("height", plot.getAttribute("height"));
  });

  it.each([
    { empty: ["worker"], sentence: "1 series has no valid sample in this range." },
    { empty: ["worker", "db"], sentence: "2 series have no valid sample in this range." },
  ])("adds the count of empty series to the accessible description: $sentence", ({ empty, sentence }) => {
    const { container } = render(
      <WidgetVisualization
        widget={widget}
        result={{ series: [podSeries("api", [5]), ...empty.map((name) => podSeries(name, [null]))] }}
      />,
    );
    expect(container.querySelector("desc")).toHaveTextContent(`Latest value for each series. Use arrow keys to explore values. ${sentence}`);
  });

  it("adds the notice to the description of an embedded chart, next to its sub-widget text", () => {
    render(
      <>
        <p id="sub-description">Latest sample: api 10%.</p>
        <EmbeddedWidgetProvider showAxis={false} descriptionId="sub-description">
          <WidgetVisualization widget={widget} result={{ series: [podSeries("api", [5, 10]), podSeries("worker", [null])] }} />
        </EmbeddedWidgetProvider>
      </>,
    );
    expect(screen.getByRole("img", { name: widget.title })).toHaveAccessibleDescription("Latest sample: api 10%. 1 series has no valid sample in this range.");
  });

  it("leaves charts without an empty series unchanged: no placeholder, no hatch, no extra description", () => {
    const { container } = render(
      <WidgetVisualization widget={widget} result={{ series: [podSeries("api", [5, 10]), podSeries("db", [4])] }} />,
    );
    expect(container.querySelector('g[data-ts-key="no-data"]')).toBeNull();
    expect(container.querySelector("pattern")).toBeNull();
    expect(container.querySelector("[data-no-data-series]")).toBeNull();
    expect(container.querySelector("desc")).toHaveTextContent(
      /^Latest value for each series\. Use arrow keys to explore values\.$/,
    );
  });

  it("explains an empty series in the data dialog", () => {
    render(
      <WidgetVisualization widget={widget} result={{ series: [podSeries("api", [5]), podSeries("worker", [null])] }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Inspect chart data for Pod capacity" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("combobox", { name: "Data series" }));
    fireEvent.click(screen.getByRole("option", { name: "worker" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("No valid samples for this series.");
  });

  it("draws a placeholder for every slot when BarChart receives only empty series, never a zero-height bar", () => {
    const { container } = render(
      <BuiltinWidgetRenderer widget={widget} result={{ series: [podSeries("api", [null]), podSeries("db", [null])] }} />,
    );
    expect(container.querySelectorAll('g[data-ts-key="bar-y-0"] rect')).toHaveLength(0);
    const placeholders = container.querySelectorAll('g[data-ts-key="no-data"] rect');
    expect(placeholders).toHaveLength(2);
    for (const placeholder of placeholders)
      expect(Number(placeholder.getAttribute("height"))).toBeGreaterThan(0);
  });
});

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Widget } from "./schema";
import type { DrilldownContext } from "./drilldown";
import { BarChart } from "./bar-chart";

// Capture the props the bar hands to TanStack's Chart, so a test can deliver the exact
// focus and selection callbacks that hover, keyboard and click deliver in a browser.
const captured = vi.hoisted(() => ({ props: null as null | Record<string, (...args: unknown[]) => unknown> }));
vi.mock("@tanstack/charts/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/charts/react")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    Chart: (props: Record<string, unknown>) => {
      captured.props = props as Record<string, (...args: unknown[]) => unknown>;
      return createElement(actual.Chart, props as never);
    },
  };
});

const bar: Widget = {
  id: "traffic",
  title: "Traffic",
  type: "bar",
  providerId: "prom",
  query: "traffic",
  unit: "ms",
  layout: { x: 0, y: 0, w: 6, h: 4 },
  selectionBindings: [{ variable: "service", source: "label", value: "service" }],
};
const series = [
  { name: "api", labels: { service: "api" }, points: [{ timestamp: 1000, value: 7 }] },
  { name: "worker", labels: { service: "worker" }, points: [{ timestamp: 1000, value: 12 }] },
];
// A point as TanStack reports it for the bar at `index`; only the datum fields the bar reads are real.
const barPoint = (index: number) => ({ key: `bar-${index}`, x: 0, y: 0, color: "", datum: { seriesIndex: index, timestamp: 1000, value: series[index].points[0].value, name: series[index].name } });

afterEach(() => {
  cleanup();
  captured.props = null;
});

function setup(options: Partial<Widget["options"]> = {}, handlers: { onContextChange?: (context: DrilldownContext) => void; onActivate?: (context: DrilldownContext) => void } = {}) {
  const { container } = render(
    <BarChart widget={{ ...bar, options: { ...options } }} series={series} onContextChange={handlers.onContextChange} onActivate={handlers.onActivate} />,
  );
  const svg = container.querySelector("svg")!;
  act(() => captured.props!.onRender?.({ svg, scene: { width: 300, height: 200, points: [] }, interaction: { setControlledFocus: vi.fn() } }));
  return { container, svg };
}

describe("a bar's drilldown context follows keyboard focus, not pointer hover", () => {
  it("pointer-driven focus on a bar leaves the drilldown context unchanged", () => {
    const onContextChange = vi.fn();
    const { svg } = setup({}, { onContextChange });
    fireEvent.pointerMove(svg);
    act(() => captured.props!.onFocusChange!(barPoint(0)));
    expect(onContextChange).not.toHaveBeenCalled();
  });

  it("keyboard focus on a bar sets the drilldown context", () => {
    const onContextChange = vi.fn();
    const { svg } = setup({}, { onContextChange });
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    onContextChange.mockClear();
    act(() => captured.props!.onFocusChange!(barPoint(1)));
    expect(onContextChange).toHaveBeenCalledOnce();
    expect(onContextChange).toHaveBeenCalledWith(expect.objectContaining({ series: "worker", labels: { service: "worker" } }));
  });

  it("leaving the plot makes the next focus change count as keyboard input again", () => {
    const onContextChange = vi.fn();
    const { svg } = setup({}, { onContextChange });
    fireEvent.pointerMove(svg);
    // React derives onPointerLeave for every ancestor from pointerout, so this leaves the plot.
    fireEvent.pointerOut(svg, { relatedTarget: null });
    act(() => captured.props!.onFocusChange!(barPoint(0)));
    expect(onContextChange).toHaveBeenCalledOnce();
  });
});

describe("a bar selection activates the bar whether or not its tooltip is shown", () => {
  it("activates the bar with its tooltip hidden", () => {
    const onActivate = vi.fn();
    setup({ showTooltip: false }, { onActivate });
    act(() => captured.props!.onSelect!(barPoint(1)));
    expect(onActivate).toHaveBeenCalledOnce();
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ series: "worker", labels: { service: "worker" } }));
  });

  it("a selection also sets the drilldown context", () => {
    const onContextChange = vi.fn();
    const onActivate = vi.fn();
    setup({}, { onContextChange, onActivate });
    act(() => captured.props!.onSelect!(barPoint(0)));
    expect(onContextChange).toHaveBeenCalledWith(expect.objectContaining({ series: "api" }));
    expect(onActivate).toHaveBeenCalledWith(expect.objectContaining({ series: "api" }));
  });
});

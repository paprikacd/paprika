import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WidgetVisualization } from "./charts";
import type { QueryResult, Widget } from "./schema";

// Layout is mocked here, so the fit is exercised without a browser. A value's text is 0.6em per character, and a value's
// box is its grid cell: the plot width divided by the columns the cells element currently declares.
const CHARACTER_EM = 0.6;
const DEFAULT_VALUE_PX = 21;
const VALUE = 1234567.891;

let plotWidth = 1500;
let observers: Array<{ callback: ResizeObserverCallback; element?: Element }> = [];
const originalGetComputedStyle = window.getComputedStyle;
const originalRange = Range.prototype.getBoundingClientRect;

function rect(width: number, height: number): DOMRect {
  return new DOMRect(0, 0, width, height);
}

function fontPx(element: Element): number {
  const inline = (element as HTMLElement).style?.fontSize;
  return Number.parseFloat(inline) || DEFAULT_VALUE_PX;
}

function columnsOf(element: Element): number {
  const grid = element.closest<HTMLElement>('[role="group"]');
  return Number(/repeat\((\d+)/.exec(grid?.style.getPropertyValue("grid-template-columns") ?? "")?.[1] ?? 1);
}

function naturalWidth(value: HTMLElement): number {
  return (value.textContent?.length ?? 0) * CHARACTER_EM * fontPx(value);
}

function heatmap(series: number) {
  const widget: Widget = {
    id: "fit",
    title: "Fit",
    type: "heatmap",
    providerId: "prometheus",
    query: "fit",
    unit: "ms",
    layout: { x: 0, y: 0, w: 6, h: 4 },
    options: { decimals: 3, showLabels: false, showValues: true, showLegend: false },
  };
  const result: QueryResult = {
    series: Array.from({ length: series }, (_, index) => ({
      name: `svc-${index}`,
      labels: { service: `svc-${index}` },
      points: [{ timestamp: 1000, value: VALUE }],
    })),
  };
  return { widget, result };
}

beforeEach(() => {
  observers = [];
  vi.stubGlobal("ResizeObserver", class {
    entry: { callback: ResizeObserverCallback; element?: Element };
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback };
      observers.push(this.entry);
    }
    observe(element: Element) { this.entry.element = element; }
    unobserve() {}
    disconnect() {}
  });
  // Only value elements read their own inline size, which is what the CSS and the fit write.
  vi.stubGlobal("getComputedStyle", (element: Element, pseudo?: string | null) => {
    const style = originalGetComputedStyle.call(window, element, pseudo);
    if (!(element as HTMLElement).hasAttribute?.("data-heatmap-value")) return style;
    return new Proxy(style, { get: (target, key) => (key === "fontSize" ? `${fontPx(element)}px` : Reflect.get(target, key)) });
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute("data-heatmap-value")) return rect(plotWidth / columnsOf(this), 20);
    return rect(plotWidth, 180);
  });
  Range.prototype.getBoundingClientRect = function (this: Range) {
    const node = this.startContainer as Element;
    return rect(((node.textContent ?? "").length) * CHARACTER_EM * fontPx(node), 20);
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Range.prototype.getBoundingClientRect = originalRange;
});

function notifyResize(cells: Element) {
  act(() => {
    for (const entry of observers) if (entry.element === cells) entry.callback([], {} as ResizeObserver);
  });
}

describe("useHeatmapValueFit through the heatmap", () => {
  it("writes an inline size that fits a value's measured text into its cell", () => {
    plotWidth = 120;
    const { widget, result } = heatmap(1);
    const { container } = render(<WidgetVisualization widget={widget} result={result} />);
    const value = container.querySelector<HTMLElement>("[data-heatmap-value]")!;
    expect(value.textContent!.length).toBeGreaterThan(12);
    const size = Number.parseFloat(value.style.fontSize);
    expect(size).toBeGreaterThan(10);
    expect(size).toBeLessThan(DEFAULT_VALUE_PX);
    expect(naturalWidth(value)).toBeLessThanOrEqual(120 + 0.01);
  });

  it("refits every value after a resize that changes the column count, before the next paint", () => {
    plotWidth = 1500;
    const { widget, result } = heatmap(6);
    const { container } = render(<WidgetVisualization widget={widget} result={result} />);
    const cells = container.querySelector<HTMLElement>('[role="group"]')!;
    expect(columnsOf(cells.querySelector("[data-heatmap-value]")!)).toBe(6);

    // Two columns of 150px: the ResizeObserver fires on the old six-column layout, then the cells re-render with two.
    plotWidth = 300;
    notifyResize(cells);

    expect(cells.style.getPropertyValue("grid-template-columns")).toContain("repeat(2");
    for (const value of cells.querySelectorAll<HTMLElement>("[data-heatmap-value]")) {
      const size = Number.parseFloat(value.style.fontSize);
      expect(size, value.textContent ?? "").toBeGreaterThan(12);
      expect(size).toBeLessThan(DEFAULT_VALUE_PX);
      expect(naturalWidth(value)).toBeLessThanOrEqual(150 + 0.01);
    }
  });
});

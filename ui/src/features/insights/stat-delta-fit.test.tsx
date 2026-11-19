import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetVisualization } from "./charts";
import { DashboardWindowProvider } from "./dashboard-window";
import { StatComparisonContext, type StatComparisonState } from "./stat-comparison";
import type { QueryResult, Widget } from "./schema";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
});

const base = { id: "rate", title: "Requests", type: "stat", providerId: "p", query: "q", unit: "req/s", layout: { x: 0, y: 0, w: 3, h: 2 } } as const;
const one = (value: number, timestamp = 1_000_000): QueryResult => ({ series: [{ name: "api", labels: {}, points: [{ timestamp, value }] }] });
const widget = { ...base, options: { decimals: 0 } } as unknown as Widget;
// An up change of 12 % against an earlier sample, with its own window: the reading is 112 and the change reads "+12%".
const comparison: StatComparisonState = {
  window: "previous",
  good: "up",
  span: 3_600_000,
  unit: "req/s",
  decimals: 0,
  outcome: { state: "ok", current: { timestamp: 1_000_000, value: 112 }, baseline: { timestamp: 1_000_000 - 3_600_000, value: 100 }, delta: 12, percent: 12, direction: "up" },
};

function renderStat() {
  return render(
    <DashboardWindowProvider value={{ rangeEnd: 1_000_000 }}>
      <StatComparisonContext.Provider value={comparison}>
        <WidgetVisualization widget={widget} result={one(112)} />
      </StatComparisonContext.Provider>
    </DashboardWindowProvider>,
  );
}

// jsdom has no layout. A stat that draws its change overflows its box by 300 px; without the change it fits.
function overflowWhenChangeDrawn() {
  const isStatRoot = (element: Element) => element.querySelector(":scope > [data-stat-summary]") !== null;
  const changeDrawn = (element: Element) => element.querySelector("[data-stat-delta]:not([data-stat-delta-fit='hidden'])") !== null;
  vi.spyOn(Element.prototype, "scrollWidth", "get").mockImplementation(function (this: Element) {
    return isStatRoot(this) && changeDrawn(this) ? 400 : 100;
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 100 });
}

// A drawn change is laid out at its own width; the fit reads that width to tell a drawn change from a 1 px box.
function layOutChange(width: number) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const box = this.hasAttribute("data-stat-delta") ? width : 0;
    return { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: box, width: box, height: 0, toJSON: () => ({}) } as DOMRect;
  });
}

describe("a stat's change that does not fit", () => {
  it("is hidden, and its words move to the reading's title where a pointer can reach them", () => {
    layOutChange(80);
    overflowWhenChangeDrawn();
    const { container } = renderStat();
    expect(container.querySelector("[data-stat-delta]")).toHaveAttribute("data-stat-delta-fit", "hidden");
    const value = container.querySelector("[data-metric-value]");
    expect(value?.getAttribute("title")).toMatch(/^Exact value 112 req\/s · Exact change \+12 req\/s \(\+12%\), better · earlier sample /);
    // The change keeps its own spoken sentence for assistive technology.
    expect(container.querySelector("[data-stat-spoken]")?.textContent).toContain("vs 1 h earlier: +12%, better");
  });

  it("is hidden by its container's rule, a 1 px box, and its words still move to the reading's title", () => {
    layOutChange(1);
    const { container } = renderStat();
    expect(container.querySelector("[data-stat-delta]")).not.toHaveAttribute("data-stat-delta-fit");
    expect(container.querySelector("[data-metric-value]")?.getAttribute("title")).toContain("Exact change");
  });

  it("is drawn, with the reading's own title, when it fits", () => {
    layOutChange(80);
    const { container } = renderStat();
    expect(container.querySelector("[data-stat-delta]")).not.toHaveAttribute("data-stat-delta-fit");
    expect(container.querySelector("[data-metric-value]")?.getAttribute("title")).toBe("Exact value 112 req/s");
  });
});

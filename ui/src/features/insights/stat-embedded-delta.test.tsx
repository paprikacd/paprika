import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { WidgetVisualization } from "./charts";
import { EmbeddedWidgetProvider } from "./widget-presentation";
import { StatComparisonContext, type StatComparisonState } from "./stat-comparison";
import type { Widget, QueryResult } from "./schema";

afterEach(cleanup);

const widget = { id: "rate", title: "Rate", type: "stat", providerId: "p", query: "rate", unit: "req/s", layout: { x: 0, y: 0, w: 3, h: 2 }, options: { decimals: 1 } } as unknown as Widget;
const result = { series: [{ name: "rate", labels: {}, points: [{ timestamp: 2000, value: 112 }] }] } as QueryResult;
const comparison: StatComparisonState = {
  window: "previous",
  span: 3_600_000,
  unit: "req/s",
  decimals: 1,
  outcome: { state: "ok", current: { timestamp: 2000, value: 112 }, baseline: { timestamp: 1000, value: 100 }, delta: 12, percent: 12, direction: "up" },
};

it("shows the tile's change beside the reading, outside an embedded view", () => {
  const { container } = render(
    <StatComparisonContext.Provider value={comparison}>
      <WidgetVisualization widget={widget} result={result} />
    </StatComparisonContext.Provider>,
  );
  expect(container.querySelector("[data-stat-delta]")).not.toBeNull();
});

// A stat inside a tooltip is a view of another widget. It must not show the parent tile's change.
it("shows no change in an embedded stat, even inside a comparing tile", () => {
  const { container } = render(
    <StatComparisonContext.Provider value={comparison}>
      <EmbeddedWidgetProvider>
        <WidgetVisualization widget={widget} result={result} />
      </EmbeddedWidgetProvider>
    </StatComparisonContext.Provider>,
  );
  expect(container.querySelector("[data-stat-delta]")).toBeNull();
});

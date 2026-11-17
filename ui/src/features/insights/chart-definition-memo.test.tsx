import { useEffect } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WidgetVisualization } from "./charts";
import { ChartCursorProvider, useChartCursorPublisher } from "./chart-cursor";

const counter = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@tanstack/charts/scene", async importOriginal => {
  const actual = await importOriginal<typeof import("@tanstack/charts/scene")>();
  return { ...actual, defineChart: (definition: unknown) => { counter.calls++; return actual.defineChart(definition as never); } };
});

function Publisher({ onReady }: { onReady: (publish: (timestamp: number) => void) => void }) {
  const store = useChartCursorPublisher();
  useEffect(() => onReady(timestamp => store.publish("other-chart", timestamp)), [store, onReady]);
  return null;
}

describe("chart definitions are not rebuilt by a shared-cursor move", () => {
  for (const type of ["timeseries", "bar"]) it(`${type} keeps its definition across ten cursor moves`, () => {
    const widget = { id: `w-${type}`, title: "W", type, providerId: "p", query: "q", unit: "ms", layout: { x: 0, y: 0, w: 6, h: 4 } };
    const result = { series: [{ name: "s", labels: {}, points: [{ timestamp: 1000, value: 5 }, { timestamp: 2000, value: 12 }] }] };
    let publish: ((timestamp: number) => void) | undefined;
    const view = render(<ChartCursorProvider><Publisher onReady={next => { publish = next; }} /><WidgetVisualization widget={widget as never} result={result} /></ChartCursorProvider>);
    const mounted = counter.calls;
    for (let index = 0; index < 10; index++) act(() => publish!(1000 + index * 50));
    expect(counter.calls - mounted).toBe(0);
    view.unmount();
  });
});

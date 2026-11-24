import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnnotationEventsProvider, eventsAt, eventsInRange, type RecordedEvent } from "./annotation-events";
import { WidgetVisualization } from "./charts";
import { InspectorEvents } from "./inspector-events";
import { DistributionHeatmap } from "./plugins/rich-metrics-view";
import { SmallMultiples } from "./plugins/small-multiples";
import { StatusHistory } from "./plugins/metric-distributions";
import type { QueryResult, Widget } from "./schema";

afterEach(cleanup);

const at = (ms: number) => new Date(ms).toISOString();
const pointEvent: RecordedEvent = { timestamp: at(2000), label: "Deploy", severity: "critical" };
const warningEvent: RecordedEvent = { timestamp: at(1000), label: "Rollout", severity: "warning" };
const interval: RecordedEvent = { timestamp: at(3000), endTimestamp: at(5000), label: "Maintenance" };

describe("event lookups", () => {
  it("names the events a sample falls on: intervals that contain it, and points within the tolerance, critical first", () => {
    expect(eventsAt([warningEvent, pointEvent, interval], 2000, 0).map(event => event.label)).toEqual(["Deploy"]);
    expect(eventsAt([warningEvent, pointEvent, interval], 4000, 0).map(event => event.label)).toEqual(["Maintenance"]);
    expect(eventsAt([warningEvent, pointEvent], 1600, 500).map(event => event.label)).toEqual(["Deploy"]);
    expect(eventsAt([warningEvent, pointEvent], 1400, 300)).toEqual([]);
  });

  it("lists at most three events at a time", () => {
    const many = [1, 2, 3, 4].map(index => ({ timestamp: at(1000), label: `E${index}`, severity: "info" as const }));
    expect(eventsAt(many, 1000, 0)).toHaveLength(3);
  });

  it("keeps the events that overlap a range", () => {
    expect(eventsInRange([warningEvent, pointEvent, interval], 4500, 9000).map(event => event.label)).toEqual(["Maintenance"]);
  });
});

describe("events in the inspector", () => {
  it("names each event with its severity chip, not colour alone", () => {
    const { container } = render(<InspectorEvents events={[pointEvent, interval]} />);
    const list = screen.getByRole("list", { name: "Events at this time" });
    expect(within(list).getByText("Deploy")).toBeInTheDocument();
    expect(container.querySelector('[data-status="critical"]')).toBeInTheDocument();
    expect(container.querySelector('[data-status="unknown"]')).toBeInTheDocument();
  });

  it("renders nothing without events", () => {
    const { container } = render(<InspectorEvents events={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("event ticks on the other time-based widgets", () => {
  const events = [pointEvent, warningEvent];

  it("draws a stat's sparkline ticks on the tile, not in an embedded view", () => {
    const stat: Widget = { id: "stat", title: "Latency", type: "stat", providerId: "metrics", query: "latency", unit: "ms", layout: { x: 0, y: 0, w: 4, h: 2 }, options: { showSparkline: true } };
    const result: QueryResult = { series: [{ name: "latency", labels: {}, points: [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: 2 }, { timestamp: 3000, value: 3 }] }] };
    const { container } = render(<AnnotationEventsProvider state={{ events }}><WidgetVisualization widget={stat} result={result} /></AnnotationEventsProvider>);
    expect(container.querySelectorAll("[data-event-tick]").length).toBeGreaterThan(0);
  });

  it("draws small-multiples ticks over each panel's time domain", () => {
    const widget: Widget = { id: "hosts", title: "Host trends", type: "plugin", pluginId: "small-multiples", dataKind: "metrics", providerId: "metrics", query: "up", unit: "%", layout: { x: 0, y: 0, w: 8, h: 4 }, config: { columns: 1, maxSeries: 1, maxPoints: 8 } } as Widget;
    const result: QueryResult = { series: [{ name: "alpha", labels: {}, points: [{ timestamp: 1000, value: 0 }, { timestamp: 3000, value: 10 }] }] };
    const { container } = render(<AnnotationEventsProvider state={{ events: [pointEvent] }}><SmallMultiples widget={widget} result={result} /></AnnotationEventsProvider>);
    expect(container.querySelectorAll('[data-event-tick="point"]')).toHaveLength(1);
  });

  it("puts a heatmap's events in the top gutter as ticks, and never as filled bands", () => {
    const widget: Widget = { id: "latency", title: "Latency distribution", type: "plugin", pluginId: "distribution-heatmap", providerId: "metrics", dataKind: "metrics", query: "buckets", unit: "ms", layout: { x: 0, y: 0, w: 6, h: 4 }, config: { maxColumns: 120 } } as Widget;
    const heatmap: QueryResult = { series: ["10", "100"].map((le, bucket) => ({ name: `bucket ${le}`, labels: { le }, points: Array.from({ length: 12 }, (_, index) => ({ timestamp: (index + 1) * 1000, value: bucket ? 3 : 1 })) })) };
    const { container } = render(<AnnotationEventsProvider state={{ events: [pointEvent] }}><DistributionHeatmap widget={widget} result={heatmap} /></AnnotationEventsProvider>);
    expect(container.querySelectorAll('[data-event-tick="point"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-event-tick="interval"]')).toHaveLength(0);
  });

  it("marks a status history's events over its rows on the layout's time scale", () => {
    const widget: Widget = { id: "states", title: "States", type: "plugin", pluginId: "status-history", dataKind: "metrics", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 0, w: 8, h: 3 } } as Widget;
    const result: QueryResult = { series: [{ name: "api", labels: {}, points: [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: 0 }, { timestamp: 3000, value: 1 }] }] };
    const { container } = render(<AnnotationEventsProvider state={{ events: [pointEvent] }}><StatusHistory widget={widget} result={result} /></AnnotationEventsProvider>);
    expect(container.querySelectorAll("[data-event-tick]")).toHaveLength(1);
  });

  it("lists a stat sparkline's events in its sample inspector, so the keyboard reaches them", () => {
    const stat: Widget = { id: "stat", title: "Latency", type: "stat", providerId: "metrics", query: "latency", unit: "ms", layout: { x: 0, y: 0, w: 4, h: 2 }, options: { showSparkline: true } };
    const result: QueryResult = { series: [{ name: "latency", labels: {}, points: [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: 2 }, { timestamp: 3000, value: 3 }] }] };
    const { container } = render(<AnnotationEventsProvider state={{ events }}><WidgetVisualization widget={stat} result={result} /></AnnotationEventsProvider>);
    const sparkline = container.querySelector<SVGSVGElement>("[data-stat-sparkline]")!;
    act(() => sparkline.focus());
    // Focus inspects the latest sample, at 3000, which no event covers.
    expect(screen.queryByRole("list", { name: "Events at this time" })).toBeNull();
    fireEvent.keyDown(sparkline, { key: "ArrowLeft" });
    expect(within(screen.getByRole("list", { name: "Events at this time" })).getByText("Deploy")).toBeInTheDocument();
  });

  it("keeps ticks inside the plotted range and out of the pointer's way", () => {
    const widget: Widget = { id: "hosts", title: "Host trends", type: "plugin", pluginId: "small-multiples", dataKind: "metrics", providerId: "metrics", query: "up", unit: "%", layout: { x: 0, y: 0, w: 8, h: 4 }, config: { columns: 1, maxSeries: 1, maxPoints: 8 } } as Widget;
    const result: QueryResult = { series: [{ name: "alpha", labels: {}, points: [{ timestamp: 1000, value: 0 }, { timestamp: 3000, value: 10 }] }] };
    // An interval that began before the panel's first sample, a point at that sample, and an event after the panel ends.
    const early: RecordedEvent = { timestamp: at(0), endTimestamp: at(2000), label: "Incident" };
    const edge: RecordedEvent = { timestamp: at(1000), label: "Deploy" };
    const late: RecordedEvent = { timestamp: at(9000), label: "Later" };
    const { container } = render(<AnnotationEventsProvider state={{ events: [early, edge, late] }}><SmallMultiples widget={widget} result={result} /></AnnotationEventsProvider>);
    const bar = container.querySelector('[data-event-tick="interval"]')!;
    const points = container.querySelectorAll('[data-event-tick="point"]');
    expect(points).toHaveLength(1);
    expect(Number(bar.getAttribute("x"))).toBe(Number(points[0].getAttribute("x1")));
    for (const tick of container.querySelectorAll("[data-event-tick]")) expect(tick.closest("g")?.getAttribute("pointer-events")).toBe("none");
  });
});

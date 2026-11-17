import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnnotationEventsProvider } from "./annotation-events";
import { WidgetVisualization } from "./charts";
import { DirectionalTraffic } from "./plugins/rich-metrics";
import { widgetSchema, type QueryResult, type Widget } from "./schema";

afterEach(cleanup);
const source = { queryRef: { id: "events" }, timestampColumn: "date", labelColumn: "label" };
const widget: Widget = { id: "chart", title: "Requests", type: "timeseries", providerId: "metrics", query: "up", unit: "", annotationSource: source, layout: { x: 0, y: 0, w: 6, h: 4 } };
const result: QueryResult = { series: [{ name: "inbound", labels: { direction: "inbound" }, points: [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: 2 }, { timestamp: 3000, value: 3 }] }] };
const events = [{ timestamp: "1970-01-01T00:00:01.500Z", label: "Deployment", severity: "warning" as const }, { timestamp: "1970-01-01T00:00:04.000Z", label: "Outside" }];

describe("recorded events on time-based charts", () => {
  it("accepts ordinary and directional time series but rejects unrelated visualizations", () => {
    expect(widgetSchema.safeParse(widget).success).toBe(true);
    expect(widgetSchema.safeParse({ ...widget, type: "plugin", pluginId: "directional-traffic", dataKind: "metrics" }).success).toBe(true);
    expect(widgetSchema.safeParse({ ...widget, type: "bar" }).success).toBe(false);
  });

  it("shows recorded markers and an accessible event list without intercepting the chart", () => {
    const { container, rerender } = render(<AnnotationEventsProvider state={{ events }}><WidgetVisualization widget={widget} result={result} /></AnnotationEventsProvider>);
    const marker = container.querySelector('[data-annotation-timestamp="1970-01-01T00:00:01.500Z"]');
    expect(marker).toBeInTheDocument();
    expect(marker).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelectorAll("[data-annotation-timestamp]")).toHaveLength(1);
    const group = screen.getByRole("group", { name: "Chart events" });
    expect(within(group).getByText("Deployment")).toBeInTheDocument();
    expect(group.querySelector("time")).toHaveAttribute("datetime", events[0].timestamp);
    expect(screen.getByRole("button", { name: /Compare window/ })).toBeEnabled();
    rerender(<AnnotationEventsProvider state={{ events: [], error: "Events unavailable" }}><WidgetVisualization widget={widget} result={result} /></AnnotationEventsProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("Events unavailable: Events unavailable");
    expect(screen.getByRole("list", { name: "Latest values by series" })).toBeInTheDocument();
  });

  it("shows provider-backed events on directional charts while keeping unknown events explicit", () => {
    const directional: Widget = { ...widget, type: "plugin", pluginId: "directional-traffic", dataKind: "metrics" };
    const { container } = render(<AnnotationEventsProvider state={{ events, omitted: 2, truncated: true }}><DirectionalTraffic widget={directional} result={result} /></AnnotationEventsProvider>);
    expect(container.querySelectorAll("[data-annotation-timestamp]")).toHaveLength(1);
    expect(screen.getByRole("group", { name: "Chart events" })).toHaveTextContent("Deployment");
    expect(screen.getByText("2 invalid or excess event records omitted.")).toBeInTheDocument();
    expect(screen.getByText("Event source response is partial.")).toBeInTheDocument();
  });
  it("clips incident intervals to the visible domain and exposes both recorded endpoints", () => {
    const incident = { timestamp:"1970-01-01T00:00:00.500Z", endTimestamp:"1970-01-01T00:00:02.000Z", label:"Incident", severity:"critical" as const };
    const annotated = {...widget, annotationSource:{...source,endColumn:"end"}};
    expect(widgetSchema.safeParse(annotated).success).toBe(true);
    const {container, unmount}=render(<AnnotationEventsProvider state={{events:[incident]}}><WidgetVisualization widget={annotated} result={result} /></AnnotationEventsProvider>);
    const band=container.querySelector('[data-annotation-interval="true"]');
    expect(band).toBeInTheDocument();
    expect(band).toHaveAttribute("aria-hidden","true");
    expect(screen.getByRole("group",{name:"Chart events"}).querySelectorAll("time")[1]).toHaveAttribute("datetime",incident.endTimestamp);
    unmount();
    const directional={...annotated,type:"plugin" as const,pluginId:"directional-traffic",dataKind:"metrics" as const};
    const rendered=render(<AnnotationEventsProvider state={{events:[incident]}}><DirectionalTraffic widget={directional} result={result} /></AnnotationEventsProvider>);
    const range=rendered.container.querySelector('[data-annotation-interval]');
    expect(range).toBeInTheDocument();
    expect(range).toHaveAttribute("pointer-events","none");
    expect(range).toHaveAttribute("data-severity","critical");
  });
});

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginConfigEditor } from "../plugin-config-editor";
import { getWidgetDefinition } from "../widget-registry";
import { StackedTimeseries, registerRichMetricPlugins } from "./rich-metrics";
import { stackedConfigSchema } from "./rich-metrics-data";
import type { QueryResult, Widget } from "../schema";
import { AnnotationEventsProvider } from "../annotation-events";

afterEach(cleanup);
const widget: Widget = { id: "metric", title: "CPU", type: "plugin", pluginId: "stacked-timeseries", dataKind: "metrics", providerId: "metrics", query: "cpu", unit: "%", layout: { x: 0, y: 0, w: 6, h: 4 } };
const result: QueryResult = { series: [{ name: "CPU", labels: {}, points: [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: 2 }] }] };

describe("metric event annotations", () => {
  it("validates bounded explicit timestamp, label and severity values", () => {
    const annotation = { timestamp: "1970-01-01T00:00:01.500Z", label: "Deploy", severity: "warning" };
    expect(stackedConfigSchema.parse({ annotations: [annotation] }).annotations).toEqual([annotation]);
    for (const value of ["tomorrow", "2026-10-29T12:00:00", ""]) expect(stackedConfigSchema.safeParse({ annotations: [{ ...annotation, timestamp: value }] }).success).toBe(false);
    expect(stackedConfigSchema.safeParse({ annotations: Array(21).fill(annotation) }).success).toBe(false);
    expect(stackedConfigSchema.safeParse({ annotations: [{ ...annotation, label: "" }] }).success).toBe(false);
    expect(stackedConfigSchema.safeParse({ annotations: [{ ...annotation, severity: "extreme" }] }).success).toBe(false);
  });

  it("places only events inside the displayed time domain without blocking metric inspection", () => {
    const annotations = [
      { timestamp: "1970-01-01T00:00:01.000Z", label: "Start", severity: "info" },
      { timestamp: "1970-01-01T00:00:01.500Z", label: "Deploy", severity: "warning" },
      { timestamp: "1970-01-01T00:00:03.000Z", label: "Outside", severity: "critical" },
    ];
    const { container } = render(<StackedTimeseries widget={{ ...widget, config: { annotations } }} result={result} />);
    const markers = [...container.querySelectorAll("[data-annotation-timestamp]")];
    expect(markers).toHaveLength(2);
    expect(Number(markers[1].getAttribute("x1"))).toBeGreaterThan(Number(markers[0].getAttribute("x1")));
    expect(markers[1]).toHaveAttribute("pointer-events", "none");
    const events = screen.getByRole("group", { name: "Chart events" });
    expect(within(events).getByText("Deploy")).toBeInTheDocument();
    const eventTime = events.querySelector('time[datetime="1970-01-01T00:00:01.500Z"]');
    expect(eventTime).toHaveAttribute("title", "1970-01-01T00:00:01.500Z");
    expect(eventTime).toHaveTextContent(new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(1500)));
    expect(within(events).queryByText("Outside")).not.toBeInTheDocument();
    fireEvent.focus(screen.getByRole("group", { name: /CPU\. Stacked/ }));
    expect(screen.getByRole("region", { name: "Observation details" })).toBeInTheDocument();
  });

  it("offers guided event editing while preserving other chart configuration", () => {
    registerRichMetricPlugins();
    const change = vi.fn();
    render(<PluginConfigEditor definition={getWidgetDefinition("plugin", "stacked-timeseries")} value={'{"display":"area","annotations":[{"timestamp":"1970-01-01T00:00:01.500Z","label":"Deploy","severity":"info"}]}'} onChange={change} />);
    fireEvent.change(screen.getByLabelText("Event 1 label"), { target: { value: "Release" } });
    expect(JSON.parse(change.mock.lastCall![0])).toEqual({ display: "area", annotations: [{ timestamp: "1970-01-01T00:00:01.500Z", label: "Release", severity: "info" }] });
    fireEvent.click(screen.getByRole("button", { name: "Remove event 1" }));
    expect(JSON.parse(change.mock.lastCall![0])).toEqual({ display: "area" });
  });

  it("limits recorded events only after filtering to the observed metric extent", () => {
    const events = [...Array.from({ length: 25 }, (_, i) => ({ timestamp: new Date(100 + i).toISOString(), label: `Earlier ${i}` })), { timestamp: new Date(1500).toISOString(), label: "Visible incident" }];
    const annotated = { ...widget, annotationSource: { queryRef: { id: "events" }, timestampColumn: "date", labelColumn: "label" } };
    const { container } = render(<AnnotationEventsProvider state={{ events }}><StackedTimeseries widget={annotated} result={result} /></AnnotationEventsProvider>);
    expect(container.querySelectorAll("[data-annotation-timestamp]")).toHaveLength(1);
    expect(screen.getByText("Visible incident")).toBeInTheDocument();
  });

  it("reports an event-library error while keeping the metric chart available", () => {
    const annotated = { ...widget, annotationSource: { queryRef: { id: "events" }, timestampColumn: "date", labelColumn: "label" } };
    render(<AnnotationEventsProvider state={{ events: [], error: "Saved-query library unavailable" }}><StackedTimeseries widget={annotated} result={result} /></AnnotationEventsProvider>);
    expect(screen.getByRole("status")).toHaveTextContent("Events unavailable: Saved-query library unavailable");
    expect(screen.getByRole("group", { name: /CPU\. Stacked/ })).toBeInTheDocument();
  });
});

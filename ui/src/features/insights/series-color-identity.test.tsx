import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WidgetVisualization } from "./charts";
import { StackedTimeseries } from "./plugins/rich-metrics";
import { SmallMultiples } from "./plugins/small-multiples";
import { RecordLine } from "./plugins/record-charts";
import { DashboardTimeZoneProvider } from "./dashboard-time-zone";
import { identitySlot, widgetSeriesColors } from "./series-colors";
import { seriesSlot } from "./series-palette";
import type { QueryResult, Widget } from "./schema";

afterEach(cleanup);

/** The palette slot a series identity draws. Services are labelled service=<name>, as Prometheus labels them. */
const slotOf = (identity: string) => seriesSlot(identitySlot(identity));
const service = (name: string) => `service=${name}`;
const sample = (name: string, value: number) => ({ name: `{service="${name}"}`, labels: { service: name }, points: [{ timestamp: 1000, value }, { timestamp: 2000, value: value + 1 }] });
const timeseries = (series: NonNullable<QueryResult["series"]>, options: Widget["options"] = {}): Widget => ({ id: "rate", title: "Request rate", type: "timeseries", providerId: "prom", query: "rate", unit: "req/s", layout: { x: 0, y: 0, w: 8, h: 5 }, options: { showLegend: true, ...options } });

/** Each drawn line's stroke, in result order: the time-series renderer draws one path per series. */
function strokesByName(container: HTMLElement, series: readonly { name: string }[]) {
  const strokes = [...container.querySelectorAll("path[stroke]")].map(path => path.getAttribute("stroke"));
  return Object.fromEntries(series.map((entry, index) => [entry.name, strokes[index]]));
}

describe("series colour identity in drawn charts", () => {
  const overview = [sample("catalog", 1), sample("checkout", 2), sample("worker", 3)];

  it("draws a service in the same colour on two widgets", () => {
    const first = render(<WidgetVisualization widget={timeseries(overview)} result={{ series: overview }} />);
    const firstColours = strokesByName(first.container, overview);
    first.unmount();
    const budget = [sample("checkout", 9)];
    const second = render(<WidgetVisualization widget={timeseries(budget)} result={{ series: budget }} />);
    const checkout = '{service="checkout"}';
    expect(strokesByName(second.container, budget)[checkout]).toBe(firstColours[checkout]);
    expect(firstColours[checkout]).toBe(slotOf(service("checkout")));
  });

  it("keeps each series' colour when the provider returns the series in another order", () => {
    const { container, rerender } = render(<WidgetVisualization widget={timeseries(overview)} result={{ series: overview }} />);
    const before = strokesByName(container, overview);
    const reversed = overview.toReversed();
    rerender(<WidgetVisualization widget={timeseries(reversed)} result={{ series: reversed }} />);
    expect(strokesByName(container, reversed)).toEqual(before);
  });

  it("keeps the position slots in index mode", () => {
    const { container } = render(<WidgetVisualization widget={timeseries(overview, { seriesColorMode: "index" })} result={{ series: overview }} />);
    expect(strokesByName(container, overview)).toEqual({ '{service="catalog"}': seriesSlot(0), '{service="checkout"}': seriesSlot(1), '{service="worker"}': seriesSlot(2) });
  });

  it("gives the same colour to a service in a stacked widget as in a time series", () => {
    const stacked = { id: "traffic", title: "Traffic", type: "plugin" as const, pluginId: "stacked-timeseries", dataKind: "metrics" as const, providerId: "metrics", query: "rate", unit: "req/s", layout: { x: 0, y: 0, w: 8, h: 4 }, config: {} };
    const { container } = render(<StackedTimeseries widget={stacked} result={{ series: overview }} />);
    const strokeOf = (name: string) => [...container.querySelectorAll("[data-series]")].find(node => node.getAttribute("data-series") === name)?.querySelector("path[stroke]")?.getAttribute("stroke");
    expect(strokeOf('{service="checkout"}')).toBe(slotOf(service("checkout")));
    expect(strokeOf('{service="worker"}')).toBe(slotOf(service("worker")));
  });

  it("colours small multiples by identity, whatever maxSeries shows", () => {
    const series = [sample("worker", 1), sample("checkout", 2), sample("catalog", 3)];
    const [worker, checkout, catalog] = [service("worker"), service("checkout"), service("catalog")];
    const widget = (maxSeries: number): Widget => ({ id: "hosts", title: "Hosts", type: "plugin", pluginId: "small-multiples", dataKind: "metrics", providerId: "metrics", query: "up", unit: "%", layout: { x: 0, y: 0, w: 8, h: 4 }, config: { columns: 3, maxSeries, maxPoints: 8 } });
    const two = render(<SmallMultiples widget={widget(2)} result={{ series }} />);
    const shown = [...two.container.querySelectorAll("path[data-multiple-path]")].map(path => path.getAttribute("stroke"));
    expect(shown).toEqual([slotOf(worker), slotOf(checkout)]);
    two.unmount();
    const three = render(<SmallMultiples widget={widget(3)} result={{ series }} />);
    expect([...three.container.querySelectorAll("path[data-multiple-path]")].map(path => path.getAttribute("stroke"))).toEqual([slotOf(worker), slotOf(checkout), slotOf(catalog)]);
  });

  it("colours record columns by column name when there is no group", () => {
    const frame: QueryResult = { records: { columns: [{ key: "at", type: "number" }, { key: "checkout", type: "number" }, { key: "worker", type: "number" }], rows: [[1, 1, 2], [2, 2, 3]] } };
    const widget: Widget = { id: "records", title: "Records", type: "plugin", pluginId: "records-line", dataKind: "records", providerId: "uptime", query: "records", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, config: { x: "at", y: ["checkout", "worker"] } };
    const { container } = render(<DashboardTimeZoneProvider timeZone="UTC"><RecordLine widget={widget} result={frame} /></DashboardTimeZoneProvider>);
    const strokes = [...container.querySelectorAll("path[stroke]")].map(path => path.getAttribute("stroke"));
    expect(strokes).toEqual([slotOf("checkout"), slotOf("worker")]);
  });

  it("colours a record group by its label, so it matches the Prometheus series with that label", () => {
    // Rows are grouped by the service column; the group value is the label, so checkout matches {service="checkout"}.
    const frame: QueryResult = { records: { columns: [{ key: "at", type: "number" }, { key: "service", type: "string" }, { key: "requests", type: "number" }], rows: [[1, "checkout", 1], [1, "worker", 2], [2, "checkout", 3], [2, "worker", 4]] } };
    const widget: Widget = { id: "records", title: "Records", type: "plugin", pluginId: "records-line", dataKind: "records", providerId: "uptime", query: "records", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, config: { x: "at", y: ["requests"], group: "service" } };
    const { container } = render(<DashboardTimeZoneProvider timeZone="UTC"><RecordLine widget={widget} result={frame} /></DashboardTimeZoneProvider>);
    const strokes = [...container.querySelectorAll("path[stroke]")].map(path => path.getAttribute("stroke"));
    expect(strokes).toEqual([slotOf(service("checkout")), slotOf(service("worker"))]);
  });

  // jsdom drops var() colours from inline styles, so the sparkline's own colour is checked in the browser e2e
  // (insights-series-identity). Here the stat and the time series ask the same helper, so they must agree.
  it("gives a stat's series the colour its time series gets, and an unlabelled series the first slot", () => {
    const stat: Widget = { id: "checkout-rate", title: "Checkout rate", type: "stat", providerId: "prom", query: "rate", unit: "req/s", layout: { x: 0, y: 0, w: 4, h: 3 }, options: { showSparkline: true } };
    expect(widgetSeriesColors([sample("checkout", 9)], stat)[0].color).toBe(slotOf(service("checkout")));
    expect(widgetSeriesColors([{ name: "Value", labels: {}, points: [] }], stat)[0].color).toBe(seriesSlot(0));
  });

  it("paints bars in the colour of their series, the same as their line elsewhere", () => {
    const series = [sample("checkout", 4), sample("worker", 5)];
    const bar: Widget = { id: "capacity", title: "Capacity", type: "bar", providerId: "metrics", query: "capacity", unit: "%", layout: { x: 0, y: 0, w: 6, h: 4 } };
    const { container } = render(<WidgetVisualization widget={bar} result={{ series }} />);
    const fills = [...container.querySelectorAll('g[data-ts-key="bar-y-0"] rect')].map(rect => rect.getAttribute("fill"));
    expect(fills).toEqual([slotOf(service("checkout")), slotOf(service("worker"))]);
  });
});

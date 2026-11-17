import { expect, it } from "vitest";
import { widgetRendered, type WidgetReadinessSnapshot } from "../../../e2e/widget-readiness";

const widget = { type: "plugin", pluginId: "connection-map", title: "Connection locations" };
const ready: WidgetReadinessSnapshot = { busy: false, loading: false, text: "Connection locations\nMelbourne", values: 0, buckets: 0, series: 0, operationalCharts: 1, gauges: 0 };

it("rejects deferred-query and renderer gaps before accepting the scoped operational chart", () => {
  expect(widgetRendered(widget, { ...ready, text: "Connection locations\nWaiting to load…", operationalCharts: 0 })).toBe(false);
  expect(widgetRendered(widget, { ...ready, text: "Connection locations\nQuerying data source…", busy: true, operationalCharts: 0 })).toBe(false);
  expect(widgetRendered(widget, { ...ready, loading: true, operationalCharts: 0 })).toBe(false);
  expect(widgetRendered(widget, { ...ready, operationalCharts: 0 })).toBe(false);
  expect(widgetRendered(widget, ready)).toBe(true);
});

it("keeps mandatory chart markers and contribution counts in the readiness contract", () => {
  expect(widgetRendered({ ...widget, type: "stat" }, ready)).toBe(false);
  expect(widgetRendered({ ...widget, type: "stat" }, { ...ready, values: 1 })).toBe(true);
  expect(widgetRendered({ ...widget, pluginId: "distribution-heatmap" }, { ...ready, buckets: 20 })).toBe(false);
  expect(widgetRendered({ ...widget, pluginId: "distribution-heatmap" }, { ...ready, buckets: 21 })).toBe(true);
  for (const pluginId of ["stacked-timeseries", "directional-traffic"]) {
    expect(widgetRendered({ ...widget, pluginId }, { ...ready, series: 1 })).toBe(false);
    expect(widgetRendered({ ...widget, pluginId }, { ...ready, series: 2 })).toBe(true);
  }
  expect(widgetRendered({ ...widget, pluginId: "threshold-gauge" }, ready)).toBe(false);
  expect(widgetRendered({ ...widget, pluginId: "threshold-gauge" }, { ...ready, gauges: 1 })).toBe(true);
  expect(widgetRendered(widget, { ...ready, operationalCharts: 2 })).toBe(false);
});

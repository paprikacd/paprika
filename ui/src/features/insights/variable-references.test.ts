import { describe, expect, it } from "vitest";
import { dashboardSchema, type Dashboard, type Widget } from "./schema";
import { placeholderNames, rewriteVariableReferences, variableReferences } from "./variable-references";

const layout = { x: 0, y: 0, w: 6, h: 4 };
function widget(id: string, extra: Partial<Widget> = {}): Widget {
  return { id, title: id, type: "timeseries", providerId: "metrics", query: "up", unit: "", layout, ...extra } as Widget;
}
function dashboardWith(widgets: Widget[], variables: Dashboard["variables"] = []): Dashboard {
  return { schemaVersion: 1, id: "service", title: "Service", timeRange: "1h", refreshInterval: 30, widgets, variables } as Dashboard;
}

describe("placeholder names", () => {
  it("finds each complete placeholder", () => {
    expect(placeholderNames('up{job="{{service}}"} + {{ region }} {{env_2}}')).toEqual(["service", "env_2"]);
  });
});

describe("variable references", () => {
  it("finds a query placeholder", () => {
    const dashboard = dashboardWith([widget("requests", { query: 'up{job="{{service}}"}' })], [{ name: "service" }]);
    expect(variableReferences(dashboard, "service")).toEqual([{ kind: "widget", widgetId: "requests", widgetTitle: "requests" }]);
  });

  it("finds a saved query binding and an event binding", () => {
    const saved = widget("saved", { queryRef: { id: "q", bindings: [{ parameter: "env", source: "variable", variable: "env" }] } });
    const event = widget("events", { annotationSource: { queryRef: { id: "e", bindings: [{ parameter: "env", source: "variable", variable: "env" }] }, timestampColumn: "t", labelColumn: "l" } });
    expect(variableReferences(dashboardWith([saved, event]), "env").map((use) => use.kind === "widget" ? use.widgetId : "")).toEqual(["saved", "events"]);
  });

  it("finds a saved tooltip binding, a selection binding and a self link", () => {
    const tooltip = widget("tip", { options: { tooltipView: { type: "stat", source: { type: "saved", ref: { id: "q", bindings: [{ parameter: "service", source: "variable", variable: "service" }] } } } } as never });
    const selection = widget("select", { selectionBindings: [{ variable: "service", source: "label", label: "service" } as never] });
    const link = widget("link", { drilldowns: [{ id: "d", title: "Open", dashboardId: "service", bindings: [{ variable: "service", source: "label", label: "service" } as never] }] as never });
    const found = variableReferences(dashboardWith([tooltip, selection, link]), "service").map((use) => use.kind === "widget" ? use.widgetId : "");
    expect(found).toEqual(["tip", "select", "link"]);
  });

  it("ignores a drilldown to another dashboard", () => {
    const foreign = widget("foreign", { drilldowns: [{ id: "d", title: "Open", dashboardId: "other", bindings: [{ variable: "service", source: "label", label: "service" } as never] }] as never });
    expect(variableReferences(dashboardWith([foreign]), "service")).toEqual([]);
  });

  it("ignores a tooltip query placeholder, which is tooltip-local", () => {
    const tip = widget("tip", { options: { tooltipView: { type: "stat", source: { type: "query", providerId: "metrics", query: 'up{job="{{service}}"}' } } } as never });
    expect(variableReferences(dashboardWith([tip]), "service")).toEqual([]);
  });

  it("finds another variable's source dependency", () => {
    const dashboard = dashboardWith([], [
      { name: "service" },
      { name: "pod", source: { type: "labelValues", providerId: "metrics", label: "pod", selector: 'up{job="{{service}}"}' } as never },
    ]);
    expect(variableReferences(dashboard, "service")).toEqual([{ kind: "variable", variableName: "pod" }]);
  });
});

describe("renaming references", () => {
  it("rewrites a query placeholder and the bindings that read the variable", () => {
    const dashboard = dashboardWith([
      widget("requests", { query: 'up{job="{{service}}"}', queryRef: { id: "q", bindings: [{ parameter: "service", source: "variable", variable: "service" }] } }),
    ], [{ name: "service" }]);
    const next = rewriteVariableReferences(dashboard, { service: "app" });
    expect(next.widgets[0].query).toBe('up{job="{{app}}"}');
    expect(next.widgets[0].queryRef?.bindings?.[0]).toMatchObject({ source: "variable", variable: "app" });
  });

  it("applies a swap in one pass", () => {
    const dashboard = dashboardWith([widget("w", { query: "{{a}} {{b}}" })], [{ name: "a" }, { name: "b" }]);
    expect(rewriteVariableReferences(dashboard, { a: "b", b: "a" }).widgets[0].query).toBe("{{b}} {{a}}");
  });

  it("keeps a foreign drilldown and the constant bindings", () => {
    const dashboard = dashboardWith([
      widget("w", {
        query: "up",
        drilldowns: [{ id: "d", title: "Open", dashboardId: "other", bindings: [{ variable: "service", source: "label", label: "service" } as never] }] as never,
        queryRef: { id: "q", bindings: [{ parameter: "env", source: "constant", value: "prod" }] },
      }),
    ], [{ name: "service" }]);
    const next = rewriteVariableReferences(dashboard, { service: "app" });
    expect(next.widgets[0].drilldowns?.[0].bindings?.[0]).toMatchObject({ variable: "service" });
    expect(next.widgets[0].queryRef?.bindings?.[0]).toMatchObject({ source: "constant", value: "prod" });
  });

  it("leaves a tooltip query placeholder untouched", () => {
    const tip = widget("tip", { options: { tooltipView: { type: "stat", source: { type: "query", providerId: "metrics", query: "{{service}}" } } } as never });
    const next = rewriteVariableReferences(dashboardWith([tip], [{ name: "service" }]), { service: "app" });
    expect(next.widgets[0].options?.tooltipView?.source).toMatchObject({ query: "{{service}}" });
  });

  it("rewrites a label selector in another variable's source and keeps the result valid", () => {
    const dashboard = dashboardWith([widget("w", { query: "{{service}}" })], [
      { name: "service" },
      { name: "pod", source: { type: "labelValues", providerId: "metrics", label: "pod", selector: "up{job={{service}}}" } as never },
    ]);
    const next = rewriteVariableReferences(dashboard, { service: "app" });
    expect(next.variables?.[1].source).toMatchObject({ selector: "up{job={{app}}}" });
    const checked = dashboardSchema.safeParse({ ...next, variables: [{ name: "app" }, { name: "pod", source: next.variables?.[1].source }] });
    expect(checked.error?.issues ?? []).toEqual([]);
  });
});

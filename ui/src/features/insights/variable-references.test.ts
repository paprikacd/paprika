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
    const link = next.widgets[0].drilldowns?.[0];
    expect(link && "bindings" in link ? link.bindings?.[0] : undefined).toMatchObject({ variable: "service" });
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

describe("references to similar names", () => {
  const url = 'probe_success{instance="https://a.example/ab?a=1"} == {{ab}}';
  const dashboard = dashboardWith([
    widget("both", { query: `{{a}} + {{ab}} + {{a_b}}` }),
    widget("url", { query: url }),
    widget("bound", {
      queryRef: { id: "q", bindings: [{ parameter: "a", source: "variable", variable: "ab" }, { parameter: "ab", source: "constant", value: "a" }] },
      selectionBindings: [{ variable: "ab", source: "label", value: "a" } as never],
    }),
  ], [{ name: "a" }, { name: "ab" }, { name: "a_b" }]);

  it("counts only the widgets that read the exact name", () => {
    const ids = (name: string) => variableReferences(dashboard, name).map((use) => use.kind === "widget" ? use.widgetId : use.variableName);
    expect(ids("a")).toEqual(["both"]);
    expect(ids("ab")).toEqual(["both", "url", "bound"]);
    expect(ids("a_b")).toEqual(["both"]);
  });

  it("renames a without touching ab, a_b, a URL that contains a, a constant value or a parameter name", () => {
    const next = rewriteVariableReferences(dashboard, { a: "service" });
    expect(next.widgets[0].query).toBe("{{service}} + {{ab}} + {{a_b}}");
    expect(next.widgets[1].query).toBe(url);
    expect(next.widgets[2].queryRef?.bindings).toEqual([{ parameter: "a", source: "variable", variable: "ab" }, { parameter: "ab", source: "constant", value: "a" }]);
    expect(next.widgets[2].selectionBindings).toEqual([{ variable: "ab", source: "label", value: "a" }]);
  });

  it("renames ab everywhere it is read and nowhere else", () => {
    const next = rewriteVariableReferences(dashboard, { ab: "region" });
    expect(next.widgets[0].query).toBe("{{a}} + {{region}} + {{a_b}}");
    expect(next.widgets[1].query).toBe('probe_success{instance="https://a.example/ab?a=1"} == {{region}}');
    expect(next.widgets[2].queryRef?.bindings?.[0]).toEqual({ parameter: "a", source: "variable", variable: "region" });
    expect(next.widgets[2].queryRef?.bindings?.[1]).toEqual({ parameter: "ab", source: "constant", value: "a" });
    expect(next.widgets[2].selectionBindings).toEqual([{ variable: "region", source: "label", value: "a" }]);
  });

  it("touches exactly the places it counts, for every name", () => {
    for (const name of ["a", "ab", "a_b"]) {
      const next = rewriteVariableReferences(dashboard, { [name]: "renamed" });
      const changed = dashboard.widgets.filter((entry, index) => JSON.stringify(entry) !== JSON.stringify(next.widgets[index])).map((entry) => entry.id);
      expect(changed).toEqual(variableReferences(dashboard, name).map((use) => use.kind === "widget" ? use.widgetId : ""));
    }
  });

  it("leaves placeholder-shaped text that is not a variable name alone", () => {
    const text = "{{ a }} {{1a}} {a} " + "$" + "a";
    const odd = dashboardWith([widget("odd", { query: text })], [{ name: "a" }]);
    expect(variableReferences(odd, "a")).toEqual([]);
    expect(rewriteVariableReferences(odd, { a: "b" }).widgets[0].query).toBe(text);
  });

  it("renames a parent in a saved query source, so its dependents wait on the new name", () => {
    const sourced = dashboardWith([], [
      { name: "cluster", defaultValue: "c1" },
      { name: "service", defaultValue: "s", source: { type: "savedQuery", queryRef: { id: "services", bindings: [{ parameter: "cluster", source: "variable", variable: "cluster" }] }, field: "service" } },
    ]);
    expect(variableReferences(sourced, "cluster")).toEqual([{ kind: "variable", variableName: "service" }]);
    const next = rewriteVariableReferences({ ...sourced, variables: [{ name: "k8s", defaultValue: "c1" }, sourced.variables![1]] }, { cluster: "k8s" });
    expect(next.variables?.[1].source).toMatchObject({ queryRef: { bindings: [{ parameter: "cluster", source: "variable", variable: "k8s" }] } });
    expect(dashboardSchema.safeParse(next).success).toBe(true);
  });
});

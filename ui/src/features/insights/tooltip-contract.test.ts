import { describe, expect, it } from "vitest"
import { parseDashboard, serializeDashboard, tooltipViewSchema, type Dashboard, type Provider, type TooltipView } from "./schema"
import { dashboardToOpenUI, parseOpenUIDashboard, validateAIProviders } from "./openui"
import { requiredProviders, remapDashboardProviders } from "./workspace-transfer"
import { registerWidgetPlugin } from "./widget-registry"

const providers: Provider[] = [
  { id: "metrics", name: "Metrics", type: "prometheus", capabilities: ["metrics"] },
  { id: "tracing", name: "Traces", type: "tempo", capabilities: ["traces"] },
]
const query = { type: "query" as const, providerId: "metrics", query: "up{service={{service}}}", bindings: [{ variable: "service", label: "service.name" }] }
const document = (tooltipView: TooltipView): Dashboard => ({
  schemaVersion: 1, id: "overview", title: "Overview", timeRange: "1h", refreshInterval: 0,
  widgets: [{ id: "health", title: "Health", type: "heatmap", providerId: "metrics", query: "up", unit: "%", layout: { x: 0, y: 0, w: 6, h: 4 }, options: { tooltipView } }],
})

describe("portable queried tooltip widgets", () => {
  it.each(["heatmap", "timeseries", "bar", "table"] as const)("round trips typed observation bindings on a %s host", type => {
    const source = document({ type: "stat", source: {
      ...query, query: "up{service={{service}},series={{series}}}@{{time}} > {{value}}",
      bindings: [...query.bindings, { variable: "series", field: "series" }, { variable: "time", field: "timestamp" }, { variable: "value", field: "value" }],
    } })
    source.widgets[0].type = type
    for (const format of ["json", "yaml"] as const)
      expect(parseDashboard(serializeDashboard(source, format), format)).toEqual(source)
    expect(parseOpenUIDashboard(dashboardToOpenUI(source))).toEqual(source)
    expect(() => validateAIProviders(source, providers)).not.toThrow()
  })

  it.each(["timeseries", "bar", "stat", "table", "traces", "heatmap", "plugin"] as const)("round trips %s through all authoring formats", type => {
    const view: TooltipView = {
      type, height: 320, title: "Signal details", unit: "ms", color: "#a44222", decimals: 3,
      showGrid: false, showAxis: false, showLegend: true,
      source: { ...query, ...(type === "traces" ? { providerId: "tracing", query: "{ resource.service.name = {{service}} }" } : {}) },
      ...(type === "plugin" ? { pluginId: "installed-gauge", dataKind: "metrics" as const, config: { label: "Latest" } } : {}),
    }
    const source = document(view)
    for (const format of ["json", "yaml"] as const)
      expect(parseDashboard(serializeDashboard(source, format), format)).toEqual(source)
    expect(parseOpenUIDashboard(dashboardToOpenUI(source))).toEqual(source)
  })

  it("rejects recursive sources, ambiguous bindings and trace history without a query", () => {
    const invalid = [
      { type: "traces" }, { type: "plugin", pluginId: "trace-plugin", dataKind: "traces" },
      { type: "stat", pluginId: "gauge" }, { type: "plugin", pluginId: "gauge" },
      { type: "stat", source: { ...query, bindings: [query.bindings[0], query.bindings[0]] } },
      { type: "stat", source: { ...query, bindings: [{ variable: "__proto__", label: "service" }] } },
      { type: "stat", source: { ...query, bindings: [{ variable: "service", label: "" }] } },
      ...[
        { variable: "v", label: "service", field: "value" }, { variable: "v" },
        { variable: "v", field: "query" }, { variable: "v", field: null },
        { variable: "v", field: "value", constant: "raw" },
      ].map(binding => ({ type: "stat", source: { ...query, bindings: [binding] } })),
      { type: "stat", source: { ...query, bindings: [{ variable: "service", label: "service" }, { variable: "service", field: "value" }] } },
      { type: "stat", source: { ...query, bindings: Array.from({ length: 21 }, (_, i) => ({ variable: `v${i}`, label: "service" })) } },
      { type: "stat", source: { ...query, source: query } },
      { type: "stat", source: { type: "series", query: "up" } },
      { type: "stat", source: null }, { type: "stat", source: { ...query, bindings: null } },
      { type: "stat", decimals: 1.5 }, { type: "stat", color: "red" },
      { type: "stat", config: {} }, { type: "stat", options: { tooltipView: { type: "stat" } } },
    ]
    for (const value of invalid) expect(tooltipViewSchema.safeParse(value).success, JSON.stringify(value)).toBe(false)
    expect(tooltipViewSchema.parse({ type: "timeseries" })).toEqual({ type: "timeseries" })
    expect(tooltipViewSchema.parse({ type: "table", source: { type: "series" } }).type).toBe("table")
  })

  it("validates nested providers and templates before accepting AI documents", () => {
    expect(() => validateAIProviders(document({ type: "stat", source: query }), providers)).not.toThrow()
    expect(() => validateAIProviders(document({ type: "stat", source: { ...query, providerId: "gone" } }), providers)).toThrow(/tooltip.*unknown provider/)
    expect(() => validateAIProviders(document({ type: "stat", source: { ...query, providerId: "tracing" } }), providers)).toThrow(/tooltip.*metrics provider/)
    for (const expression of ['up{service="{{service}}"}', "up{service={{unmapped}}}", "up # {{service}}"])
      expect(() => validateAIProviders(document({ type: "stat", source: { ...query, query: expression } }), providers)).toThrow()
  })

  it("requires trusted compatible tooltip plugins and validates their config", () => {
    const view: TooltipView = { type: "plugin", pluginId: "tooltip-contract-gauge", dataKind: "metrics", config: { label: "value" } }
    expect(() => validateAIProviders(document(view), providers)).toThrow(/tooltip.*registered plugin/)
    const unregister = registerWidgetPlugin({ id: view.pluginId!, label: "Test gauge", description: "Test", dataKind: "metrics", render: () => null, parseConfig: config => {
      if (config?.label !== "value") throw new Error("Choose a label")
      return config
    } })
    try {
      expect(() => validateAIProviders(document(view), providers)).not.toThrow()
      expect(() => validateAIProviders(document({ ...view, config: {} }), providers)).toThrow(/Choose a label/)
      expect(() => validateAIProviders(document({ ...view, dataKind: "traces", source: { ...query, providerId: "tracing" } }), providers)).toThrow(/tooltip.*wrong data kind/)
    } finally { unregister() }
  })

  it("discovers and remaps tooltip providers without mutating sources", () => {
    const source = document({ type: "traces", source: { ...query, providerId: "old-tracing", query: "{ resource.service.name = {{service}} }" } })
    expect([...requiredProviders([source])].map(([id, kinds]) => [id, [...kinds]])).toEqual([["metrics", ["metrics"]], ["old-tracing", ["traces"]]])
    expect(() => remapDashboardProviders([source], { "old-tracing": "metrics" }, providers)).toThrow(/compatible.*tooltip/)
    const [mapped] = remapDashboardProviders([source], { "old-tracing": "tracing" }, providers)
    expect(mapped.widgets[0].options?.tooltipView?.source).toMatchObject({ providerId: "tracing", bindings: query.bindings })
    expect(source.widgets[0].options?.tooltipView?.source).toMatchObject({ providerId: "old-tracing" })
  })
})

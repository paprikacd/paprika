import { describe, expect, it } from "vitest"
import {
  buildAIContext,
  dashboardToOpenUI,
  parseOpenUIDashboard,
  validateAIProviders,
} from "./openui"
import { dashboardSchema, type Dashboard, type Provider, type SavedQuery, type SavedQueryEntry } from "./schema"
import { registerWidgetPlugin } from "./widget-registry"
import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge"

export const fixture: Dashboard = {
  schemaVersion: 1,
  id: "production",
  title: "Production overview",
  description: "Services",
  timeRange: "1h",
  refreshInterval: 30,
  widgets: [
    {
      id: "requests",
      title: "Requests",
      type: "timeseries",
      providerId: "metrics",
      query: 'rate(http_requests_total{service="api"}[5m])',
      unit: "req/s",
      layout: { x: 0, y: 0, w: 6, h: 4 },
      color: "#be532a",
      description: "Throughput",
    },
    {
      id: "traces",
      title: "Slow traces",
      type: "traces",
      providerId: "tracing",
      query: "{ duration > 1s }",
      unit: "ms",
      layout: { x: 6, y: 0, w: 6, h: 4 },
    },
  ],
}
const providers: Provider[] = [
  {
    id: "metrics",
    name: "Prometheus",
    type: "prometheus",
    capabilities: ["metrics"],
  },
  { id: "tracing", name: "Tempo", type: "tempo", capabilities: ["traces"] },
]

describe("OpenUI dashboard authoring", () => {
  const saved: SavedQuery = { schemaVersion: 1, id: "availability", name: "Service availability", providerId: "metrics", kind: "metrics", query: "up{service={{service}}} * {{factor}}", parameters: [{ name: "service", type: "string" }, { name: "factor", type: "number", defaultValue: 1 }] }
  const linked: Dashboard = { ...fixture, variables: [{ name: "service" }], widgets: [{ ...fixture.widgets[0], providerId: "stale-provider", queryRef: { id: "availability", bindings: [{ parameter: "service", source: "variable", variable: "service" }] } }] }

  it("round trips saved references in the fourteenth optional position and tooltip sources", () => {
    const document: Dashboard = { ...linked, widgets: [{ ...linked.widgets[0], options: { tooltipView: { type: "stat", source: { type: "saved", ref: { id: saved.id, bindings: [{ parameter: "service", source: "label", label: "service" }, { parameter: "factor", source: "field", field: "value" }] } } } } }] }
    expect(parseOpenUIDashboard(dashboardToOpenUI(document))).toEqual(document)
    const legacy13 = 'root = Dashboard("a", "A", "1h", 0, [w])\nw = TimeSeries("w", "W", "metrics", "up", "", {"x":0,"y":0,"w":4,"h":3}, null, null, null, null, null, null, [])'
    expect(parseOpenUIDashboard(legacy13).widgets[0]).not.toHaveProperty("queryRef")
  })

  it.each([undefined, false, true])("round trips sparkline display %s in the existing options argument with saved references", (showSparkline) => {
    const setting = showSparkline === undefined ? {} : { showSparkline }
    const document: Dashboard = { ...linked, widgets: [{
      ...linked.widgets[0], type: "stat", options: {
        ...setting,
        tooltipView: { type: "stat", ...setting, source: { type: "saved", ref: {
          id: saved.id, bindings: [{ parameter: "service", source: "label", label: "service" }],
        } } },
      },
    }] }
    const source = dashboardToOpenUI(document)
    expect(parseOpenUIDashboard(source)).toEqual(document)
    expect(parseOpenUIDashboard(source).widgets[0].queryRef).toEqual(linked.widgets[0].queryRef)
    if (showSparkline === undefined) expect(source).not.toContain("showSparkline")
    else expect(source.match(/"showSparkline":/g)).toHaveLength(2)
  })

  it("validates the effective saved provider and typed bindings without requiring input values", () => {
    const entry: SavedQueryEntry = { ...saved, etag: '"version"' }
    expect(() => validateAIProviders(linked, providers, [entry])).not.toThrow()
    const tooltip: Dashboard = { ...linked, widgets: [{ ...linked.widgets[0], options: { tooltipView: { type: "bar", source: { type: "saved", ref: { id: saved.id, bindings: [{ parameter: "service", source: "label", label: "not-present-yet" }, { parameter: "factor", source: "field", field: "timestamp" }] } } } } }] }
    expect(() => validateAIProviders(tooltip, providers, [entry])).not.toThrow()
    expect(() => validateAIProviders(linked, providers, [{ ...saved, providerId: "tracing" }])).toThrow(/metrics provider/)
  })

  it("rejects unknown references, wrong kind, missing parameters, unsafe constants and undeclared variables", () => {
    expect(() => validateAIProviders(linked, providers)).toThrow(/unavailable/)
    expect(() => validateAIProviders(linked, providers, [{ ...saved, kind: "traces" }])).toThrow(/does not provide metrics/)
    expect(() => validateAIProviders({ ...linked, variables: [] }, providers, [saved])).toThrow(/undeclared dashboard variable/)
    const withBindings = (bindings: NonNullable<NonNullable<Dashboard["widgets"][number]["queryRef"]>["bindings"]>): Dashboard => ({ ...linked, widgets: [{ ...linked.widgets[0], queryRef: { id: saved.id, bindings } }] })
    expect(() => validateAIProviders(withBindings([]), providers, [saved])).toThrow(/Set a value/)
    expect(() => validateAIProviders(withBindings([{ parameter: "unknown", source: "constant", value: "x" }]), providers, [saved])).toThrow(/no parameter/)
    expect(() => validateAIProviders(withBindings([{ parameter: "service", source: "constant", value: "api" }, { parameter: "factor", source: "constant", value: "1 or vector(99)" }]), providers, [saved])).toThrow(/finite number/)
  })

  it("provides authoritative typed saved definitions and explicit reference rules in AI context", () => {
    const entry: SavedQueryEntry = { ...saved, etag: '"private-concurrency-token"' }
    const prompt = buildAIContext(linked, providers, "Reuse availability", [entry])
    expect(prompt).toContain("14th widget argument queryRef")
    expect(prompt).toContain("Available saved query definitions")
    expect(prompt).toContain('"type": "number"')
    expect(prompt).toContain('"defaultValue": 1')
    expect(prompt).toContain("name matching does not automatically bind")
    expect(prompt).not.toContain("private-concurrency-token")
  })
  it("round trips tooltip sub-widgets without a separate document model", () => {
    const dashboard: Dashboard = {
      ...fixture,
      widgets: [{ ...fixture.widgets[0], type: "heatmap", options: {
        tooltipView: { type: "timeseries", height: 120, showGrid: false, showAxis: true },
      } }],
    }
    expect(parseOpenUIDashboard(dashboardToOpenUI(dashboard))).toEqual(dashboard)
  })

  it("round trips the persisted document including escaped queries and optional props", () => {
    expect(parseOpenUIDashboard(dashboardToOpenUI(fixture))).toEqual(fixture)
  })

  it("accepts a complete fenced response", () => {
    expect(parseOpenUIDashboard(`\`\`\`openui-lang\n${dashboardToOpenUI(fixture)}\`\`\``)).toEqual(
      fixture,
    )
  })

  it("supports every widget type without a second storage format", () => {
    for (const type of ["timeseries", "bar", "stat", "table", "traces", "heatmap"] as const) {
      const dashboard = {
        ...fixture,
        widgets: [{ ...fixture.widgets[0], type }],
      }
      expect(parseOpenUIDashboard(dashboardToOpenUI(dashboard))).toEqual(dashboard)
    }
  })

  it("rejects incomplete or unresolved model output rather than applying partial widgets", () => {
    expect(() => parseOpenUIDashboard('root = Dashboard("a", "A", "1h", 0, [missing])')).toThrow()
    expect(() => parseOpenUIDashboard(dashboardToOpenUI(fixture).slice(0, -40))).toThrow()
  })

  it("rejects unknown components, runtime variables, tools, and unused statements", () => {
    const source = dashboardToOpenUI(fixture)
    expect(() => parseOpenUIDashboard(source.replace("TimeSeries(", "Unknown("))).toThrow()
    expect(() => parseOpenUIDashboard(`${source}\n$data = 1`)).toThrow(/static/i)
    expect(() => parseOpenUIDashboard(`${source}\nq = Query("fetch", {})`)).toThrow(/static/i)
    expect(() => parseOpenUIDashboard(`${source}\nunused = "hidden"`)).toThrow(/unused/i)
  })

  it("rejects invalid layout and duplicate widget ids through canonical validation", () => {
    const source = dashboardToOpenUI(fixture)
    expect(() => parseOpenUIDashboard(source.replace('"w":6', '"w":13'))).toThrow()
    expect(() =>
      parseOpenUIDashboard(source.replace('Traces("traces"', 'Traces("requests"')),
    ).toThrow(/unique/)
  })

  it("bounds source size and recursive depth before parsing", () => {
    expect(() => parseOpenUIDashboard(" ".repeat(262145) + "x")).toThrow(/256 KiB/)
    expect(() => parseOpenUIDashboard("[".repeat(33))).toThrow(/nesting/)
  })

  it("checks provider identity and capabilities", () => {
    expect(() => validateAIProviders(fixture, providers)).not.toThrow()
    expect(() => validateAIProviders(fixture, providers.slice(0, 1))).toThrow(/unknown provider/)
    expect(() =>
      validateAIProviders(
        {
          ...fixture,
          widgets: [{ ...fixture.widgets[0], providerId: "tracing" }],
        },
        providers,
      ),
    ).toThrow(/metrics provider/)
  })

  it("generates model instructions from the actual registered component library", () => {
    const prompt = buildAIContext(fixture, providers, "Add a requests stat")
    expect(prompt).toContain("TimeSeries(")
    expect(prompt).toContain("Traces(")
    expect(prompt).toContain('"id": "metrics"')
    expect(prompt).toContain("Add a requests stat")
    expect(prompt).toContain("instead of fabricating one")
  })

  it("gives AI authors the supported presets and real gallery plugin controls", () => {
    registerDefaultWidgetPlugins()
    const prompt = buildAIContext(fixture, providers, "Build a grouped treemap and a gauge bank")
    expect(prompt).toContain(`Keep timeRange in ${dashboardSchema.shape.timeRange.options.join(", ")}`)
    expect(prompt).toContain('"key": "showStatus"')
    expect(prompt).toContain('"key": "seriesMode"')
    expect(prompt).toContain('"key": "group"')
    expect(prompt).toContain('"key": "colorField"')
    expect(prompt).toContain('"recordColumn": "number"')
    expect(prompt).toContain('"defaultConfig"')
    expect(prompt).toContain("These controls are not necessarily the complete plugin schema")
    expect(prompt).toContain("PostgreSQL uses a JSON query with sql and optional parameters")
    expect(prompt).toContain("Do not assume every metrics query uses PromQL")
    expect(prompt).not.toContain("Prometheus PromQL query displayed as plugin")
    for (const timeRange of ["30m", "30d"] as const) {
      const document = { ...fixture, timeRange }
      expect(parseOpenUIDashboard(dashboardToOpenUI(document))).toEqual(document)
    }
  })

  it("retains folders, custom ranges, display options and plugin JSON through OpenUI", () => {
    const dashboard: Dashboard = {
      ...fixture,
      folder: "Production/Europe",
      customTimeRange: {
        from: "2026-10-01T00:00:00Z",
        to: "2026-10-01T01:00:00Z",
      },
      widgets: [
        {
          ...fixture.widgets[0],
          type: "plugin",
          pluginId: "test-gauge",
          dataKind: "metrics",
          options: {
            decimals: 2,
            min: 0,
            max: 1,
            showTooltip: false,
            thresholds: [
              { value: 0, color: "#ff0000", label: "Down" },
              { value: 1, color: "#00ff00", label: "Up" },
            ],
          },
          config: {
            label: "Current state",
            groups: ["api", "web"],
            nested: { enabled: true },
          },
        },
      ],
    }
    expect(parseOpenUIDashboard(dashboardToOpenUI(dashboard))).toEqual(dashboard)
    expect(() => validateAIProviders(dashboard, providers)).toThrow(/registered plugin/)
    const unregister = registerWidgetPlugin({
      id: "test-gauge",
      label: "Custom gauge",
      description: "A trusted gauge",
      dataKind: "metrics",
      render: () => null,
      parseConfig: (config) => {
        if (!config?.label) throw new Error("Missing label")
        return config
      },
    })
    try {
      expect(() => validateAIProviders(dashboard, providers)).not.toThrow()
      expect(buildAIContext(dashboard, providers, "Keep the gauge")).toContain('"id": "test-gauge"')
      expect(() =>
        validateAIProviders(
          { ...dashboard, widgets: [{ ...dashboard.widgets[0], config: {} }] },
          providers,
        ),
      ).toThrow(/Missing label/)
      expect(() =>
        validateAIProviders(
          {
            ...dashboard,
            widgets: [
              {
                ...dashboard.widgets[0],
                providerId: "tracing",
                dataKind: "traces",
              },
            ],
          },
          providers,
        ),
      ).toThrow(/wrong data kind/)
    } finally {
      unregister()
    }
  })

  it("keeps older positional OpenUI documents valid", () => {
    const source =
      'root = Dashboard("legacy", "Legacy", "1h", 0, [health])\nhealth = Stat("health", "Health", "metrics", "up", "", {"x":0,"y":0,"w":4,"h":2})'
    expect(parseOpenUIDashboard(source)).toMatchObject({
      id: "legacy",
      widgets: [{ type: "stat", query: "up" }],
    })
  })
  it("retains independent heatmap label and value visibility through OpenUI", () => {
    for (const showLabels of [true, false])
      for (const showValues of [true, false]) {
        const dashboard: Dashboard = {
          ...fixture,
          widgets: [
            {
              ...fixture.widgets[0],
              type: "heatmap",
              options: { showLabels, showValues },
            },
          ],
        }
        expect(parseOpenUIDashboard(dashboardToOpenUI(dashboard))).toEqual(dashboard)
      }
  })

  it("retains dashboard variables and widget drilldowns in trailing optional positions", () => {
    const document: Dashboard = {
      ...fixture,
      variables: [{ name: "service", label: "Service", defaultValue: "api", options: ["api", "worker", "", 'quoted"\\\n{{service}}'] }],
      widgets: [
        {
          ...fixture.widgets[0],
          query: "up{service={{service}}}",
          drilldowns: [
            {
              id: "inspect",
              title: "Inspect service",
              dashboardId: "service-details",
              carryTimeRange: true,
              bindings: [{ variable: "service", source: "label", value: "service" }],
            },
          ],
        },
      ],
    }
    expect(parseOpenUIDashboard(dashboardToOpenUI(document))).toEqual(document)
    expect(buildAIContext(document, providers, "Keep links")).toContain(
      "without surrounding quotes",
    )
  })
})

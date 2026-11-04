import { describe, expect, it } from "vitest"
import {
  dashboardSchema,
  MAX_DOCUMENT_BYTES,
  MAX_WIDGETS,
  newWidget,
  widgetSchema,
  pluginConfigSchema,
  widgetKind,
  parseDashboard,
  serializeDashboard,
  tooltipViewSchema,
  type Dashboard,
  type Provider,
} from "./schema"

const dashboard: Dashboard = {
  schemaVersion: 1,
  id: "production",
  title: "Production overview",
  description: "API availability",
  timeRange: "1h",
  refreshInterval: 30,
  widgets: [
    {
      id: "requests",
      title: "Requests",
      type: "timeseries",
      providerId: "prometheus",
      query: 'sum(rate(http_requests_total{service="api"}[5m]))',
      unit: "req/s",
      layout: { x: 0, y: 0, w: 6, h: 4 },
      color: "#bb5522",
    },
  ],
}

describe("tooltip sub-widget contract", () => {
  it("accepts optional stat sparkline booleans without changing legacy defaults", () => {
    for (const enabled of [true, false]) {
      expect(tooltipViewSchema.parse({ type: "stat", showSparkline: enabled })).toEqual({ type: "stat", showSparkline: enabled })
      expect(widgetSchema.parse({ ...dashboard.widgets[0], type: "stat", options: { showSparkline: enabled } }).options?.showSparkline).toBe(enabled)
    }
    expect(tooltipViewSchema.parse({ type: "stat" })).not.toHaveProperty("showSparkline")
    for (const invalid of ["true", 1, null, {}]) {
      expect(tooltipViewSchema.safeParse({ type: "stat", showSparkline: invalid }).success).toBe(false)
      expect(widgetSchema.safeParse({ ...dashboard.widgets[0], options: { showSparkline: invalid } }).success).toBe(false)
    }
  })
  it.each(["json", "yaml"] as const)("retains a bounded tooltip view through %s", (format) => {
    const document: Dashboard = {
      ...dashboard,
      widgets: [{ ...dashboard.widgets[0], type: "heatmap", options: {
        tooltipView: { type: "timeseries", height: 200, showGrid: false, showAxis: false },
      } }],
    }
    expect(parseDashboard(serializeDashboard(document, format), format)).toEqual(document)
    expect(widgetSchema.parse(dashboard.widgets[0]).options?.tooltipView).toBeUndefined()
  })

  it("rejects unknown, recursive or unscoped tooltip query definitions", () => {
    for (const view of [null, {}, { type: "remote" }, { type: "timeseries", height: 121 },
      { type: "timeseries", height: "160" }, { type: "timeseries", height: null },
      { type: "timeseries", showAxis: "yes" }, { type: "timeseries", showGrid: null },
      { type: "timeseries", query: "up" }, { type: "timeseries", providerId: "metrics" },
      { type: "timeseries", tooltipView: { type: "timeseries" } },
    ]) expect(tooltipViewSchema.safeParse(view).success).toBe(false)
    expect(tooltipViewSchema.parse({ type: "timeseries" })).toEqual({ type: "timeseries" })
    for (const height of [120, 160, 200, 320]) expect(tooltipViewSchema.safeParse({ type: "timeseries", height }).success).toBe(true)
  })
})

describe("dashboard document contract", () => {
  it("allows one-row stat widgets, but not other visualizations", () => {
    for (const type of ["stat", "timeseries", "bar", "table", "traces", "heatmap"] as const) {
      const widget = { ...dashboard.widgets[0], type, layout: { x: 0, y: 0, w: 4, h: 1 } }
      expect(widgetSchema.safeParse(widget).success, type).toBe(type === "stat")
    }
  })
  it.each(["json", "yaml"] as const)(
    "round trips %s without losing queries or layout",
    (format) => {
      expect(
        parseDashboard(serializeDashboard(dashboard, format), format),
      ).toEqual(dashboard)
    },
  )

  it("rejects unknown properties and unsupported versions", () => {
    expect(() =>
      parseDashboard(
        JSON.stringify({ ...dashboard, script: "alert(1)" }),
        "json",
      ),
    ).toThrow(/Unrecognized key/)
    expect(() =>
      parseDashboard(
        JSON.stringify({ ...dashboard, schemaVersion: 2 }),
        "json",
      ),
    ).toThrow(/schemaVersion/)
    expect(() =>
      parseDashboard(
        JSON.stringify({
          ...dashboard,
          widgets: [{ ...dashboard.widgets[0], html: "<script />" }],
        }),
        "json",
      ),
    ).toThrow(/Unrecognized key/)
  })

  it("rejects duplicate ids and invalid grid bounds", () => {
    expect(
      dashboardSchema.safeParse({
        ...dashboard,
        widgets: [dashboard.widgets[0], dashboard.widgets[0]],
      }).success,
    ).toBe(false)
    expect(
      dashboardSchema.safeParse({
        ...dashboard,
        widgets: [
          { ...dashboard.widgets[0], layout: { x: 8, y: 0, w: 6, h: 4 } },
        ],
      }).success,
    ).toBe(false)
    expect(
      dashboardSchema.safeParse({
        ...dashboard,
        widgets: [
          { ...dashboard.widgets[0], layout: { x: 0, y: 0, w: 6, h: 0 } },
        ],
      }).success,
    ).toBe(false)
  })

  it("rejects path-like ids, unsafe color strings, and unsupported widget types", () => {
    for (const id of ["../production", "dashboard/id", "", "a.b"])
      expect(dashboardSchema.safeParse({ ...dashboard, id }).success).toBe(
        false,
      )
    expect(
      dashboardSchema.safeParse({
        ...dashboard,
        widgets: [
          { ...dashboard.widgets[0], color: "url(https://example.com/a)" },
        ],
      }).success,
    ).toBe(false)
    expect(
      dashboardSchema.safeParse({
        ...dashboard,
        widgets: [{ ...dashboard.widgets[0], type: "html" }],
      }).success,
    ).toBe(false)
  })

  it("rejects duplicate YAML keys, aliases, merge keys, and multi-document input", () => {
    const source = serializeDashboard(dashboard, "yaml")
    expect(() =>
      parseDashboard(`${source}\ntitle: Duplicate\n`, "yaml"),
    ).toThrow()
    expect(() =>
      parseDashboard(
        source
          .replace(
            "title: Production overview",
            'title: &title "Production overview"',
          )
          .replace("description: API availability", "description: *title"),
        "yaml",
      ),
    ).toThrow()
    expect(() =>
      parseDashboard(`${source}\n<<: { title: Injected }\n`, "yaml"),
    ).toThrow()
    expect(() => parseDashboard(`${source}\n---\n${source}`, "yaml")).toThrow()
  })

  it("treats all content as data and never evaluates executable YAML tags", () => {
    const source = serializeDashboard(dashboard, "yaml").replace(
      "title: Production overview",
      "title: !!js/function 'function () { throw new Error(\"executed\") }'",
    )
    const result = parseDashboard(source, "yaml")
    expect(result.title).toContain("function ()")
  })

  it("limits UTF-8 bytes, widgets, query length, and nonfinite numbers", () => {
    expect(() =>
      parseDashboard(" ".repeat(MAX_DOCUMENT_BYTES + 1), "yaml"),
    ).toThrow(/256 KiB/)
    expect(() =>
      parseDashboard(
        JSON.stringify({
          ...dashboard,
          description: "😀".repeat(MAX_DOCUMENT_BYTES / 4),
        }),
        "json",
      ),
    ).toThrow(/256 KiB/)
    expect(
      dashboardSchema.safeParse({
        ...dashboard,
        widgets: Array.from({ length: MAX_WIDGETS + 1 }, (_, index) => ({
          ...dashboard.widgets[0],
          id: `w-${index}`,
        })),
      }).success,
    ).toBe(false)
    expect(
      dashboardSchema.safeParse({
        ...dashboard,
        widgets: [{ ...dashboard.widgets[0], query: "x".repeat(8193) }],
      }).success,
    ).toBe(false)
    expect(
      dashboardSchema.safeParse({
        ...dashboard,
        widgets: [
          {
            ...dashboard.widgets[0],
            layout: { x: Infinity, y: 0, w: 6, h: 4 },
          },
        ],
      }).success,
    ).toBe(false)
  })

  it("chooses a compatible provider when adding metrics or trace widgets", () => {
    const providers: Provider[] = [
      { id: "tempo", name: "Tempo", type: "tempo", capabilities: ["traces"] },
      {
        id: "prometheus",
        name: "Prometheus",
        type: "prometheus",
        capabilities: ["metrics"],
      },
    ]
    expect(newWidget("traces", providers, dashboard.widgets)).toMatchObject({
      providerId: "tempo",
      query: "{}",
      layout: { y: 4 },
    })
    expect(newWidget("stat", providers, dashboard.widgets)).toMatchObject({
      providerId: "prometheus",
      query: "up",
    })
    expect(newWidget("stat", [], [])).toMatchObject({
      providerId: "unconfigured",
    })
  })

  it.each(["json", "yaml"] as const)(
    "round trips extended dashboards through %s",
    (format) => {
      const extended: Dashboard = {
        ...dashboard,
        folder: "Production/Payments",
        customTimeRange: {
          from: "2026-10-01T10:00:00+10:00",
          to: "2026-10-02T10:00:00+10:00",
        },
        widgets: [
          {
            ...dashboard.widgets[0],
            type: "plugin",
            pluginId: "threshold-gauge",
            dataKind: "metrics",
            config: {
              label: "API",
              nested: { tags: ["production", 12, true, null] },
            },
            options: {
              display: "area",
              xAxisLabel: "Time",
              yAxisLabel: "Requests",
              showLegend: false,
              showTooltip: true,
              showGrid: false,
              decimals: 3,
              min: -10,
              max: 100,
              lineWidth: 2.5,
              fillOpacity: 0.4,
              curve: "monotone",
              background: "#f0f1eb",
              textColor: "#112233",
              thresholds: [
                { value: 0, color: "#009900", label: "Healthy" },
                { value: 90, color: "#aa0000", label: "Critical" },
              ],
            },
          },
        ],
      }
      expect(
        parseDashboard(serializeDashboard(extended, format), format),
      ).toEqual(extended)
    },
  )

  it("validates bounds, thresholds, styling and plugin metadata without weakening legacy documents", () => {
    for (const options of [
      { min: 1, max: 1 },
      { min: Infinity },
      { decimals: 9 },
      { decimals: 0.5 },
      { lineWidth: 0 },
      { fillOpacity: 2 },
      {
        thresholds: [
          { value: 1, color: "#ff0000" },
          { value: 0, color: "#00ff00" },
        ],
      },
      {
        thresholds: [
          { value: 1, color: "#ff0000" },
          { value: 1, color: "#00ff00" },
        ],
      },
      { thresholds: [{ value: NaN, color: "#ff0000" }] },
      { background: "url(http://example.com)" },
      { curve: "javascript" },
    ])
      expect(
        widgetSchema.safeParse({ ...dashboard.widgets[0], options }).success,
      ).toBe(false)
    expect(
      widgetSchema.safeParse({ ...dashboard.widgets[0], type: "plugin" })
        .success,
    ).toBe(false)
    expect(
      widgetSchema.safeParse({ ...dashboard.widgets[0], config: {} }).success,
    ).toBe(false)
    expect(widgetKind({ type: "heatmap" })).toBe("metrics")
    expect(widgetKind({ type: "plugin", dataKind: "traces" })).toBe("traces")
    expect(() => newWidget("plugin", [], [])).toThrow(/plugin/)
  })

  it("bounds plugin JSON, rejects reserved keys and never accepts executable values", () => {
    expect(pluginConfigSchema.safeParse({ format: () => "run" }).success).toBe(
      false,
    )
    expect(
      pluginConfigSchema.safeParse({ data: "x".repeat(16384) }).success,
    ).toBe(false)
    let nested: unknown = "leaf"
    for (let index = 0; index < 9; index++) nested = { next: nested }
    expect(pluginConfigSchema.safeParse({ nested }).success).toBe(false)
    for (const key of ["constructor", "prototype", "__proto__"]) {
      const config = JSON.parse(`{"nested":{"${key}":"no"}}`)
      expect(pluginConfigSchema.safeParse(config).success, key).toBe(false)
    }
  })

  it("requires useful folder paths and explicit bounded custom time ranges", () => {
    for (const folder of [
      ".",
      "../Production",
      "Production/",
      "Production//API",
      "Production/ API",
      "Production\\API",
      "\u0000bad",
    ])
      expect(
        dashboardSchema.safeParse({ ...dashboard, folder }).success,
        folder,
      ).toBe(false)
    for (const customTimeRange of [
      { from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" },
      { from: "2026-10-01T00:00:00Z", to: "2026-10-01T00:00:00Z" },
      { from: "2026-01-01T00:00:00Z", to: "2026-03-01T00:00:00Z" },
      { from: "2026-10-01T00:00:00", to: "2026-10-01T01:00:00" },
      { from: "1960-01-01T00:00:00Z", to: "1960-01-02T00:00:00Z" },
    ])
      expect(
        dashboardSchema.safeParse({ ...dashboard, customTimeRange }).success,
      ).toBe(false)
  })
  it.each(["json", "yaml"] as const)(
    "preserves all heatmap visibility combinations through %s",
    (format) => {
      for (const showLabels of [true, false])
        for (const showValues of [true, false]) {
          const document: Dashboard = {
            ...dashboard,
            widgets: [
              {
                ...dashboard.widgets[0],
                type: "heatmap",
                options: { showLabels, showValues },
              },
            ],
          }
          expect(
            parseDashboard(serializeDashboard(document, format), format),
          ).toEqual(document)
        }
      const legacy: Dashboard = {
        ...dashboard,
        widgets: [{ ...dashboard.widgets[0], type: "heatmap" }],
      }
      expect(
        parseDashboard(serializeDashboard(legacy, format), format),
      ).toEqual(legacy)
    },
  )

  it("accepts only boolean heatmap visibility settings while preserving omitted defaults", () => {
    for (const key of ["showLabels", "showValues"]) {
      for (const value of [null, "false", 0, [], {}])
        expect(
          widgetSchema.safeParse({
            ...dashboard.widgets[0],
            type: "heatmap",
            options: { [key]: value },
          }).success,
        ).toBe(false)
    }
    expect(
      widgetSchema.parse({
        ...dashboard.widgets[0],
        type: "heatmap",
        options: {},
      }).options,
    ).toEqual({})
  })
})

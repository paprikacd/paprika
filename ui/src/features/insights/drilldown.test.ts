import { describe, expect, it } from "vitest"
import {
  buildDashboardURL,
  interpolateQuery,
  interpolateQueryLiterals,
  parseDashboardURL,
  resolveDashboardVariables,
  resolveDrilldown,
} from "./drilldown"
import {
  dashboardSchema,
  dashboardVariableSchema,
  drilldownSchema,
  parseDashboard,
  serializeDashboard,
  widgetSchema,
  type Dashboard,
  type Drilldown,
} from "./schema"

describe("complete numeric query literals", () => {
  it("supports finite observations in arithmetic and timestamp positions without changing string variables", () => {
    expect(interpolateQueryLiterals("up{service={{service}}}@{{time}} > {{value}}+{{zero}}", {
      service: 'a"\\\n{{time}}', time: 1792490400.125, value: -7.25, zero: 0,
    })).toBe(`up{service=${JSON.stringify('a"\\\n{{time}}')}}@1792490400.125 > -7.25+0`)
    expect(() => interpolateQuery("up > {{value}}", { value: 1 } as unknown as Record<string, string>)).toThrow()
  })
  it("rejects non-finite values and fragments, comments, quoted placeholders and non-literal data", () => {
    for (const value of [NaN, Infinity, -Infinity, null, true, {}, []])
      expect(() => interpolateQueryLiterals("up > {{value}}", { value } as unknown as Record<string, number>)).toThrow()
    for (const query of ['up{a="{{value}}"}', "up # {{value}}", "prefix{{value}}", "{{value}}ms", "up[{{value}}s]"])
      expect(() => interpolateQueryLiterals(query, { value: 1 })).toThrow()
  })
})

const target: Dashboard = {
  schemaVersion: 1,
  id: "service-details",
  title: "Service details",
  timeRange: "1h",
  refreshInterval: 0,
  variables: [
    { name: "service", label: "Service" },
    { name: "environment", defaultValue: "production" },
    { name: "reading" },
    { name: "series" },
  ],
  widgets: [],
}
const link: Drilldown = {
  id: "details",
  title: "Inspect service",
  dashboardId: target.id,
  bindings: [
    { variable: "service", source: "label", value: "service" },
    { variable: "reading", source: "value" },
    { variable: "series", source: "series" },
  ],
}
const bounds = {
  start: Date.parse("2026-10-01T12:00:00Z") / 1000,
  end: Date.parse("2026-10-01T13:00:00Z") / 1000,
}

describe("dashboard variables and drilldown contracts", () => {
  it.each(["json", "yaml"] as const)("round trips variables and links through %s", (format) => {
    const document: Dashboard = {
      ...target,
      variables: [{ name: "service", label: "Service", defaultValue: "api", options: ["api", "worker", "", 'quoted"\\\n{{service}}'] }],
      widgets: [
        {
          id: "health",
          title: "Health",
          type: "heatmap",
          providerId: "metrics",
          query: "up{service={{service}}}",
          unit: "",
          layout: { x: 0, y: 0, w: 6, h: 4 },
          drilldowns: [link],
        },
      ],
    }
    expect(parseDashboard(serializeDashboard(document, format), format)).toEqual(document)
  })

  it("keeps dropdown suggestions compatible with defaults and linked values outside the list", () => {
    const variables = [{ name: "service", defaultValue: "default-outside-list", options: ["api", "worker", ""] }]
    const document = dashboardSchema.parse({ ...target, variables })
    expect(resolveDashboardVariables(document, {})).toEqual({ service: "default-outside-list" })
    expect(resolveDashboardVariables(document, { service: "from-link" })).toEqual({ service: "from-link" })
    expect(resolveDashboardVariables(document, { service: "" })).toEqual({ service: "" })
  })

  it("bounds dropdown options without rejecting valid empty strings or Unicode", () => {
    expect(dashboardVariableSchema.parse({ name: "service", options: [""] }).options).toEqual([""])
    expect(dashboardVariableSchema.safeParse({ name: "service", options: ["😀".repeat(512)] }).success).toBe(true)
    expect(dashboardVariableSchema.safeParse({ name: "service", defaultValue: "😀".repeat(513) }).success).toBe(false)
    expect(dashboardVariableSchema.safeParse({ name: "service", options: Array.from({ length: 100 }, (_, index) => String(index)) }).success).toBe(true)
    for (const options of [null, {}, "api", [], [null], [1], [true], [{}], [["api"]], ["api", "api"], ["", ""], ["😀".repeat(513)], Array.from({ length: 101 }, (_, index) => String(index))])
      expect(dashboardVariableSchema.safeParse({ name: "service", options }).success, JSON.stringify(options)).toBe(false)
  })

  it("rejects duplicate variables, reserved names, bounds, and unsupported binding combinations", () => {
    for (const variables of [
      [{ name: "service" }, { name: "service" }],
      [{ name: "__proto__" }],
      [{ name: "constructor" }],
      [{ name: "1wrong" }],
      [{ name: "service", defaultValue: 1 }],
      [{ name: "service", defaultValue: "x".repeat(1025) }],
      Array.from({ length: 21 }, (_, index) => ({ name: `v${index}` })),
    ])
      expect(dashboardSchema.safeParse({ ...target, variables }).success).toBe(false)
    for (const bindings of [
      [{ variable: "service", source: "label" }],
      [{ variable: "service", source: "label", value: "" }],
      [{ variable: "service", source: "constant" }],
      [{ variable: "service", source: "value", value: "a" }],
      [{ variable: "service", source: "series", value: "a" }],
      [{ variable: "service", source: "url", value: "https://example.com" }],
      [
        { variable: "service", source: "constant", value: "a" },
        { variable: "service", source: "constant", value: "b" },
      ],
    ])
      expect(drilldownSchema.safeParse({ ...link, bindings }).success).toBe(false)
    expect(drilldownSchema.safeParse({ ...link, dashboardId: "https://example.com" }).success).toBe(
      false,
    )
    const widget = {
      id: "a",
      title: "A",
      type: "stat",
      providerId: "metrics",
      query: "up",
      unit: "",
      layout: { x: 0, y: 0, w: 4, h: 2 },
    }
    expect(widgetSchema.safeParse({ ...widget, drilldowns: [link, link] }).success).toBe(false)
    expect(
      widgetSchema.safeParse({
        ...widget,
        drilldowns: Array.from({ length: 9 }, (_, i) => ({ ...link, id: `d${i}` })),
      }).success,
    ).toBe(false)
    expect(
      drilldownSchema.safeParse({
        ...link,
        bindings: [{ variable: "service", source: "constant", value: "" }],
      }).success,
    ).toBe(true)
  })

  it("merges declared defaults without inventing values and rejects undeclared overrides", () => {
    expect(resolveDashboardVariables(target)).toEqual({ environment: "production" })
    expect(resolveDashboardVariables(target, { service: "api", environment: "" })).toEqual({
      service: "api",
      environment: "",
    })
    expect(() => resolveDashboardVariables(target, { unknown: "value" })).toThrow(/not declared/)
  })

  it("resolves exact signal context and carries a fixed source time range", () => {
    const resolved = resolveDrilldown(
      link,
      { labels: { service: "api" }, value: 0.123456789, series: "API requests" },
      target,
      bounds,
    )
    expect(resolved).toEqual({
      dashboardId: target.id,
      variables: {
        service: "api",
        environment: "production",
        reading: "0.123456789",
        series: "API requests",
      },
      customTimeRange: { from: "2026-10-01T12:00:00.000Z", to: "2026-10-01T13:00:00.000Z" },
    })
    expect(
      resolveDrilldown(
        {
          ...link,
          carryTimeRange: false,
          bindings: [{ variable: "service", source: "constant", value: "api" }],
        },
        {},
        target,
      ),
    ).toEqual({ dashboardId: target.id, variables: { service: "api", environment: "production" } })
  })

  it("reports missing labels, series, numeric values, variables and targets", () => {
    expect(() => resolveDrilldown(link, {}, target, bounds)).toThrow(/no label “service”/)
    expect(() =>
      resolveDrilldown(link, { labels: { service: "api" }, value: null }, target, bounds),
    ).toThrow(/no finite value/)
    expect(() =>
      resolveDrilldown(link, { labels: { service: "api" }, value: 2 }, target, bounds),
    ).toThrow(/Select a series/)
    expect(() =>
      resolveDrilldown({ ...link, bindings: [] }, {}, { ...target, id: "other" }, bounds),
    ).toThrow(/does not match/)
    expect(() => resolveDrilldown({ ...link, bindings: [] }, {}, target)).toThrow(
      /time range is unavailable/,
    )
    expect(() =>
      resolveDrilldown({ ...link, bindings: [] }, {}, target, { start: 10, end: 1 }),
    ).toThrow(/increasing/)
  })
})

describe("safe complete-string query interpolation", () => {
  it("escapes user values once as complete PromQL and TraceQL string literals", () => {
    const service = 'api"} or vector(999) #\n\\next'
    expect(interpolateQuery("up{service={{service}}}", { service })).toBe(
      `up{service=${JSON.stringify(service)}}`,
    )
    expect(
      interpolateQuery("{ resource.service.name = {{service}} }", { service: "checkout" }),
    ).toBe('{ resource.service.name = "checkout" }')
    expect(
      interpolateQuery('label_replace(up, {{service}}, {{service}}, "job", ".*")', {
        service: "api",
      }),
    ).toBe('label_replace(up, "api", "api", "job", ".*")')
  })

  it("rejects interpolation inside all string forms, comments, and identifier fragments", () => {
    for (const query of [
      'up{service="{{service}}"}',
      "up{service='{{service}}'}",
      "up{service=`{{service}}`}",
      'up{service="escaped\\\"{{service}}"}',
    ])
      expect(() => interpolateQuery(query, { service: "api" })).toThrow(/surrounding quotes/)
    for (const query of ["up # {{service}}", "up // {{service}}", "up /* {{service}} */"])
      expect(() => interpolateQuery(query, { service: "api" })).toThrow(/comment/)
    for (const query of [
      "metric_{{service}}",
      "{{service}}suffix",
      "{{ service }}",
      "up{service={{service}",
    ])
      expect(() => interpolateQuery(query, { service: "api" })).toThrow()
    expect(() => interpolateQuery("up{service={{service}}}", {})).toThrow(/Set dashboard variable/)
  })

  it("handles comment delimiters inside strings, escaped quotes, newlines and bounded output", () => {
    const query =
      'up{job="a#b//c/*d*/",service={{service}}} # ordinary comment\n+ up{service={{service}}}'
    expect(interpolateQuery(query, { service: "api" })).toBe(
      query.replaceAll("{{service}}", '"api"'),
    )
    expect(() =>
      interpolateQuery(`some_function(${Array(20).fill("{{service}}").join(",")})`, {
        service: "x".repeat(1024),
      }),
    ).toThrow(/after inserting/)
  })
})

describe("shareable same-route dashboard navigation", () => {
  it("round trips special values and fixed times under a local path base", () => {
    const state = {
      dashboardId: target.id,
      variables: { service: 'api&dashboard=evil"\\' },
      customTimeRange: { from: "2026-10-01T12:00:00Z", to: "2026-10-01T13:00:00Z" },
    }
    const url = buildDashboardURL(state, "/paprika/dashboard/insights/")
    expect(url.startsWith("/paprika/dashboard/insights/?dashboard=service-details&")).toBe(true)
    expect(parseDashboardURL(url.slice(url.indexOf("?")) + "&example=1")).toEqual(state)
    expect(parseDashboardURL("?example=1")).toBeNull()
    expect(parseDashboardURL("")).toBeNull()
  })

  it("rejects external destinations, traversal, duplicate or incomplete URL state", () => {
    for (const base of [
      "https://example.com/dashboard/insights/",
      "//evil/dashboard/insights/",
      "/../dashboard/insights/",
      "/a//dashboard/insights/",
      "/dashboard/insights/?next=evil",
      "/dashboard/insights/../../",
    ])
      expect(() => buildDashboardURL({ dashboardId: target.id }, base)).toThrow(/local Insights/)
    for (const search of [
      "?dashboard=one&dashboard=two",
      "?vars=%7B%7D",
      "?dashboard=../bad",
      "?dashboard=a&from=2026-10-01T00:00:00Z",
      "?dashboard=a&vars=[]",
      "?dashboard=a&vars=%7B%22x%22%3A1%7D",
      "?dashboard=a&vars=%7B%22__proto__%22%3A%22bad%22%7D",
      "https://example.com/?dashboard=a",
    ])
      expect(() => parseDashboardURL(search)).toThrow()
    expect(() =>
      buildDashboardURL({
        dashboardId: target.id,
        variables: Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [`v${i}`, "x".repeat(1024)]),
        ),
      }),
    ).toThrow(/URL limit/)
  })
})

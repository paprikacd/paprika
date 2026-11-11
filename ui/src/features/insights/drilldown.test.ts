import { describe, expect, it } from "vitest"
import {
  buildDashboardURL,
  describeIgnoredLink,
  interpolateQuery,
  interpolateQueryLiterals,
  MAX_DASHBOARD_URL_LENGTH,
  parseDashboardLink,
  parseDashboardURL,
  resolveDashboardVariables,
  resolveDrilldown,
  resolveLinkView,
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
      "?dashboard=a&vars=%7Bnope",
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

describe("view time range and refresh in the link", () => {
  const range = { from: "2026-10-01T12:00:00.000Z", to: "2026-10-01T13:00:00.000Z" }

  it.each(["15m", "30m", "1h", "6h", "24h", "7d", "30d"] as const)("round trips the %s preset", (preset) => {
    const url = buildDashboardURL({ dashboardId: "ops", range: preset })
    expect(url).toBe(`/dashboard/insights/?dashboard=ops&range=${preset}`)
    expect(parseDashboardURL(url.slice(url.indexOf("?")))).toEqual({ dashboardId: "ops", range: preset })
  })

  it.each([0, 15, 30, 60] as const)("round trips auto refresh of %i seconds, including off", (refresh) => {
    const url = buildDashboardURL({ dashboardId: "ops", refresh })
    expect(url).toContain(`&refresh=${refresh}`)
    expect(parseDashboardURL(url.slice(url.indexOf("?")))).toEqual({ dashboardId: "ops", refresh })
  })

  it("writes the preset, refresh and fixed window in a stable order after the variables", () => {
    expect(buildDashboardURL({ dashboardId: "ops", variables: { env: "prod" }, range: "6h", refresh: 30 }))
      .toBe("/dashboard/insights/?dashboard=ops&vars=%7B%22env%22%3A%22prod%22%7D&range=6h&refresh=30")
    expect(buildDashboardURL({ dashboardId: "ops", customTimeRange: range, refresh: 0 }))
      .toBe("/dashboard/insights/?dashboard=ops&from=2026-10-01T12%3A00%3A00.000Z&to=2026-10-01T13%3A00%3A00.000Z&refresh=0")
  })

  it("keeps existing links with only variables or a fixed window exactly as before", () => {
    const legacy = "?dashboard=ops&vars=%7B%22env%22%3A%22prod%22%7D&from=2026-10-01T12%3A00%3A00.000Z&to=2026-10-01T13%3A00%3A00.000Z"
    expect(parseDashboardURL(legacy)).toEqual({ dashboardId: "ops", variables: { env: "prod" }, customTimeRange: range })
    expect(buildDashboardURL({ dashboardId: "ops", variables: { env: "prod" }, customTimeRange: range })).toBe(`/dashboard/insights/${legacy}`)
  })

  it.each([
    ["a repeated preset", "?dashboard=ops&range=6h&range=1h"],
    ["a preset with a fixed window", "?dashboard=ops&range=6h&from=2026-10-01T12%3A00%3A00.000Z&to=2026-10-01T13%3A00%3A00.000Z"],
    ["a repeated refresh", "?dashboard=ops&refresh=15&refresh=30"],
    ["a window with only one end", "?dashboard=ops&from=2026-10-01T12%3A00%3A00.000Z"],
    ["a view without a dashboard", "?range=6h"],
    ["a view parameter without a dashboard", "?refresh=30"],
  ])("rejects structural errors: %s", (_label, search) => {
    expect(() => parseDashboardLink(search)).toThrow()
  })

  it.each([
    ["an unknown preset", "?dashboard=ops&range=2h", { name: "range", value: "2h" }],
    ["a capitalised preset", "?dashboard=ops&range=6H", { name: "range", value: "6H" }],
    ["an empty preset", "?dashboard=ops&range=", { name: "range", value: "" }],
    ["an unlisted refresh", "?dashboard=ops&refresh=45", { name: "refresh", value: "45" }],
    ["a refresh below the list", "?dashboard=ops&refresh=5", { name: "refresh", value: "5" }],
    ["a signed refresh", "?dashboard=ops&refresh=%2B15", { name: "refresh", value: "+15" }],
    ["a padded refresh", "?dashboard=ops&refresh=015", { name: "refresh", value: "015" }],
    ["an empty refresh", "?dashboard=ops&refresh=", { name: "refresh", value: "" }],
  ])("reports %s and keeps the rest of the view", (_label, search, rejected) => {
    const parsed = parseDashboardLink(search)
    expect(parsed.rejected).toEqual([{ kind: "setting", ...rejected }])
    expect(parsed.navigation).toEqual({ dashboardId: "ops" })
  })

  it("keeps the valid parts of a link whose refresh is malformed", () => {
    const parsed = parseDashboardLink("?dashboard=ops&vars=%7B%22env%22%3A%22prod%22%7D&range=6h&refresh=45")
    expect(parsed).toEqual({ navigation: { dashboardId: "ops", variables: { env: "prod" }, range: "6h" }, rejected: [{ kind: "setting", name: "refresh", value: "45" }] })
  })

  it("refuses to build a preset together with a fixed window or an unknown value", () => {
    expect(() => buildDashboardURL({ dashboardId: "ops", range: "6h", customTimeRange: range })).toThrow("not both")
    expect(() => buildDashboardURL({ dashboardId: "ops", range: "2h" as never })).toThrow("time range must be one of")
    expect(() => buildDashboardURL({ dashboardId: "ops", refresh: 45 as never })).toThrow("refresh must be 0, 15, 30 or 60 seconds")
  })

  it("rejects a very long link at the parser and at the builder", () => {
    const long = "x".repeat(MAX_DASHBOARD_URL_LENGTH)
    expect(() => parseDashboardURL(`?dashboard=ops&range=6h&note=${long}`)).toThrow("too long")
    const values = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`v${index}`, "x".repeat(1000)]))
    expect(() => buildDashboardURL({ dashboardId: "ops", variables: values, range: "6h" })).toThrow("URL limit")
  })

  it("reports link variables whose name or value is malformed without rejecting the link", () => {
    const parsed = parseDashboardLink(`?dashboard=ops&vars=${encodeURIComponent(JSON.stringify({
      env: "prod", "bad-name": "x", count: 1, nested: { a: "b" }, service: "s".repeat(1025),
    }))}&range=1h`)
    expect(parsed.navigation).toEqual({ dashboardId: "ops", variables: { env: "prod" }, range: "1h" })
    expect(parsed.rejected.map(part => part.kind === "variable" ? part.name : "").sort()).toEqual(["bad-name", "count", "nested", "service"])
  })

  it("restores the __proto__ case: a reserved name is reported, never applied", () => {
    const parsed = parseDashboardLink("?dashboard=a&vars=%7B%22__proto__%22%3A%22bad%22%7D")
    expect(parsed).toEqual({ navigation: { dashboardId: "a", variables: {} }, rejected: [{ kind: "variable", name: "__proto__" }] })
  })

  it("still rejects malformed variable JSON and too many values", () => {
    expect(() => parseDashboardLink("?dashboard=ops&vars=%5B%5D")).toThrow("valid named string values")
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`v${index}`, "x"]))
    expect(() => parseDashboardLink(`?dashboard=ops&vars=${encodeURIComponent(JSON.stringify(many))}`)).toThrow("at most 20")
  })
})

describe("link resolution against the document it opens", () => {
  const document = { variables: [{ name: "env" }, { name: "service" }] }

  it("keeps declared values and drops undeclared ones, reporting each", () => {
    const resolved = resolveLinkView(document, { dashboardId: "ops", variables: { env: "prod", gateway: "edge" }, range: "6h" }, [
      { kind: "variable", name: "bad-name" },
      { kind: "setting", name: "refresh", value: "45" },
    ])
    expect(resolved.state).toEqual({ dashboardId: "ops", variables: { env: "prod" }, range: "6h" })
    expect(resolved.ignored).toEqual([
      { kind: "variable", name: "gateway", reason: "undeclared" },
      { kind: "variable", name: "bad-name", reason: "invalid" },
      { kind: "setting", name: "refresh", value: "45" },
    ])
  })

  it("leaves a link without variables unchanged", () => {
    expect(resolveLinkView(document, { dashboardId: "ops", refresh: 15 })).toEqual({ state: { dashboardId: "ops", refresh: 15 }, ignored: [] })
  })

  it("describes ignored parts in plain language, with a count beyond five", () => {
    expect(describeIgnoredLink([])).toBe("")
    expect(describeIgnoredLink([{ kind: "variable", name: "gateway", reason: "undeclared" }]))
      .toBe("Ignored link filter “gateway”: this dashboard no longer declares it.")
    expect(describeIgnoredLink([{ kind: "variable", name: "a", reason: "undeclared" }, { kind: "variable", name: "b", reason: "undeclared" }]))
      .toBe("Ignored link filters “a”, “b”: this dashboard no longer declares them.")
    expect(describeIgnoredLink([{ kind: "variable", name: "x", reason: "invalid" }]))
      .toBe("Ignored link filter “x” because its name or value is not valid.")
    const invalid = Array.from({ length: 7 }, (_, index) => ({ kind: "variable" as const, name: `n${index}`, reason: "invalid" as const }))
    expect(describeIgnoredLink(invalid)).toBe("Ignored link filters “n0”, “n1”, “n2”, “n3”, “n4”, and 2 more because their names or values are not valid.")
    const undeclared = Array.from({ length: 7 }, (_, index) => ({ kind: "variable" as const, name: `n${index}`, reason: "undeclared" as const }))
    expect(describeIgnoredLink(undeclared)).toContain(", and 2 more: this dashboard no longer declares them.")
  })

  it("describes a malformed time range or refresh with the values it accepts", () => {
    expect(describeIgnoredLink([{ kind: "setting", name: "range", value: "2h" }]))
      .toBe("Ignored link time range “2h”: use 15m, 30m, 1h, 6h, 24h, 7d or 30d.")
    expect(describeIgnoredLink([{ kind: "setting", name: "refresh", value: "5" }]))
      .toBe("Ignored link refresh “5”: use 0, 15, 30 or 60 seconds.")
  })
})

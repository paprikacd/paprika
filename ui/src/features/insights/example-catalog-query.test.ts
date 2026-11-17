import { describe, expect, it } from "vitest"
import { createExampleCatalogQuery, type FixtureDefinition } from "./example-catalog-query"
import { resolveSavedQueryReference } from "./saved-queries"
import type { QueryRequest, SavedQuery } from "./schema"

const escaped = 'api"blue\\west\n{{service}}'
const metric = "paprika_example_requests"
const fixtures: readonly FixtureDefinition[] = [
  { id: "requests", metric, series: [
    { name: "API", labels: { service: "api", region: "au", replicas: "2" }, base: 20, variation: 2, trend: 5 },
    { name: "Worker", labels: { service: "worker", region: "au", replicas: "1" }, base: 7, variation: 1 },
    { name: "Escaped", labels: { service: escaped, region: "eu", replicas: "2" }, base: 11 },
  ] },
  { id: "states", metric: "paprika_example_states", series: [
    { name: "Zero", labels: { service: "zero" }, base: 0 },
    { name: "Negative", labels: { service: "negative" }, base: -3 },
    { name: "Missing", labels: { service: "missing" }, base: null },
    { name: "Tail missing", labels: { service: "tail" }, base: 5, gaps: [{ from: .4, to: .6 }, { from: 1, to: 1 }] },
  ] },
  { id: "empty", metric: "paprika_example_empty", series: [] },
  { id: "traces", metric: "paprika_example_traces", traces: [
    { traceId: "a1", service: "api", operation: "GET /", durationMs: 12.5, status: "ok", offsetSeconds: 5, labels: { region: "au" } },
    { traceId: "b2", service: "worker", operation: "job", durationMs: 23.5, status: "error", offsetSeconds: 10, labels: { region: "eu" } },
    { traceId: "c3", service: escaped, operation: "POST /", durationMs: 0, status: "ok", offsetSeconds: 15 },
    { traceId: "d4", service: "api", operation: "old", durationMs: 1, status: "ok", offsetSeconds: 3601 },
  ] },
]
const range = { start: 1_792_500_000, end: 1_792_503_600, step: 30 }
const signal = new AbortController().signal
const engine = createExampleCatalogQuery(fixtures, { now: () => range.end * 1000 })
function query(expression: string, overrides: Partial<QueryRequest> = {}) {
  return engine.query({ providerId: "example-prometheus", kind: "metrics", query: expression, ...range, ...overrides }, signal)
}
function trace(expression = '{ resource.paprika.fixture = "paprika_example_traces" }', overrides: Partial<QueryRequest> = {}) {
  return query(expression, { providerId: "example-tempo", kind: "traces", ...overrides })
}

describe("explicit sample fixture catalog", () => {
  it("produces deterministic bounded millisecond histories and stable selected series", async () => {
    const result = await query(metric)
    expect(await query(metric)).toEqual(result)
    expect(result.series).toHaveLength(3)
    const points = result.series![0].points
    expect(points).toHaveLength(121)
    expect(points[0]).toEqual({ timestamp: range.start * 1000, value: 20 })
    expect(points.at(-1)!.timestamp).toBe(range.end * 1000)
    expect(points.at(-1)!.value).toBeCloseTo(25)
    expect(points.every(point => point.timestamp >= range.start * 1000 && point.timestamp <= range.end * 1000)).toBe(true)
    expect((await query(`${metric}{ service = "worker", region="au" }`)).series).toEqual([result.series![1]])
  })

  it("resolves typed string and number saved-query parameters without evaluating their contents", async () => {
    const saved: SavedQuery = {
      schemaVersion: 1, id: "fixture-requests", name: "Sample requests", providerId: "example-prometheus", kind: "metrics",
      query: `${metric}{service={{service}}} * {{factor}}`,
      parameters: [{ name: "service", type: "string" }, { name: "factor", type: "number", defaultValue: 1 }],
    }
    const resolved = resolveSavedQueryReference({ id: saved.id, bindings: [
      { parameter: "service", source: "constant", value: escaped },
      { parameter: "factor", source: "constant", value: 1.25 },
    ] }, [saved], {}, "metrics")
    const result = await engine.query({ ...resolved, ...range }, signal)
    expect(result.series).toHaveLength(1)
    expect(result.series![0].labels.service).toBe(escaped)
    expect(result.series![0].points.every(point => point.value === 13.75)).toBe(true)
    expect((await query(`${metric}{service="\\u0061pi", replicas="2"} * 2e-1`)).series![0].points[0].value).toBe(4)
  })

  it("treats injected syntax as a literal label and never broadens an unmatched filter", async () => {
    for (const value of ["missing", "", 'api"} or paprika_example_requests{service="worker', "{{service}}", "__proto__"]) {
      expect((await query(`${metric}{service=${JSON.stringify(value)}}`)).series).toEqual([])
    }
    expect((await query(`${metric}{unknown="api"}`)).series).toEqual([])
    expect((await query(`${metric}{__name__="paprika_example_states"}`)).series).toEqual([])
  })

  it("preserves zero, negative values, null series and explicit historical/latest gaps", async () => {
    const result = await query("paprika_example_states")
    expect(result.series![0].points.every(point => point.value === 0)).toBe(true)
    expect(result.series![1].points.every(point => point.value === -3)).toBe(true)
    expect(result.series![2].points.every(point => point.value === null)).toBe(true)
    expect(result.series![3].points[60].value).toBeNull()
    expect(result.series![3].points.at(-2)!.value).toBe(5)
    expect(result.series![3].points.at(-1)!.value).toBeNull()
    const scaled = await query('paprika_example_states{service="tail"} * 0')
    expect(scaled.series![0].points[0].value).toBe(0)
    expect(scaled.series![0].points.at(-1)!.value).toBeNull()
    expect((await query('paprika_example_states{service="negative"} * -2')).series![0].points[0].value).toBe(6)
    expect(await query("paprika_example_empty")).toEqual({ series: [] })
  })

  it.each([
    "up", "paprika_example_unknown", `${metric} or ${metric}`, `sum(${metric})`, `${metric}[5m]`,
    `${metric}{service=~"api.*"}`, `${metric}{service!="api"}`, `${metric}{service="api",service="worker"}`,
    `${metric}{service="api",}`, `${metric}{service=api}`, `${metric}{service="\\q"}`, `${metric}{service="unterminated}`,
    `${metric} # comment`, `${metric} * NaN`, `${metric} * Infinity`, `${metric} * 1e999`, `${metric} * 0x10`,
    `${metric} * 2 + 3`, `${metric} * {{factor}}`, `${metric} * 2; alert(1)`, `${metric}{service="api"} trailing`,
    " ", "a".repeat(8193),
  ])("rejects unsupported or malformed query %s without fabricated fallback data", async expression => {
    await expect(query(expression)).rejects.toThrow(/sample|Sample/)
  })

  it("bounds dense output, handles an instant range and rejects invalid time/scaling", async () => {
    const dense = await query(metric, { step: .001 })
    expect(dense.truncated).toBe(true)
    expect(dense.series![0].points).toHaveLength(1001)
    expect(dense.series![0].points.at(-1)!.timestamp).toBe(range.end * 1000)
    const instant = await query("paprika_example_states", { start: range.end })
    expect(instant.series![3].points).toEqual([{ timestamp: range.end * 1000, value: null }])
    for (const override of [{ start: -1 }, { start: range.end + 1 }, { end: NaN }, { end: Infinity }, { step: 0 }, { step: -1 }])
      await expect(query(metric, override)).rejects.toThrow(/time range/)
    await expect(query(`${metric} * 1e308`)).rejects.toThrow(/non-finite/)
  })

  it("selects only explicit trace fixtures, applies resource labels and excludes out-of-range traces", async () => {
    const all = await trace()
    expect(all.traces?.map(item => item.traceId)).toEqual(["a1", "b2", "c3"])
    expect(all.traces![0]).toEqual({ traceId: "a1", service: "api", operation: "GET /", durationMs: 12.5, status: "ok", startTime: (range.end - 5) * 1000 })
    expect((await trace('{ resource.paprika.fixture="paprika_example_traces" && resource.service.name="api" && resource.region="au" }')).traces).toEqual([all.traces![0]])
    expect((await trace(`{ resource.service.name=${JSON.stringify(escaped)} && resource.paprika.fixture="paprika_example_traces" }`)).traces).toEqual([all.traces![2]])
    expect((await trace('{ resource.paprika.fixture="paprika_example_traces" && resource.service.name="missing" }')).traces).toEqual([])
    expect((await trace(undefined, { start: range.end - 4 })).traces).toEqual([])
  })

  it.each(["{}", '{ resource.service.name="api" }', '{ resource.paprika.fixture="missing" }', '{ resource.paprika.fixture="paprika_example_traces" } | count()', '{ resource.paprika.fixture="paprika_example_traces" || resource.service.name="api" }', '{ resource.paprika.fixture="paprika_example_traces" && duration > 1s }'])
  ("rejects unsupported trace query %s", async expression => {
    await expect(trace(expression)).rejects.toThrow(/sample|Sample/)
  })

  it("keeps providers and signal kinds separate", async () => {
    await expect(query(metric, { providerId: "live-prometheus" })).rejects.toThrow(/provider not found/)
    await expect(query(metric, { providerId: "example-tempo" })).rejects.toThrow(/signal kind/)
    await expect(query("paprika_example_traces")).rejects.toThrow(/signal kind/)
    await expect(trace('{ resource.paprika.fixture="paprika_example_requests" }')).rejects.toThrow(/signal kind/)
    const custom = createExampleCatalogQuery(fixtures, { metricsProviderId: "sample-metrics", tracesProviderId: "sample-traces" })
    expect((await custom.query({ ...range, kind: "metrics", providerId: "sample-metrics", query: metric }, signal)).series).toHaveLength(3)
  })

  it("derives metric, label, value and cardinality metadata from the selected fixtures", async () => {
    const metadata = engine.metadata
    expect((await metadata("example-prometheus", { kind: "metrics" })).values).toEqual(["paprika_example_empty", metric, "paprika_example_states"])
    expect((await metadata("example-prometheus", { kind: "labels", metric })).values).toEqual(["__name__", "region", "replicas", "service"])
    expect((await metadata("example-prometheus", { kind: "values", metric: `${metric}{region="au"}`, label: "service" })).values).toEqual(["api", "worker"])
    const cardinality = (await metadata("example-prometheus", { kind: "series", metric })).series!
    expect(cardinality).toMatchObject({ count: 3, limit: 1000, sample: true, start: range.end - 86400, end: range.end })
    expect(cardinality.labels.find(label => label.name === "service")).toEqual({ name: "service", cardinality: 3, values: [escaped, "api", "worker"].sort() })
    expect((await metadata("example-prometheus", { kind: "series", metric: `${metric}{region="au"}` })).series!.count).toBe(2)
    expect((await metadata("example-prometheus", { kind: "values", metric, label: "absent" })).values).toEqual([])
    expect((await metadata("example-tempo", { kind: "values", label: "service.name" })).values).toEqual([escaped, "api", "worker"].sort())
    await expect(metadata("example-prometheus", { kind: "series", metric: "paprika_example_missing" })).rejects.toThrow(/catalog/)
    await expect(metadata("example-prometheus", { kind: "series", metric: `${metric} * 2` })).rejects.toThrow(/sample/)
  })

  it("honors pre-aborted query and metadata requests", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(engine.query({ ...range, providerId: "example-prometheus", kind: "metrics", query: metric }, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    await expect(engine.metadata("example-prometheus", { kind: "metrics" }, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
  })

  it("returns independent results and snapshots caller-owned definitions", async () => {
    const input = structuredClone(fixtures) as FixtureDefinition[]
    const isolated = createExampleCatalogQuery(input)
    const run = () => isolated.query({ ...range, providerId: "example-prometheus", kind: "metrics", query: metric }, signal)
    const first = await run()
    const expected = structuredClone(first)
    first.series![0].labels.service = "changed"
    first.series![0].points[0].value = 999
    ;(input[0].series![0].labels as Record<string, string>).service = "changed source"
    expect(await run()).toEqual(expected)
  })

  it("rejects ambiguous or invalid fixture definitions at registration", () => {
    for (const invalid of [
      [...fixtures, fixtures[0]], [{ ...fixtures[0], metric: "up" }], [{ id: "missing", metric }],
      [{ ...fixtures[0], traces: [] }], [{ id: "invalid", metric, series: [{ name: "Bad", labels: {}, base: Infinity }] }],
      [{ id: "invalid", metric, series: [{ name: "Bad", labels: {}, base: 1, gaps: [{ from: .8, to: .2 }] }] }],
    ]) expect(() => createExampleCatalogQuery(invalid)).toThrow(/Sample|sample/)
    expect(() => createExampleCatalogQuery(fixtures, { metricsProviderId: "same", tracesProviderId: "same" })).toThrow(/distinct/)
  })
})

describe("application record fixtures", () => {
  const records: FixtureDefinition = {
    id: "records", metric: "paprika_example_records",
    records: { columns: [{ key: "service", type: "string" }, { key: "value", type: "number" }, { key: "ready", type: "boolean" }], rows: [["api", 0, true], ["worker", null, false]], truncated: true },
  }
  const client = createExampleCatalogQuery([records])
  const run = (source: string) => client.query({ ...range, providerId: "example-records", kind: "records", query: source }, signal)
  it("filters exact scalar values and preserves null, zero, types and truncation", async () => {
    expect(await run('{"fixture":"paprika_example_records","filters":{"value":null}}')).toEqual({ records: { ...records.records, rows: [["worker", null, false]] }, truncated: true })
    expect((await run('{"fixture":"paprika_example_records","filters":{"service":"api","ready":true}}')).records!.rows).toEqual([["api", 0, true]])
    expect((await run('{"fixture":"paprika_example_records","filters":{"service":"api OR worker"}}')).records!.rows).toEqual([])
  })
  it.each([
    '[]', 'null', '{"fixture":"missing"}', '{"fixture":"paprika_example_records","query":"SELECT *"}',
    '{"fixture":"paprika_example_records","filters":null}', '{"fixture":"paprika_example_records","filters":[]}',
    '{"fixture":"paprika_example_records","filters":{"unknown":"x"}}', '{"fixture":"paprika_example_records","filters":{"service":{"$ne":"x"}}}',
    '{"fixture":"paprika_example_records","parameters":{"quantity":2}}', '{"fixture":"paprika_example_records","parameters":{"quantity":1e999}}',
  ])("rejects unsupported record selector %s", async query => {
    await expect(run(query)).rejects.toThrow(/Sample|sample/)
  })
  it("snapshots definitions and returns isolated record rows", async () => {
    const result = await run('{"fixture":"paprika_example_records"}')
    result.records!.rows[0][1] = 99
    expect((await run('{"fixture":"paprika_example_records"}')).records!.rows[0][1]).toBe(0)
    expect(await client.metadata("example-records", { kind: "metrics" }, signal)).toEqual({ values: [] })
  })
})

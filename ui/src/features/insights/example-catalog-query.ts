import type { InsightsClient, ProviderMetadata } from "./client"
import type { QueryRequest, QueryResult, RecordFrame } from "./schema"
import { parseRecordFrame } from "./record-data"

export interface FixtureSeries {
  readonly name: string
  readonly labels: Readonly<Record<string, string>>
  readonly base: number | null
  /** Absolute amplitude, not a fraction of the base. */
  readonly variation?: number
  /** Total change from the beginning to the end of the requested range. */
  readonly trend?: number
  /** Inclusive fractions of the requested range; { from: 1, to: 1 } omits the latest sample. */
  readonly gaps?: readonly { readonly from: number; readonly to: number }[]
}

export interface FixtureTrace {
  readonly traceId: string
  readonly service: string
  readonly operation: string
  readonly durationMs: number
  readonly status: string
  readonly offsetSeconds: number
  readonly labels?: Readonly<Record<string, string>>
}

/** Explicit synthetic fixtures or attributed static source records. Supply exactly one result kind. */
export interface FixtureDefinition {
  readonly id: string
  readonly metric: string
  readonly series?: readonly FixtureSeries[]
  readonly traces?: readonly FixtureTrace[]
  readonly records?: RecordFrame
  /** Fixed sample holdings: stock code -> named numeric quantity parameter. */
  readonly portfolioParameters?: Readonly<Record<string, string>>
  /** Explicit source control sentinel; all other filters remain exact equality. */
  readonly allFilterValues?: Readonly<Record<string, string>>
}

export interface ExampleCatalogQueryOptions {
  readonly metricsProviderId?: string
  readonly tracesProviderId?: string
  readonly recordsProviderId?: string
  /** Milliseconds since the Unix epoch; used only for metadata's sample window. */
  readonly now?: () => number
}

const MAX_POINTS = 1001
const MAX_METADATA_VALUES = 1000
const metricPattern = /^paprika_example_[a-zA-Z0-9_]+$/
const labelPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const invalidQuery = () => new Error("This sample supports a catalog metric with exact quoted label matches and optional numeric multiplication, or an explicit fixture TraceQL selector.")

class Reader {
  private offset = 0
  constructor(private readonly source: string) {
    if (!source.trim() || source.length > 8192) throw invalidQuery()
  }
  token(pattern: RegExp): string | undefined {
    this.space()
    const match = pattern.exec(this.source.slice(this.offset))
    if (!match) return undefined
    this.offset += match[0].length
    return match[0]
  }
  take(token: string): boolean {
    this.space()
    if (!this.source.startsWith(token, this.offset)) return false
    this.offset += token.length
    return true
  }
  require(token: string) {
    if (!this.take(token)) throw invalidQuery()
  }
  string(): string {
    this.space()
    const start = this.offset
    if (this.source[this.offset++] !== '"') throw invalidQuery()
    while (this.offset < this.source.length) {
      const char = this.source[this.offset++]
      if (char === "\\") this.offset++
      else if (char === '"') {
        try { return JSON.parse(this.source.slice(start, this.offset)) as string }
        catch { throw invalidQuery() }
      }
    }
    throw invalidQuery()
  }
  done() {
    this.space()
    if (this.offset !== this.source.length) throw invalidQuery()
  }
  private space() {
    while (/\s/.test(this.source[this.offset] ?? "") && this.offset < this.source.length) this.offset++
  }
}

function matchers(reader: Reader, trace: boolean): Map<string, string> {
  const values = new Map<string, string>()
  if (reader.take("}")) return values
  do {
    const label = reader.token(trace ? /^[a-zA-Z_][a-zA-Z0-9_.]*/ : /^[a-zA-Z_][a-zA-Z0-9_]*/)
    if (!label || values.has(label) || values.size >= 32) throw invalidQuery()
    reader.require("=")
    values.set(label, reader.string())
    if (reader.take("}")) return values
    reader.require(trace ? "&&" : ",")
  } while (true)
}

function parseMetric(query: string) {
  const reader = new Reader(query)
  const metric = reader.token(/^paprika_example_[a-zA-Z0-9_]+/)
  if (!metric) throw invalidQuery()
  const labels = reader.take("{") ? matchers(reader, false) : new Map<string, string>()
  let factor = 1
  if (reader.take("*")) {
    const literal = reader.token(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/)
    if (!literal || !Number.isFinite(factor = Number(literal))) throw invalidQuery()
  }
  reader.done()
  return { metric, labels, factor }
}

function parseTrace(query: string) {
  const reader = new Reader(query)
  reader.require("{")
  const labels = matchers(reader, true)
  reader.done()
  const metric = labels.get("resource.paprika.fixture")
  if (!metric || !metricPattern.test(metric)) throw invalidQuery()
  labels.delete("resource.paprika.fixture")
  for (const label of labels.keys()) {
    if (!/^resource\.[a-zA-Z_][a-zA-Z0-9_.]*$/.test(label)) throw invalidQuery()
  }
  return { metric, labels }
}

function abort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
}

function validateLabels(labels: Readonly<Record<string, string>>, trace = false) {
  for (const [key, value] of Object.entries(labels)) {
    if (!(trace ? /^[a-zA-Z_][a-zA-Z0-9_.]*$/ : labelPattern).test(key) || key === "__name__" || typeof value !== "string")
      throw new Error("Sample fixture labels must be named strings without a reserved metric name.")
  }
}

function snapshot(fixtures: readonly FixtureDefinition[]) {
  const ids = new Set<string>()
  const result = new Map<string, FixtureDefinition>()
  for (const fixture of fixtures) {
    if (!fixture.id || ids.has(fixture.id) || !metricPattern.test(fixture.metric) || result.has(fixture.metric))
      throw new Error("Sample fixtures require unique IDs and paprika_example_ metric names.")
    if ([fixture.series, fixture.traces, fixture.records].filter(value => value !== undefined).length !== 1)
      throw new Error("A sample fixture must define exactly one of metric series, traces or records.")
    ids.add(fixture.id)
    const series = fixture.series?.map(item => {
      validateLabels(item.labels)
      if (!item.name || (item.base !== null && !Number.isFinite(item.base)) || !Number.isFinite(item.variation ?? 0) || !Number.isFinite(item.trend ?? 0))
        throw new Error("Sample series require a name and finite values, or a null base.")
      const gaps = item.gaps?.map(gap => {
        if (!Number.isFinite(gap.from) || !Number.isFinite(gap.to) || gap.from < 0 || gap.to > 1 || gap.to < gap.from)
          throw new Error("Sample gaps must be ordered fractions between zero and one.")
        return { ...gap }
      })
      return { ...item, labels: { ...item.labels }, gaps }
    })
    const traceIds = new Set<string>()
    const traces = fixture.traces?.map(item => {
      validateLabels(item.labels ?? {}, true)
      if (!item.traceId || traceIds.has(item.traceId) || !item.service || !item.operation || !Number.isFinite(item.durationMs) || item.durationMs < 0 || !Number.isFinite(item.offsetSeconds) || item.offsetSeconds < 0)
        throw new Error("Sample traces require unique IDs, a service, operation and nonnegative duration and offset.")
      traceIds.add(item.traceId)
      return { ...item, labels: { ...item.labels } }
    })
    const records = fixture.records === undefined ? undefined : parseRecordFrame(structuredClone(fixture.records))
    const portfolioParameters = fixture.portfolioParameters && { ...fixture.portfolioParameters }
    if (portfolioParameters) {
      if (!records || Object.keys(portfolioParameters).length > 50 || Object.values(portfolioParameters).some(value => !labelPattern.test(value))) throw new Error("Sample portfolio parameters require bounded named record quantities.")
      for (const key of ["stock_code", "quantity", "close", "change", "market_value", "day_change"]) if (!records.columns.some(column => column.key === key)) throw new Error("Sample portfolio records are missing a calculation column.")
    }
    result.set(fixture.metric, { id: fixture.id, metric: fixture.metric, ...(series ? { series } : traces ? { traces } : { records }), ...(portfolioParameters ? { portfolioParameters } : {}), ...(fixture.allFilterValues ? { allFilterValues: { ...fixture.allFilterValues } } : {}) })
  }
  return result
}

/** A bounded fixture selector, deliberately not a PromQL or TraceQL evaluator. */
export function createExampleCatalogQuery(
  fixtures: readonly FixtureDefinition[],
  options: ExampleCatalogQueryOptions = {},
): Pick<InsightsClient, "query" | "metadata"> {
  const catalog = snapshot(fixtures)
  const metricsProvider = options.metricsProviderId ?? "example-prometheus"
  const tracesProvider = options.tracesProviderId ?? "example-tempo"
  const recordsProvider = options.recordsProviderId ?? "example-records"
  if (![metricsProvider, tracesProvider, recordsProvider].every(Boolean) || new Set([metricsProvider, tracesProvider, recordsProvider]).size !== 3)
    throw new Error("Sample metrics, traces and records need distinct provider IDs.")
  function providerKind(id: string) {
    if (id === metricsProvider) return "metrics"
    if (id === tracesProvider) return "traces"
    if (id === recordsProvider) return "records"
    throw new Error("Sample provider not found.")
  }
  function fixtureFor(metric: string, kind: QueryRequest["kind"]) {
    const fixture = catalog.get(metric)
    if (!fixture) throw new Error("Sample query is not in this fixture catalog.")
    if ((kind === "metrics" && !fixture.series) || (kind === "traces" && !fixture.traces) || (kind === "records" && !fixture.records))
      throw new Error("Sample fixture does not support this signal kind.")
    return fixture
  }
  return {
    query: async (request, signal): Promise<QueryResult> => {
      abort(signal)
      if (providerKind(request.providerId) !== request.kind) throw new Error("Sample provider does not support this signal kind.")
      if (![request.start, request.end, request.step].every(Number.isFinite) || request.start < 0 || request.end < request.start || request.step <= 0 || !Number.isFinite(request.end * 1000))
        throw new Error("Sample queries need a finite ordered time range and a positive step.")
      if (request.kind === "records") {
        const { fixture: metric, filters, parameters } = parseRecords(request.query)
        const fixture = fixtureFor(metric, "records")
        const frame = applyPortfolioParameters(fixture, parameters)
        const columns = new Map(frame.columns.map((column, index) => [column.key, index]))
        for (const key of Object.keys(filters)) if (!columns.has(key)) throw new Error("Sample record filter column is unknown.")
        frame.rows = frame.rows.filter(row => Object.entries(filters).every(([key, value]) => (Object.hasOwn(fixture.allFilterValues ?? {}, key) && fixture.allFilterValues![key] === value) || row[columns.get(key)!] === value))
        return { records: frame, ...(frame.truncated ? { truncated: true } : {}) }
      }
      if (request.kind === "traces") {
        const parsed = parseTrace(request.query)
        const fixture = fixtureFor(parsed.metric, "traces")
        return { traces: fixture.traces!.filter(trace => {
          const timestamp = request.end - trace.offsetSeconds
          return timestamp >= request.start && timestamp <= request.end && [...parsed.labels].every(([key, value]) =>
            (key === "resource.service.name" ? trace.service : trace.labels?.[key.slice("resource.".length)]) === value)
        }).map(({ labels: _labels, offsetSeconds, ...trace }) => {
          void _labels
          return { ...trace, startTime: (request.end - offsetSeconds) * 1000 }
        }).sort((a, b) => b.startTime - a.startTime) }
      }
      const parsed = parseMetric(request.query)
      const fixture = fixtureFor(parsed.metric, "metrics")
      const wanted = Math.ceil((request.end - request.start) / request.step) + 1
      const count = Math.min(wanted, MAX_POINTS)
      const series = fixture.series!.flatMap((source, index) => {
        const labels: Record<string, string> = { ...source.labels, __name__: fixture.metric }
        if (![...parsed.labels].every(([key, value]) => labels[key] === value)) return []
        const points = Array.from({ length: count }, (_, i) => {
          const fraction = count === 1 ? 1 : i / (count - 1)
          const missing = source.base === null || source.gaps?.some(gap => fraction >= gap.from && fraction <= gap.to)
          const value = missing ? null : (source.base! + (source.variation ?? 0) * Math.sin(fraction * 2 * Math.PI + index) + (source.trend ?? 0) * fraction) * parsed.factor
          if (value !== null && !Number.isFinite(value)) throw new Error("Sample scaling produced a non-finite value.")
          return { timestamp: (request.start + (request.end - request.start) * fraction) * 1000, value }
        })
        return [{ name: source.name, labels, points }]
      })
      return { series, ...(wanted > MAX_POINTS ? { truncated: true } : {}) }
    },
    metadata: async (id, request, signal): Promise<ProviderMetadata> => {
      abort(signal)
      const kind = providerKind(id)
      if (kind === "records") return { values: [] }
      const parsed = request.metric ? parseMetric(request.metric) : undefined
      if (parsed && parsed.factor !== 1) throw invalidQuery()
      const fixtures = parsed ? [fixtureFor(parsed.metric, kind)] : [...catalog.values()].filter(fixture => kind === "metrics" ? fixture.series !== undefined : fixture.traces !== undefined)
      const rows = fixtures.flatMap<Record<string, string>>(fixture => fixture.series
        ? fixture.series.map(series => ({ ...series.labels, __name__: fixture.metric }))
        : fixture.traces!.map(trace => ({ ...trace.labels, "service.name": trace.service, "paprika.fixture": fixture.metric })))
        .filter(labels => !parsed || [...parsed.labels].every(([key, value]) => labels[key] === value))
      const values = (entries: Iterable<string>) => [...new Set(entries)].sort()
      const bounded = (entries: string[]): ProviderMetadata => ({ values: entries.slice(0, MAX_METADATA_VALUES), ...(entries.length > MAX_METADATA_VALUES ? { truncated: true } : {}) })
      if (request.kind === "metrics") return bounded(fixtures.map(fixture => fixture.metric).sort())
      const labelNames = values(rows.flatMap(row => Object.keys(row)))
      if (request.kind === "labels") return bounded(labelNames)
      if (request.kind === "values") return bounded(values(rows.flatMap(row => {
        const value = row[request.label ?? ""]
        return value === undefined ? [] : [value]
      })))
      const end = Math.floor((options.now ?? Date.now)() / 1000)
      return { values: [], series: {
        sample: true, count: rows.length, limit: MAX_METADATA_VALUES, start: Math.max(0, end - 86400), end,
        labels: labelNames.map(name => {
          const entries = values(rows.flatMap(row => row[name] === undefined ? [] : [row[name]]))
          return { name, cardinality: entries.length, values: entries.slice(0, MAX_METADATA_VALUES), ...(entries.length > MAX_METADATA_VALUES ? { valuesTruncated: true } : {}) }
        }),
      } }
    },
  }
}

/** Exact fixture IDs and scalar equality only; this is not SQL or a general JSON query engine. */
function parseRecords(source: string): { fixture: string; filters: Record<string, string | number | boolean | null>; parameters: Record<string, number> } {
  if (source.length > 8192) throw new Error("Sample record query is too large.")
  let value: unknown
  try { value = JSON.parse(source) } catch { throw new Error("Sample record query must be JSON.") }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Sample record query must be an object.")
  const object = value as Record<string, unknown>
  if (Object.keys(object).some(key => key !== "fixture" && key !== "filters" && key !== "parameters") || typeof object.fixture !== "string" || !metricPattern.test(object.fixture)) throw new Error("Sample record queries require a catalog fixture and optional scalar filters.")
  const filters = object.filters === undefined ? {} : object.filters
  if (!filters || typeof filters !== "object" || Array.isArray(filters) || Object.keys(filters).length > 32) throw new Error("Sample record filters must be a bounded object.")
  for (const [key, item] of Object.entries(filters)) {
    if (!labelPattern.test(key) || ["__proto__", "prototype", "constructor"].includes(key) || (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") || (typeof item === "number" && !Number.isFinite(item))) throw new Error("Sample record filters must contain named scalar values.")
  }
  const parameters = object.parameters === undefined ? {} : object.parameters
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters) || Object.keys(parameters).length > 50 || Object.values(parameters).some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000)) throw new Error("Sample portfolio quantities must be bounded finite numbers.")
  return { fixture: object.fixture, filters: filters as Record<string, string | number | boolean | null>, parameters: parameters as Record<string, number> }
}

function applyPortfolioParameters(fixture: FixtureDefinition, parameters: Record<string, number>): RecordFrame {
  const frame = structuredClone(fixture.records!)
  const required = Object.values(fixture.portfolioParameters ?? {})
  if (Object.keys(parameters).length !== required.length || required.some(key => !Object.hasOwn(parameters, key))) throw new Error("Sample record parameters must exactly match the declared portfolio quantities.")
  if (!fixture.portfolioParameters) return frame
  const index = (key: string) => frame.columns.findIndex(column => column.key === key)
  const stock = index("stock_code"), quantity = index("quantity"), close = index("close"), change = index("change"), value = index("market_value"), delta = index("day_change")
  frame.rows.forEach(row => {
    const key = String(row[stock])
    if (!Object.hasOwn(fixture.portfolioParameters!, key)) throw new Error("Sample portfolio row is missing its declared quantity parameter.")
    const amount = parameters[fixture.portfolioParameters![key]]
    row[quantity] = amount
    row[value] = typeof row[close] === "number" ? row[close] * amount : null
    row[delta] = typeof row[change] === "number" ? row[change] * amount : null
  })
  return parseRecordFrame(frame)
}

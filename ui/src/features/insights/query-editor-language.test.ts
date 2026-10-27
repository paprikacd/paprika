import { describe, expect, it, vi } from "vitest"
import { CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete"
import { EditorState } from "@codemirror/state"
import { PostgreSQL } from "@codemirror/lang-sql"
import type { InsightsClient } from "./client"
import { createMetadataDiscovery, createQueryLanguage, maskQueryParameters, parameterCompletion, providerQueryLanguage, queryDiagnostics } from "./query-editor-language"

async function suggestions(language: ReturnType<typeof createQueryLanguage>, doc: string) {
  const state = EditorState.create({ doc, extensions: language.extensions })
  const context = new CompletionContext(state, doc.length, true)
  const results = await Promise.all(state.languageDataAt<CompletionSource>("autocomplete", doc.length).map(source => source(context)))
  return results.filter((result): result is CompletionResult => !!result)
}

describe("provider query languages", () => {
  it("selects the native language and completes only the chosen application operations", async () => {
    const metadata = vi.fn()
    for (const type of ["shorted", "uptime", "postgresql"] as const) {
      const provider = { id: type, name: type, type, capabilities: ["records" as const, "metrics" as const] }
      expect(providerQueryLanguage(provider, "records")).toBe(type === "postgresql" ? "sql" : "json")
      const language = createQueryLanguage({ language: type === "postgresql" ? "sql" : "json", providerId: type, providerType: type, client: { metadata } as unknown as InsightsClient })
      if (type !== "postgresql") {
        const labels = (await suggestions(language, '{"operation":"')).flatMap(result => result.options.map(option => option.label))
        expect(labels).toContain(type === "shorted" ? "stock_history" : "overview")
        expect(labels).not.toContain(type === "shorted" ? "overview" : "stock_history")
      }
      language.destroy()
    }
    expect(metadata).not.toHaveBeenCalled()
    expect(queryDiagnostics("json", '{"operation":"overview","args":{"serviceId":{{service}}}}', [{ name: "service", type: "string" }])).toEqual([])
    expect(queryDiagnostics("json", '{"operation":')).toHaveLength(1)
  })

  it("uses Prometheus syntax and semantic diagnostics without modifying templates", () => {
    const query = "sum(rate(http_requests_total{service={{service}},region={{region}}}[5m])) / {{divisor}}"
    const parameters = [{ name: "service" }, { name: "region" }, { name: "divisor", type: "number" }]
    expect(queryDiagnostics("promql", query, parameters)).toEqual([])
    const masked = maskQueryParameters(query, parameters)
    expect(masked.length).toBe(query.length)
    expect(masked).toContain('service="x"')
    expect(masked).toContain('region="x"')
    expect(query).toContain("{{service}}")
    expect(queryDiagnostics("promql", "rate(up)").length).toBeGreaterThan(0)
    expect(queryDiagnostics("promql", "sum(rate(up[5m])").length).toBeGreaterThan(0)
    const malformed = `${query} + )`
    expect(queryDiagnostics("promql", malformed, parameters).some(issue => issue.from >= query.length)).toBe(true)
  })

  it("leaves quoted strings and comments unchanged when masking whole-value parameters", () => {
    const query = 'up{service="{{service}}"} # {{comment}}\n + {{number}}'
    const masked = maskQueryParameters(query, [{ name: "number", type: "number" }])
    expect(masked).toContain('service="{{service}}"')
    expect(masked).toContain("# {{comment}}")
    expect(masked).toHaveLength(query.length)
  })

  it("completes PromQL functions, provider metrics, metric-scoped labels and label values", async () => {
    const metadata = vi.fn<InsightsClient["metadata"]>().mockImplementation(async (_id, options) => ({ values: options.kind === "metrics" ? ["http_requests_total", "up"] : options.kind === "labels" ? ["service", "region"] : ["worker", "api"] }))
    const client = { metadata, query: vi.fn() } as unknown as InsightsClient
    const language = createQueryLanguage({ language: "promql", providerId: "prod", client })
    const labels = async (query: string) => (await suggestions(language, query)).flatMap(result => result.options.map(option => option.label))
    expect(await labels("ra")).toContain("rate")
    expect(await labels("http_")).toContain("http_requests_total")
    expect(await labels("http_requests_total{ser")).toContain("service")
    expect(await labels('http_requests_total{service="w')).toContain("worker")
    expect(metadata).toHaveBeenCalledWith("prod", { kind: "labels", metric: "http_requests_total" }, expect.any(AbortSignal))
    expect(metadata).toHaveBeenCalledWith("prod", { kind: "values", label: "service", metric: "http_requests_total" }, expect.any(AbortSignal))
    expect(client.query).not.toHaveBeenCalled()
    language.destroy()
  })

  it("keeps language completion available when remote discovery fails, and aborts on disposal", async () => {
    let signal: AbortSignal | undefined
    const metadata = vi.fn<InsightsClient["metadata"]>().mockImplementation(async (_id, _options, currentSignal) => { signal = currentSignal; throw new Error("Unavailable") })
    const status = vi.fn()
    const language = createQueryLanguage({ language: "promql", providerId: "prod", client: { metadata } as unknown as InsightsClient, onDiscoveryStatus: status })
    expect((await suggestions(language, "ra")).flatMap(result => result.options.map(option => option.label))).toContain("rate")
    expect(status).toHaveBeenCalledWith(expect.stringContaining("Language completion still works"))
    language.destroy()
    expect(signal?.aborted).toBe(true)
  })

  it("deduplicates bounded metadata requests within an editor session", async () => {
    const metadata = vi.fn<InsightsClient["metadata"]>().mockResolvedValue({ values: ["up"] })
    const discovery = createMetadataDiscovery({ metadata } as unknown as InsightsClient, "prod")
    await Promise.all([discovery.remote.metricNames("u"), discovery.remote.metricNames("u")])
    expect(metadata).toHaveBeenCalledTimes(1)
    discovery.destroy()
    expect(await discovery.remote.metricNames()).toEqual([])
  })

  it("completes the whole parameter token without extra braces or quotes", () => {
    const doc = "up{service={{ser}}}"
    const context = new CompletionContext(EditorState.create({ doc }), doc.indexOf("ser}}") + 3, true)
    const result = parameterCompletion(context, [{ name: "service", type: "string" }])!
    const option = result.options[0]
    expect(doc.slice(0, result.from) + option.label + doc.slice(result.to)).toBe("up{service={{service}}}")
  })

  it("uses Grafana's TraceQL grammar and provider attribute/value completion", async () => {
    expect(queryDiagnostics("traceql", '{ resource.service.name = {{service}} && duration > 100ms }')).toEqual([])
    expect(queryDiagnostics("traceql", "{ duration > }").length).toBeGreaterThan(0)
    const metadata = vi.fn<InsightsClient["metadata"]>().mockImplementation(async (_id, options) => ({ values: options.kind === "labels" ? ["service.name"] : ["worker", 'path\\with"quote'] }))
    const language = createQueryLanguage({ language: "traceql", providerId: "tempo", client: { metadata } as unknown as InsightsClient })
    expect((await suggestions(language, "{ resource.ser")).flatMap(result => result.options.map(option => option.label))).toContain("resource.service.name")
    const values = (await suggestions(language, '{ resource.service.name = "w')).flatMap(result => result.options)
    expect(values).toContainEqual(expect.objectContaining({ label: "worker", apply: 'worker"' }))
    const rawValues = (await suggestions(language, '{ resource.service.name = `p')).flatMap(result => result.options)
    expect(rawValues).toContainEqual(expect.objectContaining({ label: 'path\\with"quote', apply: 'path\\with"quote`' }))
    expect(metadata).toHaveBeenCalledWith("tempo", { kind: "values", label: "service.name" }, expect.any(AbortSignal))
    language.destroy()
  })

  it("offers SQL dialect and schema completion without pretending to execute SQL", async () => {
    const language = createQueryLanguage({ language: "sql", providerId: "", sqlConfig: { dialect: PostgreSQL, schema: { services: ["name", "latency"] } } })
    expect((await suggestions(language, "SEL")).flatMap(result => result.options.map(option => option.label.toUpperCase()))).toContain("SELECT")
    expect((await suggestions(language, "SELECT * FROM serv")).flatMap(result => result.options.map(option => option.label))).toContain("services")
    language.destroy()
  })
})

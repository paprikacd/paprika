import { CompletionContext, type Completion, type CompletionResult } from "@codemirror/autocomplete"
import { EditorState, type Extension } from "@codemirror/state"
import { LRLanguage, syntaxTree } from "@codemirror/language"
import type { Diagnostic } from "@codemirror/lint"
import { sql, type SQLConfig } from "@codemirror/lang-sql"
import { styleTags, tags } from "@lezer/highlight"
import { parser as traceParser } from "@grafana/lezer-traceql"
// Select the ESM distribution consistently: mixing the package's legacy CJS
// main with CodeMirror ESM creates incompatible EditorState instances in SSR/tests.
import { LanguageType, PromQLExtension, promQLLanguage, type PrometheusClient } from "@prometheus-io/codemirror-promql/dist/esm/index"
// The upstream package exposes its parser submodule for standalone static analysis.
import { Parser as PromQLParser } from "@prometheus-io/codemirror-promql/dist/esm/parser/parser"
import type { InsightsClient, ProviderMetadata } from "./client"

export type QueryLanguage = "promql" | "traceql" | "sql"
export interface QueryEditorParameter { name: string; type?: string; label?: string }
export const queryLanguageNames = { promql: "PromQL", traceql: "TraceQL", sql: "SQL" } as const

const traceLanguage = LRLanguage.define({
  parser: traceParser.configure({ props: [styleTags({
    "LineComment BlockComment": tags.comment,
    String: tags.string,
    "Integer Float Duration": tags.number,
    "IntrinsicField Resource Span Event Link Instrumentation Parent": tags.keyword,
    "Aggregate MetricsOperationBasicType MetricsOverTimeType MetricsAggregatorFunctionType": tags.function(tags.variableName),
    Identifier: tags.propertyName,
    "FieldOp ScalarOp ComparisonOp And Or Pipe": tags.operator,
    TemplateVariable: tags.special(tags.variableName),
  })] }),
  languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } }, closeBrackets: { brackets: ["(", "[", "{", '"', "`"] } },
})

/** A shadow document preserves offsets and the authored template, including undo history. */
export function maskQueryParameters(query: string, parameters: readonly QueryEditorParameter[] = []): string {
  const types = new Map(parameters.map(parameter => [parameter.name, parameter.type]))
  let quote = "", comment = false, blockComment = false, selectorDepth = 0, result = ""
  for (let index = 0; index < query.length;) {
    const char = query[index]
    if (comment) { result += char; index++; if (char === "\n") comment = false; continue }
    if (blockComment) {
      if (query.slice(index, index + 2) === "*/") { result += "*/"; index += 2; blockComment = false }
      else { result += char; index++ }
      continue
    }
    if (quote) {
      result += char; index++
      if (char === "\\" && quote !== "`" && index < query.length) { result += query[index++]; continue }
      if (char === quote) quote = ""
      continue
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; result += char; index++; continue }
    if (char === "#" || query.slice(index, index + 2) === "//") { comment = true; result += char; index++; continue }
    if (query.slice(index, index + 2) === "/*") { blockComment = true; result += "/*"; index += 2; continue }
    const token = query.slice(index).match(/^\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/)
    if (token) {
      const type = types.get(token[1])
      const literal = type === "number" ? "0" : type === "string" || selectorDepth > 0 ? '"x"' : "0"
      result += literal.padEnd(token[0].length, " ")
      index += token[0].length
    } else {
      if (char === "{") selectorDepth++
      if (char === "}") selectorDepth = Math.max(0, selectorDepth - 1)
      result += char; index++
    }
  }
  return result
}

export function queryDiagnostics(language: QueryLanguage, query: string, parameters: readonly QueryEditorParameter[] = []): Diagnostic[] {
  if (!query.trim() || language === "sql") return []
  const masked = maskQueryParameters(query, parameters)
  if (language === "promql") {
    const state = EditorState.create({ doc: masked, extensions: [promQLLanguage(LanguageType.PromQL)] })
    const parser = new PromQLParser(state)
    parser.analyze()
    const diagnostics = parser.getDiagnostics()
    // Upstream deliberately suppresses trailing parse errors while typing. Our
    // status also needs to identify incomplete expressions before an explicit Run.
    syntaxTree(state).iterate({ enter(node) {
      if (node.type.isError && !diagnostics.some(issue => issue.from <= node.from && issue.to >= node.to)) diagnostics.push({
        from: Math.min(node.from, Math.max(0, query.length - 1)),
        to: Math.min(query.length, Math.max(node.to, node.from + 1)),
        severity: "error", message: node.to === query.length ? "Incomplete PromQL expression" : "Unexpected syntax in PromQL expression",
      })
    } })
    return diagnostics.sort((a, b) => a.from - b.from)
  }
  const diagnostics: Diagnostic[] = []
  traceParser.parse(masked).iterate({ enter(node) {
    if (node.type.isError) diagnostics.push({
      from: Math.min(node.from, Math.max(0, query.length - 1)),
      to: Math.min(query.length, Math.max(node.to, node.from + 1)),
      severity: "error", message: "Unexpected syntax in TraceQL expression",
    })
  } })
  return diagnostics
}

/** Requests use the authenticated host API, never the provider URL or query endpoint. */
export function createMetadataDiscovery(client: InsightsClient | undefined, providerId: string, onStatus?: (message: string) => void) {
  const controller = new AbortController()
  const cache = new Map<string, { at: number; result: Promise<ProviderMetadata> }>()
  async function read(options: Parameters<InsightsClient["metadata"]>[1]): Promise<ProviderMetadata> {
    if (!client || !providerId || controller.signal.aborted) return { values: [] }
    const key = JSON.stringify(options), previous = cache.get(key)
    if (previous && Date.now() - previous.at < 30_000) return previous.result
    if (cache.size >= 32) cache.delete(cache.keys().next().value!)
    const result = client.metadata(providerId, options, controller.signal).then(data => {
      if (controller.signal.aborted) return { values: [] }
      onStatus?.(data.truncated ? "Provider suggestions are limited; you can still type any name." : "")
      return data
    }).catch(() => {
      cache.delete(key)
      if (!controller.signal.aborted) onStatus?.("Provider suggestions unavailable. Language completion still works.")
      return { values: [] }
    })
    cache.set(key, { at: Date.now(), result })
    return result
  }
  const remote: PrometheusClient = {
    metricNames: async prefix => (await read({ kind: "metrics" })).values.filter(name => !prefix || name.startsWith(prefix)),
    labelNames: async metric => (await read({ kind: "labels", ...(metric ? { metric } : {}) })).values,
    labelValues: async (label, metric) => (await read({ kind: "values", label, ...(metric ? { metric } : {}) })).values,
    // Paprika's bounded metadata API exposes names/values, not HELP text or raw series tuples.
    metricMetadata: async () => ({}), series: async () => [], flags: async () => ({}),
    destroy: () => controller.abort(),
  }
  return { read, remote, aborted: () => controller.signal.aborted, destroy: () => controller.abort() }
}

export function parameterCompletion(context: CompletionContext, parameters: readonly QueryEditorParameter[]): CompletionResult | null {
  const prefix = context.matchBefore(/\{\{[a-zA-Z0-9_]*/)
  if (!prefix && !context.explicit) return null
  if (!parameters.length) return null
  const word = prefix ?? context.matchBefore(/[a-zA-Z0-9_]*/)
  const suffix = context.state.sliceDoc(context.pos).match(/^[a-zA-Z0-9_]*\}\}/)
  return {
    from: word?.from ?? context.pos,
    to: prefix && suffix ? context.pos + suffix[0].length : context.pos,
    options: parameters.filter(parameter => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(parameter.name)).map(parameter => ({
      label: `{{${parameter.name}}}`, displayLabel: `{{${parameter.name}}}`,
      detail: parameter.label || `${parameter.type ?? "string"} parameter`, type: "variable", boost: prefix ? 99 : 0,
    })),
    validFor: /^\{?\{?[a-zA-Z0-9_]*$/,
  }
}

// Scoped intrinsics and pipeline operations from Grafana's TraceQL reference.
const traceIntrinsics = [
  "duration", "name", "status", "statusMessage", "kind", "rootName", "rootServiceName", "traceDuration",
  "span:duration", "span:name", "span:status", "span:statusMessage", "span:kind", "span:id", "span:parentID", "span:childCount",
  "trace:duration", "trace:rootName", "trace:rootService", "trace:id", "event:name", "event:timeSinceStart",
  "link:spanID", "link:traceID", "instrumentation:name", "instrumentation:version",
]
const traceOperations = [
  "count()", "avg(duration)", "min(duration)", "max(duration)", "sum(duration)",
  "by(resource.service.name)", "select(resource.service.name)", "coalesce()", "rate()", "count_over_time()",
  "sum_over_time(duration)", "max_over_time(duration)", "min_over_time(duration)", "avg_over_time(duration)",
  "quantile_over_time(duration, 0.99)", "histogram_over_time(duration)", "compare({ status = error })", "topk(10)", "bottomk(10)",
]

function scopedTraceLabels(labels: string[]): Completion[] {
  const attribute = (name: string) => /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(name) ? name : JSON.stringify(name)
  return labels.flatMap(label => /^(resource|span|event|link|instrumentation)\./.test(label)
    ? [{ label, apply: `${label.slice(0, label.indexOf("."))}.${attribute(label.slice(label.indexOf(".") + 1))}`, type: "property", detail: "Provider attribute" }]
    : [{ label: `resource.${label}`, apply: `resource.${attribute(label)}`, type: "property", detail: "Resource attribute" }, { label: `span.${label}`, apply: `span.${attribute(label)}`, type: "property", detail: "Span attribute" }])
}

function traceCompletion(discovery: ReturnType<typeof createMetadataDiscovery>) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const before = context.state.sliceDoc(0, context.pos)
    const valueMatch = before.match(/([a-zA-Z_][a-zA-Z0-9_.:]*)\s*(?:=~|!~|!=|>=|<=|=|>|<)\s*(["`]?)([^"`{}\n]*)$/)
    if (valueMatch) {
      const label = valueMatch[1], quote = valueMatch[2], typed = valueMatch[3]
      const from = context.pos - typed.length
      const intrinsicValues = label === "status" || label === "span:status" ? ["ok", "error", "unset"] : label === "kind" || label === "span:kind" ? ["server", "client", "producer", "consumer", "internal", "unspecified"] : []
      if (intrinsicValues.length) return { from, options: intrinsicValues.map(value => ({ label: value, type: "constant" })), validFor: /^\w*$/ }
      if (!label.includes(".")) return null
      const labels = (await discovery.read({ kind: "labels" })).values
      const unscoped = label.replace(/^(resource|span|event|link|instrumentation)\./, "")
      const lookup = labels.includes(label) ? label : unscoped
      const values = (await discovery.read({ kind: "values", label: lookup })).values
      if (context.aborted || discovery.aborted()) return null
      const closingQuote = quote && context.state.sliceDoc(context.pos, context.pos + 1) === quote
      return { from, options: values.filter(value => quote !== "`" || !value.includes("`")).map(value => ({
        label: value, type: "text",
        apply: quote ? (quote === "`" ? value : JSON.stringify(value).slice(1, -1)) + (closingQuote ? "" : quote) : JSON.stringify(value),
      })), validFor: /^[^"`{}\n]*$/ }
    }
    const word = context.matchBefore(/[a-zA-Z_][a-zA-Z0-9_.:]*/)
    if (!word && !context.explicit) return null
    if (context.explicit && /(?:\{|&&|\|\|)\s*[a-zA-Z_][a-zA-Z0-9_.:]*\s+$/.test(before)) {
      return { from: context.pos, options: ["=", "!=", "=~", "!~", ">", ">=", "<", "<="].map(label => ({ label, type: "operator" })) }
    }
    const afterPipe = /\|\s*[a-zA-Z_]*$/.test(before)
    const options: Completion[] = afterPipe
      ? traceOperations.map(label => ({ label, type: "function" }))
      : [...traceIntrinsics.map(label => ({ label, type: "keyword", detail: "TraceQL intrinsic" })), ...scopedTraceLabels((await discovery.read({ kind: "labels" })).values)]
    if (context.aborted || discovery.aborted()) return null
    return { from: word?.from ?? context.pos, options, validFor: /^[a-zA-Z0-9_.:]*$/ }
  }
}

export function createQueryLanguage({ language, client, providerId, parameters = [], sqlConfig, onDiscoveryStatus }: {
  language: QueryLanguage; client?: InsightsClient; providerId: string;
  parameters?: readonly QueryEditorParameter[]; sqlConfig?: SQLConfig; onDiscoveryStatus?: (message: string) => void;
}) {
  const discovery = createMetadataDiscovery(client, providerId, onDiscoveryStatus)
  const promql = language === "promql" ? new PromQLExtension().activateLinter(false).setComplete({ remote: discovery.remote }) : undefined
  const extensions: Extension = language === "promql" ? promql!.asExtension() : language === "traceql"
    ? [traceLanguage, traceLanguage.data.of({ autocomplete: traceCompletion(discovery) })]
    : sql(sqlConfig)
  // Completion source identity must remain stable between editor transactions.
  const parameterSource = (context: CompletionContext) => parameterCompletion(context, parameters)
  return {
    extensions: [extensions, EditorState.languageData.of(() => [{ autocomplete: parameterSource }])],
    destroy() { promql?.destroy(); discovery.destroy() },
  }
}

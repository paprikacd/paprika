import {
  createLibrary,
  createParser,
  defineComponent,
  type ElementNode,
} from "@openuidev/lang-core"
import { z } from "zod"
import {
  dashboardSchema,
  widgetSchema,
  widgetKind,
  MAX_DOCUMENT_BYTES,
  MAX_WIDGETS,
  type Dashboard,
  type Provider,
  type SavedQuery,
  type SavedQueryReference,
  type Widget,
} from "./schema"
import { getWidgetDefinition, getWidgetPlugins } from "./widget-registry"
import { validateTooltipQueryTemplate } from "./tooltip-context"
import { resolveSavedQueryReference } from "./saved-queries"

const componentNames = {
  timeseries: "TimeSeries",
  bar: "BarChart",
  stat: "Stat",
  table: "MetricsTable",
  traces: "Traces",
  heatmap: "Heatmap",
  plugin: "Plugin",
} as const

// OpenUI is an authoring language here. Parsed components become the same
// persisted document as the visual builder; no model-authored code runs.
const widgetProps = z.strictObject({
  id: widgetSchema.shape.id,
  title: widgetSchema.shape.title,
  providerId: widgetSchema.shape.providerId,
  query: widgetSchema.shape.query,
  unit: widgetSchema.shape.unit,
  layout: widgetSchema.shape.layout,
  description: widgetSchema.shape.description,
  color: widgetSchema.shape.color,
  options: widgetSchema.shape.options,
  pluginId: widgetSchema.shape.pluginId,
  dataKind: widgetSchema.shape.dataKind,
  config: widgetSchema.shape.config,
  drilldowns: widgetSchema.shape.drilldowns,
  queryRef: widgetSchema.shape.queryRef,
  selectionBindings: widgetSchema.shape.selectionBindings,
  annotationSource: widgetSchema.shape.annotationSource,
})
const widgetComponents = Object.entries(componentNames).map(([type, name]) =>
  defineComponent({
    name,
    description: `Provider query displayed as ${type}. Query syntax must match the configured provider and data kind. Layout is a 12-column grid. Data comes from a configured provider, never embedded values.`,
    // defineComponent tags the schema with its name; each needs its own object.
    props: z.strictObject({ ...widgetProps.shape }),
    component: null,
  }),
)
const dashboardComponent = defineComponent({
  name: "Dashboard",
  description:
    "A Paprika Insights dashboard. Preserve its id when editing. All widget IDs must be unique.",
  props: z.strictObject({
    id: dashboardSchema.shape.id,
    title: dashboardSchema.shape.title,
    timeRange: dashboardSchema.shape.timeRange,
    refreshInterval: dashboardSchema.shape.refreshInterval,
    widgets: z.array(z.union(widgetComponents.map((component) => component.ref))).max(MAX_WIDGETS),
    description: dashboardSchema.shape.description,
    folder: dashboardSchema.shape.folder,
    customTimeRange: dashboardSchema.shape.customTimeRange,
    variables: dashboardSchema.shape.variables,
  }),
  component: null,
})

export const insightsLibrary = createLibrary({
  components: [dashboardComponent, ...widgetComponents],
  root: "Dashboard",
})
const parser = createParser(insightsLibrary.toJSONSchema(), "Dashboard")

function optionalProps(props: Record<string, unknown>) {
  const value = { ...props }
  for (const key of [
    "description",
    "color",
    "options",
    "pluginId",
    "dataKind",
    "config",
    "folder",
    "customTimeRange",
    "variables",
    "drilldowns",
    "queryRef",
    "selectionBindings",
    "annotationSource",
  ])
    if (value[key] === null || value[key] === undefined) delete value[key]
  return value
}

function element(value: unknown): ElementNode {
  if (!value || typeof value !== "object" || !("type" in value) || value.type !== "element")
    throw new Error("Use only Dashboard and registered widget components.")
  const node = value as ElementNode
  if (node.partial || node.hasDynamicProps)
    throw new Error(
      "Dashboard definitions must use complete, static values. Expressions and actions are not supported.",
    )
  return node
}

function checkComplexity(source: string) {
  if (new TextEncoder().encode(source).byteLength > MAX_DOCUMENT_BYTES)
    throw new Error("Dashboard documents must be smaller than 256 KiB")
  let depth = 0
  let quoted = false
  let escaped = false
  for (const char of source) {
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if ("([{".includes(char)) {
      depth++
      if (depth > 32) throw new Error("Dashboard definition nesting is too deep")
    } else if (")]}".includes(char)) depth = Math.max(0, depth - 1)
  }
}

export function parseOpenUIDashboard(source: string): Dashboard {
  if (new TextEncoder().encode(source).byteLength > MAX_DOCUMENT_BYTES)
    throw new Error("Dashboard documents must be smaller than 256 KiB")
  const clean = source.trim().replace(/^```(?:openui-lang|openui)?\s*\n([\s\S]*?)\n```$/, "$1")
  checkComplexity(clean)
  const result = parser.parse(clean)
  if (result.meta.errors.length)
    throw new Error(result.meta.errors.map((error) => error.message).join("\n"))
  if (result.meta.incomplete || result.meta.unresolved.length || result.meta.orphaned.length)
    throw new Error(
      "Finish the definition and remove unresolved or unused statements before applying it.",
    )
  if (
    result.queryStatements.length ||
    result.mutationStatements.length ||
    Object.keys(result.stateDeclarations).length ||
    result.rootExpression
  )
    throw new Error(
      "Use static widget queries. OpenUI tools, mutations, variables and actions are not supported.",
    )
  const root = element(result.root)
  if (root.typeName !== "Dashboard" || !Array.isArray(root.props.widgets))
    throw new Error("The root must be a Dashboard with a widget list.")
  const widgets = root.props.widgets.map((value) => {
    const node = element(value)
    const type = (Object.keys(componentNames) as Widget["type"][]).find(
      (key) => componentNames[key] === node.typeName,
    )
    if (!type) throw new Error(`Unknown widget component: ${node.typeName}`)
    return { ...optionalProps(node.props), type }
  })
  const checked = dashboardSchema.safeParse({
    ...optionalProps(root.props),
    schemaVersion: 1,
    widgets,
  })
  if (!checked.success)
    throw new Error(
      checked.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"),
    )
  return checked.data
}

export function dashboardToOpenUI(dashboard: Dashboard): string {
  const value = dashboardSchema.parse(dashboard)
  const args = (values: unknown[]) => values.map((item) => JSON.stringify(item ?? null)).join(", ")
  const lines = value.widgets.map(
    (widget, index) =>
      `widget${index} = ${componentNames[widget.type]}(${args([widget.id, widget.title, widget.providerId, widget.query, widget.unit, widget.layout, widget.description, widget.color, widget.options, widget.pluginId, widget.dataKind, widget.config, widget.drilldowns, widget.queryRef, widget.selectionBindings, widget.annotationSource])})`,
  )
  return `root = Dashboard(${args([value.id, value.title, value.timeRange, value.refreshInterval])}, [${value.widgets.map((_, index) => `widget${index}`).join(", ")}], ${args([value.description, value.folder, value.customTimeRange, value.variables])})\n${lines.join("\n")}\n`
}

export function validateAIProviders(dashboard: Dashboard, providers: Provider[], savedQueries: SavedQuery[] = []) {
  // Validate bindings with typed placeholders rather than requiring a hovered
  // observation or populated dashboard controls at authoring time.
  function referenceProvider(ref: SavedQueryReference, kind: "metrics" | "traces" | "records", observation: boolean) {
    const declared = new Set((dashboard.variables ?? []).map(variable => variable.name))
    for (const binding of ref.bindings ?? []) {
      if (binding.source === "variable" && !declared.has(binding.variable))
        throw new Error(`Saved query parameter “${binding.parameter}” refers to undeclared dashboard variable “${binding.variable}”.`)
      if (!observation && (binding.source === "label" || binding.source === "field"))
        throw new Error("Dashboard query references cannot use observation bindings.")
    }
    const point = { timestamp: 1_700_000_000_000, value: 1 }
    const labels = Object.fromEntries((ref.bindings ?? []).filter(binding => binding.source === "label").map(binding => [binding.label, "1"]))
    const documents = savedQueries.map(entry => { const document = { ...entry } as SavedQuery & { etag?: string }; delete document.etag; return document })
    return resolveSavedQueryReference(ref, documents, Object.fromEntries([...declared].map(name => [name, "1"])), kind, observation ? { series: { name: "validation", labels, points: [point] }, point } : undefined).providerId
  }
  for (const widget of dashboard.widgets) {
    if (widget.annotationSource) {
      const eventProvider = referenceProvider(widget.annotationSource.queryRef, "records", false)
      if (!providers.some(item => item.id === eventProvider && item.capabilities.includes("records")))
        throw new Error(`“${widget.title}” event query needs an available records provider.`)
    }
    const providerId = widget.queryRef ? referenceProvider(widget.queryRef, widgetKind(widget), false) : widget.providerId
    const provider = providers.find((item) => item.id === providerId)
    if (!provider)
      throw new Error(
        `“${widget.title}” refers to unknown provider “${providerId}”. Choose an available provider.`,
      )
    if (!provider.capabilities.includes(widgetKind(widget)))
      throw new Error(
        `“${widget.title}” needs a ${widgetKind(widget) === "traces" ? "trace" : "metrics"} provider.`,
      )
    if (widget.type === "plugin") {
      const definition = getWidgetDefinition(widget)
      if (!definition)
        throw new Error(`“${widget.title}” needs the registered plugin “${widget.pluginId}”.`)
      if (definition.dataKind !== widgetKind(widget))
        throw new Error(`“${widget.title}” has the wrong data kind for its plugin.`)
      definition.parseConfig?.(widget.config)
    }
    const tooltip = widget.options?.tooltipView
    if (tooltip?.source?.type === "widget" && widgetKind(tooltip) !== widgetKind(widget))
      throw new Error(`“${widget.title}” tooltip needs the same data kind as its parent when reusing the widget result.`)
    if (tooltip?.source?.type === "query") {
      const source = tooltip.source
      const tooltipProvider = providers.find(item => item.id === source.providerId)
      if (!tooltipProvider)
        throw new Error(`“${widget.title}” tooltip refers to unknown provider “${source.providerId}”.`)
      if (!tooltipProvider.capabilities.includes(widgetKind(tooltip)))
        throw new Error(`“${widget.title}” tooltip needs a ${widgetKind(tooltip)} provider.`)
      validateTooltipQueryTemplate(source)
    }
    if (tooltip?.source?.type === "saved") {
      const providerId = referenceProvider(tooltip.source.ref, widgetKind(tooltip), true)
      const tooltipProvider = providers.find(item => item.id === providerId)
      if (!tooltipProvider) throw new Error(`“${widget.title}” tooltip refers to unknown provider “${providerId}”.`)
      if (!tooltipProvider.capabilities.includes(widgetKind(tooltip))) throw new Error(`“${widget.title}” tooltip needs a ${widgetKind(tooltip)} provider.`)
    }
    if (tooltip?.type === "plugin") {
      const definition = getWidgetDefinition("plugin", tooltip.pluginId)
      if (!definition)
        throw new Error(`“${widget.title}” tooltip needs the registered plugin “${tooltip.pluginId}”.`)
      if (definition.dataKind !== widgetKind(tooltip))
        throw new Error(`“${widget.title}” tooltip has the wrong data kind for its plugin.`)
      definition.parseConfig?.(tooltip.config)
    }
  }
}

export function buildAIContext(
  dashboard: Dashboard,
  providers: Provider[],
  request: string,
  savedQueries: SavedQuery[] = [],
): string {
  return `${insightsLibrary.prompt({
    preamble:
      "You are helping an operator edit a Paprika Insights dashboard. Return a complete OpenUI Lang document for review; nothing is applied automatically.",
    toolCalls: false,
    bindings: false,
    builtinFunctions: false,
    additionalRules: [
      "Use static literals and component references only. Do not use Query, Mutation, actions, expressions, functions, URLs, HTML or JavaScript.",
      "Preserve the existing Dashboard id. Use unique widget ids and only the provided provider ids. Keep existing widgets unless the user asks to remove them.",
      "Query fields are strings executed by the configured data provider. Use that provider's syntax and supported data kind: Prometheus metrics use PromQL, Tempo traces use TraceQL, and PostgreSQL uses a JSON query with sql and optional parameters (plus projection when requesting metrics). Do not assume every metrics query uses PromQL. Reuse a known query or ask for provider-specific syntax when it is unknown.",
      'PostgreSQL can bind the current query range as UTC timestamp parameters using {"range":"start"} and {"range":"end"} in the parameters array. SQL comparison operators determine whether each endpoint is included; range bounds are never inserted into SQL text.',
      "Metric names in the existing document are context, not proof that those metrics exist. If a requested metric is unknown, ask the operator for its name instead of fabricating one.",
      `At most ${MAX_WIDGETS} widgets. Layout x is 0–11, y is 0–1000, width w is 1–12, height h is 1–12 for stat widgets and 2–12 for all others, and x+w <= 12. Avoid overlapping widgets.`,
      `Never embed fake metric values or credentials. Keep timeRange in ${dashboardSchema.shape.timeRange.options.join(", ")} and refreshInterval in 0, 15, 30, 60 seconds.`,
      "Optional folder is a slash-separated path. customTimeRange uses ISO from/to timestamps with timezone, increasing by at most 31 days. Options configure axes, display line/area, legend, tooltip, grid, decimals, bounds and ascending threshold values/colors. Single value may set staleAfterSeconds to warn when its latest valid returned sample is older than that threshold relative to the selected range end; this does not measure source scrape health. Preserve these settings when editing.",
      "Plugin widgets must reference an installed trusted plugin id and its declared dataKind. Configuration is JSON data; never generate renderer code or new plugin identifiers. The plugin list includes its defaults and available configuration controls; config field keys name JSON properties, and recordColumn fields name returned record columns rather than expressions. These controls are not necessarily the complete plugin schema. Preserve existing configuration unless asked to change it.",
      "Heatmap, TimeSeries, BarChart and MetricsTable options.tooltipView select a built-in or installed plugin sub-widget. Omit source or use {type:'series'} for the hovered metric series. Opt into source:{type:'query',providerId,query,bindings:[{variable,label}]} for a separate query. Bindings may instead be {variable,field:'value'|'timestamp'|'series'}: value is the exact hovered observation, timestamp is Unix seconds (may be fractional), and series is its name. Numeric fields supply finite numeric literals; labels and series supply complete quoted strings. Do not add surrounding quotes or concatenate token fragments. For example up{service={{service}}} @ {{timestamp}}. Bindings are independent of dashboard variables. Missing labels/values/timestamps prevent queries. TimeSeries uses the hovered historical point; bars/tables use their displayed latest-valid sample; heatmaps retain the latest sample even when null. Trace tooltip widgets require a compatible query source. Never nest tooltip definitions or executable code.",
      "Dashboard variables are named strings. Use {{variableName}} as a complete query string literal without surrounding quotes, for example up{service={{service}}}. Never interpolate inside quotes, comments, identifiers, or query fragments. Widget drilldowns reference dashboard IDs and bind declared target variables from label, value, series or constant sources. Preserve existing links and variables unless asked to change them.",
      "Reuse only listed saved queries. The trailing 14th widget argument queryRef is {id,bindings?}; all previous positional arguments remain unchanged. A saved reference is authoritative: use its providerId and kind, keep the required query string as a fallback, and do not copy changes into the shared query. To edit a template, use Explore. Bindings are {parameter,source:'variable',variable} or {parameter,source:'constant',value}. Every variable binding must name a declared dashboard variable; name matching does not automatically bind it. An omitted binding uses the typed saved default; no default means a binding is required. Text and finite numeric parameters must retain their types. Never invent query IDs or parameters.",
      "Tooltip source:{type:'saved',ref:{id,bindings?}} reuses a compatible saved query. Tooltip-only parameter bindings may use {parameter,source:'label',label} or {parameter,source:'field',field:'value'|'timestamp'|'series'}. Numeric value and timestamp fields are finite numbers; timestamp uses Unix seconds. Series and labels are strings. Missing observation data prevents the request. source:{type:'widget'} reuses the complete loaded parent widget result without a request; source:{type:'series'} reuses only the hovered series. Do not nest queries or tooltip definitions.",
    ],
    examples: [dashboardToOpenUI(dashboard)],
  })}\n\nInstalled trusted widget plugins:\n${JSON.stringify(
    getWidgetPlugins().map(({ id, label, description, dataKind, defaultOptions, defaultConfig, configFields, styleControls }) => ({
      id,
      label,
      description,
      dataKind,
      defaultOptions,
      defaultConfig,
      configFields,
      styleControls,
    })),
    null,
    2,
  )}\n\nAvailable providers (only identifiers, names and capabilities; no secrets):\n${JSON.stringify(
    providers.map(({ id, name, type, capabilities }) => ({ id, name, type, capabilities })),
    null,
    2,
  )}\n\nAvailable saved query definitions (reuse these IDs; typed parameters and defaults are authoritative):\n${JSON.stringify(savedQueries.map(({ id, name, description, providerId, kind, query, parameters }) => ({ id, name, description, providerId, kind, query, parameters })), null, 2)}\n\nCurrent dashboard:\n${dashboardToOpenUI(dashboard)}\nOperator request:\n${request.trim() || "Improve the layout while preserving existing queries and providers."}`
}

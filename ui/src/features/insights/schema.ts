import { z } from "zod"
import { parseDocument, stringify } from "yaml"

export const MAX_WIDGETS = 48
export const MAX_DOCUMENT_BYTES = 256 * 1024
export const timeRanges = {
  "15m": 900,
  "1h": 3600,
  "6h": 21600,
  "24h": 86400,
  "7d": 604800,
} as const
export const widgetTypes = [
  "timeseries",
  "bar",
  "stat",
  "table",
  "traces",
  "heatmap",
  "plugin",
] as const
export const builtinWidgetTypes = [
  "timeseries",
  "bar",
  "stat",
  "table",
  "traces",
  "heatmap",
] as const
const identifier = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "Use letters, numbers, hyphens or underscores")

export const MAX_DASHBOARD_VARIABLES = 20
export const MAX_VARIABLE_VALUE_LENGTH = 1024
export const MAX_VARIABLE_OPTIONS = 100
export const variableNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use a variable name beginning with a letter or underscore")
  .refine(
    (name) => !["__proto__", "prototype", "constructor"].includes(name),
    "This variable name is reserved",
  )
export const variableValueSchema = z.string().max(MAX_VARIABLE_VALUE_LENGTH).refine(
  (value) => value.length <= MAX_VARIABLE_VALUE_LENGTH,
  "Use a variable value of at most 1024 UTF-16 code units",
)
export const dashboardVariableSchema = z.strictObject({
  name: variableNameSchema,
  label: z.string().max(80).optional(),
  defaultValue: variableValueSchema.optional(),
  options: z.array(variableValueSchema).min(1).max(MAX_VARIABLE_OPTIONS).optional(),
}).superRefine((variable, context) => {
  const seen = new Set<string>()
  variable.options?.forEach((option, index) => {
    if (seen.has(option)) context.addIssue({ code: "custom", path: ["options", index], message: "Variable options must be unique" })
    seen.add(option)
  })
})

export const savedQueryParameterSchema = z.strictObject({
  name: variableNameSchema,
  label: z.string().max(80).optional(),
  type: z.enum(["string", "number"]),
  defaultValue: z.union([variableValueSchema, z.number().finite()]).optional(),
}).superRefine((parameter, context) => {
  if (parameter.defaultValue !== undefined && typeof parameter.defaultValue !== parameter.type)
    context.addIssue({ code: "custom", path: ["defaultValue"], message: `Use a ${parameter.type} default value` })
})
export const MAX_SAVED_QUERY_TAGS = 12
export const MAX_SAVED_QUERY_METADATA = 12
export const savedQueryImageUrlSchema = z.string().min(1).max(2048).refine((value) => {
  if (value.length > 2048) return false
  if (/[\s\u0000-\u001f\u007f\\]/u.test(value)) return false
  if (value.startsWith("/")) return !value.startsWith("//")
  if (!value.startsWith("https://")) return false
  const authority = value.slice(8).split(/[/?#]/, 1)[0]
  if (!authority || authority.includes("@")) return false
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password
  } catch { return false }
}, "Use an HTTPS image URL or a path beginning with /, without credentials")
export const savedQueryTagSchema = z.string().min(1).max(32).refine(
  (value) => value.length <= 32 && value === value.trim(), "Tags must fit 32 characters without surrounding whitespace",
)
export const savedQueryMetadataKeySchema = z.string().min(1).max(64).refine(
  (value) => value.length <= 64 && value === value.trim() && !["__proto__", "prototype", "constructor"].includes(value),
  "Use a nonempty metadata key without surrounding whitespace or reserved names",
)
export const savedQueryMetadataSchema = z.unknown().superRefine((value, context) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value)
    if (keys.length > MAX_SAVED_QUERY_METADATA)
      context.addIssue({ code: "custom", message: "Use at most 12 metadata entries" })
    if (keys.some((key) => ["__proto__", "prototype", "constructor"].includes(key)))
      context.addIssue({ code: "custom", message: "This metadata key is reserved" })
  }
}).pipe(z.record(savedQueryMetadataKeySchema, z.string().max(256).refine((value) => value.length <= 256, "Use a metadata value of at most 256 characters")))
export const savedQuerySchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: identifier,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).optional(),
  imageUrl: savedQueryImageUrlSchema.optional(),
  tags: z.array(savedQueryTagSchema).max(MAX_SAVED_QUERY_TAGS).optional(),
  metadata: savedQueryMetadataSchema.optional(),
  providerId: identifier,
  kind: z.enum(["metrics", "traces", "records"]),
  query: z.string().trim().min(1).max(8192),
  parameters: z.array(savedQueryParameterSchema).max(MAX_DASHBOARD_VARIABLES).optional(),
}).superRefine((query, context) => {
  const tags = new Set<string>()
  query.tags?.forEach((tag, index) => {
    if (tags.has(tag)) context.addIssue({ code: "custom", path: ["tags", index], message: "Tags must be unique" })
    tags.add(tag)
  })
  const names = new Set<string>()
  query.parameters?.forEach((parameter, index) => {
    if (names.has(parameter.name)) context.addIssue({ code: "custom", path: ["parameters", index, "name"], message: "Parameter names must be unique" })
    names.add(parameter.name)
  })
})
const savedVariableBindingSchema = z.strictObject({
  parameter: variableNameSchema, source: z.literal("variable"), variable: variableNameSchema,
})
const savedConstantBindingSchema = z.strictObject({
  parameter: variableNameSchema, source: z.literal("constant"), value: z.union([variableValueSchema, z.number().finite()]),
})
export const dashboardQueryBindingSchema = z.discriminatedUnion("source", [savedVariableBindingSchema, savedConstantBindingSchema])
export const savedQueryBindingSchema = z.discriminatedUnion("source", [
  savedVariableBindingSchema, savedConstantBindingSchema,
  z.strictObject({ parameter: variableNameSchema, source: z.literal("label"), label: z.string().min(1).max(128) }),
  z.strictObject({ parameter: variableNameSchema, source: z.literal("field"), field: z.enum(["value", "timestamp", "series"]) }),
])
function uniqueQueryBindings(ref: { bindings?: { parameter: string }[] }, context: z.RefinementCtx) {
  const names = new Set<string>()
  ref.bindings?.forEach((binding, index) => {
    if (names.has(binding.parameter)) context.addIssue({ code: "custom", path: ["bindings", index, "parameter"], message: "Bind each saved query parameter once" })
    names.add(binding.parameter)
  })
}
export const savedQueryReferenceSchema = z.strictObject({
  id: identifier,
  bindings: z.array(savedQueryBindingSchema).max(MAX_DASHBOARD_VARIABLES).optional(),
}).superRefine(uniqueQueryBindings)
export const dashboardQueryReferenceSchema = z.strictObject({
  id: identifier,
  bindings: z.array(dashboardQueryBindingSchema).max(MAX_DASHBOARD_VARIABLES).optional(),
}).superRefine(uniqueQueryBindings)
export type SavedQuery = z.infer<typeof savedQuerySchema>
export type SavedQueryParameter = z.infer<typeof savedQueryParameterSchema>
export type SavedQueryBinding = z.infer<typeof savedQueryBindingSchema>
export type SavedQueryReference = z.infer<typeof savedQueryReferenceSchema>
export type DashboardQueryReference = z.infer<typeof dashboardQueryReferenceSchema>
export type SavedQueryEntry = SavedQuery & { etag?: string }
export const drilldownBindingSchema = z
  .strictObject({
    variable: variableNameSchema,
    source: z.enum(["label", "value", "series", "constant"]),
    value: variableValueSchema.optional(),
  })
  .superRefine((binding, context) => {
    if (
      binding.source === "label" &&
      (binding.value === undefined || binding.value.length === 0 || binding.value.length > 128)
    )
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Label bindings require a label key of 1–128 characters",
      })
    if (binding.source === "constant" && binding.value === undefined)
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Constant bindings require a value",
      })
    if ((binding.source === "value" || binding.source === "series") && binding.value !== undefined)
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Value and series bindings do not take a configured value",
      })
  })
export const drilldownSchema = z
  .strictObject({
    id: identifier,
    title: z.string().trim().min(1).max(120),
    dashboardId: identifier,
    carryTimeRange: z.boolean().optional(),
    bindings: z.array(drilldownBindingSchema).max(MAX_DASHBOARD_VARIABLES).optional(),
  })
  .superRefine((drilldown, context) => {
    const names = new Set<string>()
    drilldown.bindings?.forEach((binding, index) => {
      if (names.has(binding.variable))
        context.addIssue({
          code: "custom",
          path: ["bindings", index, "variable"],
          message: "Bind each target variable once",
        })
      names.add(binding.variable)
    })
  })

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color")
export const thresholdSchema = z.strictObject({
  value: z.number(),
  color: hexColor,
  label: z.string().max(80).optional(),
})

// Inspect raw keys before Zod normalizes JSON records (which drops __proto__).
export const pluginConfigSchema = z
  .unknown()
  .superRefine((config, context) => {
    const pending: { value: unknown; depth: number }[] = [{ value: config, depth: 0 }]
    while (pending.length) {
      const { value, depth } = pending.pop()!
      if (depth > 8) {
        context.addIssue({
          code: "custom",
          message: "Plugin configuration nesting exceeds eight levels",
        })
        return
      }
      if (value && typeof value === "object")
        for (const [key, child] of Object.entries(value)) {
          if (["__proto__", "prototype", "constructor"].includes(key)) {
            context.addIssue({
              code: "custom",
              message: "Plugin configuration contains a reserved key",
            })
            return
          }
          pending.push({ value: child, depth: depth + 1 })
        }
    }
    try {
      if (new TextEncoder().encode(JSON.stringify(config)).byteLength > 16 * 1024)
        context.addIssue({
          code: "custom",
          message: "Plugin configuration must be smaller than 16 KiB",
        })
    } catch {
      context.addIssue({
        code: "custom",
        message: "Plugin configuration must contain JSON data",
      })
    }
  })
  .pipe(z.record(z.string(), z.json()))

// Tooltip query definitions are declarative; only the host may execute them.
// Renderers receive bounded results and cannot nest tooltip definitions.
export const tooltipBindingSchema = z.union([
  z.strictObject({
    variable: variableNameSchema,
    label: z.string().min(1).max(128),
  }),
  z.strictObject({
    variable: variableNameSchema,
    field: z.enum(["value", "timestamp", "series"]),
  }),
])
export const tooltipSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("series") }),
  z.strictObject({ type: z.literal("widget") }),
  z.strictObject({ type: z.literal("saved"), ref: savedQueryReferenceSchema }),
  z.strictObject({
    type: z.literal("query"),
    providerId: identifier,
    query: z.string().trim().min(1).max(8192),
    bindings: z.array(tooltipBindingSchema).max(MAX_DASHBOARD_VARIABLES).optional(),
  }).superRefine((source, context) => {
    const names = new Set<string>()
    source.bindings?.forEach((binding, index) => {
      if (names.has(binding.variable)) context.addIssue({
        code: "custom", path: ["bindings", index, "variable"],
        message: "Bind each tooltip variable once",
      })
      names.add(binding.variable)
    })
  }),
])
export const tooltipViewSchema = z.strictObject({
  type: z.enum(widgetTypes),
  height: z.union([z.literal(120), z.literal(160), z.literal(200), z.literal(320)]).optional(),
  showGrid: z.boolean().optional(),
  showAxis: z.boolean().optional(),
  showLegend: z.boolean().optional(),
  showSparkline: z.boolean().optional(),
  title: z.string().trim().min(1).max(120).optional(),
  unit: z.string().max(24).optional(),
  color: hexColor.optional(),
  decimals: z.number().int().min(0).max(8).optional(),
  source: tooltipSourceSchema.optional(),
  pluginId: identifier.optional(),
  dataKind: z.enum(["metrics", "traces", "records"]).optional(),
  config: pluginConfigSchema.optional(),
}).superRefine((view, context) => {
  if (view.type === "plugin") {
    if (!view.pluginId) context.addIssue({ code: "custom", path: ["pluginId"], message: "Choose a registered tooltip plugin" })
    if (!view.dataKind) context.addIssue({ code: "custom", path: ["dataKind"], message: "Tooltip plugins require their data kind" })
  } else {
    for (const field of ["pluginId", "dataKind", "config"] as const)
      if (view[field] !== undefined) context.addIssue({ code: "custom", path: [field], message: "This field is only available to tooltip plugins" })
  }
  if ((view.type === "traces" || (view.type === "plugin" && (view.dataKind === "traces" || view.dataKind === "records"))) && (!view.source || view.source.type === "series"))
    context.addIssue({ code: "custom", path: ["source"], message: "Trace tooltip widgets require a query data source" })
})

export const widgetOptionsSchema = z
  .strictObject({
    display: z.enum(["line", "area"]).optional(),
    xAxisLabel: z.string().max(80).optional(),
    yAxisLabel: z.string().max(80).optional(),
    showLegend: z.boolean().optional(),
    showLabels: z.boolean().optional(),
    showValues: z.boolean().optional(),
    showSparkline: z.boolean().optional(),
    showTooltip: z.boolean().optional(),
    tooltipView: tooltipViewSchema.optional(),
    showGrid: z.boolean().optional(),
    decimals: z.number().int().min(0).max(8).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    lineWidth: z.number().min(0.5).max(8).optional(),
    fillOpacity: z.number().min(0).max(1).optional(),
    curve: z.enum(["linear", "step", "monotone"]).optional(),
    background: hexColor.optional(),
    textColor: hexColor.optional(),
    thresholds: z.array(thresholdSchema).max(12).optional(),
  })
  .superRefine((options, context) => {
    if (options.min !== undefined && options.max !== undefined && options.min >= options.max)
      context.addIssue({
        code: "custom",
        path: ["max"],
        message: "Maximum must be greater than minimum",
      })
    options.thresholds?.forEach((threshold, index, thresholds) => {
      if (index && threshold.value <= thresholds[index - 1].value)
        context.addIssue({
          code: "custom",
          path: ["thresholds", index, "value"],
          message: "Threshold values must be strictly increasing",
        })
    })
  })

export const customTimeRangeSchema = z
  .strictObject({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  })
  .refine((range) => {
    const duration = Date.parse(range.to) - Date.parse(range.from)
    return Date.parse(range.from) > 0 && duration > 0 && duration <= 31 * 24 * 60 * 60 * 1000
  }, "Choose an increasing time range of at most 31 days, after the Unix epoch")

export const widgetSchema = z
  .strictObject({
    id: identifier,
    title: z.string().trim().min(1).max(120),
    type: z.enum(widgetTypes),
    providerId: identifier,
    query: z.string().trim().min(1).max(8192),
    unit: z.string().max(24),
    queryRef: dashboardQueryReferenceSchema.optional(),
    description: z.string().max(500).optional(),
    color: hexColor.optional(),
    options: widgetOptionsSchema.optional(),
    pluginId: identifier.optional(),
    dataKind: z.enum(["metrics", "traces", "records"]).optional(),
    config: pluginConfigSchema.optional(),
    drilldowns: z.array(drilldownSchema).max(8).optional(),
    layout: z
      .strictObject({
        x: z.number().int().min(0).max(11),
        y: z.number().int().min(0).max(1000),
        w: z.number().int().min(1).max(12),
        h: z.number().int().min(2).max(12),
      })
      .refine((v) => v.x + v.w <= 12, "Widget must fit within the 12-column canvas"),
  })
  .superRefine((widget, context) => {
    const drilldownIds = new Set<string>()
    widget.drilldowns?.forEach((drilldown, index) => {
      if (drilldownIds.has(drilldown.id))
        context.addIssue({
          code: "custom",
          path: ["drilldowns", index, "id"],
          message: "Drilldown IDs must be unique within the widget",
        })
      drilldownIds.add(drilldown.id)
    })
    if (widget.type === "plugin") {
      if (!widget.pluginId)
        context.addIssue({
          code: "custom",
          path: ["pluginId"],
          message: "Choose a registered plugin",
        })
      if (!widget.dataKind)
        context.addIssue({
          code: "custom",
          path: ["dataKind"],
          message: "Plugin widgets require their data kind",
        })
    } else {
      for (const field of ["pluginId", "dataKind", "config"] as const)
        if (widget[field] !== undefined)
          context.addIssue({
            code: "custom",
            path: [field],
            message: "This field is only available to plugin widgets",
          })
    }
  })

export const dashboardSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: identifier,
    title: z.string().trim().min(1).max(120),
    description: z.string().max(500).optional(),
    folder: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .refine(
        (folder) =>
          !/[\u0000-\u001f\u007f\\]/.test(folder) &&
          folder
            .split("/")
            .every(
              (segment) =>
                segment.trim() === segment &&
                segment.length > 0 &&
                segment !== "." &&
                segment !== "..",
            ),
        "Use a folder path without empty, dot, or parent segments",
      )
      .optional(),
    customTimeRange: customTimeRangeSchema.optional(),
    variables: z.array(dashboardVariableSchema).max(MAX_DASHBOARD_VARIABLES).optional(),
    timeRange: z.enum(["15m", "1h", "6h", "24h", "7d"]),
    refreshInterval: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(60)]),
    widgets: z.array(widgetSchema).max(MAX_WIDGETS),
  })
  .superRefine((value, context) => {
    const variableNames = new Set<string>()
    value.variables?.forEach((variable, index) => {
      if (variableNames.has(variable.name))
        context.addIssue({
          code: "custom",
          path: ["variables", index, "name"],
          message: "Dashboard variable names must be unique",
        })
      variableNames.add(variable.name)
    })
    const ids = new Set<string>()
    value.widgets.forEach((widget, i) => {
      if (ids.has(widget.id))
        context.addIssue({
          code: "custom",
          path: ["widgets", i, "id"],
          message: "Widget IDs must be unique",
        })
      ids.add(widget.id)
    })
  })

export type Dashboard = z.infer<typeof dashboardSchema>
export type Widget = z.infer<typeof widgetSchema>
export type WidgetOptions = z.infer<typeof widgetOptionsSchema>
export type TooltipView = z.infer<typeof tooltipViewSchema>
export type TooltipSource = z.infer<typeof tooltipSourceSchema>
export type TooltipQuerySource = Extract<TooltipSource, { type: "query" }>
export type TooltipBinding = z.infer<typeof tooltipBindingSchema>

export function supportsTooltipView(type: Widget["type"]): boolean {
  return type === "heatmap" || type === "timeseries" || type === "bar" || type === "table"
}
export type Threshold = z.infer<typeof thresholdSchema>
export type DashboardVariable = z.infer<typeof dashboardVariableSchema>
export type Drilldown = z.infer<typeof drilldownSchema>
export type DrilldownBinding = z.infer<typeof drilldownBindingSchema>
export type DataKind = "metrics" | "traces" | "records"

export function widgetKind(widget: Pick<Widget, "type" | "dataKind">): DataKind {
  return widget.type === "plugin"
    ? (widget.dataKind ?? "metrics")
    : widget.type === "traces"
      ? "traces"
      : "metrics"
}
export interface Provider {
  /** Shared sources retain their canonical Observe identity in configuration only. */
  source?: "observability"
  transport?: "mcp"
  providerRef?: string
  id: string
  name: string
  managed?: boolean
  type: "prometheus" | "tempo" | "postgresql" | "shorted" | "uptime"
  capabilities: DataKind[]
}
export interface QueryRequest {
  providerId: string
  query: string
  kind: DataKind
  start: number
  end: number
  step: number
  /** Authoring reference; the host resolves and removes this before transport. */
  queryRef?: DashboardQueryReference
}
export interface RecordColumn {
  key: string
  label?: string
  type: "string" | "number" | "boolean" | "timestamp"
  unit?: string
}
export interface RecordFrame {
  columns: RecordColumn[]
  rows: (string | number | boolean | null)[][]
  truncated?: boolean
}
export interface QueryResult {
  records?: RecordFrame
  truncated?: boolean
  series?: {
    name: string
    labels: Record<string, string>
    points: { timestamp: number; value: number | null }[]
  }[]
  traces?: {
    traceId: string
    service: string
    operation: string
    durationMs: number
    startTime: number
    status: string
  }[]
}
export type DocumentFormat = "json" | "yaml"

export function parseDashboard(source: string, format: DocumentFormat): Dashboard {
  if (new TextEncoder().encode(source).byteLength > MAX_DOCUMENT_BYTES)
    throw new Error("Dashboard documents must be smaller than 256 KiB")
  let value: unknown
  if (format === "json") value = JSON.parse(source)
  else {
    const document = parseDocument(source, { uniqueKeys: true, merge: false })
    if (document.errors.length) throw new Error(document.errors[0].message)
    value = document.toJS({ maxAliasCount: 0 })
  }
  const result = dashboardSchema.safeParse(value)
  if (!result.success)
    throw new Error(
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "dashboard"}: ${issue.message}`)
        .join("\n"),
    )
  return result.data
}

export function serializeDashboard(dashboard: Dashboard, format: DocumentFormat) {
  return format === "json"
    ? JSON.stringify(dashboard, null, 2)
    : stringify(dashboard, { lineWidth: 0 })
}

export function newDashboard(): Dashboard {
  return {
    schemaVersion: 1,
    id: `dashboard-${crypto.randomUUID()}`,
    title: "Untitled dashboard",
    description: "",
    timeRange: "1h",
    refreshInterval: 0,
    widgets: [],
  }
}

export function newWidget(
  type: Widget["type"],
  providers: Provider[],
  widgets: Widget[],
  plugin?: {
    id: string
    label: string
    dataKind: DataKind
    defaultOptions?: WidgetOptions
  },
): Widget {
  if (type === "plugin" && !plugin)
    throw new Error("Choose a registered plugin before adding its widget")
  const kind = type === "plugin" ? plugin!.dataKind : type === "traces" ? "traces" : "metrics"
  const provider = providers.find((p) => p.capabilities.includes(kind))
  return {
    id: `widget-${crypto.randomUUID()}`,
    title: {
      timeseries: "Time series",
      bar: "Bar chart",
      stat: "Single value",
      table: "Metrics table",
      traces: "Trace explorer",
      heatmap: "Service heatmap",
      plugin: plugin?.label ?? "Plugin widget",
    }[type],
    type,
    providerId: provider?.id ?? "unconfigured",
    query: kind === "traces" ? "{}" : "up",
    unit: "",
    ...(type === "heatmap"
      ? {
          options: {
            thresholds: [
              { value: 0, color: "#b64a3a", label: "Unhealthy" },
              { value: 1, color: "#53876a", label: "Healthy" },
            ],
            showLegend: true,
            showTooltip: true,
          },
        }
      : {}),
    ...(type === "plugin"
      ? {
          pluginId: plugin!.id,
          dataKind: plugin!.dataKind,
          options: plugin!.defaultOptions,
        }
      : {}),
    layout: {
      x: 0,
      y: Math.min(1000, Math.max(0, ...widgets.map((w) => w.layout.y + w.layout.h))),
      w: type === "stat" ? 3 : 6,
      h: type === "stat" ? 2 : 4,
    },
  }
}

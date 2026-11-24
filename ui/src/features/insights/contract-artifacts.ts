import { z } from "zod"
import { dashboardSchema, savedQuerySchema } from "./schema"

// Builds the published authoring contracts from the canonical Zod models. Pure: this module imports schema.ts and
// zod only, never a plugin, so the writer and its tests stay light. Run `npm run schema:generate` in ui/ to write
// the committed files from these builders.

/** Stable file text: two-space JSON and a trailing newline. Key order follows the builder, so the output is deterministic. */
export function stableJSON(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

// Zod's JSON Schema exporter cannot emit some refinements. Each literal below is the published form of one of them.
// The contract test compares the whole builder output with the committed file, so a change to any literal shows up there.

/** The widget-level rules: stat height, the slo-summary config, compare and baseline imply their widget type. */
export const WIDGET_ALL_OF = [{
  if: { properties: { type: { const: "stat" } }, required: ["type"] },
  else: { properties: { layout: { properties: { h: { minimum: 2 } } } } },
}, {
  if: { properties: { pluginId: { const: "slo-summary" } }, required: ["pluginId"] },
  then: {
    required: ["config"],
    properties: {
      config: {
        type: "object",
        properties: {
          objective: { type: "number", minimum: 50, maximum: 99.9999 },
          period: { type: "string", enum: ["1d", "7d", "28d", "30d"] },
          total: { type: "string", minLength: 1 },
          bad: { type: "string", minLength: 1 },
          good: { type: "string", minLength: 1 },
          burnAlerts: { type: "string", enum: ["multiwindow", "page", "none"] },
          groupBy: { type: "string", minLength: 1, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
          maxRows: { type: "integer", minimum: 1, maximum: 12 },
        },
        required: ["objective", "period", "total"],
        oneOf: [{ required: ["bad"] }, { required: ["good"] }],
        additionalProperties: false,
      },
    },
  },
}, {
  if: { required: ["options"], properties: { options: { required: ["compare"] } } },
  then: { properties: { type: { const: "stat" } } },
}, {
  if: { required: ["options"], properties: { options: { required: ["baseline"] } } },
  then: { properties: { type: { const: "timeseries" } } },
}] as const

/** showStatBar needs both bounds. */
export const OPTIONS_ALL_OF = [{
  if: { properties: { showStatBar: { const: true } }, required: ["showStatBar"] },
  then: { required: ["min", "max"] },
}] as const

/** A threshold names a status or a colour. */
export const THRESHOLD_ANY_OF = [{ required: ["status"] }, { required: ["color"] }] as const

/** A series colour rule names exactly one of a colour or a role. */
export const SERIES_RULE_ONE_OF = [{ required: ["color"] }, { required: ["role"] }] as const

type Json = Record<string, unknown>

function propertyNode(root: Json, key: string): Json {
  const node = (root.properties as Record<string, Json>)[key]
  if (!node) throw new Error(`dashboard schema has no property ${key}`)
  return node
}

const DASHBOARD_METADATA = {
  title: "Paprika Insights dashboard",
  description: "Version 1 of the portable Paprika Insights dashboard document.",
  $comment: "Runtime validation additionally enforces unique widget, variable and drilldown IDs, x+w<=12, sorted thresholds, increasing bounds and custom ranges of at most 31 days, timeZone names from the canonical IANA list (exact and case-sensitive, so offsets, Local, Factory and posixrules are refused), safe folder paths, plugin metadata, JSON configuration limits (16 KiB, depth 8, no reserved keys), unique dropdown options and binding targets, source-specific binding fields, and reserved variable names.",
} as const

const SAVED_QUERY_METADATA = {
  title: "Paprika saved query",
  description: "A named, typed query owned by one data source, with optional library image, tags and metadata. Parameters are complete unquoted literals.",
} as const

/** The dashboard document contract, with the published refinements attached. */
export function dashboardJSONSchema(): Json {
  const generated = z.toJSONSchema(dashboardSchema) as Json
  const widget = (propertyNode(generated, "widgets").items ?? {}) as Json
  widget.allOf = structuredClone(WIDGET_ALL_OF)
  const options = propertyNode(widget, "options") as Json
  options.allOf = structuredClone(OPTIONS_ALL_OF)
  const thresholds = propertyNode(options, "thresholds") as Json
  ;(thresholds.items as Json).anyOf = structuredClone(THRESHOLD_ANY_OF)
  const seriesColors = propertyNode(options, "seriesColors") as Json
  ;(seriesColors.items as Json).oneOf = structuredClone(SERIES_RULE_ONE_OF)
  return { $schema: generated.$schema, ...DASHBOARD_METADATA, ...withoutSchema(generated) }
}

/** The saved-query contract. */
export function savedQueryJSONSchema(): Json {
  const generated = z.toJSONSchema(savedQuerySchema) as Json
  return { $schema: generated.$schema, ...SAVED_QUERY_METADATA, ...withoutSchema(generated) }
}

function withoutSchema(value: Json): Json {
  const rest = { ...value }
  delete rest.$schema
  return rest
}

/** One built-in plugin's configuration contract, as the registry holds it. */
export interface PluginConfigDefinition {
  id: string;
  dataKind: string;
  configSchema: z.ZodType;
}

const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema"

/**
 * The published configuration schema of one plugin. The writer refuses what the JSON Schema cannot carry: a regex
 * with flags (the flag would be lost, so the published schema could reject a value Zod accepts), any unrepresentable
 * type, and any reference, because the bundle must stay self-contained for agents and Go.
 */
export function pluginConfigJSONSchema(definition: PluginConfigDefinition): Json {
  const generated = z.toJSONSchema(definition.configSchema, {
    io: "input",
    unrepresentable: "throw",
    override: ({ zodSchema }) => refuseFlaggedRegex(zodSchema, definition.id),
  }) as Json
  assertNoReferences(generated, definition.id)
  return { ...withoutSchema(generated), "x-dataKind": definition.dataKind }
}

/** The bundle of every built-in plugin configuration, keyed by plugin id. Ids must be unique. */
export function pluginConfigBundle(definitions: readonly PluginConfigDefinition[]): Json {
  const sorted = [...definitions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  for (let index = 1; index < sorted.length; index++)
    if (sorted[index].id === sorted[index - 1].id) throw new Error(`duplicate plugin configuration id ${sorted[index].id}`)
  return {
    $schema: JSON_SCHEMA_DIALECT,
    title: "Paprika Insights built-in plugin configurations",
    description: "Configuration schemas for the built-in widget plugins, keyed by plugin id. Each widget's config must pass its plugin's schema.",
    $comment: "Written by npm run schema:generate from each plugin's configSchema. Go checks a plugin's config on save through these schemas. Plugin ids outside this bundle are not checked here.",
    $defs: Object.fromEntries(sorted.map((definition) => [definition.id, pluginConfigJSONSchema(definition)])),
  }
}

function refuseFlaggedRegex(schema: unknown, pluginId: string) {
  const checks = (schema as { _zod?: { def?: { checks?: unknown[] } } })._zod?.def?.checks ?? []
  for (const check of checks) {
    const pattern = (check as { _zod?: { def?: { pattern?: RegExp } } })._zod?.def?.pattern
    if (pattern?.flags)
      throw new Error(`plugin "${pluginId}": regex /${pattern.source}/${pattern.flags} has flags the published schema cannot carry`)
  }
}

function assertNoReferences(value: unknown, pluginId: string, path = "") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoReferences(item, pluginId, `${path}/${index}`))
    return
  }
  if (value === null || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref") throw new Error(`plugin "${pluginId}": published schema has a reference at ${path || "/"}`)
    assertNoReferences(child, pluginId, `${path}/${key}`)
  }
}

/**
 * The human reference for the published contracts: the widget options and each built-in plugin's configuration, one row
 * per field. It is generated, so it cannot disagree with the schemas it describes.
 */
export function contractReferenceMarkdown(dashboard: Json, bundle: Json): string {
  const widget = (propertyNode(dashboard, "widgets").items ?? {}) as Json
  const options = propertyNode(widget, "options") as Json
  const optionRows = sortedProperties(options).map(([key, node]) => {
    const field = describeField(node)
    return `| ${cell(key)} | ${cell(field.type)} | ${cell(field.allowed)} | no |`
  })
  const pluginRows: string[] = []
  const defs = (bundle.$defs ?? {}) as Record<string, Json>
  for (const id of Object.keys(defs).sort()) {
    const definition = defs[id]
    const required = new Set((definition.required as string[] | undefined) ?? [])
    for (const [key, node] of sortedProperties(definition)) {
      const field = describeField(node)
      pluginRows.push(`| ${cell(id)} | ${cell(key)} | ${cell(field.type)} | ${cell(field.allowed)} | ${required.has(key) ? "yes" : "no"} |`)
    }
  }
  return [
    "<!-- Generated by `npm run schema:generate` from the Zod models and the plugin configuration schemas. Do not edit. -->",
    "",
    "# Insights contract reference",
    "",
    "## Widget options",
    "",
    "| Field | Type | Allowed or bounds | Required |",
    "| --- | --- | --- | --- |",
    ...optionRows,
    "",
    "## Plugin configuration",
    "",
    "| Plugin | Field | Type | Allowed or bounds | Required |",
    "| --- | --- | --- | --- | --- |",
    ...pluginRows,
    "",
  ].join("\n")
}

function sortedProperties(node: Json): Array<[string, Json]> {
  const properties = (node.properties ?? {}) as Record<string, Json>
  return Object.keys(properties).sort().map((key) => [key, properties[key]])
}

function describeField(node: Json): { type: string; allowed: string } {
  if (Array.isArray(node.enum)) return { type: "enum", allowed: (node.enum as unknown[]).map(String).join(", ") }
  if (node.type === "array") {
    const inner = describeField((node.items ?? {}) as Json)
    // JSON Schema's default lower bound is 0, so a maximum alone still reads as a range.
    const minimum = node.minItems ?? (node.maxItems === undefined ? undefined : 0)
    return { type: `array of ${inner.type}`, allowed: bounds(minimum, node.maxItems) || inner.allowed }
  }
  if (node.type === "object") return { type: "object", allowed: "" }
  return { type: String(node.type ?? "value"), allowed: bounds(node.minimum, node.maximum) }
}

function bounds(minimum: unknown, maximum: unknown): string {
  if (minimum === undefined && maximum === undefined) return ""
  return `${minimum ?? ""}..${maximum ?? ""}`
}

/** A Markdown table cell: the pipe is escaped so a value cannot start a new column. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|")
}

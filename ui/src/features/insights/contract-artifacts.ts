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

import { variableListSchema, variableValueSchema } from "./schema"

export { MAX_VARIABLE_LIST_ITEMS, MAX_VARIABLE_LIST_UNITS, variableInputSchema, variableListSchema } from "./schema"

/**
 * A dashboard variable's value: one string, or a list for a variable with several values. An empty list is All.
 * The Go twin is internal/insights/variablevalue; both apply the same bounds and list rules.
 */
export type VariableValue = string | string[]

/** The declaration fields that decide which values a variable accepts. */
export interface VariableDeclaration {
  multi?: boolean
  allowAll?: boolean
}

/**
 * Applies a variable's declaration to a value. A multi-value variable turns one string into a one-item list.
 * An empty list needs allowAll, since it means All. A single-value variable refuses a list.
 */
export function normalizeVariableValue(declaration: VariableDeclaration, raw: unknown): VariableValue {
  if (!declaration.multi) {
    if (Array.isArray(raw)) throw new Error("A list needs a variable with several values")
    return variableValueSchema.parse(raw)
  }
  if (typeof raw === "string") return [variableValueSchema.parse(raw)]
  const items = variableListSchema.parse(raw)
  if (items.length === 0 && !declaration.allowAll)
    throw new Error("An empty list means All; turn on Include All")
  return items
}

/**
 * The text of a single-value variable, for controls that only edit one string. A list has no single text, so it
 * reads as unset here. Multi-value controls use the list directly.
 */
export function singleValueText(value: VariableValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

/**
 * The values of a call that takes single strings only. Saved-query parameters take several values in a later
 * step; until then a list here is an error, not a silent choice.
 */
export function singleValues(values: Record<string, VariableValue>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => {
      if (typeof value !== "string") throw new Error(`Variable “${name}” takes one value here`)
      return [name, value]
    }),
  )
}

export function isAllValue(value: VariableValue): boolean {
  return Array.isArray(value) && value.length === 0
}

/** Equal values have the same text, or the same items in the same order. */
export function sameVariableValue(left: VariableValue, right: VariableValue): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right
  return left.length === right.length && left.every((item, index) => item === right[index])
}

/** Short text for a trigger or a summary: All, the single value, "a, b", or "a +N" past two items. */
export function formatVariableValue(value: VariableValue, allLabel = "All"): string {
  if (typeof value === "string") return value
  if (value.length === 0) return allLabel
  const joined = value.join(", ")
  if (joined.length <= 24) return joined
  return `${value[0]} +${value.length - 1}`
}

/** Escapes each item for a regex and joins them with |. The escaped set matches Go's regexp.QuoteMeta. */
export function regexAlternation(items: string[]): string {
  return items.map((item) => item.replace(/[\\.+*?()|[\]{}^$]/g, "\\$&")).join("|")
}

export type ListContext = "none" | "regex" | "negated" | "array"

/**
 * Classifies the template text before a placeholder. Trailing ASCII whitespace is ignored, so the rule
 * reads the same as listContextBefore in saved_query_schema.go.
 */
export function placeholderContext(template: string, index: number): ListContext {
  const before = template.slice(0, index).replace(/[ \t\n\r\f\v]+$/, "")
  if (before.endsWith("=~") || before.endsWith("|~")) return "regex"
  if (before.endsWith("!~")) return "negated"
  if (before.endsWith("[") || before.endsWith(",")) return "array"
  return "none"
}

/** The query text for a list value in a context. Matches dashboardListLiteral in the Go resolver. */
export function listLiteral(items: string[], context: ListContext): string {
  if (context === "regex" || context === "negated") {
    if (items.length === 0) {
      if (context === "negated") throw new Error("An All value cannot follow !~; it would exclude every value")
      return JSON.stringify(".+")
    }
    return JSON.stringify(regexAlternation(items))
  }
  if (context === "array") {
    if (items.length === 0) return "null"
    return `[${items.map((item) => JSON.stringify(item)).join(",")}]`
  }
  throw new Error("Query list values need =~, !~ or a SQL parameters array")
}

import { maskQueryParameters, type QueryEditorParameter } from "./query-editor-language"
import { assertProviderQueryTemplate, jsonObjectFragments } from "./provider-query-template"

export interface SQLQueryDraft {
  sql: string
  parameters: string
  projection: string
  envelope: boolean
  raw?: string
}

export function readSQLQuery(value: string, parameters: readonly QueryEditorParameter[] = []): SQLQueryDraft {
  if (!value.trimStart().startsWith("{")) return { sql: value, parameters: "[]", projection: "", envelope: false }
  try {
    const parsed = JSON.parse(maskQueryParameters(value, parameters))
    if (!parsed || typeof parsed.sql !== "string" || Object.keys(parsed).some(key => !["sql", "parameters", "projection"].includes(key))) throw new Error("Invalid SQL envelope")
    const fields = jsonObjectFragments(value)
    return { sql: parsed.sql, parameters: fields.get("parameters") ?? "[]", projection: fields.get("projection") ?? "", envelope: true }
  } catch { return { sql: "", parameters: "[]", projection: "", envelope: true, raw: value } }
}

export function writeSQLQuery(draft: SQLQueryDraft): string {
  if (draft.raw !== undefined) return draft.raw
  if (!draft.envelope && draft.parameters.trim() === "[]" && !draft.projection.trim()) return draft.sql
  return `{\n  "sql": ${JSON.stringify(draft.sql)},\n  "parameters": ${draft.parameters || "[]"}${draft.projection.trim() ? `,\n  "projection": ${draft.projection}` : ""}\n}`
}

export function sqlQueryIssue(draft: SQLQueryDraft, parameters: readonly QueryEditorParameter[] = [], records = false): string {
  if (draft.raw !== undefined) return "Use an SQL envelope with sql, parameters and an optional metric projection. Fix its JSON to return to the SQL editor."
  if (!draft.sql.trim()) return "Write an SQL SELECT statement before running or saving."
  if (/\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\}/.test(draft.sql)) return "Use $1, $2 and so on in SQL. Place typed {{parameters}} in the parameter array below."
  try { assertProviderQueryTemplate("postgresql", writeSQLQuery(draft)) }
  catch (error) { return error instanceof Error ? error.message : "SQL parameters need a fixed SQL body." }
  try {
    const values = JSON.parse(maskQueryParameters(draft.parameters || "[]", parameters))
    if (!Array.isArray(values) || values.length > 64 || values.some(value => value !== null && !["string", "number", "boolean"].includes(typeof value)))
      return "SQL parameters must be an array of up to 64 scalar values or typed placeholders."
  } catch { return "Complete the SQL parameter JSON array before running or saving." }
  if (draft.projection.trim()) {
    if (records) return "Record queries return their columns directly. Remove the metric projection."
    try {
      const projection = JSON.parse(draft.projection)
      if (!projection || typeof projection.value !== "string" || !projection.value || Object.keys(projection).some(key => !["value", "time", "labels"].includes(key)) || (projection.time !== undefined && typeof projection.time !== "string") || (projection.labels !== undefined && (!Array.isArray(projection.labels) || projection.labels.some((label: unknown) => typeof label !== "string"))))
        return "A metric projection needs a value column and optional time and label columns."
    } catch { return "Complete the SQL metric projection JSON before running or saving." }
  }
  return writeSQLQuery(draft).length > 8192 ? "The complete SQL query and bindings must fit 8,192 characters." : ""
}

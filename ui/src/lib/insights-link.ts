/**
 * A link to one Insights dashboard, with its variable values. It writes the same query string as
 * buildDashboardURL in features/insights/drilldown.ts, which the Insights page reads. This module
 * imports nothing, so the console does not load the Insights schema to build a link.
 */
export function insightsDashboardHref(id: string, variables: Record<string, string>): string {
  const search = new URLSearchParams({ dashboard: id })
  const entries = Object.entries(variables).sort(([left], [right]) => left.localeCompare(right))
  if (entries.length) search.set("vars", JSON.stringify(Object.fromEntries(entries)))
  return `/dashboard/insights/?${search}`
}

// The Insights schema's rules (features/insights/schema.ts), repeated so this module stays import-free.
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const RESERVED_NAMES = new Set(["__proto__", "prototype", "constructor"])
const MAX_VARIABLES = 20
const MAX_VALUE_LENGTH = 1024

/**
 * The Insights page in embed mode, showing one widget of a dashboard: the address an application page frames.
 * It is always this same-origin path, built only from a valid dashboard id, widget id and variables, so a value
 * from the server can never point the frame elsewhere. Returns undefined when any part is not valid.
 */
export function insightsEmbedHref(
  dashboardId: string,
  widgetId: string,
  variables: Record<string, string>,
  theme: "light" | "dark",
): string | undefined {
  if (!IDENTIFIER.test(dashboardId) || !IDENTIFIER.test(widgetId)) return undefined
  const entries = Object.entries(variables)
  if (entries.length > MAX_VARIABLES) return undefined
  for (const [name, value] of entries)
    if (!VARIABLE_NAME.test(name) || RESERVED_NAMES.has(name) || typeof value !== "string" || value.length > MAX_VALUE_LENGTH)
      return undefined
  const search = new URLSearchParams(insightsDashboardHref(dashboardId, variables).slice("/dashboard/insights/?".length))
  search.set("embed", widgetId)
  search.set("theme", theme)
  return `/dashboard/insights/?${search}`
}

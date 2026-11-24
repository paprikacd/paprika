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

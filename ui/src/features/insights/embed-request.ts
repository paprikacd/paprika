/**
 * The embed parameters of an Insights address: `embed` names one widget of the linked dashboard and `theme` the host
 * page's appearance. The rest of the view (dashboard, vars, range, refresh) is the ordinary URL-owned view.
 * This module imports nothing, so the Insights page reads it before it loads the workspace.
 */
export type EmbedRequest = {
  /** The widget id, or "" when the parameter is not a widget id. */
  widgetId: string
  /** The host page's appearance. Absent means the Insights appearance preference. */
  theme?: "light" | "dark"
}

// The same identifier rule as widget ids in schema.ts.
const WIDGET_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/

/** The embed request in a query string, or null for the ordinary Insights page. */
export function readEmbedRequest(search: string): EmbedRequest | null {
  const params = new URLSearchParams(search)
  const embed = params.getAll("embed")
  if (!embed.length) return null
  const widgetId = embed.length === 1 && WIDGET_ID.test(embed[0]) ? embed[0] : ""
  const theme = params.get("theme")
  return theme === "light" || theme === "dark" ? { widgetId, theme } : { widgetId }
}

// Instructions for an agent that edits a dashboard through the Paprika Observe MCP server. The agent returns
// widget_edits; Insights reviews them and applies them to the draft. Nothing is saved from here.
// No imports: the text is plain data for the clipboard and for a prefilled assistant link.

/** Longest prefilled link that is offered. Longer instructions are copied, not linked. */
export const AGENT_LINK_MAX = 6000

export interface AgentHandoffInput {
  id: string
  title: string
  request?: string
  /** The Observe MCP endpoint, when Observe is connected. */
  endpoint?: string
  /** The open draft, when it has unsaved changes. The agent edits this rather than the saved dashboard. */
  draft?: unknown
}

export interface AgentHandoff {
  text: string
  setupCommand?: string
  links: { label: string; href: string }[]
}

export function buildAgentHandoff({ id, title, request, endpoint, draft }: AgentHandoffInput): AgentHandoff {
  const lines = [
    // JSON quoting keeps a title with quotes or line breaks on one line.
    `Edit the Paprika Insights dashboard ${JSON.stringify(title)} (id: ${id}).`,
    endpoint ? `Use the Paprika Observe MCP server at ${endpoint}.` : "Use your Paprika Observe MCP server.",
    `Request: ${request?.trim() || "Improve the layout while keeping existing queries and providers."}`,
    `1. Read get_insights_schema (kind "dashboard" and "widget") and list_insights_providers.`,
    `2. Read get_dashboard with id "${id}".`,
    `3. Change only the widgets the request needs. Express each change as a widget_edits item: {"op":"update","id","patch"}, {"op":"add","widget"} or {"op":"remove","id"}. Use "patch" only for dashboard fields.`,
    `4. Check the merged dashboard with validate_dashboard and fix every error.`,
    `5. Do not call patch_dashboard or update_dashboard. Reply with one JSON object: {"id":"${id}","widget_edits":[…]}. I will review it in Insights.`,
  ]
  if (draft !== undefined)
    lines.push(`The open draft has unsaved changes. Edit this draft, not the saved dashboard:`, JSON.stringify(draft))
  const text = lines.join("\n")
  const href = `https://claude.ai/new?q=${encodeURIComponent(text)}`
  return {
    text,
    ...(endpoint ? { setupCommand: `claude mcp add --transport http paprika-observe ${endpoint}` } : {}),
    links: href.length <= AGENT_LINK_MAX ? [{ label: "Open in Claude", href }] : [],
  }
}

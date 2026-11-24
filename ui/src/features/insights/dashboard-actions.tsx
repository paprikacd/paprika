import { Braces, Clock3, History, Keyboard, Pencil, Settings2, Sparkles } from "lucide-react"
import type { GammaActionMenuItem } from "./gamma/action-menu"
import type { Dashboard } from "./schema"

export type DashboardPanelName = "manage" | "ai" | "source" | "history"

export interface DashboardActionState {
  /** Phone shell: the header holds one menu with every dashboard action. */
  phoneShell: boolean
  refreshInterval: Dashboard["refreshInterval"]
  /** A fixed custom range has no auto refresh; the radios are shown disabled. */
  customRange: boolean
  /** Revision history exists for this dashboard: saved dashboards on a host that serves it. */
  history?: boolean
}

export interface DashboardActionHandlers {
  edit: () => void
  /** Opens the panel, or closes it when it is already open. */
  togglePanel: (panel: DashboardPanelName) => void
  inspectQueries: () => void
  refresh: (refresh: Dashboard["refreshInterval"]) => void
  /** Opens the keyboard shortcut list. */
  shortcuts: () => void
}

const refreshOptions: readonly { value: Dashboard["refreshInterval"]; label: string }[] = [
  { value: 0, label: "Auto refresh off" },
  { value: 15, label: "Every 15 s" },
  { value: 30, label: "Every 30 s" },
  { value: 60, label: "Every 1 min" },
]

/**
 * The items of the Dashboard actions menu. Off the phone shell it keeps the Manage and Build with AI pair; on the
 * phone shell it holds every action, in groups, with Edit first.
 */
export function dashboardActionItems(
  state: DashboardActionState,
  handlers: DashboardActionHandlers,
): GammaActionMenuItem[] {
  if (!state.phoneShell) {
    return [
      ...(state.history ? [{ id: "history", label: "Revision history", icon: <History size={15} />, onSelect: () => handlers.togglePanel("history") }] : []),
      { id: "manage", label: "Manage dashboards", icon: <Settings2 size={15} />, onSelect: () => handlers.togglePanel("manage") },
      { id: "ai", label: "Build with AI", icon: <Sparkles size={15} />, onSelect: () => handlers.togglePanel("ai") },
      { id: "shortcuts", label: "Keyboard shortcuts", icon: <Keyboard size={15} />, onSelect: handlers.shortcuts },
    ]
  }
  const fixed = state.customRange ? "Fixed custom range" : undefined
  return [
    { id: "edit", group: "Dashboard", label: "Edit dashboard", icon: <Pencil size={15} />, onSelect: handlers.edit },
    { id: "code", group: "Dashboard", label: "Dashboard as code", icon: <Braces size={15} />, onSelect: () => handlers.togglePanel("source") },
    { id: "queries", group: "Dashboard", label: "Query inspector", icon: <Clock3 size={15} />, onSelect: handlers.inspectQueries },
    ...(state.history ? [{ id: "history", group: "Dashboard", label: "Revision history", icon: <History size={15} />, onSelect: () => handlers.togglePanel("history") }] : []),
    { id: "manage", group: "Workspace", label: "Manage dashboards", icon: <Settings2 size={15} />, onSelect: () => handlers.togglePanel("manage") },
    { id: "ai", group: "Workspace", label: "Build with AI", icon: <Sparkles size={15} />, onSelect: () => handlers.togglePanel("ai") },
    ...refreshOptions.map<GammaActionMenuItem>(option => ({
      id: `refresh-${option.value}`,
      group: "Auto refresh",
      label: option.label,
      description: fixed,
      disabled: state.customRange,
      selected: !state.customRange && state.refreshInterval === option.value,
      onSelect: () => handlers.refresh(option.value),
    })),
  ]
}

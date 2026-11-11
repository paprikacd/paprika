import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { buildDashboardURL, parseDashboardURL, type DashboardNavigation } from "./drilldown"

/**
 * What changed the URL-owned view. The action alone decides how browser history
 * records the change, so every view write names one of these.
 */
export type ViewAction =
  | "load"
  | "keep"
  | "prune"
  | "variables"
  | "selection"
  | "brush"
  | "range"
  | "reset"
  | "recover"
  | "navigate"
  | "popstate"

export type ViewHistory = "push" | "replace" | "none"

/**
 * The one place that decides push versus replace. Values match the workspace
 * before the view-state refactor; changing one changes that action everywhere.
 */
export const VIEW_HISTORY: Readonly<Record<ViewAction, ViewHistory>> = {
  // A link or example start rewrites its own canonical URL.
  load: "replace",
  // A link that could not be applied stays in the address bar as shared.
  keep: "none",
  // A removed declaration drops the values it owned.
  prune: "replace",
  variables: "replace",
  selection: "replace",
  brush: "replace",
  // The toolbar preset edits the document too; the URL only drops its fixed window.
  range: "replace",
  // A new, duplicated or deleted dashboard starts a fresh view.
  reset: "replace",
  // A failed Back or Forward rewrites the view that is still on screen.
  recover: "replace",
  // Opening another dashboard is a new history entry.
  navigate: "push",
  // Back and Forward already moved the browser to this entry.
  popstate: "none",
}

/** Reads the view from the current address. Throws for malformed or conflicting parameters. */
export function readDashboardView(): DashboardNavigation | null {
  return parseDashboardURL(location.search)
}

/** Serialises a view for the current Insights route. Throws when the view cannot be linked. */
export function serialiseDashboardView(state: DashboardNavigation, options: { example?: boolean } = {}): string {
  const path = /\/dashboard\/insights\/?$/.test(location.pathname) ? location.pathname : "/dashboard/insights/"
  return buildDashboardURL(state, path) + (options.example ? "&example=1" : "")
}

export interface DashboardViewWrite {
  /** Overrides the example flag the hook was given, for a write made before that flag has rendered. */
  example?: boolean
}

/**
 * Owns the URL writes and the in-memory view for the dashboard on screen. The
 * example flag is read from the render that last committed, so writes made from
 * event handlers and effects need no flag at the call site. Reading the address
 * (initial load, Back and Forward) stays with the caller, through readDashboardView.
 */
export function useDashboardView(dashboardId: string, example: boolean) {
  const [route, setRoute] = useState<DashboardNavigation | null>(null)
  const exampleMode = useRef(example)
  useLayoutEffect(() => { exampleMode.current = example })
  // Writes the address for an action without changing the in-memory view.
  const reflect = useCallback((state: DashboardNavigation, action: ViewAction, options: DashboardViewWrite = {}) => {
    const method = VIEW_HISTORY[action]
    if (method === "none") return
    const url = serialiseDashboardView(state, { example: options.example ?? exampleMode.current })
    if (method === "push") window.history.pushState(window.history.state, "", url)
    else window.history.replaceState(window.history.state, "", url)
  }, [])
  // Writes the address for an action, then makes the view current. A write that throws
  // leaves the view unchanged, so the caller decides what to show.
  const apply = useCallback((state: DashboardNavigation, action: ViewAction, options?: DashboardViewWrite) => {
    reflect(state, action, options)
    setRoute(state)
  }, [reflect])
  // Makes a view current without writing the address. Used when the address must keep the value it came from.
  const show = useCallback((state: DashboardNavigation) => setRoute(state), [])
  return {
    current: route?.dashboardId === dashboardId ? route : undefined,
    apply,
    reflect,
    show,
  }
}

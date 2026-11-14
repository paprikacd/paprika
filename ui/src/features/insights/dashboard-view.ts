import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { buildDashboardURL, parseDashboardLink, type DashboardNavigation, type ParsedDashboardLink } from "./drilldown"
import type { Dashboard } from "./schema"

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
  | "refresh"
  | "reset"
  | "recover"
  | "navigate"
  | "popstate"

export type ViewHistory = "push" | "replace" | "none"

/**
 * The one place that decides push versus replace, and the contract in drilldowns.md:
 * deliberate filter steps push a Back entry, view controls and corrections replace.
 * Changing one value changes that action everywhere it is written.
 */
export const VIEW_HISTORY: Readonly<Record<ViewAction, ViewHistory>> = {
  // A link or example start rewrites its own canonical URL.
  load: "replace",
  // A link that could not be applied stays in the address bar as shared.
  keep: "none",
  // A removed declaration drops the values it owned.
  prune: "replace",
  // Deliberate filter steps: each dropdown apply or Apply values is a Back step.
  variables: "push",
  // A clicked mark or row is a deliberate filter step too.
  selection: "push",
  // A dragged window is a deliberate step in the investigation.
  brush: "push",
  // The toolbar preset or custom window is view state, so it does not add a Back step.
  range: "replace",
  // The toolbar refresh interval is view state, so it does not add a Back step.
  refresh: "replace",
  // A new, duplicated or deleted dashboard starts a fresh view.
  reset: "replace",
  // A failed Back or Forward rewrites the view that is still on screen.
  recover: "replace",
  // Opening another dashboard is a new history entry.
  navigate: "push",
  // Back and Forward already moved the browser to this entry.
  popstate: "none",
}

/** Reads the link in the current address, including variables that could not be applied. */
export function readDashboardLink(): ParsedDashboardLink {
  return parseDashboardLink(location.search)
}

/** Reads the view from the current address. Throws for malformed or conflicting parameters. */
export function readDashboardView(): DashboardNavigation | null {
  return readDashboardLink().navigation
}

/**
 * The dashboard as this viewer sees it. A view time range or refresh interval overrides
 * the saved default for display only; the document itself is never changed by a view.
 */
export function viewedDashboard(dashboard: Dashboard, view: DashboardNavigation | undefined): Dashboard {
  const timed: Dashboard = view?.customTimeRange
    ? { ...dashboard, customTimeRange: view.customTimeRange }
    : view?.range
      ? { ...dashboard, timeRange: view.range, customTimeRange: undefined }
      : dashboard
  return view?.refresh === undefined ? timed : { ...timed, refreshInterval: view.refresh }
}

/** The auto refresh the toolbar shows: a fixed window pauses it, so the select reads off. */
export function shownRefreshInterval(viewed: Dashboard): Dashboard["refreshInterval"] {
  return viewed.customTimeRange ? 0 : viewed.refreshInterval
}

/** True when the view's time or refresh, as shown, would differ from the saved defaults in the document. */
export function viewDiffersFromDefaults(dashboard: Dashboard, viewed: Dashboard): boolean {
  return viewed.timeRange !== dashboard.timeRange ||
    shownRefreshInterval(viewed) !== shownRefreshInterval(dashboard) ||
    JSON.stringify(viewed.customTimeRange ?? null) !== JSON.stringify(dashboard.customTimeRange ?? null)
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
    // A step that leaves the address unchanged (re-picking the applied value) adds no Back entry.
    if (method === "push") {
      if (new URL(url, location.href).href !== location.href) window.history.pushState(window.history.state, "", url)
    } else window.history.replaceState(window.history.state, "", url)
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

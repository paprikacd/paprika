"use client"

import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { Dashboard, DashboardVariable, SavedQueryEntry } from "./schema"

/**
 * An Explorer opened from a chart: a trace search over a time range (milliseconds), such as a latency region's traces.
 * It lives here, not in explorer.tsx, so chart renderers that read this context never type-check the Explorer and its client.
 */
export interface ExplorerSeed { providerId: string; kind: "traces"; query: string; start: number; end: number }

export interface SavedQueryLibrary {
  queries: SavedQueryEntry[]
  variables: NonNullable<Dashboard["variables"]>
  values: Record<string, string>
  loading?: boolean
  error?: string
  /** Opens the Explorer. A seed opens it on a trace search over a range, such as a latency region's traces. */
  onOpenExplorer?: (seed?: ExplorerSeed) => void
  onRefresh?: () => Promise<void>
  /** Declares a variable on the dashboard being edited. Throws with the reason when the declaration is refused. */
  onDeclareVariable?: (variable: DashboardVariable) => void
  /** The dashboard the library's variables belong to. A link to this id can read them. */
  dashboardId?: string
}
const Context = createContext<SavedQueryLibrary>({ queries: [], variables: [], values: {} })
export function SavedQueryLibraryProvider({ children, queries, variables, values, loading, error, onOpenExplorer, onRefresh, onDeclareVariable, dashboardId }: SavedQueryLibrary & { children: ReactNode }) {
  const library = useMemo(() => ({ queries, variables, values, loading, error, onOpenExplorer, onRefresh, onDeclareVariable, dashboardId }), [queries, variables, values, loading, error, onOpenExplorer, onRefresh, onDeclareVariable, dashboardId])
  return <Context.Provider value={library}>{children}</Context.Provider>
}
export const useSavedQueryLibrary = () => useContext(Context)

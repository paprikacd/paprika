"use client"

import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { Dashboard, SavedQueryEntry } from "./schema"
import type { ExplorerSeed } from "./explorer"

export interface SavedQueryLibrary {
  queries: SavedQueryEntry[]
  variables: NonNullable<Dashboard["variables"]>
  values: Record<string, string>
  loading?: boolean
  error?: string
  /** Opens the Explorer. A seed opens it on a trace search over a range, such as a latency region's traces. */
  onOpenExplorer?: (seed?: ExplorerSeed) => void
  onRefresh?: () => Promise<void>
}
const Context = createContext<SavedQueryLibrary>({ queries: [], variables: [], values: {} })
export function SavedQueryLibraryProvider({ children, queries, variables, values, loading, error, onOpenExplorer, onRefresh }: SavedQueryLibrary & { children: ReactNode }) {
  const library = useMemo(() => ({ queries, variables, values, loading, error, onOpenExplorer, onRefresh }), [queries, variables, values, loading, error, onOpenExplorer, onRefresh])
  return <Context.Provider value={library}>{children}</Context.Provider>
}
export const useSavedQueryLibrary = () => useContext(Context)

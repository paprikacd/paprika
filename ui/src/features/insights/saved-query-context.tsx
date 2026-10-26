"use client"

import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { Dashboard, SavedQueryEntry } from "./schema"

export interface SavedQueryLibrary {
  queries: SavedQueryEntry[]
  variables: NonNullable<Dashboard["variables"]>
  values: Record<string, string>
  loading?: boolean
  error?: string
  onOpenExplorer?: () => void
  onRefresh?: () => Promise<void>
}
const Context = createContext<SavedQueryLibrary>({ queries: [], variables: [], values: {} })
export function SavedQueryLibraryProvider({ children, queries, variables, values, loading, error, onOpenExplorer, onRefresh }: SavedQueryLibrary & { children: ReactNode }) {
  const library = useMemo(() => ({ queries, variables, values, loading, error, onOpenExplorer, onRefresh }), [queries, variables, values, loading, error, onOpenExplorer, onRefresh])
  return <Context.Provider value={library}>{children}</Context.Provider>
}
export const useSavedQueryLibrary = () => useContext(Context)

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { InsightsClient } from "../client"
import { type Dashboard, type SavedQueryEntry } from "../schema"
import { dashboardUsesSavedQuery } from "../saved-queries"
import type { ExplorerSeed } from "../saved-query-context"
import type { AfterWorkspaceBackend } from "./types"

export function useSavedQueryLibrary(
  backend: AfterWorkspaceBackend["backend"],
  latestDocument: AfterWorkspaceBackend["latestDocument"],
  mode: AfterWorkspaceBackend["mode"],
) {
  const [dashboards, setDashboards] = useState<Dashboard[]>([])
  const [exploring, setExploring] = useState(false)
  const [inspectingQueries, setInspectingQueries] = useState(false)
  const [explorerOpened, setExplorerOpened] = useState(false)
  const [explorerSource, setExplorerSource] = useState<{ providerId?: string; seed?: ExplorerSeed; revision: number }>({ revision: 0 })
  const [explorerDirty, setExplorerDirty] = useState(false)
  const [savedQueries, setSavedQueries] = useState<SavedQueryEntry[]>([])
  const [queriesLoading, setQueriesLoading] = useState(true)
  const [queriesLoaded, setQueriesLoaded] = useState(false)
  const [queriesError, setQueriesError] = useState("")
  const [libraryRevision, setLibraryRevision] = useState(0)
  const libraryMutation = useRef(0)
  const updateSavedQueries = useCallback((entries: SavedQueryEntry[]) => {
    libraryMutation.current++
    setSavedQueries(entries)
    setQueriesLoading(false)
    setQueriesError("")
  }, [])
  const libraryClient = useMemo<InsightsClient>(() => {
    const scoped = backend.savedQueries(() => latestDocument.current)
    return { ...scoped, removeSavedQuery: async (id, etag) => {
      if (dashboardUsesSavedQuery(latestDocument.current, id))
        throw new Error("This saved query is used by the current dashboard. Switch its widgets to custom queries before deleting it.")
      return scoped.removeSavedQuery(id, etag)
    } }
  }, [backend, latestDocument])
  useEffect(() => {
    if (mode !== "live" && mode !== "example") return
    const controller = new AbortController()
    const generation = libraryMutation.current
    queueMicrotask(() => { if (!controller.signal.aborted && generation === libraryMutation.current) { setQueriesLoading(true); setQueriesError("") } })
    libraryClient.listSavedQueries(controller.signal).then(entries => {
      if (!controller.signal.aborted && generation === libraryMutation.current) { setSavedQueries(entries); setQueriesLoading(false); setQueriesLoaded(true) }
    }, reason => {
      if (!controller.signal.aborted && generation === libraryMutation.current) { setQueriesLoading(false); setQueriesError(reason instanceof Error ? reason.message : "Saved queries are unavailable.") }
    })
    return () => controller.abort()
  }, [libraryClient, mode, libraryRevision])
  return [
    dashboards,
    explorerDirty,
    explorerOpened,
    explorerSource,
    exploring,
    inspectingQueries,
    libraryClient,
    libraryMutation,
    queriesError,
    queriesLoaded,
    queriesLoading,
    savedQueries,
    setDashboards,
    setExplorerDirty,
    setExplorerOpened,
    setExplorerSource,
    setExploring,
    setInspectingQueries,
    setLibraryRevision,
    setQueriesError,
    setQueriesLoaded,
    updateSavedQueries,
  ] as const
}

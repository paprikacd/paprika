/* eslint-disable react-hooks/immutability -- code moved verbatim from InsightsWorkspace, which the React Compiler lint skips; its ref and setter patterns are reviewed there, not rewritten in a move */
import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { documentFingerprint } from "../fingerprint"
import { sameSyncInputs, useWorkspaceRefresh } from "../use-workspace-refresh"
import { resolveDashboardVariables, type VariableValues } from "../drilldown"
import { viewDiffersFromDefaults, viewedDashboard } from "../dashboard-view"
import type { AfterSourceCatalog } from "./types"

export function useLiveSync(
  applyView: AfterSourceCatalog["applyView"],
  busy: AfterSourceCatalog["busy"],
  client: AfterSourceCatalog["client"],
  currentRoute: AfterSourceCatalog["currentRoute"],
  dashboard: AfterSourceCatalog["dashboard"],
  dashboards: AfterSourceCatalog["dashboards"],
  editing: AfterSourceCatalog["editing"],
  etags: AfterSourceCatalog["etags"],
  explorerDirty: AfterSourceCatalog["explorerDirty"],
  importingBundle: AfterSourceCatalog["importingBundle"],
  lastSyncInputs: AfterSourceCatalog["lastSyncInputs"],
  libraryMutation: AfterSourceCatalog["libraryMutation"],
  mode: AfterSourceCatalog["mode"],
  openRequest: AfterSourceCatalog["openRequest"],
  panel: AfterSourceCatalog["panel"],
  queriesLoading: AfterSourceCatalog["queriesLoading"],
  reset: AfterSourceCatalog["reset"],
  saved: AfterSourceCatalog["saved"],
  savedQueries: AfterSourceCatalog["savedQueries"],
  setDashboards: AfterSourceCatalog["setDashboards"],
  setQueriesError: AfterSourceCatalog["setQueriesError"],
  setQueriesLoaded: AfterSourceCatalog["setQueriesLoaded"],
  setRemoteDashboard: AfterSourceCatalog["setRemoteDashboard"],
  setSaved: AfterSourceCatalog["setSaved"],
  updateSavedQueries: AfterSourceCatalog["updateSavedQueries"],
) {
  const dirty = saved !== documentFingerprint(dashboard)
  const liveSyncState = useRef({ dashboards, savedQueries, dashboard, saved, dirty, editing, explorerDirty, panel, busy, importingBundle, queriesLoading })
  useLayoutEffect(() => {
    liveSyncState.current = { dashboards, savedQueries, dashboard, saved, dirty, editing, explorerDirty, panel, busy, importingBundle, queriesLoading }
  })
  const syncError = useWorkspaceRefresh(mode === "live", async signal => {
    const before = liveSyncState.current
    if (before.busy || before.importingBundle || before.queriesLoading) return
    const request = openRequest.current
    const generation = libraryMutation.current
    const [documents, entries] = await Promise.all([client.list(signal), client.listSavedQueries(signal)])
    const listed = documents.find(item => item.id === before.dashboard.id)
    const active = listed ? await client.get(listed.id, signal) : undefined
    const current = liveSyncState.current
    // A list request started before a save/import/navigation must never restore
    // its older snapshot, even if the write finished while the request ran.
    if (signal.aborted || request !== openRequest.current || generation !== libraryMutation.current ||
      current.busy || current.importingBundle || current.queriesLoading ||
      current.saved !== before.saved || current.dashboards !== before.dashboards || current.savedQueries !== before.savedQueries) return
    // Every input the reconcile reads. A 304 for the list and the open document hands back the same objects,
    // so an unchanged workspace is recognised here without fingerprinting it again.
    const inputs = [documents, entries, active, current.dashboards, current.savedQueries, current.saved, current.dirty, current.editing, current.explorerDirty, current.panel, current.dashboard.id, etags.current.get(current.dashboard.id)]
    if (sameSyncInputs(lastSyncInputs.current, inputs)) {
      setQueriesLoaded(true)
      setQueriesError("")
      return
    }
    lastSyncInputs.current = inputs
    const nextDocuments = active
      ? documents.map(item => item.id === active.dashboard.id ? active.dashboard : item)
      : documents
    if (documentFingerprint(nextDocuments) !== documentFingerprint(current.dashboards)) setDashboards(nextDocuments)
    if (documentFingerprint(entries) !== documentFingerprint(current.savedQueries)) updateSavedQueries(entries)
    setQueriesLoaded(true)
    setQueriesError("")
    if (active && (documentFingerprint(active.dashboard) !== current.saved || active.etag !== etags.current.get(active.dashboard.id))) {
      if (current.dirty || current.editing || current.explorerDirty || current.panel) {
        setRemoteDashboard({ id: active.dashboard.id, removed: false })
      } else {
        if (active.etag) etags.current.set(active.dashboard.id, active.etag)
        else etags.current.delete(active.dashboard.id)
        if (documentFingerprint(active.dashboard) !== current.saved) {
          reset(active.dashboard)
          setSaved(documentFingerprint(active.dashboard))
        }
        setRemoteDashboard(undefined)
      }
    } else if (!listed && etags.current.has(current.dashboard.id)) {
      setRemoteDashboard({ id: current.dashboard.id, removed: true })
    } else setRemoteDashboard(undefined)
  })
  // The view's time range and refresh override the saved defaults for display; the document stays as saved.
  const viewDashboard = useMemo(() => viewedDashboard(dashboard, currentRoute), [dashboard, currentRoute])
  const viewDiffers = editing && viewDiffersFromDefaults(dashboard, viewDashboard)
  const saveButton = useRef<HTMLButtonElement>(null)
  // Edit chosen from the phone menu moves focus to the title field, which also announces the edit state.
  const titleField = useRef<HTMLInputElement>(null)
  const focusTitleOnEdit = useRef(false)
  useLayoutEffect(() => {
    if (!editing || !focusTitleOnEdit.current) return
    focusTitleOnEdit.current = false
    titleField.current?.focus()
  }, [editing])
  // Definitions can be removed while editing. Stale view overrides must not
  // make an otherwise valid document impossible to edit.
  const variableKey = JSON.stringify(resolveDashboardVariables(dashboard, Object.fromEntries(
    Object.entries(currentRoute?.variables ?? {}).filter(([name]) => dashboard.variables?.some(item => item.name === name)),
  )))
  const variableValues = useMemo(() => JSON.parse(variableKey) as VariableValues, [variableKey])
  useEffect(() => {
    if (!currentRoute?.variables) return
    const entries = Object.entries(currentRoute.variables)
    const retained = entries.filter(([name]) => dashboard.variables?.some(item => item.name === name))
    if (retained.length === entries.length) return
    let active = true
    queueMicrotask(() => {
      if (!active) return
      applyView({ ...currentRoute, variables: Object.fromEntries(retained) }, "prune")
    })
    return () => { active = false }
  }, [currentRoute, dashboard.variables, applyView])
  return [
    dirty,
    focusTitleOnEdit,
    saveButton,
    syncError,
    titleField,
    variableValues,
    viewDashboard,
    viewDiffers,
  ] as const
}

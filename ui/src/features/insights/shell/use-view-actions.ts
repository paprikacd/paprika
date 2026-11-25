/* eslint-disable react-hooks/immutability -- code moved verbatim from InsightsWorkspace, which the React Compiler lint skips; its ref and setter patterns are reviewed there, not rewritten in a move */
import { useCallback } from "react"
import type { InsightsClient } from "../client"
import { dashboardAsSent } from "../layout-compaction"
import { newDashboard, writableDashboard, type Dashboard, type Provider } from "../schema"
import { loadBundleImportReview, type BundleImportRequest } from "../bundle-import"
import type { DashboardBundle } from "../workspace-transfer"
import { documentFingerprint } from "../fingerprint"
import type { ExplorerSeed } from "../saved-query-context"
import { type TimeRangeChoice } from "../time-range"
import { resolveDashboardVariables, type DashboardNavigation } from "../drilldown"
import type { AfterDocumentActions } from "./types"

export function useViewActions(
  advanceEnd: AfterDocumentActions["advanceEnd"],
  applyView: AfterDocumentActions["applyView"],
  backend: AfterDocumentActions["backend"],
  bundleImportActive: AfterDocumentActions["bundleImportActive"],
  bundleImporter: AfterDocumentActions["bundleImporter"],
  busy: AfterDocumentActions["busy"],
  client: AfterDocumentActions["client"],
  close: AfterDocumentActions["close"],
  confirmDiscard: AfterDocumentActions["confirmDiscard"],
  confirmation: AfterDocumentActions["confirmation"],
  currentRoute: AfterDocumentActions["currentRoute"],
  dashboard: AfterDocumentActions["dashboard"],
  dashboards: AfterDocumentActions["dashboards"],
  dirty: AfterDocumentActions["dirty"],
  editing: AfterDocumentActions["editing"],
  enterEdit: AfterDocumentActions["enterEdit"],
  etags: AfterDocumentActions["etags"],
  exitEdit: AfterDocumentActions["exitEdit"],
  explorerDirty: AfterDocumentActions["explorerDirty"],
  importingBundle: AfterDocumentActions["importingBundle"],
  latestDocument: AfterDocumentActions["latestDocument"],
  libraryClient: AfterDocumentActions["libraryClient"],
  libraryMutation: AfterDocumentActions["libraryMutation"],
  openRequest: AfterDocumentActions["openRequest"],
  panel: AfterDocumentActions["panel"],
  panelOpener: AfterDocumentActions["panelOpener"],
  providers: AfterDocumentActions["providers"],
  reset: AfterDocumentActions["reset"],
  saveButton: AfterDocumentActions["saveButton"],
  setBusy: AfterDocumentActions["setBusy"],
  setDashboards: AfterDocumentActions["setDashboards"],
  setError: AfterDocumentActions["setError"],
  setExplorerDirty: AfterDocumentActions["setExplorerDirty"],
  setExplorerOpened: AfterDocumentActions["setExplorerOpened"],
  setExplorerSource: AfterDocumentActions["setExplorerSource"],
  setExploring: AfterDocumentActions["setExploring"],
  setImportingBundle: AfterDocumentActions["setImportingBundle"],
  setLibraryRevision: AfterDocumentActions["setLibraryRevision"],
  setLinkNotice: AfterDocumentActions["setLinkNotice"],
  setMessage: AfterDocumentActions["setMessage"],
  setMobileSidebar: AfterDocumentActions["setMobileSidebar"],
  setQueryRevision: AfterDocumentActions["setQueryRevision"],
  setRemoteDashboard: AfterDocumentActions["setRemoteDashboard"],
  setReturnTo: AfterDocumentActions["setReturnTo"],
  setSaved: AfterDocumentActions["setSaved"],
  showPanel: AfterDocumentActions["showPanel"],
  update: AfterDocumentActions["update"],
  updateSavedQueries: AfterDocumentActions["updateSavedQueries"],
  viewDashboard: AfterDocumentActions["viewDashboard"],
  widgetDraftDirty: AfterDocumentActions["widgetDraftDirty"],
) {
  // View controls write the URL view only. They never edit the document or enter edit mode.
  function changeViewRange(choice: TimeRangeChoice): boolean {
    try {
      const view: DashboardNavigation = choice.customTimeRange
        ? { ...currentRoute, dashboardId: dashboard.id, range: undefined, customTimeRange: choice.customTimeRange }
        : { ...currentRoute, dashboardId: dashboard.id, range: choice.timeRange, customTimeRange: undefined }
      applyView(view, "range")
      advanceEnd(false)
      setError("")
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the time range")
      return false
    }
  }
  // Returns the view to the saved window: the URL drops its range and the refresh and variables stay as they are.
  function resetViewRange() {
    try {
      applyView({ ...currentRoute, dashboardId: dashboard.id, range: undefined, customTimeRange: undefined }, "range")
      advanceEnd(false)
      setError("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reset the time range")
    }
  }
  function applyDashboardVariables(values: Parameters<typeof resolveDashboardVariables>[1]) {
    try {
      applyView({ ...currentRoute, dashboardId: dashboard.id, variables: resolveDashboardVariables(dashboard, values) }, "variables")
      setError("")
    } catch (error) { setError(error instanceof Error ? error.message : "Invalid variable values") }
  }
  function changeViewRefresh(refresh: Dashboard["refreshInterval"]) {
    try {
      applyView({ ...currentRoute, dashboardId: dashboard.id, refresh }, "refresh")
      setError("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change auto refresh")
    }
  }
  // The one explicit path from a view to the saved dashboard: copy what is on screen into the draft.
  function setViewAsDefault() {
    update({
      ...dashboard,
      timeRange: viewDashboard.timeRange,
      customTimeRange: viewDashboard.customTimeRange,
      // Refresh does not apply to a fixed window, so the saved interval stays as the author set it.
      refreshInterval: viewDashboard.customTimeRange ? dashboard.refreshInterval : viewDashboard.refreshInterval,
    })
    setError("")
    setMessage("View set as the dashboard default. Save the dashboard to keep it.")
    // The button leaves the toolbar once the view matches the draft; focus moves to the next step, Save.
    saveButton.current?.focus()
  }
  function resetView(next: Dashboard) {
    applyView({ dashboardId: next.id }, "reset")
    setReturnTo(null)
    setLinkNotice("")
  }
  async function reloadRemoteDashboard() {
    if (busy || importingBundle) return
    const id = dashboard.id
    const request = ++openRequest.current
    const before = documentFingerprint(dashboard)
    if ((dirty || editing || panel) && !await confirmDiscard()) return
    if (request !== openRequest.current) return
    setBusy(true)
    setError("")
    try {
      const active = await client.get(id)
      if (request !== openRequest.current || latestDocument.current.id !== id) return
      if (documentFingerprint(latestDocument.current) !== before)
        throw new Error("Your draft changed while the saved dashboard was loading. Load it again when you are ready.")
      if (active.etag) etags.current.set(id, active.etag)
      else etags.current.delete(id)
      reset(active.dashboard)
      setSaved(documentFingerprint(active.dashboard))
      setDashboards(items => [...items.filter(item => item.id !== id), active.dashboard])
      exitEdit()
      setRemoteDashboard(undefined)
      close()
      setMessage("Loaded the latest saved dashboard.")
    } catch (reason) {
      if (request === openRequest.current) setError(reason instanceof Error ? reason.message : "Could not load the saved dashboard.")
    } finally { setBusy(false) }
  }

  async function createDashboard() {
    if (bundleImportActive.current) return
    const request = ++openRequest.current
    if ((dirty || widgetDraftDirty) && !await confirmDiscard()) return
    if (request !== openRequest.current) return
    const next = newDashboard()
    setExploring(false)
    resetView(next)
    reset(next)
    setSaved("")
    enterEdit()
    close()
    panelOpener.current = undefined
    showPanel("add")
    setMessage("")
    setMobileSidebar(false)
  }

  function duplicateDashboard() {
    if (bundleImportActive.current) return
    ++openRequest.current
    const copy = writableDashboard({
      ...dashboard,
      id: `dashboard-${crypto.randomUUID()}`,
      title: `${dashboard.title.slice(0, 113)} (copy)`,
    })
    resetView(copy)
    reset(copy)
    setSaved("")
    enterEdit()
    close()
    setMessage("Dashboard duplicated. Save it to add the copy to your library.")
  }

  async function deleteDashboard() {
    if (busy) return
    const request = ++openRequest.current
    if (
      !await confirmation.ask({ title: "Delete dashboard?", description: `Delete “${dashboard.title}” from the workspace? This cannot be undone.`, action: "Delete dashboard" })
    )
      return
    if (request !== openRequest.current) return
    const id = dashboard.id
    setBusy(true)
    setError("")
    try {
      const remaining = dashboards.filter((item) => item.id !== id)
      await backend.remove(id, remaining, etags.current.get(id))
      etags.current.delete(id)
      setDashboards((items) => items.filter((item) => item.id !== id))
      if (request !== openRequest.current) return
      // An example opens the next stored dashboard; live, the workspace starts a new draft.
      const stored = backend.afterDelete(remaining)
      const next = stored ?? newDashboard()
      ++openRequest.current
      resetView(next)
      reset(next)
      setSaved(stored ? documentFingerprint(next) : "")
      enterEdit()
      close()
      setMessage("Dashboard deleted.")
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not delete dashboard.",
      )
    } finally {
      setBusy(false)
    }
  }

  async function moveDashboard(id: string, folder?: string) {
    if (busy) return
    if (id === dashboard.id) {
      update({ ...dashboard, folder })
      enterEdit()
      setMessage("Dashboard moved. Save to keep its new location.")
      return
    }
    const existing = dashboards.find((item) => item.id === id)
    if (!existing || existing.folder === folder) return
    setBusy(true)
    setError("")
    try {
      const loaded = await backend.load(existing)
      const moved = dashboardAsSent(writableDashboard({ ...loaded.dashboard, folder }))
      const etag = await backend.move(moved, dashboards, dashboard.id, loaded.etag)
      if (etag) etags.current.set(id, etag)
      setDashboards((items) =>
        items.map((item) => (item.id === id ? moved : item)),
      )
      setMessage(`Moved ${moved.title} to ${folder || "workspace root"}.`)
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not move dashboard.",
      )
    } finally {
      setBusy(false)
    }
  }

  const refreshSavedQueries = useCallback(async () => {
    const generation = libraryMutation.current
    const entries = await libraryClient.listSavedQueries()
    if (generation === libraryMutation.current) updateSavedQueries(entries)
  }, [libraryClient, updateSavedQueries, libraryMutation])

  // A seeded open (a chart's trace search) remounts the Explorer on that seed. Unsaved explorer work is confirmed first, as a provider switch is.
  const openQueryExplorer = useCallback((seed?: ExplorerSeed) => {
    const open = () => {
      if (seed) setExplorerSource(previous => ({ providerId: seed.providerId, seed, revision: previous.revision + 1 }))
      setExplorerOpened(true)
      setExploring(true)
      setMobileSidebar(false)
      setLibraryRevision(value => value + 1)
    }
    if (!seed || !explorerDirty) return open()
    void confirmation.ask({
      title: "Discard query changes?",
      description: "Your unsaved query changes will be lost. Saved queries will remain unchanged.",
      action: "Discard changes",
    }).then(confirmed => { if (confirmed) { setExplorerDirty(false); open() } })
  }, [confirmation, explorerDirty, setExplorerDirty, setExplorerOpened, setExplorerSource, setExploring, setLibraryRevision, setMobileSidebar])

  async function exploreProvider(provider: Provider) {
    if (explorerDirty && !await confirmation.ask({
      title: "Discard query changes?",
      description: "Your unsaved query changes will be lost. Saved queries will remain unchanged.",
      action: "Discard changes",
    })) return
    setExplorerSource(previous => ({ providerId: provider.id, revision: previous.revision + 1 }))
    setExplorerDirty(false)
    close()
    openQueryExplorer()
  }

  // Sample data keeps no revisions. A host that predates revision history serves no listing.
  const historyAvailable = backend.revisions
  // A restored revision is the saved document now: the canvas, the saved fingerprint and the ETag all move to it.
  function applyRestoredDocument(restored: Dashboard, etag?: string) {
    if (etag) etags.current.set(restored.id, etag)
    else etags.current.delete(restored.id)
    setDashboards(items => [...items.filter(item => item.id !== restored.id), restored])
    reset(restored)
    setSaved(documentFingerprint(restored))
    setQueryRevision(value => value + 1)
    setMessage("Dashboard restored from an earlier revision.")
  }
  function importClient(): InsightsClient {
    return backend.importClient(libraryClient)
  }

  async function reviewBundle(bundle: DashboardBundle) {
    return loadBundleImportReview(bundle, importClient())
  }

  async function importBundle(request: BundleImportRequest) {
    if (busy || bundleImportActive.current) throw new Error("Wait for the current save before importing dashboards.")
    if (dirty && request.dashboardChoices?.[dashboard.id] === "replace")
      throw new Error("This dashboard has unsaved edits. Save them or open another dashboard before replacing its saved version.")
    const activeFingerprint = documentFingerprint(latestDocument.current)
    bundleImportActive.current = true
    ++openRequest.current
    setImportingBundle(true)
    setBusy(true)
    try {
      return await bundleImporter.current!(request, {
        client: importClient(), providers, dashboards,
        onQueriesChange: updateSavedQueries,
        onDashboardSaved: (document, etag) => {
          const editedDuringImport = document.id === dashboard.id && documentFingerprint(latestDocument.current) !== activeFingerprint
          if (etag && !editedDuringImport) etags.current.set(document.id, etag)
          setDashboards(items => [...items.filter(item => item.id !== document.id), document])
          if (editedDuringImport) {
            setError("The saved dashboard was replaced. Your newer local edits are retained; open another dashboard and return to load the replacement, or duplicate your draft.")
          } else if (document.id === dashboard.id) {
            reset(document)
            setSaved(documentFingerprint(document))
            setQueryRevision(value => value + 1)
            setMessage("Dashboard replaced with the reviewed import.")
          }
        },
      })
    } finally { bundleImportActive.current = false; setImportingBundle(false); setBusy(false) }
  }
  return [
    applyDashboardVariables,
    applyRestoredDocument,
    changeViewRange,
    changeViewRefresh,
    createDashboard,
    deleteDashboard,
    duplicateDashboard,
    exploreProvider,
    historyAvailable,
    importBundle,
    moveDashboard,
    openQueryExplorer,
    refreshSavedQueries,
    reloadRemoteDashboard,
    resetViewRange,
    reviewBundle,
    setViewAsDefault,
  ] as const
}

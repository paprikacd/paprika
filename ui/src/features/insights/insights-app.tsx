"use client"

import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import "react-dom"
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Braces,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Database,
  FilePlus2,
  LayoutDashboard,
  LayoutTemplate,
  LineChart,
  Link2,
  Loader2,
  PanelLeftClose,
  PanelTop,
  Pencil,
  Plus,
  Redo2,
  RefreshCw,
  Save,
  Search,
  History,
  Sparkles,
  Settings2,
  Undo2,
  X,
} from "lucide-react"
import { GammaActionMenu } from "./gamma/action-menu"
import { verticalCompactor, type Layout } from "react-grid-layout"
import type { InsightsClient } from "./client"
import { dashboardAsSent } from "./layout-compaction"
import {
  customTimeRangeSchema,
  newDashboard,
  newWidget,
  writableDashboard,
  MAX_WIDGETS,
  type Dashboard,
  type Widget,
  type Provider,
  isApplicationLink,
  type WidgetLink,
  type QueryRequest,
  type SavedQuery,
  type DashboardVariable,
  dashboardSchema,
  MAX_DASHBOARD_VARIABLES,
} from "./schema"
import "./example"
import {
  createExampleDashboardImportClient,
  EXAMPLE_STORAGE_KEY,
  saveExampleWorkspace,
  writeExampleWorkspace,
} from "./example-storage"
import { assertProviderQueryTemplate } from "./provider-query-template"
import catalogMeta from "./repository-examples/catalog-meta.json"
import { LazyFailure, LazyPanelBoundary, MountSignal, reloadPage } from "./lazy-panel"
import { WidgetEditorSkeleton } from "./widget-editor-skeleton"
import { SavedQueryLibraryProvider } from "./saved-query-context"
import { queryConnectionKey, type QueryFieldSnapshot } from "./query-connections"
import "./saved-query-storage"
import { createBundleImporter, loadBundleImportReview, type BundleImportRequest } from "./bundle-import"
import { resolveSavedQueryReference } from "./saved-queries"
import type { DashboardBundle } from "./workspace-transfer"
import { documentFingerprint } from "./fingerprint"
import "./use-mobile-navigation"
import { dashboardActionItems } from "./dashboard-actions"
import { useBuilderPanelFocus } from "./use-builder-panel-focus"
import type { ExplorerSeed } from "./saved-query-context"
import "./history"
import { isApplePlatform, useInsightsShortcuts, type ChartCommands } from "./use-insights-shortcuts"
import { ariaKeyshortcutsFor, hintFor, OVERLAY_SELECTOR } from "./shortcuts"
import { sameSyncInputs, useWorkspaceRefresh } from "./use-workspace-refresh"
import { DashboardCanvas, type WidgetResultSnapshot } from "./canvas"
import { EmbedView } from "./embed-view"
import type { EmbedRequest } from "./embed-request"
import { refreshStaggerSpread } from "./refresh-stagger"

import { visibleTileControl } from "./tile-controls"
import "./canvas-density"
import { builderPanelPlan } from "./responsive-layout"
import { createQueryScheduler, createResolvedQueryFetcher } from "./query"
import { DashboardTree } from "./dashboard-library"
import { applyChartToDashboard } from "./chart-apply"
import { TimeRangeControl, alignedDashboardEnd, dashboardRange, savedRangeLabel, type TimeRangeChoice } from "./time-range"
import { WidgetLibrary } from "./widget-library"
import type { WidgetDefinition } from "./widget-registry"
import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge"
import styles from "./insights.module.css"
import { checksFromError, loadProviderCatalog, type ProviderCatalog } from "./client"
import { SourceStatusContext, sourceWaitMessage, type SourceStatus } from "./source-status"
import { GammaButton } from "./gamma/button"
import { GammaInput } from "./gamma/input"
import { GammaSelect } from "./gamma/select"
import { GammaConfirmation } from "./gamma/confirmation"
import { lockBodyScroll } from "./gamma/scroll-lock"
import gammaTheme from "./gamma/gamma-theme.module.css"
import { PhoneVariables, VariableBar } from "./dashboard-variables"
import { ClampedDescription } from "./dashboard-description"
import { sourceQueryStep, variableValueScope, type VariableValueLoaders } from "./variable-options"
import type { VariableSourceCatalog } from "./variable-source-editor"
import { InsightsThemeControl } from "./insights-theme"
import { describeIgnoredLink, resolveDashboardVariables, resolveApplicationLink, resolveDrilldown, resolveLinkView, resolveSelectionBindings, interpolateQuery, type DashboardNavigation, type DrilldownContext, type VariableValues } from "./drilldown"
import { duplicateLayout, savedLayout } from "./layout-edit"

import { readDashboardLink, serialiseDashboardView, viewDiffersFromDefaults, viewTimeDiffers, viewedDashboard } from "./dashboard-view"
import { RepositoryWorkspace, DashboardHistory, Explorer, ShortcutList, QueryInspector, DocumentEditor, ProviderManager, DashboardManager, ChecksList, AIBuilder, WidgetEditor, RepositoryGallery, StarterPicker, loadRepositoryWorkspace, preloadWidgetEditor, preloadExamples } from "./shell/lazy-panels"
import { placementPhrase, initialNavigation, panelOpenerElement } from "./shell/navigation"
import { type SourceState, sourceBannerCopy, sourceFailureReason, sharedFailureReason } from "./shell/source-catalog"
import "./shell/media-stores"
import { MANUAL_REFRESH_BYPASS_MS, NO_VARIABLES, UNAPPLIED_CHART_NOTICE } from "./shell/constants"
import { useWorkspace } from "./shell/use-workspace"
import { useSavedQueryLibrary } from "./shell/use-saved-query-library"
import { useDashboardSession } from "./shell/use-dashboard-session"
import { useShellLayout } from "./shell/use-shell-layout"


registerDefaultWidgetPlugins()

export interface InsightsAppProps {
  client: InsightsClient
  initialExample?: boolean
  onBack?: () => void
  /** Changes when the host renews its session; a sign-in banner reloads its sources on a change. */
  sessionRevision?: number
  /** The signed-in principal, stable across token renewals. Variable values are cached per principal. */
  principal?: string
  /** Opens the Paprika application page. Without it, an application link reports that it opens from the console. */
  onOpenApplication?: (ref: { namespace: string; name: string }) => void
  /** Embed mode: one widget of the linked dashboard, read-only, with none of the workspace around it. */
  embed?: EmbedRequest | null
}


export default function InsightsApp({ embed, ...props }: InsightsAppProps) {
  // Embed mode is decided before the workspace mounts, so a frame runs none of the workspace's loads or effects.
  return embed ? <EmbedView client={props.client} embed={embed} /> : <InsightsWorkspace {...props} />
}

function InsightsWorkspace({
  sessionRevision,
  principal,
  client,
  initialExample = false,
  onBack,
  onOpenApplication,
}: Omit<InsightsAppProps, "embed">) {
  const [
    activeExample,
    canRedo,
    canUndo,
    dashboard,
    editorMounted,
    endGroup,
    exampleGeneration,
    exampleStarting,
    galleryMounted,
    latestDocument,
    markEditorMounted,
    markGalleryMounted,
    markManageMounted,
    markProvidersMounted,
    markSourceMounted,
    mode,
    mounted,
    mountedPanels,
    providers,
    redo,
    reset,
    resolvedTheme,
    setExampleStarting,
    setMode,
    setProviders,
    setTheme,
    setUnsupportedProviders,
    setWorkspace,
    setWorkspaceFailed,
    theme,
    undo,
    unsupportedProviders,
    update,
    workspace,
    workspaceFailed,
  ] = useWorkspace()
  const [
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
  ] = useSavedQueryLibrary(
    activeExample,
    client,
    latestDocument,
    mode,
  )
  const [
    applyView,
    busy,
    currentRoute,
    editing,
    error,
    importingBundle,
    invalidWidgetSaveHintId,
    linkNotice,
    message,
    messageAction,
    panel,
    reflectView,
    remoteDashboard,
    returnTo,
    saveFindings,
    saved,
    selected,
    setBusy,
    setEditing,
    setError,
    setImportingBundle,
    setLinkNotice,
    setMessage,
    setMessageAction,
    setPanel,
    setRemoteDashboard,
    setReturnTo,
    setSaveFindings,
    setSaved,
    setSelected,
    setShortcutsOpen,
    setWidgetDraftDirty,
    setWidgetDraftValid,
    setWidgetPreview,
    shortcutsOpen,
    showView,
    widgetDraftDirty,
    widgetDraftValid,
    widgetOpener,
    widgetPreview,
  ] = useDashboardSession(
    dashboard,
    mode,
  )
  const [
    canvasMode,
    compactNavigationExpanded,
    compactShell,
    confirmation,
    dense,
    drawerOpen,
    finePointer,
    isMobile,
    layoutRoot,
    mobileSidebar,
    navigation,
    navigationToggle,
    panelHidden,
    panelOpener,
    phoneViewport,
    planRevision,
    search,
    setCanvasMode,
    setCompactNavigationExpanded,
    setDense,
    setMobileSidebar,
    setPanelHidesSidebar,
    setSearch,
    setSidebar,
    setSidebarOverride,
    setWidePanel,
    sidebar,
    sidebarOpenWidth,
    sidebarOverride,
    sidebarShown,
    widePanel,
  ] = useShellLayout(
    editing,
    exploring,
    panel,
  )
  const [end, setEnd] = useState(() => Math.floor(Date.now() / 1000))
  // Whether the current end came from an automatic tick. An automatic tick staggers across the tiles; any other change adopts at once.
  const [autoTick, setAutoTick] = useState(false)
  // When the user last pressed Refresh. Queries in the bypass window skip the server's result cache.
  const [refreshedAt, setRefreshedAt] = useState(0)
  const advanceEnd = useCallback((auto: boolean) => {
    setEnd(Math.floor(Date.now() / 1000))
    setAutoTick(auto)
  }, [])
  const [retry, setRetry] = useState(0)
  // The shared source list loads behind a rendered workspace. Only tiles that need it wait.
  const [sources, setSources] = useState<SourceState>({ status: "ready" })
  const [sourceRequest, setSourceRequest] = useState<object | null>(null)
  const sourceNoticeRef = useRef<HTMLDivElement>(null)
  const bannerRetry = useRef<HTMLButtonElement>(null)
  // Always rendered in the live workspace, so it is a dependable focus target after a retry.
  const workspaceRegion = useRef<HTMLElement>(null)
  // The retry request whose outcome owns focus. Superseding or aborting it releases the claim.
  const retryFocus = useRef<object | null>(null)
  // A retry that ends busy again moves focus to the banner's retry control once it renders.
  const focusBannerRetry = useRef(false)
  // Callers awaiting the listing (the observe card, the provider manager) settle with the request that loads it.
  const catalogWaiters = useRef<Array<{ resolve: (catalog: ProviderCatalog) => void; reject: (error: unknown) => void }>>([])
  // A session change while the banner asks for sign-in reloads the sources.
  const [seenSessionRevision, setSeenSessionRevision] = useState(sessionRevision)
  if (sessionRevision !== seenSessionRevision) {
    setSeenSessionRevision(sessionRevision)
    if (mode === "live" && sources.status === "unavailable" && sources.reason === "signin") {
      setSources({ status: "pending" })
      setSourceRequest({})
    }
  }
  // The sign-in action only exists when the host can start sign-in.
  const sourceContext: SourceStatus = sources.status === "unavailable"
    ? (sources.reason === "signin" && client.signIn ? "signin" : "unavailable")
    : sources.status
  // Retry leaves the button out of the DOM as the load starts, so focus moves to the
  // persistent live region, which stays mounted for the whole episode.
  const retrySources = () => {
    const request = {}
    retryFocus.current = request
    sourceNoticeRef.current?.focus()
    setSources({ status: "pending" })
    setSourceRequest(request)
  }
  // The one way a listing reaches the workspace: boot, retry, and the provider
  // manager all share it, so a busy shared catalog is never mistaken for a clean one.
  const acceptCatalog = useCallback((catalog: ProviderCatalog) => {
    setProviders(catalog.providers)
    setUnsupportedProviders(catalog.unsupportedProviders ?? [])
    const shared = catalog.sharedCatalog
    setSources(shared
      ? { status: "unavailable", reason: sharedFailureReason(shared.status), message: shared.message }
      : { status: "ready" })
  }, [setProviders, setUnsupportedProviders])
  // The observe card and the provider manager wait on the request that loads the listing.
  // That request owns the abort, so closing their panel never strands the sources.
  const refreshCatalog = useCallback(() => new Promise<ProviderCatalog>((resolve, reject) => {
    catalogWaiters.current.push({ resolve, reject })
    setSources({ status: "pending" })
    setSourceRequest({})
  }), [])
  const [queryRevision, setQueryRevision] = useState(0)
  const etags = useRef(new Map<string, string>())
  // The inputs of the last workspace reconcile; see sameSyncInputs.
  const lastSyncInputs = useRef<readonly unknown[] | undefined>(undefined)
  const openRequest = useRef(0)
  const bundleImporter = useRef<ReturnType<typeof createBundleImporter> | null>(null)
  const bundleImportActive = useRef(false)
  if (!bundleImporter.current) bundleImporter.current = createBundleImporter()
  useEffect(() => {
    if (editing) preloadWidgetEditor()
  }, [editing])
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
  // The notice's Save now runs the latest save. It works from view mode too, where the header save button is gone.
  const saveLatest = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    saveLatest.current = () => { if (!busy) void save() }
  })
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
  const [queryFieldSnapshot, setQueryFieldSnapshot] = useState<QueryFieldSnapshot>();
  const [queryResultSnapshot, setQueryResultSnapshot] = useState<WidgetResultSnapshot>();
  const currentWidget = dashboard.widgets.find(
    (widget) => widget.id === selected,
  )
  const editingWidget = panel === "widget" && !!currentWidget
  const focusedWidget = editingWidget && !exploring
  // Removes a tile from the dashboard, as one undo step, and moves focus to the neighbouring tile or the title.
  const pendingTileFocus = useRef<string | undefined>(undefined)
  // A notice with one Undo action. Undo applies only while `document` is still the latest one, so a later edit is never
  // reverted by it. Focus moves to `focus` once the undone change renders.
  // The chart editor's draft, read at undo time. A notice's closure is older than the edits made after it.
  const chartDraftDirty = useRef(false)
  const askConfirmation = confirmation.ask
  useLayoutEffect(() => { chartDraftDirty.current = widgetDraftDirty })
  // `leave` closes the chart editor when the undone change is the chart it was showing. Unapplied edits to that chart
  // then need the same discard confirmation as leaving it.
  const noticeWithUndo = useCallback((notice: { text: string; name: string; document: Dashboard; focus: string; restored: string; leave?: () => void }) => {
    setError("")
    setMessage(notice.text)
    setMessageAction({
      text: notice.text,
      label: "Undo",
      name: notice.name,
      document: notice.document,
      run: () => {
        const undoNow = () => {
          if (JSON.stringify(latestDocument.current) !== JSON.stringify(notice.document)) {
            setMessageAction(undefined)
            setMessage("Could not undo: the dashboard changed since then.")
            return
          }
          notice.leave?.()
          pendingTileFocus.current = notice.focus
          undo()
          setMessage(notice.restored)
        }
        if (!notice.leave || !chartDraftDirty.current) return undoNow()
        void askConfirmation({
          title: "Discard chart changes?",
          description: "These chart settings have not been applied to the dashboard.",
          action: "Discard changes",
        }).then(accepted => { if (accepted) undoNow() })
      },
    })
  }, [undo, askConfirmation, latestDocument, setError, setMessage, setMessageAction])
  const removeTile = useCallback((widgetId: string) => {
    const index = dashboard.widgets.findIndex((widget) => widget.id === widgetId)
    if (index < 0) return
    const removed = dashboard.widgets[index]
    const next = { ...dashboard, widgets: dashboard.widgets.filter((widget) => widget.id !== widgetId) }
    const neighbour = next.widgets[index] ?? next.widgets[index - 1]
    update(next)
    pendingTileFocus.current = neighbour?.id ?? "title"
    // The open chart editor returns focus to its opener when it closes. Its opener is the removed tile, so it moves to the neighbour.
    if (widgetOpener.current === widgetId) widgetOpener.current = neighbour?.id
    noticeWithUndo({
      text: `Removed ${removed.title}.`,
      name: `Undo remove ${removed.title}`,
      document: next,
      focus: removed.id,
      restored: `Restored ${removed.title}.`,
    })
  }, [dashboard, update, noticeWithUndo, widgetOpener])
  // Copies a saved tile from its actions menu: one undo step, the copy beside the tile or below it, and focus on the copy.
  // The copy is the saved widget, so unapplied editor changes are not included (the editor's Duplicate chart does include them).
  const duplicateTile = useCallback((widgetId: string) => {
    const source = dashboard.widgets.find((widget) => widget.id === widgetId)
    if (!source) return
    if (dashboard.widgets.length >= MAX_WIDGETS) {
      setError("A dashboard supports up to 48 widgets.")
      return
    }
    const copyId = `widget-${crypto.randomUUID()}`
    const edit = duplicateLayout(savedLayout(dashboard.widgets), widgetId, copyId)
    if ("blocked" in edit) {
      setError(edit.blocked)
      return
    }
    const placed = new Map(edit.layout.map((item) => [item.i, item]))
    const moved = dashboard.widgets.map((item) => {
      const at = placed.get(item.id)
      return at ? { ...item, layout: { ...item.layout, x: at.x, y: at.y } } : item
    })
    const at = placed.get(copyId)!
    const copy = { ...source, id: copyId, title: `${source.title.slice(0, 113)} (copy)`, layout: { ...source.layout, x: at.x, y: at.y } }
    const next = { ...dashboard, widgets: [...moved, copy] }
    update(next)
    pendingTileFocus.current = copy.id
    noticeWithUndo({
      text: `Duplicated ${source.title}${placementPhrase(edit.placement)}.`,
      name: `Undo duplicate ${source.title}`,
      document: next,
      focus: source.id,
      restored: "Removed the copy.",
    })
  }, [dashboard, update, noticeWithUndo, setError])
  // Focus moves to the pending tile once it is in the DOM. A copy can mount a commit after the change that made it, so until
  // then a MutationObserver on the canvas retries, and the target is dropped only when the dashboard no longer has that tile.
  const tileFocusWatch = useRef<MutationObserver | null>(null)
  const focusPendingTile = useCallback(() => {
    const target = pendingTileFocus.current
    if (target === undefined) return true
    if (target === "title") {
      pendingTileFocus.current = undefined
      titleField.current?.focus()
      return true
    }
    const tile = Array.from(layoutRoot.current?.querySelectorAll<HTMLElement>("[data-widget-id]") ?? [])
      .find((element) => element.dataset.widgetId === target)
    if (!tile) return false
    pendingTileFocus.current = undefined
    if (tile.hasAttribute("tabindex")) tile.focus()
    else visibleTileControl(tile, "[data-widget-edit], [data-widget-actions]")?.focus()
    return true
  }, [layoutRoot])
  useLayoutEffect(() => {
    const target = pendingTileFocus.current
    const stopWatching = () => {
      tileFocusWatch.current?.disconnect()
      tileFocusWatch.current = null
    }
    if (target === undefined || focusPendingTile()) return stopWatching()
    if (!dashboard.widgets.some((widget) => widget.id === target)) {
      pendingTileFocus.current = undefined
      return stopWatching()
    }
    const root = layoutRoot.current
    if (!root || tileFocusWatch.current) return
    tileFocusWatch.current = new MutationObserver(() => {
      if (focusPendingTile()) stopWatching()
    })
    tileFocusWatch.current.observe(root, { childList: true, subtree: true })
  })
  // The phone shell is a view: editing, a focused chart and Explore keep their full chrome.
  const phoneShell = phoneViewport && !editing && !focusedWidget && !exploring
  // Keyboard shortcuts for the dashboard. Chart history and apply are routed to the chart editor in a later change.
  const applePlatform = isApplePlatform()
  // The open chart editor registers its undo, redo and apply here. A ref, so registering never re-renders the page.
  const chartCommands = useRef<ChartCommands | null>(null)
  const registerChartCommands = useCallback((commands: ChartCommands | null) => { chartCommands.current = commands }, [])
  useInsightsShortcuts(layoutRoot, {
    editing,
    chartOpen: editingWidget,
    chart: chartCommands,
    blocked: busy || importingBundle || exploring,
    undoDashboard: undo,
    redoDashboard: redo,
    save: () => saveButton.current?.click(),
    removeTile,
    duplicateTile,
    openShortcuts: () => setShortcutsOpen(true),
  })
  // A successful save moves focus, so it is lost when the save button goes. Each save bumps the revision, so the focus
  // effect also runs when the save came from view mode, where editing and the document may not change.
  const actionsRegion = useRef<HTMLDivElement>(null)
  const [saveRevision, setSaveRevision] = useState(0)
  // The tile to focus after a save, if the save was Apply and save. An empty object means the plain save.
  const focusAfterSave = useRef<{ widget?: string } | null>(null)
  useLayoutEffect(() => {
    const after = focusAfterSave.current
    if (!after || editing) return
    focusAfterSave.current = null
    const root = layoutRoot.current
    if (after.widget !== undefined) {
      const tile = Array.from(root?.querySelectorAll<HTMLElement>("[data-widget-id]") ?? [])
        .find((element) => element.dataset.widgetId === after.widget)
      if (tile) {
        // Tiles are not focusable in view mode, so the focus target gets a -1 tab index for this focus call only.
        if (!tile.hasAttribute("tabindex")) {
          tile.tabIndex = -1
          tile.addEventListener("blur", () => tile.removeAttribute("tabindex"), { once: true })
        }
        tile.focus()
        return
      }
    }
    // The phone shell keeps Edit in the Dashboard actions menu, so its trigger takes focus. Elsewhere Edit is a button.
    const buttons = Array.from(actionsRegion.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])
    const target = phoneShell
      ? buttons[0]
      : buttons.find((button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === "Edit dashboard")
    target?.focus()
  }, [editing, dashboard, saveRevision, phoneShell, layoutRoot])
  const previewWidget = widgetPreview?.id === currentWidget?.id ? widgetPreview : currentWidget
  const builderPanel = useBuilderPanelFocus(
    panel && !exploring
      ? `${dashboard.id}:${panel}:${panel === "widget" ? (selected ?? "") : ""}`
      : null,
    () => {
      if (panelOpener.current) return panelOpenerElement(panelOpener.current) ?? document.querySelector<HTMLElement>('[aria-label="Toggle sidebar"]')
      if (!widgetOpener.current) return null
      const opener = CSS.escape(widgetOpener.current)
      return visibleTileControl(document, `[data-widget-edit="${opener}"], [data-widget-actions="${opener}"]`) ??
        document.querySelector<HTMLElement>('[data-widget-edit], [aria-label="Dashboard title"]')
    },
    panel === "examples" ? galleryMounted
      : panel === "widget" ? editorMounted
      : panel === "source" || panel === "providers" || panel === "manage" ? mountedPanels.has(panel)
      : true,
  )

  useEffect(() => {
    // Opening the Examples panel loads the catalog without changing the live workspace.
    if (panel !== "examples" || workspace || workspaceFailed) return
    let active = true
    loadRepositoryWorkspace().then(
      (runtime) => { if (active) setWorkspace(runtime) },
      () => { if (active) setWorkspaceFailed(true) },
    )
    return () => { active = false }
  }, [panel, workspace, workspaceFailed, setWorkspace, setWorkspaceFailed])

  const enterExample = useCallback(async () => {
    const generation = ++exampleGeneration.current
    const current = () => mounted.current && generation === exampleGeneration.current
    setExampleStarting(true)
    let runtime: RepositoryWorkspace
    try {
      runtime = await loadRepositoryWorkspace()
    } catch {
      if (!current()) return
      setWorkspaceFailed(true)
      setExampleStarting(false)
      setError("The example workspace could not load. Reload the page to try again.")
      setMode("unavailable")
      return
    }
    if (!current()) return
    const stored = runtime.readRepositoryExampleWorkspace(localStorage)
    if (localStorage.getItem(EXAMPLE_STORAGE_KEY) === null) writeExampleWorkspace(localStorage, stored.dashboards, stored.activeId)
    const fallback =
      stored.dashboards.find((item) => item.id === stored.activeId) ??
      newDashboard()
    const { document: sample, link, rejected, error } = initialNavigation(stored.dashboards, fallback)
    reset(sample)
    setSaved(documentFingerprint(sample))
    setDashboards(stored.dashboards)
    setProviders(runtime.repositoryWorkspaceProviders)
    setUnsupportedProviders([])
    setWorkspace(runtime)
    setSources({ status: "ready" })
    setSourceRequest(null)
    setMode("example")
    const linked = resolveLinkView(sample, link, rejected)
    let viewError = error
    try {
      applyView(linked.state, error ? "keep" : "load", { example: true })
    } catch (cause) {
      // A link that parses but cannot be written back keeps its value on screen, and the address keeps the link.
      showView(linked.state)
      viewError = cause instanceof Error ? cause.message : "Invalid dashboard link"
    }
    setLinkNotice(describeIgnoredLink(linked.ignored))
    setError(viewError)
    setExampleStarting(false)
  }, [reset, applyView, showView, exampleGeneration, mounted, setDashboards, setExampleStarting, setMode, setProviders, setUnsupportedProviders, setWorkspace, setWorkspaceFailed, setError, setLinkNotice, setSaved])

  useEffect(() => {
    if (initialExample) {
      let active = true
      queueMicrotask(() => {
        if (active) enterExample()
      })
      return () => {
        active = false
      }
    }
    exampleGeneration.current++
    const controller = new AbortController()
    client.list(controller.signal)
      .then(async (documents) => {
        if (controller.signal.aborted) return
        const initial = initialNavigation(documents, documents[0] ?? newDashboard())
        const active = documents.length
          ? await client.get(initial.document.id)
          : { dashboard: newDashboard(), etag: undefined }
        if (controller.signal.aborted) return
        if (active.etag) etags.current.set(active.dashboard.id, active.etag)
        // The workspace renders now; the shared source list loads behind it.
        setSources({ status: "pending" })
        setSourceRequest({})
        setDashboards(documents)
        reset(active.dashboard)
        setSaved(documentFingerprint(active.dashboard))
        setMode("live")
        // The fetched document is authoritative: values it no longer declares are dropped, not thrown.
        const linked = resolveLinkView(active.dashboard, { ...initial.link, dashboardId: active.dashboard.id }, initial.rejected)
        applyView(linked.state, initial.error ? "keep" : "load")
        setLinkNotice(describeIgnoredLink(linked.ignored))
        setError(initial.error)
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setMode("unavailable")
          setError(error.message)
        }
      })
    return () => controller.abort()
  }, [client, initialExample, enterExample, reset, retry, applyView, exampleGeneration, setDashboards, setMode, setError, setLinkNotice, setSaved])

  // One background load, one retry layer: the client replays a busy listing, and a
  // failure that remains is shown with a manual retry. The listing carries the shared
  // catalog's own status, so local sources still load.
  useEffect(() => {
    if (!sourceRequest || mode !== "live") return
    const controller = new AbortController()
    const ownsFocus = retryFocus.current === sourceRequest
    loadProviderCatalog(client, controller.signal).then(
      (catalog) => {
        if (controller.signal.aborted) return
        if (ownsFocus) {
          retryFocus.current = null
          if (catalog.sharedCatalog) {
            // A busy answer still resolves, but the retry did not recover: its control keeps focus.
            focusBannerRetry.current = true
          } else {
            // Move focus only while it still sits on the banner, or nowhere: a user who moved on keeps it.
            const active = document.activeElement
            if (!active || active === document.body || active === sourceNoticeRef.current || active === bannerRetry.current) workspaceRegion.current?.focus()
          }
        }
        acceptCatalog(catalog)
        for (const waiter of catalogWaiters.current.splice(0)) waiter.resolve(catalog)
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        if (ownsFocus) {
          retryFocus.current = null
          focusBannerRetry.current = true
        }
        // The workspace is already on screen: a rejected catalog never unmounts it,
        // so unsaved edits survive. Sign-in is offered as an explicit action.
        const message = error instanceof Error ? error.message : "Data sources are unavailable."
        setSources({ status: "unavailable", reason: sourceFailureReason(error), message })
        for (const waiter of catalogWaiters.current.splice(0)) waiter.reject(error)
      },
    )
    return () => {
      controller.abort()
      // An aborted retry no longer owns focus.
      if (retryFocus.current === sourceRequest) retryFocus.current = null
    }
  }, [client, mode, sourceRequest, acceptCatalog])

  // A retry that ends busy again renders a new retry control, which takes focus.
  useEffect(() => {
    if (!focusBannerRetry.current) return
    focusBannerRetry.current = false
    const target = bannerRetry.current ?? sourceNoticeRef.current
    target?.focus()
  }, [sources])


  useEffect(() => {
    if (!dirty && !widgetDraftDirty && !explorerDirty && !importingBundle) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [dirty, widgetDraftDirty, explorerDirty, importingBundle])

  useEffect(() => {
    if (!drawerOpen || !navigation.current) return
    const drawer = navigation.current
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : navigationToggle.current
    const unlock = lockBodyScroll()
    const focusable = () => [
      ...drawer.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ]
    focusable()[0]?.focus()
    const keydown = (event: KeyboardEvent) => {
      // A native modal above the drawer owns Tab and Escape, including events
      // delivered at document level by the browser's modal close watcher.
      if (event.defaultPrevented || document.querySelector("dialog[open]")) return
      if (event.key === "Escape") {
        event.preventDefault()
        setMobileSidebar(false)
        return
      }
      if (event.key !== "Tab") return
      const controls = focusable()
      const first = controls[0]
      const last = controls.at(-1)
      if (!first || !last) {
        event.preventDefault()
        drawer.focus()
        return
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !drawer.contains(document.activeElement))
      ) {
        event.preventDefault()
        last.focus()
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !drawer.contains(document.activeElement))
      ) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", keydown)
    return () => {
      document.removeEventListener("keydown", keydown)
      unlock()
      if (previous?.isConnected) previous.focus()
    }
  }, [drawerOpen, navigation, navigationToggle, setMobileSidebar])

  useEffect(() => {
    // A fixed window pauses auto refresh; a relative window keeps refreshing at the view's interval.
    if (!viewDashboard.refreshInterval || viewDashboard.customTimeRange) return
    const timer = setInterval(() => {
      if (!document.hidden) advanceEnd(true)
    }, viewDashboard.refreshInterval * 1000)
    const onVisible = () => {
      if (!document.hidden) advanceEnd(true)
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [viewDashboard.refreshInterval, viewDashboard.customTimeRange, advanceEnd])

  const scheduledFetcher = useMemo(() => {
    // A refresh or provider edit invalidates cached fixed-range observations too.
    void queryRevision
    // The scheduler owns the capacity backoff, so its slot is free while a refused query waits.
    const query = activeExample ? activeExample.repositoryWorkspaceQuery : (request: QueryRequest, signal: AbortSignal) => client.query(request, signal, { replayCapacity: false, refresh: Date.now() - refreshedAt < MANUAL_REFRESH_BYPASS_MS })
    return createQueryScheduler(query)
  }, [client, activeExample, queryRevision, refreshedAt])
  // Resolve each authoring scope once, before sharing the bounded scheduler.
  // Tooltip label values may themselves contain {{text}}; never interpolate
  // those resolved query literals again as dashboard variables.
  // A saved query whose source is loaded runs even when the shared catalog failed.
  const fetcher = useMemo(() => createResolvedQueryFetcher(scheduledFetcher, (request: QueryRequest) => {
    const { queryRef, ...resolved } = request
    if (queryRef) {
      if (queriesLoading) throw new Error("Loading the saved-query library…")
      if (queriesError) throw new Error(queriesError)
      const authored = savedQueries.find(query => query.id === queryRef.id)
      if (authored) assertProviderQueryTemplate(providers.find(provider => provider.id === authored.providerId)?.type, authored.query)
      const definition = resolveSavedQueryReference(queryRef, savedQueries, variableValues, request.kind)
      if (!providers.some(provider => provider.id === definition.providerId)) {
        if (sourceContext !== "ready") throw new Error(sourceWaitMessage(sourceContext))
        throw new Error("The saved query’s data source is unavailable. Choose a connected source in Explore.")
      }
      if (!providers.some(provider => provider.id === definition.providerId && provider.capabilities.includes(definition.kind)))
        throw new Error("The saved query’s data source is unavailable. Choose a connected source in Explore.")
      return { ...resolved, ...definition }
    }
    assertProviderQueryTemplate(providers.find(provider => provider.id === request.providerId)?.type, request.query)
    return { ...resolved, query: interpolateQuery(request.query, variableValues) }
  }), [scheduledFetcher, variableValues, savedQueries, queriesLoading, queriesError, providers, sourceContext])
  // The view reads its window to the shared grain, so viewers and query_dashboard ask for the same window.
  const alignedEnd = alignedDashboardEnd(viewDashboard, end)
  const range = dashboardRange(viewDashboard, alignedEnd)
  // Values for variable sources come from the same metadata and query paths the widgets use.
  const variableLoaders = useMemo<VariableValueLoaders>(() => ({
    // The principal is the scope, so values loaded under one sign-in never serve another; a token renewal keeps them.
    scope: variableValueScope(!!activeExample, principal),
    metadata: async (request, signal) => {
      // Example workspaces read a fixed fixture that has no selectors, so a selector is refused rather than ignored.
      if (activeExample && request.selector !== undefined) throw new Error("Selector-filtered values are not available in examples")
      const metadata = activeExample ? activeExample.repositoryWorkspaceMetadata : client.metadata
      const response = await metadata(request.providerId, { kind: "values", label: request.label, selector: request.selector, start: request.start, end: request.end }, signal)
      return { values: response.values, truncated: response.truncated }
    },
    query: (request, signal) => {
      // Resolve with the values the plan was keyed on, not the route's current values, so the result matches its key.
      if (queriesLoading) throw new Error("Loading the saved-query library…")
      if (queriesError) throw new Error(queriesError)
      const saved = savedQueries.find(query => query.id === request.queryRef.id)
      if (!saved) throw new Error(`Saved query “${request.queryRef.id}” is unavailable.`)
      assertProviderQueryTemplate(providers.find(provider => provider.id === saved.providerId)?.type, saved.query)
      const definition = resolveSavedQueryReference(request.queryRef, savedQueries, request.variables, saved.kind)
      if (!providers.some(provider => provider.id === definition.providerId && provider.capabilities.includes(definition.kind)))
        throw new Error("The saved query’s data source is unavailable. Choose a connected source in Explore.")
      const minStepSeconds = providers.find(provider => provider.id === definition.providerId)?.minStepSeconds
      return scheduledFetcher({ ...definition, start: request.start, end: request.end, step: sourceQueryStep(request.start, request.end, minStepSeconds) }, signal)
    },
  }), [client, activeExample, scheduledFetcher, savedQueries, queriesLoading, queriesError, providers, principal])
  // The variable editor reads providers, label names and saved queries; its preview runs the same loaders as the bar.
  const variableCatalog = useMemo<VariableSourceCatalog>(() => ({
    loaders: variableLoaders,
    providers,
    savedQueries,
    range: { start: range.start, end: range.end },
    labels: async (providerId, signal) => {
      const metadata = activeExample ? activeExample.repositoryWorkspaceMetadata : client.metadata
      return (await metadata(providerId, { kind: "labels" }, signal)).values
    },
  }), [variableLoaders, providers, savedQueries, client, activeExample, range.start, range.end])
  const builderClient = useMemo(
    () =>
      activeExample
        ? { ...client, metadata: activeExample.repositoryWorkspaceMetadata, query: activeExample.repositoryWorkspaceQuery }
        : client,
    [client, activeExample],
  )
  const close = useCallback(() => {
    if (bundleImportActive.current) return
    setPanel(null)
    setSidebarOverride(false)
    setSelected(undefined)
    setWidgetPreview(undefined)
    setWidgetDraftDirty(false)
    // The unapplied-chart notice and its action are only true while that chart's editor is open.
    setMessageAction(current => current?.chartEditor ? undefined : current)
    setMessage(current => current === UNAPPLIED_CHART_NOTICE ? "" : current)
  }, [setMessage, setMessageAction, setPanel, setSelected, setSidebarOverride, setWidgetDraftDirty, setWidgetPreview])
  const selectWidget = useCallback((id: string) => {
    if (bundleImportActive.current) return
    widgetOpener.current = id
    panelOpener.current = undefined
    setMessage("")
    setWidgetPreview(undefined)
    setWidgetDraftDirty(false)
    setMobileSidebar(false)
    setSelected(id)
    setPanel("widget")
    setEditing(true)
  }, [panelOpener, setEditing, setMessage, setMobileSidebar, setPanel, setSelected, setWidgetDraftDirty, setWidgetPreview, widgetOpener])
  const askToDiscardChart = confirmation.ask
  const navigateFromChart = useCallback((navigate: () => void) => {
    if (!widgetDraftDirty) {
      navigate()
      return
    }
    void askToDiscardChart({
      title: "Discard chart changes?",
      description: "These chart settings have not been applied to the dashboard.",
      action: "Discard changes",
    }).then(accepted => { if (accepted) navigate() })
  }, [widgetDraftDirty, askToDiscardChart])
  const leaveWidget = useCallback(() => navigateFromChart(close), [navigateFromChart, close])
  // Opens a builder panel. The width and sidebar are planned by the layout effect below, before paint.
  function showPanel(next: typeof panel) {
    setSidebarOverride(false)
    setPanel(next)
  }
  function openBuilderPanel(next: typeof panel) {
    // Record the control before any state changes move or remove it. Lookups stay lazy so a deferred confirm still works.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-panel-opener]") : null
    panelOpener.current = opener?.dataset.panelOpener
    // Explore keeps the focused chart mounted. Any other panel replaces it,
    // so wait for its unapplied draft to be resolved before changing views.
    navigateFromChart(() => {
      close()
      setExploring(false)
      showPanel(next)
      setMobileSidebar(false)
      if (next === "ai") setEditing(true)
    })
  }
  // Keeps the room for the open panel planned: the canvas, the panel and the sidebar as rendered now. The room does not
  // depend on the plan's choice, so re-running after any change converges. It runs before paint, and skips the canvas
  // while Explore or a focused widget hides it.
  useLayoutEffect(() => {
    // The plan is a function of the DOM as it is laid out, so it is written here, before paint, rather than during render.
    if (!panel || panel === "widget") { setPanelHidesSidebar(false); return }
    const wide = panel === "source" || panel === "examples"
    if (isMobile) { setPanelHidesSidebar(false); setWidePanel(wide); return }
    const root = layoutRoot.current
    const canvas = root?.querySelector<HTMLElement>('[data-testid="dashboard-canvas"]')
    if (exploring || !canvas || canvas.clientWidth === 0) return
    const sidebarWidth = navigation.current?.offsetWidth ?? 0
    if (sidebarWidth) sidebarOpenWidth.current = sidebarWidth
    const plan = builderPanelPlan({
      canvasWidth: canvas.clientWidth,
      panelWidth: root?.querySelector<HTMLElement>('[aria-label="Builder panel"]')?.offsetWidth ?? 0,
      sidebarWidth,
      openSidebarWidth: sidebarOpenWidth.current,
    }, { wide, sidebarCollapsible: !sidebarOverride, sidebarPreferred: compactShell || sidebar })
    setPanelHidesSidebar(plan.collapsed)
    setWidePanel(plan.widePanel)
  }, [panel, exploring, isMobile, compactShell, editing, sidebar, sidebarOverride, planRevision, layoutRoot, navigation, setPanelHidesSidebar, setWidePanel, sidebarOpenWidth])
  useEffect(() => {
    if (!focusedWidget) return
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented ||
        document.querySelector(OVERLAY_SELECTOR)) return
      event.preventDefault()
      void leaveWidget()
    }
    window.addEventListener("keydown", keydown)
    return () => window.removeEventListener("keydown", keydown)
  }, [focusedWidget, leaveWidget])
  const layoutUpdate = useCallback(
    (layout: Layout) =>
      update((current) => ({
        ...current,
        widgets: current.widgets.map((widget) => {
          const position = layout.find((item) => item.i === widget.id)
          return position && (widget.layout.x !== position.x || widget.layout.y !== Math.min(1000, position.y) || widget.layout.w !== position.w || widget.layout.h !== position.h)
            ? {
                ...widget,
                layout: {
                  x: position.x,
                  y: Math.min(1000, position.y),
                  w: position.w,
                  h: position.h,
                },
              }
            : widget
        }),
      })),
    [update],
  )

  function applyDocument(next: Dashboard, message = "Dashboard draft replaced. Review the canvas, then save the dashboard.") {
    syncVariableDefinitions(next)
    // Importing a document edits the active dashboard; a document cannot silently
    // switch persistence identity and overwrite another saved dashboard.
    const layout = verticalCompactor.compact(
      next.widgets.map((widget) => ({ i: widget.id, ...widget.layout })),
      12,
    )
    update({
      ...next,
      id: dashboard.id,
      widgets: next.widgets.map((widget) => {
        const item = layout.find((entry) => entry.i === widget.id)!
        return {
          ...widget,
          layout: { x: item.x, y: item.y, w: item.w, h: item.h },
        }
      }),
    })
    setEditing(true)
    close()
    setMessage(message)
  }
  function syncVariableDefinitions(next: Dashboard) {
    if (!currentRoute?.variables) return
    const variables = Object.fromEntries(Object.entries(currentRoute.variables).filter(([name]) => next.variables?.some(item => item.name === name)))
    applyView({ ...currentRoute, variables }, "prune")
  }
  // Declares a variable from another editor. It reads the latest document, so a stale closure cannot drop a variable.
  // Callers see a refusal as a thrown error and keep their own draft.
  const declareRef = useRef<(variable: DashboardVariable) => void>(() => {})
  useLayoutEffect(() => {
    declareRef.current = (variable) => {
      const next = { ...latestDocument.current, variables: [...(latestDocument.current.variables ?? []), variable] }
      const checked = dashboardSchema.safeParse(next)
      if (!checked.success) throw new Error(checked.error.issues[0]?.message ?? "This variable could not be declared.")
      syncVariableDefinitions(checked.data)
      update(checked.data)
      setEditing(true)
    }
  })
  const declareVariable = useCallback((variable: DashboardVariable) => declareRef.current(variable), [])
  function addWidget(definition: WidgetDefinition) {
    if (dashboard.widgets.length >= MAX_WIDGETS) {
      setError("A dashboard supports up to 48 widgets.")
      return
    }
    const widget = newWidget(
      definition.type,
      providers,
      dashboard.widgets,
      definition.type === "plugin" ? definition : undefined,
      definition.starterQueries,
    )
    update({ ...dashboard, widgets: [...dashboard.widgets, widget] })
    selectWidget(widget.id)
  }
  function useSavedQuery(query: SavedQuery) {
    if (dashboard.widgets.length >= MAX_WIDGETS) throw new Error("A dashboard supports up to 48 widgets.")
    const variables = [...(dashboard.variables ?? [])]
    for (const parameter of query.parameters ?? []) {
      if (!variables.some(variable => variable.name === parameter.name)) variables.push({
        name: parameter.name, ...(parameter.label ? { label: parameter.label } : {}),
        ...(parameter.defaultValue !== undefined ? { defaultValue: String(parameter.defaultValue) } : {}),
      })
    }
    if (variables.length > MAX_DASHBOARD_VARIABLES) throw new Error("This query would exceed the dashboard’s 20-variable limit. Add a widget and bind some parameters to constants instead.")
    const widget = {
      ...newWidget(query.kind === "records" ? "plugin" : query.kind === "traces" ? "traces" : "timeseries", providers.filter(provider => provider.id === query.providerId), dashboard.widgets,
        query.kind === "records" ? { id: "record-table", label: "Records table", dataKind: "records" } : undefined),
      title: query.name, providerId: query.providerId,
      queryRef: { id: query.id, bindings: (query.parameters ?? []).map(parameter => ({ parameter: parameter.name, source: "variable" as const, variable: parameter.name })) },
    }
    // Keep validation synchronous for Explorer's error handling. Adding the
    // validated widget waits until replacing the current chart is accepted.
    navigateFromChart(() => {
      update({ ...dashboard, variables, widgets: [...dashboard.widgets, widget] })
      setExploring(false)
      setEditing(true)
      selectWidget(widget.id)
      setMessage("Saved query linked. Parameters use dashboard variables; review their values, then save the dashboard.")
    })
  }
  async function save() {
    await saveDocument(dashboard)
  }
  /**
   * Writes a dashboard document. Apply and save passes the document it has just applied, since this render still
   * holds the one from before the apply, and chartApplied, since this render still holds the chart's dirty flag.
   */
  async function saveDocument(doc: Dashboard, options: { chartApplied?: boolean; focusWidget?: string } = {}) {
    if (!options.chartApplied && !widgetDraftValid) {
      setError("Fix the invalid widget settings before saving, or close its editor to keep the last valid preview.")
      return
    }
    const request = openRequest.current
    setError("")
    setSaveFindings(undefined)
    setBusy(true)
    try {
      // The document as the save writes it, so the stored copy and the editor agree with what the server holds.
      const parsed = dashboardAsSent(doc)
      // Normalize trimmed form values before the request, so a completed save
      // never overwrites edits made while the request was in flight.
      if (documentFingerprint(parsed) !== documentFingerprint(doc))
        update(parsed)
      if (activeExample) {
        const persisted = activeExample.readRepositoryExampleWorkspace(localStorage).dashboards.find(item => item.id === parsed.id)
        if (persisted && documentFingerprint(persisted) !== saved)
          throw new Error("The saved dashboard changed. Open another dashboard and return to review it before saving, or duplicate your draft to keep these edits.")
        saveExampleWorkspace(localStorage, dashboards, parsed)
      } else {
        const etag = await client.save(parsed, etags.current.get(parsed.id))
        if (etag) etags.current.set(parsed.id, etag)
      }
      setDashboards((items) => [
        ...items.filter((item) => item.id !== parsed.id),
        parsed,
      ])
      if (request !== openRequest.current) return
      setSaved(documentFingerprint(parsed))
      // An unapplied chart draft is not part of the saved dashboard. Saving keeps the chart editor and its draft open.
      if (!options.chartApplied && widgetDraftDirty) {
        const text = UNAPPLIED_CHART_NOTICE
        setMessage(text)
        // The name starts with the visible label, so voice control can say "Apply and save" and reach it.
        setMessageAction({ text, label: "Apply and save", name: "Apply and save chart", run: () => chartCommands.current?.applyAndSave(), chartEditor: true })
        return
      }
      setMessage(
        mode === "example"
          ? "Example saved in this browser."
          : "Dashboard saved.",
      )
      // Apply and save moves focus to the chart's tile. A plain save moves it to Edit, or to the actions trigger on the phone.
      focusAfterSave.current = { widget: options.focusWidget }
      setSaveRevision((value) => value + 1)
      setEditing(false)
      close()
    } catch (error) {
      if (request === openRequest.current) {
        const message = error instanceof Error ? error.message : "Could not save dashboard"
        const report = checksFromError(error)
        setError(message)
        setSaveFindings(report ? { message, report } : undefined)
      }
    } finally {
      setBusy(false)
    }
  }
  async function openDashboard(
    item: Dashboard,
    state: DashboardNavigation | ((target: Dashboard) => DashboardNavigation) = { dashboardId: item.id },
    action: "navigate" | "popstate" = "navigate",
  ): Promise<boolean> {
    if (busy) return false
    const request = ++openRequest.current
    const beforeLoad = documentFingerprint(dashboard)
    if (((item.id !== dashboard.id && dirty) || widgetDraftDirty) && !await confirmDiscard()) return false
    if (request !== openRequest.current) return false
    try {
      const active =
        item.id === dashboard.id
          ? { dashboard, etag: undefined }
          : mode === "example"
          ? { dashboard: item, etag: undefined }
          : await client.get(item.id)
      if (request !== openRequest.current) return false
      if (item.id !== dashboard.id && beforeLoad !== documentFingerprint(latestDocument.current))
        throw new Error("Your dashboard changed while the destination was loading. Open the link again when you are ready.")
      const nextState = typeof state === "function" ? state(active.dashboard) : state
      resolveDashboardVariables(active.dashboard, nextState.variables)
      // Validate the complete URL before changing the document or view state.
      serialiseDashboardView(nextState)
      if (active.etag) etags.current.set(item.id, active.etag)
      if (item.id !== dashboard.id) {
        if (mode === "example")
          saveExampleWorkspace(localStorage, dashboards, active.dashboard)
        reset(active.dashboard)
        setSaved(documentFingerprint(active.dashboard))
        setEditing(false)
      }
      applyView(nextState, action)
      advanceEnd(false)
      // Back and Forward within the same dashboard change only the view: an open panel keeps its unapplied text.
      if (!(action === "popstate" && item.id === dashboard.id)) close()
      setError("")
      setLinkNotice("")
      setMessage("")
      setMobileSidebar(false)
      return true
    } catch (error) {
      if (request === openRequest.current)
        setError(
          error instanceof Error ? error.message : "Could not open dashboard",
        )
      return false
    }
  }
  async function drilldown(link: WidgetLink, context: DrilldownContext) {
    if (isApplicationLink(link)) {
      try {
        const ref = resolveApplicationLink(link, context)
        if (!onOpenApplication) setError("Application pages open from the Paprika console.")
        else onOpenApplication(ref)
      } catch (error) {
        setError(error instanceof Error ? error.message : "Could not open the application")
      }
      return
    }
    const target = dashboard.id === link.dashboardId ? dashboard : dashboards.find(item => item.id === link.dashboardId)
    if (!target) {
      setError("This drilldown’s dashboard is unavailable. Update its link in the widget’s Links tab.")
      return
    }
    try {
      const previous = { state: currentRoute ?? { dashboardId: dashboard.id }, title: dashboard.title }
      if (await openDashboard(target, loaded => resolveDrilldown(link, context, loaded, range))) setReturnTo(previous)
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not open drilldown")
    }
  }
  function selectDashboardContext(widget: Widget, context: DrilldownContext) {
    try {
      const variables = resolveSelectionBindings(widget.selectionBindings ?? [], context, dashboard, variableValues)
      applyView({ ...currentRoute, dashboardId: dashboard.id, variables }, "selection")
      setError("")
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not apply selection")
    }
  }
  function selectDashboardTime(window: { start: number; end: number }) {
    let customTimeRange: { from: string; to: string }
    try {
      customTimeRange = customTimeRangeSchema.parse({ from: new Date(window.start).toISOString(), to: new Date(window.end).toISOString() })
    } catch {
      setError("Choose an increasing time range of at most 31 days.")
      return
    }
    try {
      applyView({ ...currentRoute, dashboardId: dashboard.id, variables: variableValues, range: undefined, customTimeRange }, "brush")
      setError("")
    } catch (cause) {
      // An address that cannot be written keeps the view and says why.
      setError(cause instanceof Error ? cause.message : "Could not select this time range")
    }
  }
  // Browser history must restore the same document, variable values, and time
  // range as a link. Keep the listener stable while using the latest editor state.
  const popHandler = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    popHandler.current = () => {
      const restore = () => reflectView(currentRoute ?? { dashboardId: dashboard.id }, "recover")
      try {
        const link = readDashboardLink()
        const state = link.navigation
        // The open dashboard may be new or unsaved, so it is not in the saved list.
        const target = state?.dashboardId === dashboard.id ? dashboard : dashboards.find(item => item.id === state?.dashboardId)
        if (!state || !target) throw new Error("The linked dashboard is unavailable.")
        // The fresh document decides which link variables still apply; the resolution is kept for the notice.
        const resolution: { current?: ReturnType<typeof resolveLinkView> } = {}
        const pending = openDashboard(target, loaded => {
          resolution.current = resolveLinkView(loaded, state, link.rejected)
          return resolution.current.state
        }, "popstate")
        const request = openRequest.current
        void pending.then(opened => {
          if (request !== openRequest.current) return
          if (!opened) restore()
          else {
            setReturnTo(null)
            const linked = resolution.current
            setLinkNotice(describeIgnoredLink(linked?.ignored ?? []))
            // Back and Forward moved to this entry: correct its stale values in place.
            if (linked?.ignored.length) reflectView(linked.state, "prune")
          }
        })
      } catch (error) {
        restore()
        setError(error instanceof Error ? error.message : "Invalid dashboard link")
      }
    }
  })
  useEffect(() => {
    const onPop = () => popHandler.current()
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

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
  function confirmDiscard() {
    return confirmation.ask({ title: "Discard unsaved changes?", description: `Your unsaved changes to “${dashboard.title}” will be lost.`, action: "Discard changes" })
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
      setEditing(false)
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
    setEditing(true)
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
    setEditing(true)
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
      if (mode === "example")
        writeExampleWorkspace(localStorage, remaining, remaining[0]?.id ?? "")
      else await client.remove(id, etags.current.get(id))
      etags.current.delete(id)
      setDashboards((items) => items.filter((item) => item.id !== id))
      if (request !== openRequest.current) return
      const next =
        mode === "example" && remaining[0] ? remaining[0] : newDashboard()
      ++openRequest.current
      resetView(next)
      reset(next)
      setSaved(
        mode === "example" && remaining[0] ? documentFingerprint(next) : "",
      )
      setEditing(true)
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
      setEditing(true)
      setMessage("Dashboard moved. Save to keep its new location.")
      return
    }
    const existing = dashboards.find((item) => item.id === id)
    if (!existing || existing.folder === folder) return
    setBusy(true)
    setError("")
    try {
      const loaded =
        mode === "example"
          ? { dashboard: existing, etag: undefined }
          : await client.get(id)
      const moved = dashboardAsSent(writableDashboard({ ...loaded.dashboard, folder }))
      if (mode === "example")
        writeExampleWorkspace(
          localStorage,
          dashboards.map((item) => (item.id === id ? moved : item)),
          dashboard.id,
        )
      else {
        const etag = await client.save(moved, loaded.etag)
        if (etag) etags.current.set(id, etag)
      }
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
  const historyAvailable = mode !== "example" && !!client.listRevisions
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
    return mode === "example"
      ? { ...libraryClient, ...createExampleDashboardImportClient(localStorage) }
      : libraryClient
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

  if (mode === "loading")
    return (
      <div className={`${styles.root} ${gammaTheme.scope}`} data-insights-theme={resolvedTheme}>
        <div className={styles.loading} role="status">
          <Loader2 className={styles.spin} size={24} /> Opening your workspace…
        </div>
      </div>
    )
  if (mode === "unavailable")
    return (
      <div className={`${styles.root} ${gammaTheme.scope}`} data-insights-theme={resolvedTheme}>
        <div className={styles.setup}>
          <span className={styles.eyebrow}>PAPRIKA / INSIGHTS</span>
          <h1>A clearer view of your stack.</h1>
          <p>
            Build your own observability workspace. Connect Prometheus and
            Tempo, compose widgets, and keep dashboards as code.
          </p>
          <div className={styles.setupPreview}>
            <LineChart size={44} strokeWidth={1} />
            <div>
              <strong>Your signals. Your canvas.</strong>
              <span>Visual editing · JSON & YAML · OpenUI</span>
            </div>
          </div>
          <p role="alert" className={styles.validationError}>
            {error && error.charAt(0).toUpperCase() + error.slice(1)}
          </p>
          {exampleStarting && <p className={styles.hint} role="status">Opening the example workspace…</p>}
          <div className={styles.actions}>
            {workspaceFailed ? (
              <GammaButton size="sm" variant="primary" className={styles.primary} onClick={reloadPage}>
                Reload the page <RefreshCw size={16} />
              </GammaButton>
            ) : (
              <>
                <GammaButton size="sm" variant="primary"
                  className={styles.primary}
                  disabled={exampleStarting}
                  onClick={() => {
                    setMode("loading")
                    setRetry((value) => value + 1)
                  }}
                >
                  Retry connection
                </GammaButton>
                <GammaButton size="sm" variant="secondary" className={styles.secondary} disabled={exampleStarting} onClick={() => { void enterExample() }}>
                  Explore the example <ArrowUpRight size={16} />
                </GammaButton>
              </>
            )}
          </div>
          <p className={styles.hint}>
            Enable the separate Insights service to connect live data and save
            shared dashboards. Example mode uses generated sample data and
            browser storage.
          </p>
        </div>
      </div>
    )

  return (
    <SavedQueryLibraryProvider queries={savedQueries} variables={dashboard.variables ?? NO_VARIABLES} values={variableValues} loading={queriesLoading} error={queriesError} onOpenExplorer={openQueryExplorer} onRefresh={refreshSavedQueries} onDeclareVariable={declareVariable} dashboardId={dashboard.id}>
    <SourceStatusContext.Provider value={sourceContext}>
    <div ref={layoutRoot} className={`${styles.root} ${gammaTheme.scope}`} data-insights-theme={resolvedTheme} data-density={dense && !editing ? "compact" : "standard"} data-compact-shell={compactShell || undefined} data-phone-shell={phoneShell || undefined} data-widget-focus={focusedWidget || undefined}>
      <GammaConfirmation request={confirmation.request} onResolve={confirmation.resolve} />
      {drawerOpen && (
        <button type="button"
          className={styles.sidebarBackdrop}
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setMobileSidebar(false)}
        />
      )}
      {!focusedWidget && (isMobile ? drawerOpen : sidebarShown) && (
        <aside
          ref={navigation}
          id="insights-navigation"
          className={`${styles.sidebar} ${mobileSidebar ? styles.mobileSidebar : ""} ${compactShell && !compactNavigationExpanded ? styles.compactRail : ""}`}
          data-navigation-expanded={compactShell ? compactNavigationExpanded : undefined}
          aria-label="Insights navigation"
          role={drawerOpen ? "dialog" : undefined}
          aria-modal={drawerOpen ? true : undefined}
          tabIndex={drawerOpen ? -1 : undefined}
        >
          {drawerOpen && (
            <GammaButton iconOnly size="sm" variant="quiet"
              className={styles.iconButton}
              style={{ position: "absolute", top: 12, right: 12 }}
              aria-label="Close navigation"
              onClick={() => setMobileSidebar(false)}
            >
              <X size={17} />
            </GammaButton>
          )}
          <GammaButton size="sm" variant="quiet"
            className={styles.back}
            title={compactShell ? "Back to Paprika" : undefined}
            disabled={importingBundle}
            onClick={async () => {
              if (bundleImportActive.current) return
              if (
                (!dirty && !widgetDraftDirty && !explorerDirty) ||
                await confirmation.ask({ title: "Discard unsaved changes?", description: "Your unsaved dashboard and explorer query changes will be lost when you leave Insights.", action: "Discard changes" })
              )
                onBack?.()
            }}
          >
            <ArrowLeft size={15} /> Back to Paprika
          </GammaButton>
          <div className={styles.wordmark}>
            <span>
              <Activity size={19} />
            </span>
            Insights<span className={styles.previewTag}>preview</span>
          </div>
          <div className={styles.sideLabel}>WORKSPACE</div>
          <GammaButton size="sm" variant="quiet"
            className={styles.sideLink}
            title={compactShell ? "Dashboards — expand navigation to choose a dashboard" : undefined}
            aria-current={!exploring ? "page" : undefined}
            disabled={importingBundle}
            onClick={() => {
              setExploring(false)
              if (!exploring) close()
              setMobileSidebar(false)
            }}
          >
            <LayoutDashboard size={16} /> Dashboards{" "}
            <span>{dashboards.length}</span>
          </GammaButton>
          <GammaButton size="sm" variant="quiet"
            className={styles.sideLink}
            title={compactShell ? "Explore" : undefined}
            aria-current={exploring ? "page" : undefined}
            disabled={importingBundle}
            onClick={() => openQueryExplorer()}
          ><Search size={16} /> Explore <span>{savedQueries.length}</span></GammaButton>
          <GammaButton data-panel-opener="providers" size="sm" variant="quiet"
            className={styles.sideLink}
            title={compactShell ? "Data sources" : undefined}
            disabled={importingBundle}
            onClick={() => openBuilderPanel("providers")}
          >
            <Database size={16} /> Data sources <span>{providers.length}</span>
          </GammaButton>
          <GammaButton data-panel-opener="examples" size="sm" variant="quiet" className={styles.sideLink} title={compactShell ? "Examples" : undefined} disabled={importingBundle} onMouseEnter={preloadExamples} onFocus={preloadExamples} onClick={() => openBuilderPanel("examples")}><FilePlus2 size={16} /> Examples <span>{catalogMeta.count}</span></GammaButton>
          <div className={styles.sideSection}>
            <span className={styles.sideLabel}>YOUR DASHBOARDS</span>
            <GammaButton iconOnly size="sm" variant="quiet"
              className={styles.iconButton}
              aria-label="New dashboard"
              disabled={importingBundle}
              onClick={createDashboard}
            >
              <Plus size={15} />
            </GammaButton>
          </div>
          <label className={styles.search}>
            <Search size={13} />
            <GammaInput
              aria-label="Search dashboards"
              placeholder="Find a dashboard"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <div className={styles.dashboardList}>
            <DashboardTree
              dashboards={dashboards.map((item) =>
                item.id === dashboard.id ? dashboard : item,
              )}
              activeId={dashboard.id}
              search={search}
              onOpen={async (item) => {
                if (await openDashboard(item)) {
                  setExploring(false)
                  setReturnTo(null)
                }
              }}
              onMove={moveDashboard}
            />
          </div>
          <div className={styles.sidebarBottom}>
            <div className={styles.environment}>
              <span className={styles.statusDot} />
              <div>
                <strong>
                  {mode === "example"
                    ? "Example workspace"
                    : "Connected workspace"}
                </strong>
                <span>
                  {mode === "example"
                    ? "Sample data · stored locally"
                    : `${providers.length} configured data sources`}
                </span>
              </div>
            </div>
            <GammaButton data-panel-opener="source" size="sm" variant="quiet"
              className={styles.sideLink}
              disabled={importingBundle}
              onClick={() => openBuilderPanel("source")}
            >
              <Braces size={15} /> Dashboard as code
            </GammaButton>
          </div>
        </aside>
      )}
      <div className={styles.workspace} data-density={dense && !editing && canvasMode === "wide" ? "compact" : "standard"} inert={drawerOpen || undefined}>
        <div className={styles.topbar} data-tooltip-obstacle>
          <div className={styles.breadcrumb}>
            <GammaButton iconOnly size="sm" variant="quiet"
              ref={navigationToggle}
              className={styles.iconButton}
              aria-label="Toggle sidebar"
              aria-expanded={isMobile ? drawerOpen : compactShell ? compactNavigationExpanded && sidebarShown : sidebarShown}
              aria-controls="insights-navigation"
              onClick={() => {
                if (isMobile) setMobileSidebar(!mobileSidebar)
                // Showing the sidebar over an open panel is the user's choice; it stays until they hide it again.
                else if (panelHidden) {
                  setPanelHidesSidebar(false)
                  setSidebarOverride(true)
                } else if (compactShell) setCompactNavigationExpanded(!compactNavigationExpanded)
                else setSidebar(!sidebar)
              }}
            >
              <PanelLeftClose size={17} />
            </GammaButton>
            <span>Insights</span>
            <ChevronRight size={12} />
            <strong>{exploring ? "Explore" : "Dashboards"}</strong>
          </div>
          <div className={styles.topbarRight}>
            <InsightsThemeControl value={theme} onChange={setTheme} className={styles.themeControl} />
            <GammaButton iconOnly size="sm" variant="quiet" aria-label="Copy dashboard link" onClick={async () => {
              try {
                const state = { ...currentRoute, dashboardId: dashboard.id, variables: variableValues }
                const url = new URL(serialiseDashboardView(state, { example: mode === "example" }), location.origin)
                await navigator.clipboard.writeText(url.href)
                setError("")
                setMessage("Dashboard link copied with the current variables and time settings.")
              } catch { setError("Could not copy the link. Copy the current address from your browser.") }
            }}><Link2 size={15} /></GammaButton>
            <span className={styles.modeBadge}>
              <span />
              {mode === "example" ? "Sample data" : "Live providers"}
            </span>
            <GammaButton data-panel-opener="providers" iconOnly size="sm" variant="quiet"
              className={styles.iconButton}
              aria-label="About data sources"
              disabled={importingBundle}
              onClick={() => openBuilderPanel("providers")}
            >
              <CircleHelp size={17} />
            </GammaButton>
          </div>
        </div>
        {explorerOpened && (
          <section hidden={!exploring} className={styles.explorerArea} aria-label="Data source explorer">
            {queriesLoading && <p className={styles.loading} role="status">Loading saved queries…</p>}
            {queriesError && <div role="alert"><p>{queriesError}</p><GammaButton variant="secondary" onClick={() => setLibraryRevision(value => value + 1)}>Reload saved queries</GammaButton></div>}
            {queriesLoaded && <Suspense fallback={<p className={styles.loading}>Loading explorer…</p>}>
              <Explorer key={explorerSource.revision} initialProviderId={explorerSource.providerId} initialSeed={explorerSource.seed} client={libraryClient} providers={providers} queries={savedQueries} onQueriesChange={updateSavedQueries} onDirtyChange={setExplorerDirty} onUse={useSavedQuery} onClose={() => setExploring(false)} active={exploring && !queriesLoading && !queriesError} />
            </Suspense>}
          </section>
        )}
        <section ref={workspaceRegion} tabIndex={-1} hidden={exploring} aria-label="Dashboard workspace">
        <div className={styles.pageHeader} data-tooltip-obstacle>
          <div className={styles.heading}>
            {editing ? (
              <GammaInput
                ref={titleField}
                className={styles.titleInput}
                aria-label="Dashboard title"
                maxLength={120}
                value={dashboard.title}
                onBlur={() => endGroup()}
                onChange={(e) =>
                  update({ ...dashboard, title: e.target.value }, { group: "dashboard:title" })
                }
              />
            ) : (
              <h1>{dashboard.title}</h1>
            )}
            {dashboard.description && (compactShell
              ? <details className={styles.compactDescription}><summary>Dashboard context</summary><p>{dashboard.description}</p></details>
              : isMobile ? <ClampedDescription text={dashboard.description} /> : <p>{dashboard.description}</p>)}
          </div>
          <div className={styles.actions} ref={actionsRegion}>
            {isMobile || compactShell ? <GammaActionMenu
              label="Dashboard actions"
              openerName="dashboard-actions"
              className={styles.iconButton}
              disabled={importingBundle}
              items={dashboardActionItems({ phoneShell, refreshInterval: viewDashboard.refreshInterval, customRange: !!viewDashboard.customTimeRange, history: historyAvailable }, {
                edit: () => { focusTitleOnEdit.current = true; setEditing(true) },
                togglePanel: name => openBuilderPanel(panel === name ? null : name),
                inspectQueries: () => setInspectingQueries(value => !value),
                refresh: changeViewRefresh,
                shortcuts: () => setShortcutsOpen(true),
              })}
            /> : <>
            {historyAvailable && <GammaButton data-panel-opener="history" size="sm" variant="secondary"
              className={styles.secondary}
              disabled={importingBundle}
              onClick={() => openBuilderPanel(panel === "history" ? null : "history")}
            >
              <History size={15} /> History
            </GammaButton>}
            <GammaButton data-panel-opener="manage" size="sm" variant="secondary"
              className={styles.secondary}
              aria-label="Manage dashboards"
              disabled={importingBundle}
              onClick={() => openBuilderPanel(panel === "manage" ? null : "manage")}
            >
              <Settings2 size={15} /> Manage
            </GammaButton>
            <GammaButton data-panel-opener="ai" size="sm" variant="secondary"
              className={styles.secondary}
              disabled={importingBundle}
              onClick={() => openBuilderPanel(panel === "ai" ? null : "ai")}
            >
              <Sparkles size={15} /> Build with AI
            </GammaButton>
            </>}
            {!phoneShell && (editing ? (
              <GammaButton ref={saveButton} size="sm" variant="primary" className={styles.primary} aria-keyshortcuts={ariaKeyshortcutsFor("save")} title={hintFor("save", applePlatform)} disabled={busy || !widgetDraftValid} aria-describedby={!widgetDraftValid ? invalidWidgetSaveHintId : undefined} onClick={save}>
                {busy ? (
                  <Loader2 size={15} className={styles.spin} />
                ) : (
                  <Save size={15} />
                )}{" "}
                Save dashboard
              </GammaButton>
            ) : (
              <GammaButton size="sm" variant="primary"
                iconOnly={compactShell}
                aria-label={compactShell ? "Edit dashboard" : undefined}
                title={compactShell ? "Edit dashboard" : undefined}
                className={styles.primary}
                onClick={() => setEditing(true)}
              >
                <Pencil size={14} />{!compactShell && " Edit dashboard"}
              </GammaButton>
            ))}
          </div>
        </div>
        {editing && !widgetDraftValid && <p id={invalidWidgetSaveHintId} className={styles.saveBlockedHint} role="status">Fix the widget settings to save, or close the editor to keep the last valid preview.</p>}
        <div className={styles.toolbar} data-tooltip-obstacle>
          {!phoneShell && <div className={styles.toolbarLeft}>
            <VariableBar dashboard={dashboard} values={variableValues} loaders={variableLoaders} range={range} onApply={applyDashboardVariables} onDeclareVariable={editing ? declareVariable : undefined} />
            {/* The phone shell holds Code and Queries in the Dashboard actions menu, so the canvas tools row is not shown. */}
            <div className={styles.canvasTools}>
            <span className={styles.canvasTab}>
              <LayoutDashboard size={14} /> Canvas
            </span>
            <GammaButton data-panel-opener="source" size="sm" variant="quiet"
              className={panel === "source" ? styles.activeTool : ""}
              iconOnly={compactShell} aria-label={compactShell ? "Code" : undefined} title={compactShell ? "Dashboard as code" : undefined}
              disabled={importingBundle}
              onClick={() => openBuilderPanel(panel === "source" ? null : "source")}
            >
              <Braces size={14} />{!compactShell && " Code"}
            </GammaButton>
            <GammaButton size="sm" variant="quiet"
              className={inspectingQueries ? styles.activeTool : ""}
              iconOnly={compactShell} aria-label="Query inspector"
              aria-haspopup="dialog" aria-expanded={inspectingQueries} aria-controls={inspectingQueries ? "insights-query-inspector" : undefined}
              title="Inspect query timing, reuse and result bounds"
              onClick={() => setInspectingQueries(value => !value)}>
              <Clock3 size={14} />{!compactShell && " Queries"}
            </GammaButton>
            {canvasMode === "wide" && <>
            <span className={styles.divider} />
            <GammaButton size="sm" variant="quiet" iconOnly={compactShell} aria-label={compactShell ? "Compact view" : undefined} aria-pressed={dense} disabled={editing || canvasMode !== "wide"}
              title={editing ? "Compact view is available when previewing" : canvasMode !== "wide" ? "Compact view is available when the dashboard canvas is wider" : "Icon rail, one-row header and a tighter grid. The saved dashboard is unchanged."}
              className={dense && !editing ? styles.activeTool : ""} onClick={() => setDense(!dense)}>
              <PanelTop size={14} />{!compactShell && " Compact view"}
            </GammaButton>
            </>}
            <span className={styles.widgetCount}>
              {dashboard.widgets.length} widgets
            </span>
            {editing && (
              <>
                <GammaButton iconOnly size="sm" variant="quiet"
                  className={styles.iconButton}
                  aria-label="Undo"
                  aria-keyshortcuts={ariaKeyshortcutsFor("undo")}
                  title={hintFor("undo", applePlatform)}
                  disabled={!canUndo}
                  onClick={undo}
                >
                  <Undo2 size={14} />
                </GammaButton>
                <GammaButton iconOnly size="sm" variant="quiet"
                  className={styles.iconButton}
                  aria-label="Redo"
                  aria-keyshortcuts={ariaKeyshortcutsFor("redo")}
                  title={hintFor("redo", applePlatform)}
                  disabled={!canRedo}
                  onClick={redo}
                >
                  <Redo2 size={14} />
                </GammaButton>
              </>
            )}
            </div>
          </div>}
          <div className={styles.toolbarRight} role={phoneShell ? "group" : undefined} aria-label={phoneShell ? "Dashboard view" : undefined}>
            {phoneShell && <PhoneVariables dashboard={dashboard} values={variableValues} loaders={variableLoaders} range={range} onApply={applyDashboardVariables} />}
            <TimeRangeControl
              key={dashboard.id}
              dashboard={viewDashboard}
              onChange={changeViewRange}
              onReset={viewTimeDiffers(dashboard, viewDashboard) ? resetViewRange : undefined}
              resetLabel={savedRangeLabel(dashboard)}
              customButton={!phoneShell}
              className={phoneShell ? styles.phoneTime : undefined}
            />
            <GammaButton iconOnly size="sm" variant="quiet"
              className={styles.iconButton}
              aria-label="Refresh data"
              onClick={() => {
                advanceEnd(false)
                setRefreshedAt(Date.now())
                setQueryRevision((value) => value + 1)
                setLibraryRevision((value) => value + 1)
              }}
            >
              <RefreshCw size={14} />
            </GammaButton>
            {!phoneShell && <GammaSelect
              className={styles.refreshSelect}
              aria-label="Auto refresh"
              size="sm"
              value={String(viewDashboard.customTimeRange ? 0 : viewDashboard.refreshInterval)}
              disabled={!!viewDashboard.customTimeRange}
              onValueChange={(value) => changeViewRefresh(Number(value) as Dashboard["refreshInterval"])}
              options={[
                {value: "0", label: "Auto off"}, {value: "15", label: "15s"},
                {value: "30", label: "30s"}, {value: "60", label: "1m"},
              ]}
            />}
            {viewDiffers && (
              <GammaButton size="sm" variant="quiet" onClick={setViewAsDefault}>
                Set as dashboard default
              </GammaButton>
            )}
            {editing && (
              <GammaButton data-panel-opener="add" size="sm" variant="quiet"
                className={styles.addButton}
                onClick={() => openBuilderPanel(panel === "add" ? null : "add")}
                disabled={importingBundle || dashboard.widgets.length >= MAX_WIDGETS}
              >
                <Plus size={14} /> Add widget
              </GammaButton>
            )}
          </div>
        </div>
        {inspectingQueries && <Suspense fallback={<p role="status" className={styles.loading}>Loading query inspector…</p>}><QueryInspector store={scheduledFetcher.diagnostics} synthetic={mode === "example"} onClose={() => setInspectingQueries(false)} /></Suspense>}
        {returnTo ? (
          <div className={styles.viewContext}>
            <GammaButton size="sm" variant="quiet" onClick={async () => {
              const target = dashboards.find(item => item.id === returnTo.state.dashboardId)
              if (!target) { setError("The previous dashboard is no longer available."); return }
              if (await openDashboard(target, returnTo.state)) setReturnTo(null)
            }}><ArrowLeft size={14} /> Back to {returnTo.title}</GammaButton>
          </div>
        ) : null}
        {remoteDashboard?.id === dashboard.id && (
          <div className={styles.notice} role="status">
            <span>{remoteDashboard.removed
              ? "The saved dashboard was removed elsewhere. This view is preserved; duplicate it to keep a copy."
              : "The saved dashboard changed elsewhere. Your draft is preserved."}</span>
            {!remoteDashboard.removed && <GammaButton size="sm" variant="secondary" disabled={busy || importingBundle} onClick={reloadRemoteDashboard}>Load latest dashboard</GammaButton>}
          </div>
        )}
        {syncError && <p className={styles.notice} role="status">Workspace updates paused: {syncError} Retrying automatically.</p>}
        {/* One persistent live region for the source banner: it exists before its content changes. */}
        <div ref={sourceNoticeRef} role="status" tabIndex={-1} data-source-state={sources.status === "unavailable" ? sources.reason : sources.status} className={sources.status === "unavailable" ? styles.notice : undefined}>
          {sources.status === "unavailable" && (
            <>
              <span>{sourceBannerCopy(sources)}</span>
              {sources.reason === "signin" && client.signIn ? (
                <GammaButton size="sm" variant="secondary" onClick={() => client.signIn?.()}>Sign in again</GammaButton>
              ) : (
                <GammaButton ref={bannerRetry} size="sm" variant="secondary" onClick={retrySources}>Retry data sources</GammaButton>
              )}
            </>
          )}
        </div>
        {(error || message) && (
          <div
            className={`${styles.notice} ${error ? styles.errorNotice : ""}`}
            role={error ? "alert" : "status"}
          >
            {!error && <Check size={14} />}
            <span>{error || message}</span>
            {!error && messageAction?.text === message && (
              <GammaButton size="sm" variant="secondary" aria-label={messageAction.name} onClick={() => {
                const action = messageAction
                setMessageAction(undefined)
                action.run()
              }}>{messageAction.label}</GammaButton>
            )}
            <GammaButton iconOnly size="sm" variant="quiet"
              className={styles.iconButton}
              aria-label="Dismiss message"
              onClick={() => {
                setError("")
                setMessage("")
                setMessageAction(undefined)
              }}
            >
              <X size={14} />
            </GammaButton>
          </div>
        )}
        {saveFindings && error === saveFindings.message && (
          <Suspense fallback={null}><ChecksList label="Save checks" report={saveFindings.report} dashboard={dashboard} onFocusWidget={selectWidget} /></Suspense>
        )}
        {/* Always mounted, so a notice is announced when its content appears. */}
        <div role="status" data-link-notice>
          {linkNotice && (
            <div className={styles.notice}>
              <span>{linkNotice}</span>
              <GammaButton iconOnly size="sm" variant="quiet"
                className={styles.iconButton}
                aria-label="Dismiss link notice"
                onClick={() => setLinkNotice("")}
              >
                <X size={14} />
              </GammaButton>
            </div>
          )}
        </div>
        <div className={styles.workArea}>
          <div className={styles.canvasArea}>
            {editing && !focusedWidget && (
              <div className={styles.editHint}>
                <span className={styles.statusDot} /> Editing canvas{" "}
                <span className={styles.wideEditHint}>
                  Drag a handle to move. Pull an edge or corner to resize.
                </span>
                <span className={styles.compactEditHint}>
                  {"Use a widget's ⋯ menu to move, resize or duplicate it."}
                </span>
                {/* Phone-width layouts and touch-only devices have no use for the list, so it stays hidden there. */}
                {!phoneViewport && (
                  <GammaButton size="sm" variant="quiet" className={styles.shortcutsButton} onClick={() => setShortcutsOpen(true)}>
                    Keyboard shortcuts
                  </GammaButton>
                )}
                <GammaButton size="sm" variant="quiet"
                  disabled={importingBundle}
                  onClick={() => {
                    setEditing(false)
                    close()
                  }}
                >
                  Preview
                </GammaButton>
              </div>
            )}
            {dashboard.widgets.length ? (
              <DashboardCanvas
                dashboard={viewDashboard}
                sidePanelOpen={!!panel && panel !== "widget"}
                focus={editingWidget && currentWidget && previewWidget ? {
                  widget: previewWidget,
                  render: (preview, previewFootprints) => <section ref={builderPanel} tabIndex={-1}>
                <LazyPanelBoundary label="Widget editor" unsaved={dirty || widgetDraftDirty} onClose={leaveWidget}>
                <Suspense fallback={<WidgetEditorSkeleton preview={preview} onClose={leaveWidget} />}>
                    <WidgetEditor
                      key={currentWidget.id}
                      widget={currentWidget}
                      workspace={{ preview, previewFootprints, canvasMode, dashboardTitle: dashboard.title, dashboardDirty: dirty, saveBusy: busy || !widgetDraftValid, onSaveDashboard: save, onDiscard: close, widgets: dashboard.widgets }}
                      onPreview={setWidgetPreview}
                      onDirtyChange={setWidgetDraftDirty}
                      dashboards={dashboards.map(item => item.id === dashboard.id ? dashboard : item)}
                      providers={providers}
                      client={builderClient}
                      range={range}
                      queryFetcher={fetcher}
                      queryFields={currentWidget.id === queryFieldSnapshot?.widgetId && queryFieldSnapshot.fetcher === fetcher && queryFieldSnapshot.key === queryConnectionKey(previewWidget ?? currentWidget, range) ? queryFieldSnapshot.fields : undefined}
                      result={currentWidget.id === queryResultSnapshot?.widgetId && queryResultSnapshot.fetcher === fetcher ? queryResultSnapshot.result : undefined}
                      onClose={leaveWidget}
                      onCommands={registerChartCommands}
                      onDraftValidityChange={setWidgetDraftValid}
                      onApply={(next, layout, options) => {
                        const applied = applyChartToDashboard(latestDocument.current, next, layout)
                        if (options?.save && !busy) {
                          // Normalizing the form values joins the apply in one undo step: the document is written as it
                          // is applied, so the save below has nothing left to normalize. A document that will not
                          // parse is left as it is, and the save reports the error.
                          let sent = applied
                          try { sent = dashboardAsSent(applied) } catch { /* reported by saveDocument */ }
                          update(sent)
                          close()
                          void saveDocument(sent, { chartApplied: true, focusWidget: next.id })
                          return
                        }
                        update(applied)
                        close()
                        // The notice offers the save as its action, so the user need not find the header button.
                        const text = "Chart changes applied. Save the dashboard to keep them."
                        setMessage(text)
                        // Named "Save now", not "Save dashboard": the header button keeps that name, and e2e suites find it by name.
                        setMessageAction({ text, label: "Save now", name: "Save now", run: () => saveLatest.current() })
                      }}
                      onDelete={() => {
                        removeTile(currentWidget.id)
                        close()
                      }}
                      onDuplicate={() => {
                        if (dashboard.widgets.length >= MAX_WIDGETS) {
                          setError("A dashboard supports up to 48 widgets.")
                          return
                        }
                        // The copy holds the chart as it is in the editor, unapplied changes included. Its footprint is the
                        // draft's, and it is placed beside the saved tile or below it. The original is never resized.
                        const draft = previewWidget ?? currentWidget
                        const copyId = `widget-${crypto.randomUUID()}`
                        const edit = duplicateLayout(savedLayout(dashboard.widgets), currentWidget.id, copyId, { w: draft.layout.w, h: draft.layout.h })
                        if ("blocked" in edit) {
                          setError(edit.blocked)
                          return
                        }
                        const placed = new Map(edit.layout.map((item) => [item.i, item]))
                        const moved = dashboard.widgets.map((item) => {
                          const at = placed.get(item.id)
                          return at ? { ...item, layout: { ...item.layout, x: at.x, y: at.y } } : item
                        })
                        const at = placed.get(copyId)!
                        const copy = {
                          ...draft,
                          id: copyId,
                          title: `${draft.title.slice(0, 113)} (copy)`,
                          layout: { ...draft.layout, x: at.x, y: at.y, w: at.w, h: at.h },
                        }
                        const next = { ...dashboard, widgets: [...moved, copy] }
                        update(next)
                        selectWidget(copy.id)
                        const where = placementPhrase(edit.placement)
                        noticeWithUndo({
                          // A clean draft has no unapplied changes to call out, so the copy is described like a tile copy.
                          text: widgetDraftDirty
                            ? "Duplicated with your unapplied changes; the original is unchanged."
                            : `Duplicated ${draft.title}${where}.`,
                          name: `Undo duplicate ${draft.title}`,
                          document: next,
                          focus: currentWidget.id,
                          restored: "Removed the copy.",
                          // The editor's opener was the copy, which Undo removes. The original takes its place as the opener.
                          leave: () => {
                            widgetOpener.current = currentWidget.id
                            close()
                          },
                        })
                      }}
                    />
                  <MountSignal onMount={markEditorMounted} />
                </Suspense>
                </LazyPanelBoundary>
                  </section>,
                } : undefined}
                active={!exploring}
                onDrilldown={drilldown}
                onSelection={selectDashboardContext}
                variables={variableValues}
                onTimeRange={selectDashboardTime}
                providers={providers}
                fetcher={fetcher}
                tooltipFetcher={scheduledFetcher}
                end={alignedEnd}
                refreshStaggerMs={autoTick && !editing ? refreshStaggerSpread(viewDashboard.refreshInterval ?? 0) : 0}
                editing={editing}
                dense={dense}
                referenceCompact={compactShell && finePointer}
                onModeChange={setCanvasMode}
                selected={selected}
                onSelect={selectWidget}
                onLayout={layoutUpdate}
                onDuplicate={duplicateTile}
                onRemove={removeTile}
                duplicateBlocked={dashboard.widgets.length >= MAX_WIDGETS ? "A dashboard supports up to 48 widgets." : undefined}
                onQueryFields={setQueryFieldSnapshot}
                onQueryResult={setQueryResultSnapshot}
              />
            ) : (
              <div className={styles.emptyCanvas}>
                <LayoutDashboard size={38} strokeWidth={1} />
                <h2>Start with a signal.</h2>
                <p>
                  Add a widget, bring a dashboard document, or let your AI
                  assistant help shape your view.
                </p>
                <div className={styles.actions}>
                  <GammaButton data-panel-opener="add" size="sm" variant="primary"
                    className={styles.primary}
                    disabled={importingBundle}
                    onClick={() => {
                      setEditing(true)
                      openBuilderPanel("add")
                    }}
                  >
                    <Plus size={15} /> Add your first widget
                  </GammaButton>
                  <GammaButton data-panel-opener="source" size="sm" variant="secondary"
                    className={styles.secondary}
                    disabled={importingBundle}
                    onClick={() => openBuilderPanel("source")}
                  >
                    <FilePlus2 size={15} /> Import dashboard
                  </GammaButton>
                  {client.listStarters && client.getStarter && (
                    <GammaButton data-panel-opener="starters" size="sm" variant="secondary"
                      className={styles.secondary}
                      disabled={importingBundle}
                      onClick={() => openBuilderPanel("starters")}
                    >
                      <LayoutTemplate size={15} /> Start from a template
                    </GammaButton>
                  )}
                </div>
              </div>
            )}
            {!focusedWidget && <footer className={styles.canvasFooter}>
              <span>
                {mode === "example"
                  ? "Generated sample data"
                  : "Provider queries run server-side"}
              </span>
              <span>
                {dirty ? "Unsaved changes" : "All changes saved"}
                <span className={dirty ? styles.unsavedDot : styles.savedDot} />
              </span>
            </footer>}
          </div>
          {panel && panel !== "widget" && (
            <aside
              ref={builderPanel}
              tabIndex={-1}
              className={`${styles.panel} ${(panel === "source" || panel === "examples") && widePanel ? styles.widePanel : ""}`}
              aria-label="Builder panel"
            >
              {panel === "examples" && (workspaceFailed ? (
                <LazyFailure label="Dashboard examples" kind="load" unsaved={dirty || widgetDraftDirty} onClose={close} />
              ) : workspace ? (
                <LazyPanelBoundary label="Dashboard examples" unsaved={dirty || widgetDraftDirty} onClose={close}>
                  <Suspense fallback={<p className={styles.loading} role="status">Loading examples…</p>}>
                    <RepositoryGallery entries={workspace.repositoryExamples} mode={mode === "example" ? "example" : "live"} providers={providers} onImportBundle={importBundle} onReviewBundle={reviewBundle} validateDocument={client.validate} onRefreshQueries={refreshSavedQueries} onClose={close} />
                    <MountSignal onMount={markGalleryMounted} />
                  </Suspense>
                </LazyPanelBoundary>
              ) : <p className={styles.loading} role="status">Loading examples…</p>)}
              {panel === "starters" && client.listStarters && client.getStarter && (
                <LazyPanelBoundary label="Templates" unsaved={dirty || widgetDraftDirty} onClose={close}>
                  <Suspense fallback={<p className={styles.loading} role="status">Loading templates…</p>}>
                    <StarterPicker
                      listStarters={client.listStarters}
                      getStarter={client.getStarter}
                      providers={providers}
                      onImportBundle={importBundle}
                      onReviewBundle={reviewBundle}
                      validateDocument={client.validate}
                      onRefreshQueries={refreshSavedQueries}
                      onClose={close}
                    />
                  </Suspense>
                </LazyPanelBoundary>
              )}
              {panel === "source" && (
                <LazyPanelBoundary label="Dashboard source" unsaved={dirty || widgetDraftDirty} onClose={close}>
                  <Suspense fallback={<p className={styles.loading} role="status">Loading dashboard source…</p>}>
                    <DocumentEditor
                      key={dashboard.id}
                      dashboard={dashboard}
                      providers={providers}
                      onImportBundle={importBundle}
                      onReviewBundle={reviewBundle}
                      onRefreshQueries={refreshSavedQueries}
                      checkDocument={client.validate}
                      onFocusWidget={selectWidget}
                      onApply={applyDocument}
                      onClose={close}
                    />
                    <MountSignal onMount={markSourceMounted} />
                  </Suspense>
                </LazyPanelBoundary>
              )}
              {panel === "ai" && (
                <Suspense
                  fallback={
                    <p className={styles.loading}>Loading AI builder…</p>
                  }
                >
                  <AIBuilder
                    dashboard={dashboard}
                    providers={providers}
                    onApply={applyDocument}
                    onClose={close}
                    checkDocument={client.validate}
                    onFocusWidget={selectWidget}
                    observe={!!client.observeConnection}
                    unsaved={dirty}
                  />
                </Suspense>
              )}
              {panel === "add" && (
                <WidgetLibrary
                  onAdd={addWidget}
                  onClose={close}
                  onAI={() => openBuilderPanel("ai")}
                  disabled={dashboard.widgets.length >= MAX_WIDGETS}
                />
              )}
              {panel === "providers" && (
                <LazyPanelBoundary label="Data sources" unsaved={dirty || widgetDraftDirty} onClose={close}>
                  <Suspense fallback={<p className={styles.loading} role="status">Loading data sources…</p>}>
                    <ProviderManager
                      client={client}
                      providers={providers}
                      unsupportedProviders={unsupportedProviders}
                      example={mode === "example"}
                      onClose={close}
                      onExplore={exploreProvider}
                      loadCatalog={refreshCatalog}
                      onChange={(catalog) => {
                        // The manager's listing is authoritative now: it replaces any failed or pending load.
                        acceptCatalog(catalog)
                        setSourceRequest(null)
                        setQueryRevision((value) => value + 1)
                        setLibraryRevision((value) => value + 1)
                      }}
                    />
                    <MountSignal onMount={markProvidersMounted} />
                  </Suspense>
                </LazyPanelBoundary>
              )}
              {panel === "history" && (
                <LazyPanelBoundary label="Revision history" unsaved={dirty || widgetDraftDirty} onClose={close}>
                  <Suspense fallback={<p className={styles.loading} role="status">Loading history…</p>}>
                    <DashboardHistory
                      key={dashboard.id}
                      dashboard={dashboard}
                      client={client}
                      canRestore={!dirty && !widgetDraftDirty && !busy && !importingBundle}
                      refreshKey={saved}
                      onRestored={applyRestoredDocument}
                      onClose={close}
                      savedQueries={savedQueries}
                    />
                  </Suspense>
                </LazyPanelBoundary>
              )}
              {panel === "manage" && (
                <LazyPanelBoundary label="Manage dashboards" unsaved={dirty || widgetDraftDirty} onClose={close}>
                  <Suspense fallback={<p className={styles.loading} role="status">Loading dashboard manager…</p>}>
                    <DashboardManager
                      key={dashboard.id}
                      dashboard={dashboard}
                      dashboards={dashboards}
                      providers={providers}
                      variableCatalog={variableCatalog}
                      busy={busy}
                      onClose={close}
                      onApply={(next) => {
                        syncVariableDefinitions(next)
                        update(next)
                        setEditing(true)
                      }}
                      onDetailsChange={(next, group) => {
                        update(next, { group })
                        setEditing(true)
                      }}
                      onDetailsEnd={endGroup}
                      onDuplicate={duplicateDashboard}
                      onDelete={deleteDashboard}
                      onImportBundle={importBundle}
                      onReviewBundle={reviewBundle}
                      validateDocument={client.validate}
                      onRefreshQueries={refreshSavedQueries}
                    />
                    <MountSignal onMount={markManageMounted} />
                  </Suspense>
                </LazyPanelBoundary>
              )}

            </aside>
          )}
        </div>
        </section>
      </div>
    {shortcutsOpen && <Suspense fallback={null}><ShortcutList isMac={applePlatform} onClose={() => setShortcutsOpen(false)} /></Suspense>}
    </div>
    </SourceStatusContext.Provider>
    </SavedQueryLibraryProvider>
  )
}

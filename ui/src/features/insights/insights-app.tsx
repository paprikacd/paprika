"use client"

import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react"
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
  saveExampleWorkspace,
  writeExampleWorkspace,
} from "./example-storage"
import { assertProviderQueryTemplate } from "./provider-query-template"
import catalogMeta from "./repository-examples/catalog-meta.json"
import { LazyFailure, LazyPanelBoundary, MountSignal, reloadPage } from "./lazy-panel"
import { WidgetEditorSkeleton } from "./widget-editor-skeleton"
import { SavedQueryLibraryProvider } from "./saved-query-context"
import { queryConnectionKey } from "./query-connections"
import "./saved-query-storage"
import { loadBundleImportReview, type BundleImportRequest } from "./bundle-import"
import { resolveSavedQueryReference } from "./saved-queries"
import type { DashboardBundle } from "./workspace-transfer"
import { documentFingerprint } from "./fingerprint"
import "./use-mobile-navigation"
import { dashboardActionItems } from "./dashboard-actions"
import "./use-builder-panel-focus"
import type { ExplorerSeed } from "./saved-query-context"
import "./history"
import "./use-insights-shortcuts"
import { ariaKeyshortcutsFor, hintFor, OVERLAY_SELECTOR } from "./shortcuts"
import "./use-workspace-refresh"
import { DashboardCanvas } from "./canvas"
import { EmbedView } from "./embed-view"
import type { EmbedRequest } from "./embed-request"
import { refreshStaggerSpread } from "./refresh-stagger"

import "./tile-controls"
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
import { checksFromError } from "./client"
import { SourceStatusContext, sourceWaitMessage } from "./source-status"
import { GammaButton } from "./gamma/button"
import { GammaInput } from "./gamma/input"
import { GammaSelect } from "./gamma/select"
import { GammaConfirmation } from "./gamma/confirmation"
import "./gamma/scroll-lock"
import gammaTheme from "./gamma/gamma-theme.module.css"
import { PhoneVariables, VariableBar } from "./dashboard-variables"
import { ClampedDescription } from "./dashboard-description"
import { sourceQueryStep, variableValueScope, type VariableValueLoaders } from "./variable-options"
import type { VariableSourceCatalog } from "./variable-source-editor"
import { InsightsThemeControl } from "./insights-theme"
import { describeIgnoredLink, resolveDashboardVariables, resolveApplicationLink, resolveDrilldown, resolveLinkView, resolveSelectionBindings, interpolateQuery, type DashboardNavigation, type DrilldownContext } from "./drilldown"
import { duplicateLayout, savedLayout } from "./layout-edit"

import { readDashboardLink, serialiseDashboardView, viewTimeDiffers } from "./dashboard-view"
import { DashboardHistory, Explorer, ShortcutList, QueryInspector, DocumentEditor, ProviderManager, DashboardManager, ChecksList, AIBuilder, WidgetEditor, RepositoryGallery, StarterPicker, preloadExamples } from "./shell/lazy-panels"
import { placementPhrase } from "./shell/navigation"
import { sourceBannerCopy } from "./shell/source-catalog"
import "./shell/media-stores"
import { MANUAL_REFRESH_BYPASS_MS, NO_VARIABLES, UNAPPLIED_CHART_NOTICE } from "./shell/constants"
import { useWorkspace } from "./shell/use-workspace"
import { useSavedQueryLibrary } from "./shell/use-saved-query-library"
import { useDashboardSession } from "./shell/use-dashboard-session"
import { useShellLayout } from "./shell/use-shell-layout"
import { useSourceCatalog } from "./shell/use-source-catalog"
import { useLiveSync } from "./shell/use-live-sync"
import { useTileActions } from "./shell/use-tile-actions"
import { useWorkspaceBoot } from "./shell/use-workspace-boot"


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
  const [
    acceptCatalog,
    advanceEnd,
    autoTick,
    bannerRetry,
    bundleImportActive,
    bundleImporter,
    catalogWaiters,
    end,
    etags,
    focusBannerRetry,
    lastSyncInputs,
    openRequest,
    queryRevision,
    refreshCatalog,
    refreshedAt,
    retry,
    retryFocus,
    retrySources,
    setQueryRevision,
    setRefreshedAt,
    setRetry,
    setSourceRequest,
    setSources,
    sourceContext,
    sourceNoticeRef,
    sourceRequest,
    sources,
    workspaceRegion,
  ] = useSourceCatalog(
    client,
    editing,
    mode,
    sessionRevision,
    setProviders,
    setUnsupportedProviders,
  )
  const [
    dirty,
    focusTitleOnEdit,
    saveButton,
    syncError,
    titleField,
    variableValues,
    viewDashboard,
    viewDiffers,
  ] = useLiveSync(
    applyView,
    busy,
    client,
    currentRoute,
    dashboard,
    dashboards,
    editing,
    etags,
    explorerDirty,
    importingBundle,
    lastSyncInputs,
    libraryMutation,
    mode,
    openRequest,
    panel,
    queriesLoading,
    reset,
    saved,
    savedQueries,
    setDashboards,
    setQueriesError,
    setQueriesLoaded,
    setRemoteDashboard,
    setSaved,
    updateSavedQueries,
  )
  const [
    actionsRegion,
    applePlatform,
    builderPanel,
    chartCommands,
    currentWidget,
    duplicateTile,
    editingWidget,
    focusAfterSave,
    focusedWidget,
    noticeWithUndo,
    phoneShell,
    previewWidget,
    queryFieldSnapshot,
    queryResultSnapshot,
    registerChartCommands,
    removeTile,
    setQueryFieldSnapshot,
    setQueryResultSnapshot,
    setSaveRevision,
  ] = useTileActions(
    busy,
    confirmation,
    dashboard,
    editing,
    editorMounted,
    exploring,
    galleryMounted,
    importingBundle,
    latestDocument,
    layoutRoot,
    mountedPanels,
    panel,
    panelOpener,
    phoneViewport,
    redo,
    saveButton,
    selected,
    setError,
    setMessage,
    setMessageAction,
    setShortcutsOpen,
    setWorkspace,
    setWorkspaceFailed,
    titleField,
    undo,
    update,
    widgetDraftDirty,
    widgetOpener,
    widgetPreview,
    workspace,
    workspaceFailed,
  )

  const [
    enterExample,
  ] = useWorkspaceBoot(
    acceptCatalog,
    advanceEnd,
    applyView,
    bannerRetry,
    catalogWaiters,
    client,
    dirty,
    drawerOpen,
    etags,
    exampleGeneration,
    explorerDirty,
    focusBannerRetry,
    importingBundle,
    initialExample,
    mode,
    mounted,
    navigation,
    navigationToggle,
    reset,
    retry,
    retryFocus,
    setDashboards,
    setError,
    setExampleStarting,
    setLinkNotice,
    setMobileSidebar,
    setMode,
    setProviders,
    setSaved,
    setSourceRequest,
    setSources,
    setUnsupportedProviders,
    setWorkspace,
    setWorkspaceFailed,
    showView,
    sourceNoticeRef,
    sourceRequest,
    sources,
    viewDashboard,
    widgetDraftDirty,
    workspaceRegion,
  )

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
  }, [setMessage, setMessageAction, setPanel, setSelected, setSidebarOverride, setWidgetDraftDirty, setWidgetPreview, bundleImportActive])
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
  }, [panelOpener, setEditing, setMessage, setMobileSidebar, setPanel, setSelected, setWidgetDraftDirty, setWidgetPreview, widgetOpener, bundleImportActive])
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
  // The notice's Save now runs the latest save. It works from view mode too, where the header save button is gone.
  const saveLatest = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    saveLatest.current = () => { if (!busy) void save() }
  })
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

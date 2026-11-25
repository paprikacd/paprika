"use client"

import { Suspense } from "react"
import "./gamma/action-menu"
import type { InsightsClient } from "./client"
import "./layout-compaction"
import "./schema"
import "./example"
import "./example-storage"
import "./provider-query-template"
import "./repository-examples/catalog-meta.json"
import "./lazy-panel"
import "./widget-editor-skeleton"
import { SavedQueryLibraryProvider } from "./saved-query-context"
import "./query-connections"
import "./saved-query-storage"
import "./bundle-import"
import "./saved-queries"
import "./fingerprint"
import "./use-mobile-navigation"
import "./dashboard-actions"
import "./use-builder-panel-focus"
import "./history"
import "./use-insights-shortcuts"
import "./shortcuts"
import "./use-workspace-refresh"
import "./canvas"
import { EmbedView } from "./embed-view"
import type { EmbedRequest } from "./embed-request"
import "./refresh-stagger"

import "./tile-controls"
import "./canvas-density"
import "./responsive-layout"
import "./query"
import "./dashboard-library"
import "./chart-apply"
import "./time-range"
import "./widget-library"
import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge"
import styles from "./insights.module.css"
import "./client"
import { SourceStatusContext } from "./source-status"
import "./gamma/button"
import "./gamma/input"
import "./gamma/select"
import { GammaConfirmation } from "./gamma/confirmation"
import "./gamma/scroll-lock"
import gammaTheme from "./gamma/gamma-theme.module.css"
import "./dashboard-variables"
import "./dashboard-description"
import "./variable-options"
import "./insights-theme"
import "./drilldown"
import "./layout-edit"

import "./dashboard-view"
import { ShortcutList } from "./shell/lazy-panels"
import { NO_VARIABLES } from "./shell/constants"
import { useWorkspace } from "./shell/use-workspace"
import { useWorkspaceBackend } from "./shell/workspace-backend"
import { useSavedQueryLibrary } from "./shell/use-saved-query-library"
import { useDashboardSession } from "./shell/use-dashboard-session"
import { useShellLayout } from "./shell/use-shell-layout"
import { useSourceCatalog } from "./shell/use-source-catalog"
import { useLiveSync } from "./shell/use-live-sync"
import { useTileActions } from "./shell/use-tile-actions"
import { useWorkspaceBoot } from "./shell/use-workspace-boot"
import { useDashboardData } from "./shell/use-dashboard-data"
import { usePanels } from "./shell/use-panels"
import { useDocumentActions } from "./shell/use-document-actions"
import { useViewActions } from "./shell/use-view-actions"
import { renderPanelRouter } from "./shell/panel-router"
import { renderUnavailableScreen } from "./shell/unavailable-screen"
import { renderLoadingScreen } from "./shell/loading-screen"
import { renderCanvasArea } from "./shell/canvas-area"
import { renderWorkspaceNotices } from "./shell/workspace-notices"
import { renderDashboardToolbar } from "./shell/dashboard-toolbar"
import { renderDashboardHeader } from "./shell/dashboard-header"
import { renderDashboardTopbar } from "./shell/dashboard-topbar"
import { renderInsightsSidebar } from "./shell/insights-sidebar"


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
    backend,
  ] = useWorkspaceBackend(
    client,
    activeExample,
  )
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
    backend,
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
    backend,
    dashboard,
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

  const [
    alignedEnd,
    builderClient,
    fetcher,
    range,
    scheduledFetcher,
    variableCatalog,
    variableLoaders,
  ] = useDashboardData(
    backend,
    end,
    principal,
    providers,
    queriesError,
    queriesLoading,
    queryRevision,
    refreshedAt,
    savedQueries,
    sourceContext,
    variableValues,
    viewDashboard,
  )
  const [
    close,
    leaveWidget,
    navigateFromChart,
    openBuilderPanel,
    selectWidget,
    showPanel,
  ] = usePanels(
    bundleImportActive,
    compactShell,
    confirmation,
    editing,
    exploring,
    focusedWidget,
    isMobile,
    layoutRoot,
    navigation,
    panel,
    panelOpener,
    planRevision,
    setEditing,
    setExploring,
    setMessage,
    setMessageAction,
    setMobileSidebar,
    setPanel,
    setPanelHidesSidebar,
    setSelected,
    setSidebarOverride,
    setWidePanel,
    setWidgetDraftDirty,
    setWidgetPreview,
    sidebar,
    sidebarOpenWidth,
    sidebarOverride,
    widgetDraftDirty,
    widgetOpener,
  )
  const [
    addWidget,
    applyDocument,
    confirmDiscard,
    declareVariable,
    drilldown,
    layoutUpdate,
    openDashboard,
    save,
    saveDocument,
    saveLatest,
    selectDashboardContext,
    selectDashboardTime,
    syncVariableDefinitions,
    useSavedQuery,
  ] = useDocumentActions(
    advanceEnd,
    applyView,
    backend,
    busy,
    chartCommands,
    close,
    confirmation,
    currentRoute,
    dashboard,
    dashboards,
    dirty,
    etags,
    focusAfterSave,
    latestDocument,
    navigateFromChart,
    onOpenApplication,
    openRequest,
    providers,
    range,
    reflectView,
    reset,
    saved,
    selectWidget,
    setBusy,
    setDashboards,
    setEditing,
    setError,
    setExploring,
    setLinkNotice,
    setMessage,
    setMessageAction,
    setMobileSidebar,
    setReturnTo,
    setSaveFindings,
    setSaveRevision,
    setSaved,
    update,
    variableValues,
    widgetDraftDirty,
    widgetDraftValid,
  )

  const [
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
  ] = useViewActions(
    advanceEnd,
    applyView,
    backend,
    bundleImportActive,
    bundleImporter,
    busy,
    client,
    close,
    confirmDiscard,
    confirmation,
    currentRoute,
    dashboard,
    dashboards,
    dirty,
    editing,
    etags,
    explorerDirty,
    importingBundle,
    latestDocument,
    libraryClient,
    libraryMutation,
    openRequest,
    panel,
    panelOpener,
    providers,
    reset,
    saveButton,
    setBusy,
    setDashboards,
    setEditing,
    setError,
    setExplorerDirty,
    setExplorerOpened,
    setExplorerSource,
    setExploring,
    setImportingBundle,
    setLibraryRevision,
    setLinkNotice,
    setMessage,
    setMobileSidebar,
    setQueryRevision,
    setRemoteDashboard,
    setReturnTo,
    setSaved,
    showPanel,
    update,
    updateSavedQueries,
    viewDashboard,
    widgetDraftDirty,
  )

  if (mode === "loading")
    return (
      renderLoadingScreen(resolvedTheme)
    )
  if (mode === "unavailable")
    return (
      renderUnavailableScreen(enterExample, error, exampleStarting, resolvedTheme, setMode, setRetry, workspaceFailed)
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
      {renderInsightsSidebar(backend, bundleImportActive, close, compactNavigationExpanded, compactShell, confirmation, createDashboard, dashboard, dashboards, dirty, drawerOpen, explorerDirty, exploring, focusedWidget, importingBundle, isMobile, mobileSidebar, moveDashboard, navigation, onBack, openBuilderPanel, openDashboard, openQueryExplorer, providers, savedQueries, search, setExploring, setMobileSidebar, setReturnTo, setSearch, sidebarShown, widgetDraftDirty)}
      <div className={styles.workspace} data-density={dense && !editing && canvasMode === "wide" ? "compact" : "standard"} inert={drawerOpen || undefined}>
        {renderDashboardTopbar(backend, compactNavigationExpanded, compactShell, currentRoute, dashboard, drawerOpen, explorerOpened, explorerSource, exploring, importingBundle, isMobile, libraryClient, mobileSidebar, navigationToggle, openBuilderPanel, panelHidden, providers, queriesError, queriesLoaded, queriesLoading, savedQueries, setCompactNavigationExpanded, setError, setExplorerDirty, setExploring, setLibraryRevision, setMessage, setMobileSidebar, setPanelHidesSidebar, setSidebar, setSidebarOverride, setTheme, sidebar, sidebarShown, theme, updateSavedQueries, useSavedQuery, variableValues)}
        <section ref={workspaceRegion} tabIndex={-1} hidden={exploring} aria-label="Dashboard workspace">
        {renderDashboardHeader(actionsRegion, applePlatform, busy, changeViewRefresh, compactShell, dashboard, editing, endGroup, focusTitleOnEdit, historyAvailable, importingBundle, invalidWidgetSaveHintId, isMobile, openBuilderPanel, panel, phoneShell, save, saveButton, setEditing, setInspectingQueries, setShortcutsOpen, titleField, update, viewDashboard, widgetDraftValid)}
        {renderDashboardToolbar(advanceEnd, applePlatform, applyDashboardVariables, canRedo, canUndo, canvasMode, changeViewRange, changeViewRefresh, compactShell, dashboard, declareVariable, dense, editing, importingBundle, inspectingQueries, invalidWidgetSaveHintId, openBuilderPanel, panel, phoneShell, range, redo, resetViewRange, setDense, setInspectingQueries, setLibraryRevision, setQueryRevision, setRefreshedAt, setViewAsDefault, undo, variableLoaders, variableValues, viewDashboard, viewDiffers, widgetDraftValid)}
        {renderWorkspaceNotices(backend, bannerRetry, busy, client, dashboard, dashboards, error, importingBundle, inspectingQueries, linkNotice, message, messageAction, openDashboard, reloadRemoteDashboard, remoteDashboard, retrySources, returnTo, saveFindings, scheduledFetcher, selectWidget, setError, setInspectingQueries, setLinkNotice, setMessage, setMessageAction, setReturnTo, sourceNoticeRef, sources, syncError)}
        <div className={styles.workArea}>
          {renderCanvasArea(alignedEnd, autoTick, backend, builderClient, builderPanel, busy, canvasMode, client, close, compactShell, currentWidget, dashboard, dashboards, dense, dirty, drilldown, duplicateTile, editing, editingWidget, exploring, fetcher, finePointer, focusedWidget, importingBundle, latestDocument, layoutUpdate, leaveWidget, markEditorMounted, noticeWithUndo, openBuilderPanel, panel, phoneViewport, previewWidget, providers, queryFieldSnapshot, queryResultSnapshot, range, registerChartCommands, removeTile, save, saveDocument, saveLatest, scheduledFetcher, selectDashboardContext, selectDashboardTime, selectWidget, selected, setCanvasMode, setEditing, setError, setMessage, setMessageAction, setQueryFieldSnapshot, setQueryResultSnapshot, setShortcutsOpen, setWidgetDraftDirty, setWidgetDraftValid, setWidgetPreview, update, variableValues, viewDashboard, widgetDraftDirty, widgetDraftValid, widgetOpener)}
          {panel && panel !== "widget" && (
            renderPanelRouter(acceptCatalog, addWidget, applyDocument, applyRestoredDocument, backend, builderPanel, busy, client, close, dashboard, dashboards, deleteDashboard, dirty, duplicateDashboard, endGroup, exploreProvider, importBundle, importingBundle, markGalleryMounted, markManageMounted, markProvidersMounted, markSourceMounted, openBuilderPanel, panel, providers, refreshCatalog, refreshSavedQueries, reviewBundle, saved, savedQueries, selectWidget, setEditing, setLibraryRevision, setQueryRevision, setSourceRequest, syncVariableDefinitions, unsupportedProviders, update, variableCatalog, widePanel, widgetDraftDirty, workspace, workspaceFailed)
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

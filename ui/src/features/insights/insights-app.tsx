"use client"
/* eslint-disable react-hooks/immutability, react-hooks/refs -- the React Compiler lint skipped this component while it was one 2,600-line function. Its JSX handlers set refs from the shell hooks, as they did before the split, and it hands refs to the shell render functions, which only attach them as ref props */

import { Suspense } from "react"
import "react-dom"
import {
  Activity,
  ArrowLeft,
  Braces,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Database,
  FilePlus2,
  LayoutDashboard,
  LayoutTemplate,
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
import "react-grid-layout"
import type { InsightsClient } from "./client"
import { dashboardAsSent } from "./layout-compaction"
import {
  MAX_WIDGETS,
  type Dashboard,
} from "./schema"
import "./example"
import "./example-storage"
import "./provider-query-template"
import catalogMeta from "./repository-examples/catalog-meta.json"
import { LazyPanelBoundary, MountSignal } from "./lazy-panel"
import { WidgetEditorSkeleton } from "./widget-editor-skeleton"
import { SavedQueryLibraryProvider } from "./saved-query-context"
import { queryConnectionKey } from "./query-connections"
import "./saved-query-storage"
import "./bundle-import"
import "./saved-queries"
import "./fingerprint"
import "./use-mobile-navigation"
import { dashboardActionItems } from "./dashboard-actions"
import "./use-builder-panel-focus"
import "./history"
import "./use-insights-shortcuts"
import { ariaKeyshortcutsFor, hintFor } from "./shortcuts"
import "./use-workspace-refresh"
import { DashboardCanvas } from "./canvas"
import { EmbedView } from "./embed-view"
import type { EmbedRequest } from "./embed-request"
import { refreshStaggerSpread } from "./refresh-stagger"

import "./tile-controls"
import "./canvas-density"
import "./responsive-layout"
import "./query"
import { DashboardTree } from "./dashboard-library"
import { applyChartToDashboard } from "./chart-apply"
import { TimeRangeControl, savedRangeLabel } from "./time-range"
import "./widget-library"
import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge"
import styles from "./insights.module.css"
import "./client"
import { SourceStatusContext } from "./source-status"
import { GammaButton } from "./gamma/button"
import { GammaInput } from "./gamma/input"
import { GammaSelect } from "./gamma/select"
import { GammaConfirmation } from "./gamma/confirmation"
import "./gamma/scroll-lock"
import gammaTheme from "./gamma/gamma-theme.module.css"
import { PhoneVariables, VariableBar } from "./dashboard-variables"
import { ClampedDescription } from "./dashboard-description"
import "./variable-options"
import { InsightsThemeControl } from "./insights-theme"
import "./drilldown"
import { duplicateLayout, savedLayout } from "./layout-edit"

import { serialiseDashboardView, viewTimeDiffers } from "./dashboard-view"
import { Explorer, ShortcutList, QueryInspector, ChecksList, WidgetEditor, preloadExamples } from "./shell/lazy-panels"
import { placementPhrase } from "./shell/navigation"
import { sourceBannerCopy } from "./shell/source-catalog"
import "./shell/media-stores"
import { NO_VARIABLES } from "./shell/constants"
import { useWorkspace } from "./shell/use-workspace"
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

  const [
    alignedEnd,
    builderClient,
    fetcher,
    range,
    scheduledFetcher,
    variableCatalog,
    variableLoaders,
  ] = useDashboardData(
    activeExample,
    client,
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
    activeExample,
    advanceEnd,
    applyView,
    busy,
    chartCommands,
    client,
    close,
    confirmation,
    currentRoute,
    dashboard,
    dashboards,
    dirty,
    etags,
    focusAfterSave,
    latestDocument,
    mode,
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
    mode,
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
            renderPanelRouter(acceptCatalog, addWidget, applyDocument, applyRestoredDocument, builderPanel, busy, client, close, dashboard, dashboards, deleteDashboard, dirty, duplicateDashboard, endGroup, exploreProvider, importBundle, importingBundle, markGalleryMounted, markManageMounted, markProvidersMounted, markSourceMounted, mode, openBuilderPanel, panel, providers, refreshCatalog, refreshSavedQueries, reviewBundle, saved, savedQueries, selectWidget, setEditing, setLibraryRevision, setQueryRevision, setSourceRequest, syncVariableDefinitions, unsupportedProviders, update, variableCatalog, widePanel, widgetDraftDirty, workspace, workspaceFailed)
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

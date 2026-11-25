// The shell scope: the root's props and each hook's result, in call order. A hook takes a Pick of the scope before
// it; a view takes a Pick of the whole Shell. Generated alongside the hooks by the R70 extract tool.
import type { InsightsAppProps } from "../insights-app"
import type { useWorkspace } from "./use-workspace"
import type { useWorkspaceBackend } from "./workspace-backend"
import type { useSavedQueryLibrary } from "./use-saved-query-library"
import type { useDashboardSession } from "./use-dashboard-session"
import type { useShellLayout } from "./use-shell-layout"
import type { useSourceCatalog } from "./use-source-catalog"
import type { useLiveSync } from "./use-live-sync"
import type { useTileActions } from "./use-tile-actions"
import type { useWorkspaceBoot } from "./use-workspace-boot"
import type { useDashboardData } from "./use-dashboard-data"
import type { usePanels } from "./use-panels"
import type { useDocumentActions } from "./use-document-actions"
import type { useViewActions } from "./use-view-actions"

export type ShellProps = Omit<InsightsAppProps, "embed">

// A hook's tuple result, keyed by the names the root destructures it into (the guard test checks they match).
type Named<N extends readonly string[], T extends readonly unknown[]> = { [I in keyof N & `${number}` as N[I] & string]: T[I & keyof T] }

export type WorkspaceNames = ["activeExample", "canRedo", "canUndo", "dashboard", "editorMounted", "endGroup", "exampleGeneration", "exampleStarting", "galleryMounted", "latestDocument", "markEditorMounted", "markGalleryMounted", "markManageMounted", "markProvidersMounted", "markSourceMounted", "mode", "mounted", "mountedPanels", "providers", "redo", "reset", "resolvedTheme", "setExampleStarting", "setMode", "setProviders", "setTheme", "setUnsupportedProviders", "setWorkspace", "setWorkspaceFailed", "theme", "undo", "unsupportedProviders", "update", "workspace", "workspaceFailed"]
export type AfterWorkspace = ShellProps & Named<WorkspaceNames, ReturnType<typeof useWorkspace>>

export type SavedQueryLibraryNames = ["dashboards", "explorerDirty", "explorerOpened", "explorerSource", "exploring", "inspectingQueries", "libraryClient", "libraryMutation", "queriesError", "queriesLoaded", "queriesLoading", "savedQueries", "setDashboards", "setExplorerDirty", "setExplorerOpened", "setExplorerSource", "setExploring", "setInspectingQueries", "setLibraryRevision", "setQueriesError", "setQueriesLoaded", "updateSavedQueries"]
export type WorkspaceBackendNames = ["backend"]
export type AfterWorkspaceBackend = AfterWorkspace & Named<WorkspaceBackendNames, ReturnType<typeof useWorkspaceBackend>>

export type AfterSavedQueryLibrary = AfterWorkspaceBackend & Named<SavedQueryLibraryNames, ReturnType<typeof useSavedQueryLibrary>>

export type DashboardSessionNames = ["applyView", "busy", "currentRoute", "editing", "enterEdit", "error", "exitEdit", "importingBundle", "invalidWidgetSaveHintId", "linkNotice", "message", "messageAction", "panel", "reflectView", "remoteDashboard", "returnTo", "saveFindings", "saved", "selected", "setBusy", "setError", "setImportingBundle", "setLinkNotice", "setMessage", "setMessageAction", "setPanel", "setRemoteDashboard", "setReturnTo", "setSaveFindings", "setSaved", "setSelected", "setShortcutsOpen", "setWidgetDraftDirty", "setWidgetDraftValid", "setWidgetPreview", "shortcutsOpen", "showView", "widgetDraftDirty", "widgetDraftValid", "widgetOpener", "widgetPreview"]
export type AfterDashboardSession = AfterSavedQueryLibrary & Named<DashboardSessionNames, ReturnType<typeof useDashboardSession>>

export type ShellLayoutNames = ["canvasMode", "compactNavigationExpanded", "compactShell", "confirmation", "dense", "drawerOpen", "finePointer", "isMobile", "layoutRoot", "mobileSidebar", "navigation", "navigationToggle", "panelHidden", "panelOpener", "phoneViewport", "planRevision", "search", "setCanvasMode", "setCompactNavigationExpanded", "setDense", "setMobileSidebar", "setPanelHidesSidebar", "setSearch", "setSidebar", "setSidebarOverride", "setWidePanel", "sidebar", "sidebarOpenWidth", "sidebarOverride", "sidebarShown", "widePanel"]
export type AfterShellLayout = AfterDashboardSession & Named<ShellLayoutNames, ReturnType<typeof useShellLayout>>

export type SourceCatalogNames = ["acceptCatalog", "advanceEnd", "autoTick", "bannerRetry", "bundleImportActive", "bundleImporter", "catalogWaiters", "end", "etags", "focusBannerRetry", "lastSyncInputs", "openRequest", "queryRevision", "refreshCatalog", "refreshedAt", "retry", "retryFocus", "retrySources", "setQueryRevision", "setRefreshedAt", "setRetry", "setSourceRequest", "setSources", "sourceContext", "sourceNoticeRef", "sourceRequest", "sources", "workspaceRegion"]
export type AfterSourceCatalog = AfterShellLayout & Named<SourceCatalogNames, ReturnType<typeof useSourceCatalog>>

export type LiveSyncNames = ["dirty", "focusTitleOnEdit", "saveButton", "syncError", "titleField", "variableValues", "viewDashboard", "viewDiffers"]
export type AfterLiveSync = AfterSourceCatalog & Named<LiveSyncNames, ReturnType<typeof useLiveSync>>

export type TileActionsNames = ["actionsRegion", "applePlatform", "builderPanel", "chartCommands", "currentWidget", "duplicateTile", "editingWidget", "focusAfterSave", "focusedWidget", "noticeWithUndo", "phoneShell", "previewWidget", "queryFieldSnapshot", "queryResultSnapshot", "registerChartCommands", "removeTile", "setQueryFieldSnapshot", "setQueryResultSnapshot", "setSaveRevision"]
export type AfterTileActions = AfterLiveSync & Named<TileActionsNames, ReturnType<typeof useTileActions>>

export type WorkspaceBootNames = ["enterExample"]
export type AfterWorkspaceBoot = AfterTileActions & Named<WorkspaceBootNames, ReturnType<typeof useWorkspaceBoot>>

export type DashboardDataNames = ["alignedEnd", "builderClient", "fetcher", "range", "scheduledFetcher", "variableCatalog", "variableLoaders"]
export type AfterDashboardData = AfterWorkspaceBoot & Named<DashboardDataNames, ReturnType<typeof useDashboardData>>

export type PanelsNames = ["close", "leaveWidget", "navigateFromChart", "openBuilderPanel", "selectWidget", "showPanel"]
export type AfterPanels = AfterDashboardData & Named<PanelsNames, ReturnType<typeof usePanels>>

export type DocumentActionsNames = ["addWidget", "applyDocument", "confirmDiscard", "declareVariable", "drilldown", "layoutUpdate", "openDashboard", "save", "saveDocument", "saveLatest", "selectDashboardContext", "selectDashboardTime", "syncVariableDefinitions", "linkSavedQuery"]
export type AfterDocumentActions = AfterPanels & Named<DocumentActionsNames, ReturnType<typeof useDocumentActions>>

export type ViewActionsNames = ["applyDashboardVariables", "applyRestoredDocument", "changeViewRange", "changeViewRefresh", "createDashboard", "deleteDashboard", "duplicateDashboard", "exploreProvider", "historyAvailable", "importBundle", "moveDashboard", "openQueryExplorer", "refreshSavedQueries", "reloadRemoteDashboard", "resetViewRange", "reviewBundle", "setViewAsDefault"]
export type AfterViewActions = AfterDocumentActions & Named<ViewActionsNames, ReturnType<typeof useViewActions>>
export type Shell = AfterViewActions

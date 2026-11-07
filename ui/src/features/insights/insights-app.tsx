"use client"

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Braces,
  Check,
  ChevronRight,
  CircleHelp,
  Database,
  FilePlus2,
  LayoutDashboard,
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
  Sparkles,
  Settings2,
  Undo2,
  X,
} from "lucide-react"
import { GammaActionMenu } from "./gamma/action-menu"
import { verticalCompactor, type Layout } from "react-grid-layout"
import type { InsightsClient } from "./client"
import {
  dashboardSchema,
  customTimeRangeSchema,
  newDashboard,
  newWidget,
  MAX_WIDGETS,
  type Dashboard,
  type Widget,
  type Provider,
  type Drilldown,
  type QueryRequest,
  type SavedQuery,
  type SavedQueryEntry,
  MAX_DASHBOARD_VARIABLES,
} from "./schema"
import {
  exampleDashboard,
} from "./example"
import {
  createExampleDashboardImportClient,
  EXAMPLE_STORAGE_KEY,
  saveExampleWorkspace,
  writeExampleWorkspace,
} from "./example-storage"
import { assertProviderQueryTemplate } from "./provider-query-template"
import { repositoryExamples } from "./repository-examples"
import { RepositoryGallery } from "./repository-gallery"
import { readRepositoryExampleWorkspace as readExampleWorkspace, repositoryWorkspaceProviders as exampleProviders, repositoryWorkspaceQuery as exampleQuery, repositoryWorkspaceMetadata as exampleMetadata, repositoryWorkspaceQueries } from "./repository-workspace"
import { SavedQueryLibraryProvider } from "./saved-query-context"
import { queryConnectionKey, type QueryFieldSnapshot } from "./query-connections"
import { createExampleSavedQueryClient } from "./saved-query-storage"
import { createBundleImporter, loadBundleImportReview, type BundleImportRequest } from "./bundle-import"
import { dashboardUsesSavedQuery, resolveSavedQueryReference } from "./saved-queries"
import type { DashboardBundle } from "./workspace-transfer"
import { documentFingerprint } from "./fingerprint"
import { useMobileNavigation } from "./use-mobile-navigation"
import { useBuilderPanelFocus } from "./use-builder-panel-focus"
import { useDashboardHistory } from "./history"
import { useWorkspaceRefresh } from "./use-workspace-refresh"
import { DashboardCanvas } from "./canvas"
import { useCanvasDensity } from "./canvas-density"
import type { CanvasMode } from "./responsive-layout"
import { createQueryScheduler, createResolvedQueryFetcher } from "./query"
import { DocumentEditor } from "./document-editor"
import { WidgetEditor } from "./widget-editor"
import { ProviderManager } from "./provider-manager"
import { DashboardManager, DashboardTree } from "./dashboard-library"
import { TimeRangeControl, dashboardRange } from "./time-range"
import { WidgetLibrary } from "./widget-library"
import type { WidgetDefinition } from "./widget-registry"
import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge"
import styles from "./insights.module.css"
import { GammaButton } from "./gamma/button"
import { GammaInput } from "./gamma/input"
import { GammaSelect } from "./gamma/select"
import { GammaConfirmation, useConfirmation } from "./gamma/confirmation"
import { lockBodyScroll } from "./gamma/scroll-lock"
import gammaTheme from "./gamma/gamma-theme.module.css"
import { VariableBar } from "./dashboard-variables"
import { InsightsThemeControl, useInsightsTheme } from "./insights-theme"
import {
  buildDashboardURL, parseDashboardURL, resolveDashboardVariables,
  resolveDrilldown, resolveSelectionBindings, interpolateQuery, type DashboardNavigation, type DrilldownContext,
} from "./drilldown"

function writeLocation(state: DashboardNavigation, example: boolean, method: "push" | "replace") {
  const path = /\/dashboard\/insights\/?$/.test(location.pathname)
    ? location.pathname : "/dashboard/insights/"
  const url = buildDashboardURL(state, path) + (example ? "&example=1" : "")
  if (method === "push") window.history.pushState(window.history.state, "", url)
  else window.history.replaceState(window.history.state, "", url)
}

function initialNavigation(documents: Dashboard[], fallback: Dashboard) {
  try {
    const state = parseDashboardURL(location.search)
    if (!state) return { document: fallback, state: { dashboardId: fallback.id }, error: "" }
    const document = documents.find(item => item.id === state.dashboardId)
    if (!document) throw new Error("The linked dashboard is unavailable. Choose a dashboard from the library.")
    resolveDashboardVariables(document, state.variables)
    return { document, state, error: "" }
  } catch (error) {
    return { document: fallback, state: { dashboardId: fallback.id }, error: error instanceof Error ? error.message : "Invalid dashboard link" }
  }
}
function importIdentity(document: Dashboard) {
  // Correcting a destination provider after a partial import must keep every
  // allocated dashboard ID, so successful copies keep linking to the retry.
  return documentFingerprint({ ...document, widgets: document.widgets.map(widget => ({
    ...widget, providerId: "mapped-provider",
    ...(widget.options?.tooltipView?.source?.type === "query" ? {
      options: { ...widget.options, tooltipView: {
        ...widget.options.tooltipView,
        source: { ...widget.options.tooltipView.source, providerId: "mapped-provider" },
      } },
    } : {}),
  })) })
}

const Explorer = lazy(() => import("./explorer").then(module => ({ default: module.Explorer })))
const NO_VARIABLES: NonNullable<Dashboard["variables"]> = []

const AIBuilder = lazy(() =>
  import("./ai").then((module) => ({ default: module.AIBuilder })),
)
registerDefaultWidgetPlugins()

export interface InsightsAppProps {
  client: InsightsClient
  initialExample?: boolean
  onBack?: () => void
}

// Desktop compact chrome is a view preference, independent of measured canvas
// width so expanding navigation cannot repeatedly toggle the rail.
const compactDesktopQuery = "(min-width: 1024px)";
function subscribeCompactDesktop(listener: () => void) {
  const media = window.matchMedia(compactDesktopQuery);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
const compactDesktopSnapshot = () => window.matchMedia(compactDesktopQuery).matches;
const compactDesktopServerSnapshot = () => false;
function subscribeFinePointer(listener: () => void) {
  const media = window.matchMedia("(pointer: fine)");
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
const finePointerSnapshot = () => window.matchMedia("(pointer: fine)").matches;

export default function InsightsApp({
  client,
  initialExample = false,
  onBack,
}: InsightsAppProps) {
  const { theme, resolvedTheme, setTheme } = useInsightsTheme()
  const history = useDashboardHistory(exampleDashboard)
  const { dashboard, update, reset, undo, redo, canUndo, canRedo } = history
  const latestDocument = useRef(dashboard)
  useLayoutEffect(() => { latestDocument.current = dashboard }, [dashboard])
  const [mode, setMode] = useState<
    "loading" | "live" | "example" | "unavailable"
  >(initialExample ? "example" : "loading")
  const [providers, setProviders] = useState<Provider[]>(
    initialExample ? exampleProviders : [],
  )
  const [dashboards, setDashboards] = useState<Dashboard[]>([])
  const [exploring, setExploring] = useState(false)
  const [explorerOpened, setExplorerOpened] = useState(false)
  const [explorerSource, setExplorerSource] = useState<{ providerId?: string; revision: number }>({ revision: 0 })
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
    // A draft must not hide a dependency that still exists in saved storage.
    const currentDocuments = () => [...readExampleWorkspace(localStorage).dashboards, latestDocument.current]
    const scoped = mode === "example" && typeof window !== "undefined"
      ? { ...client, ...createExampleSavedQueryClient(localStorage, currentDocuments, repositoryWorkspaceQueries.filter(query => currentDocuments().some(document => dashboardUsesSavedQuery(document, query.id)))), metadata: exampleMetadata, query: exampleQuery }
      : client
    return { ...scoped, removeSavedQuery: async (id, etag) => {
      if (dashboardUsesSavedQuery(latestDocument.current, id))
        throw new Error("This saved query is used by the current dashboard. Switch its widgets to custom queries before deleting it.")
      return scoped.removeSavedQuery(id, etag)
    } }
  }, [client, mode])
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
  const [routeState, setRouteState] = useState<DashboardNavigation | null>(null)
  const [returnTo, setReturnTo] = useState<{ state: DashboardNavigation; title: string } | null>(null)
  const [saved, setSaved] = useState(documentFingerprint(exampleDashboard))
  const [editing, setEditing] = useState(false)
  const [widgetDraftValid, setWidgetDraftValid] = useState(true)
  const invalidWidgetSaveHintId = useId()
  const [panel, setPanel] = useState<
    "add" | "source" | "ai" | "providers" | "widget" | "manage" | "examples" | null
  >(null)
  const [selected, setSelected] = useState<string>()
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [remoteDashboard, setRemoteDashboard] = useState<{ id: string; removed: boolean }>()
  const [busy, setBusy] = useState(false)
  const [importingBundle, setImportingBundle] = useState(false)
  const confirmation = useConfirmation()
  const [search, setSearch] = useState("")
  const { dense, setDense } = useCanvasDensity()
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("wide")
  const [sidebar, setSidebar] = useState(true)
  const [compactNavigationExpanded, setCompactNavigationExpanded] = useState(false)
  const compactDesktop = useSyncExternalStore(subscribeCompactDesktop, compactDesktopSnapshot, compactDesktopServerSnapshot)
  const finePointer = useSyncExternalStore(subscribeFinePointer, finePointerSnapshot, compactDesktopServerSnapshot)
  const compactShell = dense && !editing && resolvedTheme === "dark" && compactDesktop
  const [mobileSidebar, setMobileSidebar] = useState(false)
  const isMobile = useMobileNavigation()
  const drawerOpen = isMobile && mobileSidebar
  const navigation = useRef<HTMLElement>(null)
  const navigationToggle = useRef<HTMLButtonElement>(null)
  const [end, setEnd] = useState(() => Math.floor(Date.now() / 1000))
  const [retry, setRetry] = useState(0)
  const [queryRevision, setQueryRevision] = useState(0)
  const etags = useRef(new Map<string, string>())
  const openRequest = useRef(0)
  const importReceipts = useRef(new Map<string, string>())
  const importBatch = useRef<{ pending: Set<string>; targets: Map<string, string> }>({ pending: new Set(), targets: new Map() })
  const bundleImporter = useRef<ReturnType<typeof createBundleImporter> | null>(null)
  const bundleImportActive = useRef(false)
  if (!bundleImporter.current) bundleImporter.current = createBundleImporter()
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
  const currentRoute = routeState?.dashboardId === dashboard.id ? routeState : undefined
  const viewDashboard = currentRoute?.customTimeRange
    ? { ...dashboard, customTimeRange: currentRoute.customTimeRange }
    : dashboard
  // Definitions can be removed while editing. Stale view overrides must not
  // make an otherwise valid document impossible to edit.
  const variableKey = JSON.stringify(resolveDashboardVariables(dashboard, Object.fromEntries(
    Object.entries(currentRoute?.variables ?? {}).filter(([name]) => dashboard.variables?.some(item => item.name === name)),
  )))
  const variableValues = useMemo(() => JSON.parse(variableKey) as Record<string, string>, [variableKey])
  useEffect(() => {
    if (!currentRoute?.variables) return
    const entries = Object.entries(currentRoute.variables)
    const retained = entries.filter(([name]) => dashboard.variables?.some(item => item.name === name))
    if (retained.length === entries.length) return
    let active = true
    queueMicrotask(() => {
      if (!active) return
      const state = { ...currentRoute, variables: Object.fromEntries(retained) }
      setRouteState(state)
      writeLocation(state, mode === "example", "replace")
    })
    return () => { active = false }
  }, [currentRoute, dashboard.variables, mode])
  const [queryFieldSnapshot, setQueryFieldSnapshot] = useState<QueryFieldSnapshot>();
  const currentWidget = dashboard.widgets.find(
    (widget) => widget.id === selected,
  )
  const builderPanel = useBuilderPanelFocus(
    panel
      ? `${dashboard.id}:${panel}:${panel === "widget" ? (selected ?? "") : ""}`
      : null,
  )

  const enterExample = useCallback(() => {
    const workspace = readExampleWorkspace(localStorage)
    if (localStorage.getItem(EXAMPLE_STORAGE_KEY) === null) writeExampleWorkspace(localStorage, workspace.dashboards, workspace.activeId)
    const fallback =
      workspace.dashboards.find((item) => item.id === workspace.activeId) ??
      newDashboard()
    const { document: sample, state, error } = initialNavigation(workspace.dashboards, fallback)
    reset(sample)
    setSaved(documentFingerprint(sample))
    setDashboards(workspace.dashboards)
    setProviders(exampleProviders)
    setMode("example")
    setRouteState(state)
    setError(error)
    if (!error) writeLocation(state, true, "replace")
  }, [reset])

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
    const controller = new AbortController()
    Promise.all([
      client.providers(controller.signal),
      client.list(controller.signal),
    ])
      .then(async ([available, documents]) => {
        if (controller.signal.aborted) return
        const initial = initialNavigation(documents, documents[0] ?? newDashboard())
        const active = documents.length
          ? await client.get(initial.document.id)
          : { dashboard: newDashboard(), etag: undefined }
        if (controller.signal.aborted) return
        if (active.etag) etags.current.set(active.dashboard.id, active.etag)
        setProviders(available)
        setDashboards(documents)
        reset(active.dashboard)
        setSaved(documentFingerprint(active.dashboard))
        setMode("live")
        const state = { ...initial.state, dashboardId: active.dashboard.id }
        resolveDashboardVariables(active.dashboard, state.variables)
        setRouteState(state)
        setError(initial.error)
        if (!initial.error) writeLocation(state, false, "replace")
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setMode("unavailable")
          setError(error.message)
        }
      })
    return () => controller.abort()
  }, [client, initialExample, enterExample, reset, retry])

  useEffect(() => {
    if (!dirty && !explorerDirty && !importingBundle) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [dirty, explorerDirty, importingBundle])

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
  }, [drawerOpen])

  useEffect(() => {
    if (!dashboard.refreshInterval || viewDashboard.customTimeRange) return
    const timer = setInterval(() => {
      if (!document.hidden) setEnd(Math.floor(Date.now() / 1000))
    }, dashboard.refreshInterval * 1000)
    const onVisible = () => {
      if (!document.hidden) setEnd(Math.floor(Date.now() / 1000))
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [dashboard.refreshInterval, viewDashboard.customTimeRange])

  const scheduledFetcher = useMemo(() => {
    // A refresh or provider edit invalidates cached fixed-range observations too.
    void queryRevision
    const query = mode === "example" ? exampleQuery : client.query
    return createQueryScheduler(query)
  }, [client, mode, queryRevision])
  // Resolve each authoring scope once, before sharing the bounded scheduler.
  // Tooltip label values may themselves contain {{text}}; never interpolate
  // those resolved query literals again as dashboard variables.
  const fetcher = useMemo(() => createResolvedQueryFetcher(scheduledFetcher, (request: QueryRequest) => {
    const { queryRef, ...resolved } = request
    if (queryRef) {
      if (queriesLoading) throw new Error("Loading the saved-query library…")
      if (queriesError) throw new Error(queriesError)
      const authored = savedQueries.find(query => query.id === queryRef.id)
      if (authored) assertProviderQueryTemplate(providers.find(provider => provider.id === authored.providerId)?.type, authored.query)
      const definition = resolveSavedQueryReference(queryRef, savedQueries, variableValues, request.kind)
      if (!providers.some(provider => provider.id === definition.providerId && provider.capabilities.includes(definition.kind)))
        throw new Error("The saved query’s data source is unavailable. Choose a connected source in Explore.")
      return { ...resolved, ...definition }
    }
    assertProviderQueryTemplate(providers.find(provider => provider.id === request.providerId)?.type, request.query)
    return { ...resolved, query: interpolateQuery(request.query, variableValues) }
  }), [scheduledFetcher, variableValues, savedQueries, queriesLoading, queriesError, providers])
  const range = dashboardRange(viewDashboard, end)
  const builderClient = useMemo(
    () =>
      mode === "example"
        ? { ...client, metadata: exampleMetadata, query: exampleQuery }
        : client,
    [client, mode],
  )
  const close = useCallback(() => {
    if (bundleImportActive.current) return
    setPanel(null)
    setSelected(undefined)
  }, [])
  const selectWidget = useCallback((id: string) => {
    if (bundleImportActive.current) return
    setSelected(id)
    setPanel("widget")
    setEditing(true)
  }, [])
  const layoutUpdate = useCallback(
    (layout: Layout) =>
      update((current) => ({
        ...current,
        widgets: current.widgets.map((widget) => {
          const position = layout.find((item) => item.i === widget.id)
          return position
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

  function applyDocument(next: Dashboard) {
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
    setMessage("Document applied. Review the canvas, then save your dashboard.")
  }
  function syncVariableDefinitions(next: Dashboard) {
    if (!currentRoute?.variables) return
    const variables = Object.fromEntries(Object.entries(currentRoute.variables).filter(([name]) => next.variables?.some(item => item.name === name)))
    const state = { ...currentRoute, variables }
    setRouteState(state)
    writeLocation(state, mode === "example", "replace")
  }
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
    update({ ...dashboard, variables, widgets: [...dashboard.widgets, widget] })
    setExploring(false)
    setEditing(true)
    selectWidget(widget.id)
    setMessage("Saved query linked. Parameters use dashboard variables; review their values, then save the dashboard.")
  }
  async function save() {
    if (!widgetDraftValid) {
      setError("Fix the invalid widget settings before saving, or close its editor to keep the last valid preview.")
      return
    }
    const request = openRequest.current
    setError("")
    setBusy(true)
    try {
      const parsed = dashboardSchema.parse(dashboard)
      // Normalize trimmed form values before the request, so a completed save
      // never overwrites edits made while the request was in flight.
      if (documentFingerprint(parsed) !== documentFingerprint(dashboard))
        update(parsed)
      if (mode === "example") {
        const persisted = readExampleWorkspace(localStorage).dashboards.find(item => item.id === parsed.id)
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
      setMessage(
        mode === "example"
          ? "Example saved in this browser."
          : "Dashboard saved.",
      )
      setEditing(false)
      close()
    } catch (error) {
      if (request === openRequest.current)
        setError(
          error instanceof Error ? error.message : "Could not save dashboard",
        )
    } finally {
      setBusy(false)
    }
  }
  async function openDashboard(
    item: Dashboard,
    state: DashboardNavigation | ((target: Dashboard) => DashboardNavigation) = { dashboardId: item.id },
    method: "push" | "replace" | "none" = "push",
  ): Promise<boolean> {
    if (busy) return false
    const request = ++openRequest.current
    const beforeLoad = documentFingerprint(dashboard)
    if (item.id !== dashboard.id && dirty && !await confirmDiscard()) return false
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
      buildDashboardURL(nextState)
      if (active.etag) etags.current.set(item.id, active.etag)
      if (item.id !== dashboard.id) {
        if (mode === "example")
          saveExampleWorkspace(localStorage, dashboards, active.dashboard)
        reset(active.dashboard)
        setSaved(documentFingerprint(active.dashboard))
        setEditing(false)
      }
      if (method !== "none") writeLocation(nextState, mode === "example", method)
      setRouteState(nextState)
      setEnd(Math.floor(Date.now() / 1000))
      close()
      setError("")
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
  async function drilldown(link: Drilldown, context: DrilldownContext) {
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
      const state = { ...currentRoute, dashboardId: dashboard.id, variables }
      writeLocation(state, mode === "example", "replace")
      setRouteState(state)
      setError("")
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not apply selection")
    }
  }
  function selectDashboardTime(window: { start: number; end: number }) {
    try {
      const customTimeRange = customTimeRangeSchema.parse({ from: new Date(window.start).toISOString(), to: new Date(window.end).toISOString() })
      const state = { ...currentRoute, dashboardId: dashboard.id, variables: variableValues, customTimeRange }
      writeLocation(state, mode === "example", "replace")
      setRouteState(state)
      setError("")
    } catch {
      setError("Choose an increasing time range of at most 31 days.")
    }
  }
  // Browser history must restore the same document, variable values, and time
  // range as a link. Keep the listener stable while using the latest editor state.
  const popHandler = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    popHandler.current = () => {
      const restore = () => writeLocation(currentRoute ?? { dashboardId: dashboard.id }, mode === "example", "replace")
      try {
        const state = parseDashboardURL(location.search)
        const target = dashboards.find(item => item.id === state?.dashboardId)
        if (!state || !target) throw new Error("The linked dashboard is unavailable.")
        const pending = openDashboard(target, state, "none")
        const request = openRequest.current
        void pending.then(opened => {
          if (request !== openRequest.current) return
          if (!opened) restore()
          else setReturnTo(null)
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

  function resetView(next: Dashboard) {
    setRouteState({ dashboardId: next.id })
    setReturnTo(null)
    writeLocation({ dashboardId: next.id }, mode === "example", "replace")
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
    if (dirty && !await confirmDiscard()) return
    if (request !== openRequest.current) return
    const next = newDashboard()
    setExploring(false)
    resetView(next)
    reset(next)
    setSaved("")
    setEditing(true)
    setPanel("add")
    setSelected(undefined)
    setMessage("")
    setMobileSidebar(false)
  }

  function duplicateDashboard() {
    if (bundleImportActive.current) return
    ++openRequest.current
    const copy = dashboardSchema.parse({
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
      const moved = dashboardSchema.parse({ ...loaded.dashboard, folder })
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
  }, [libraryClient, updateSavedQueries])

  const openQueryExplorer = useCallback(() => {
    setExplorerOpened(true)
    setExploring(true)
    setMobileSidebar(false)
    setLibraryRevision(value => value + 1)
  }, [])

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

  async function importDashboards(documents: Dashboard[]) {
    if (busy)
      throw new Error("Wait for the current save before importing dashboards.")
    if (dashboards.length + documents.length > 100)
      throw new Error(
        "The workspace supports up to 100 dashboards. Remove unused dashboards before importing.",
      )
    setBusy(true)
    const failed: Dashboard[] = []
    const errors: string[] = []
    const imported: Dashboard[] = []
    if (!documents.every(document => importBatch.current.pending.has(importIdentity(document))))
      importBatch.current = { pending: new Set(), targets: new Map() }
    // Allocate identities for the entire batch before copying links. Retain the
    // mapping through partial retries, including targets already imported.
    for (const document of documents) {
      const receipt = importIdentity(document)
      if (!importReceipts.current.has(receipt))
        importReceipts.current.set(receipt, `dashboard-${crypto.randomUUID()}`)
      importBatch.current.targets.set(document.id, importReceipts.current.get(receipt)!)
    }
    try {
      for (const document of documents) {
        const receipt = importIdentity(document)
        let copyId = importReceipts.current.get(receipt)
        if (!copyId) {
          copyId = `dashboard-${crypto.randomUUID()}`
          importReceipts.current.set(receipt, copyId)
          while (importReceipts.current.size > 100)
            importReceipts.current.delete(
              importReceipts.current.keys().next().value!,
            )
        }
        const copy = dashboardSchema.parse({
          ...document,
          id: copyId,
          widgets: document.widgets.map(widget => ({
            ...widget,
            ...(widget.drilldowns ? { drilldowns: widget.drilldowns.map(link => ({
              ...link, dashboardId: importBatch.current.targets.get(link.dashboardId) ?? link.dashboardId,
            })) } : {}),
          })),
        })
        try {
          if (mode === "example")
            writeExampleWorkspace(
              localStorage,
              [...dashboards, ...imported, copy],
              dashboard.id,
            )
          else {
            let etag: string | undefined
            try {
              etag = await client.save(copy)
            } catch (writeError) {
              // A dropped response can hide a successful conditional create.
              // Confirm the same document before reporting failure or retrying.
              try {
                const confirmed = await client.get(copy.id)
                if (
                  documentFingerprint(confirmed.dashboard) !==
                  documentFingerprint(copy)
                )
                  throw writeError
                etag = confirmed.etag
              } catch {
                throw writeError
              }
            }
            if (etag) etags.current.set(copy.id, etag)
          }
          importReceipts.current.delete(receipt)
          imported.push(copy)
          setDashboards((items) => [
            ...items.filter((item) => item.id !== copy.id),
            copy,
          ])
        } catch (error) {
          failed.push(document)
          errors.push(
            `${document.title}: ${error instanceof Error ? error.message : "Import failed"}`,
          )
        }
      }
    } finally {
      importBatch.current.pending = new Set(failed.map(importIdentity))
      if (!failed.length) importBatch.current.targets.clear()
      while (importReceipts.current.size > 100)
        importReceipts.current.delete(importReceipts.current.keys().next().value!)
      setBusy(false)
    }
    return { added: imported.length, failed, errors }
  }

  if (mode === "loading")
    return (
      <div className={`${styles.root} ${gammaTheme.scope}`} data-insights-theme={resolvedTheme}>
        <div className={styles.loading}>
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
            {error}
          </p>
          <div className={styles.actions}>
            <GammaButton size="sm" variant="primary" className={styles.primary} onClick={enterExample}>
              Explore the example <ArrowUpRight size={16} />
            </GammaButton>
            <GammaButton size="sm" variant="secondary"
              className={styles.secondary}
              onClick={() => {
                setMode("loading")
                setRetry((value) => value + 1)
              }}
            >
              Retry connection
            </GammaButton>
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
    <SavedQueryLibraryProvider queries={savedQueries} variables={dashboard.variables ?? NO_VARIABLES} values={variableValues} loading={queriesLoading} error={queriesError} onOpenExplorer={openQueryExplorer} onRefresh={refreshSavedQueries}>
    <div className={`${styles.root} ${gammaTheme.scope}`} data-insights-theme={resolvedTheme} data-density={dense && !editing ? "compact" : "standard"} data-compact-shell={compactShell || undefined}>
      <GammaConfirmation request={confirmation.request} onResolve={confirmation.resolve} />
      {drawerOpen && (
        <button type="button"
          className={styles.sidebarBackdrop}
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setMobileSidebar(false)}
        />
      )}
      {(isMobile ? drawerOpen : compactShell || sidebar) && (
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
                (!dirty && !explorerDirty) ||
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
            onClick={openQueryExplorer}
          ><Search size={16} /> Explore <span>{savedQueries.length}</span></GammaButton>
          <GammaButton size="sm" variant="quiet"
            className={styles.sideLink}
            title={compactShell ? "Data sources" : undefined}
            disabled={importingBundle}
            onClick={() => {
              setExploring(false)
              setPanel("providers")
              setMobileSidebar(false)
            }}
          >
            <Database size={16} /> Data sources <span>{providers.length}</span>
          </GammaButton>
          <GammaButton size="sm" variant="quiet" className={styles.sideLink} title={compactShell ? "Examples" : undefined} disabled={importingBundle} onClick={() => { setExploring(false); setPanel("examples"); setMobileSidebar(false) }}><FilePlus2 size={16} /> Examples <span>{repositoryExamples.length}</span></GammaButton>
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
              onOpen={(item) => { setExploring(false); setReturnTo(null); void openDashboard(item) }}
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
            <GammaButton size="sm" variant="quiet"
              className={styles.sideLink}
              disabled={importingBundle}
              onClick={() => {
                setExploring(false)
                setPanel("source")
                setMobileSidebar(false)
              }}
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
              aria-expanded={isMobile ? drawerOpen : compactShell ? compactNavigationExpanded : sidebar}
              aria-controls="insights-navigation"
              onClick={() => {
                if (isMobile) setMobileSidebar(!mobileSidebar)
                else if (compactShell) setCompactNavigationExpanded(!compactNavigationExpanded)
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
                const path = /\/dashboard\/insights\/?$/.test(location.pathname) ? location.pathname : "/dashboard/insights/"
                const url = new URL(buildDashboardURL(state, path), location.origin)
                if (mode === "example") url.searchParams.set("example", "1")
                await navigator.clipboard.writeText(url.href)
                setError("")
                setMessage("Dashboard link copied with the current variables and time settings.")
              } catch { setError("Could not copy the link. Copy the current address from your browser.") }
            }}><Link2 size={15} /></GammaButton>
            <span className={styles.modeBadge}>
              <span />
              {mode === "example" ? "Sample data" : "Live providers"}
            </span>
            <GammaButton iconOnly size="sm" variant="quiet"
              className={styles.iconButton}
              aria-label="About data sources"
              disabled={importingBundle}
              onClick={() => { setExploring(false); setPanel("providers") }}
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
              <Explorer key={explorerSource.revision} initialProviderId={explorerSource.providerId} client={libraryClient} providers={providers} queries={savedQueries} onQueriesChange={updateSavedQueries} onDirtyChange={setExplorerDirty} onUse={useSavedQuery} onClose={() => setExploring(false)} active={exploring && !queriesLoading && !queriesError} />
            </Suspense>}
          </section>
        )}
        <section hidden={exploring} aria-label="Dashboard workspace">
        <div className={styles.pageHeader} data-tooltip-obstacle>
          <div className={styles.heading}>
            {editing ? (
              <GammaInput
                className={styles.titleInput}
                aria-label="Dashboard title"
                maxLength={120}
                value={dashboard.title}
                onChange={(e) =>
                  update({ ...dashboard, title: e.target.value })
                }
              />
            ) : (
              <h1>{dashboard.title}</h1>
            )}
            {dashboard.description && (compactShell ? <details className={styles.compactDescription}><summary>Dashboard context</summary><p>{dashboard.description}</p></details> : <p>{dashboard.description}</p>)}
          </div>
          <div className={styles.actions}>
            {isMobile || compactShell ? <GammaActionMenu
              label="Dashboard actions"
              className={styles.iconButton}
              disabled={importingBundle}
              items={[
                { id: "manage", label: "Manage dashboards", icon: <Settings2 size={15} />, onSelect: () => setPanel(panel === "manage" ? null : "manage") },
                { id: "ai", label: "Build with AI", icon: <Sparkles size={15} />, onSelect: () => { setPanel(panel === "ai" ? null : "ai"); setEditing(true) } },
              ]}
            /> : <>
            <GammaButton size="sm" variant="secondary"
              className={styles.secondary}
              aria-label="Manage dashboards"
              disabled={importingBundle}
              onClick={() => setPanel(panel === "manage" ? null : "manage")}
            >
              <Settings2 size={15} /> Manage
            </GammaButton>
            <GammaButton size="sm" variant="secondary"
              className={styles.secondary}
              disabled={importingBundle}
              onClick={() => {
                setPanel(panel === "ai" ? null : "ai")
                setEditing(true)
              }}
            >
              <Sparkles size={15} /> Build with AI
            </GammaButton>
            </>}
            {editing ? (
              <GammaButton size="sm" variant="primary" className={styles.primary} disabled={busy || !widgetDraftValid} aria-describedby={!widgetDraftValid ? invalidWidgetSaveHintId : undefined} onClick={save}>
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
            )}
          </div>
        </div>
        {editing && !widgetDraftValid && <p id={invalidWidgetSaveHintId} className={styles.saveBlockedHint} role="status">Fix the widget settings to save, or close the editor to keep the last valid preview.</p>}
        <div className={styles.toolbar} data-tooltip-obstacle>
          <div className={styles.toolbarLeft}>
            <VariableBar key={dashboard.id} dashboard={dashboard} values={variableValues} onApply={values => {
              try {
                const state = { ...currentRoute, dashboardId: dashboard.id, variables: resolveDashboardVariables(dashboard, values) }
                writeLocation(state, mode === "example", "replace")
                setRouteState(state)
                setError("")
              } catch (error) { setError(error instanceof Error ? error.message : "Invalid variable values") }
            }} />
            <div className={styles.canvasTools}>
            <span className={styles.canvasTab}>
              <LayoutDashboard size={14} /> Canvas
            </span>
            <GammaButton size="sm" variant="quiet"
              className={panel === "source" ? styles.activeTool : ""}
              iconOnly={compactShell} aria-label={compactShell ? "Code" : undefined} title={compactShell ? "Dashboard as code" : undefined}
              disabled={importingBundle}
              onClick={() => setPanel(panel === "source" ? null : "source")}
            >
              <Braces size={14} />{!compactShell && " Code"}
            </GammaButton>
            {canvasMode === "wide" && <>
            <span className={styles.divider} />
            <GammaButton size="sm" variant="quiet" iconOnly={compactShell} aria-label={compactShell ? "Compact view" : undefined} aria-pressed={dense} disabled={editing || canvasMode !== "wide"}
              title={editing ? "Compact view is available when previewing" : canvasMode !== "wide" ? "Compact view is available when the dashboard canvas is wider" : "Use a denser wide-screen layout without changing the saved dashboard"}
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
                  disabled={!canUndo}
                  onClick={undo}
                >
                  <Undo2 size={14} />
                </GammaButton>
                <GammaButton iconOnly size="sm" variant="quiet"
                  className={styles.iconButton}
                  aria-label="Redo"
                  disabled={!canRedo}
                  onClick={redo}
                >
                  <Redo2 size={14} />
                </GammaButton>
              </>
            )}
            </div>
          </div>
          <div className={styles.toolbarRight}>
            <TimeRangeControl
              key={dashboard.id}
              dashboard={viewDashboard}
              onChange={(next) => {
                const state = { ...currentRoute, dashboardId: dashboard.id, customTimeRange: undefined }
                setRouteState(state)
                writeLocation(state, mode === "example", "replace")
                update({ ...dashboard, ...next })
                setEnd(Math.floor(Date.now() / 1000))
                setEditing(true)
              }}
            />
            <GammaButton iconOnly size="sm" variant="quiet"
              className={styles.iconButton}
              aria-label="Refresh data"
              onClick={() => {
                setEnd(Math.floor(Date.now() / 1000))
                setQueryRevision((value) => value + 1)
                setLibraryRevision((value) => value + 1)
              }}
            >
              <RefreshCw size={14} />
            </GammaButton>
            <GammaSelect
              className={styles.refreshSelect}
              aria-label="Auto refresh"
              size="sm"
              value={String(viewDashboard.customTimeRange ? 0 : dashboard.refreshInterval)}
              disabled={!!viewDashboard.customTimeRange}
              onValueChange={(value) => update({
                ...dashboard, refreshInterval: Number(value) as Dashboard["refreshInterval"],
              })}
              options={[
                {value: "0", label: "Auto off"}, {value: "15", label: "15s"},
                {value: "30", label: "30s"}, {value: "60", label: "1m"},
              ]}
            />
            {editing && (
              <GammaButton size="sm" variant="quiet"
                className={styles.addButton}
                onClick={() => setPanel(panel === "add" ? null : "add")}
                disabled={importingBundle || dashboard.widgets.length >= MAX_WIDGETS}
              >
                <Plus size={14} /> Add widget
              </GammaButton>
            )}
          </div>
        </div>
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
        {(error || message) && (
          <div
            className={`${styles.notice} ${error ? styles.errorNotice : ""}`}
            role={error ? "alert" : "status"}
          >
            {!error && <Check size={14} />}
            <span>{error || message}</span>
            <GammaButton iconOnly size="sm" variant="quiet"
              className={styles.iconButton}
              aria-label="Dismiss message"
              onClick={() => {
                setError("")
                setMessage("")
              }}
            >
              <X size={14} />
            </GammaButton>
          </div>
        )}
        <div className={styles.workArea}>
          <div className={styles.canvasArea}>
            {editing && (
              <div className={styles.editHint}>
                <span className={styles.statusDot} /> Editing canvas{" "}
                <span className={styles.wideEditHint}>
                  Drag a handle to move. Pull a corner to resize.
                </span>
                <span className={styles.compactEditHint}>
                  Arrange widgets in the Layout tab.
                </span>
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
                active={!exploring}
                onDrilldown={drilldown}
                onSelection={selectDashboardContext}
                onTimeRange={selectDashboardTime}
                providers={providers}
                fetcher={fetcher}
                tooltipFetcher={scheduledFetcher}
                end={end}
                editing={editing}
                dense={dense}
                referenceCompact={compactShell && finePointer}
                onModeChange={setCanvasMode}
                selected={selected}
                onSelect={selectWidget}
                onLayout={layoutUpdate}
                onQueryFields={setQueryFieldSnapshot}
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
                  <GammaButton size="sm" variant="primary"
                    className={styles.primary}
                    disabled={importingBundle}
                    onClick={() => {
                      setEditing(true)
                      setPanel("add")
                    }}
                  >
                    <Plus size={15} /> Add your first widget
                  </GammaButton>
                  <GammaButton size="sm" variant="secondary"
                    className={styles.secondary}
                    disabled={importingBundle}
                    onClick={() => setPanel("source")}
                  >
                    <FilePlus2 size={15} /> Import dashboard
                  </GammaButton>
                </div>
              </div>
            )}
            <footer className={styles.canvasFooter}>
              <span>
                {mode === "example"
                  ? "Generated sample data"
                  : "Provider queries run server-side"}
              </span>
              <span>
                {dirty ? "Unsaved changes" : "All changes saved"}
                <span className={dirty ? styles.unsavedDot : styles.savedDot} />
              </span>
            </footer>
          </div>
          {panel && (
            <aside
              ref={builderPanel}
              tabIndex={-1}
              className={`${styles.panel} ${(panel === "source" || panel === "examples") ? styles.widePanel : ""}`}
              aria-label="Builder panel"
            >
              {panel === "examples" && <RepositoryGallery entries={repositoryExamples} mode={mode === "example" ? "example" : "live"} providers={providers} onImportBundle={importBundle} onReviewBundle={reviewBundle} onRefreshQueries={refreshSavedQueries} onClose={close} />}
              {panel === "source" && (
                <DocumentEditor
                  key={dashboard.id}
                  dashboard={dashboard}
                  providers={providers}
                  onImportBundle={importBundle}
                  onReviewBundle={reviewBundle}
                  onRefreshQueries={refreshSavedQueries}
                  onApply={applyDocument}
                  onClose={close}
                />
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
                  />
                </Suspense>
              )}
              {panel === "add" && (
                <WidgetLibrary
                  onAdd={addWidget}
                  onClose={close}
                  onAI={() => setPanel("ai")}
                  disabled={dashboard.widgets.length >= MAX_WIDGETS}
                />
              )}
              {panel === "providers" && (
                <ProviderManager
                  client={client}
                  providers={providers}
                  example={mode === "example"}
                  onClose={close}
                  onExplore={exploreProvider}
                  onChange={(next) => {
                    setProviders(next)
                    setQueryRevision((value) => value + 1)
                    setLibraryRevision((value) => value + 1)
                  }}
                />
              )}
              {panel === "manage" && (
                <DashboardManager
                  key={dashboard.id}
                  dashboard={dashboard}
                  dashboards={dashboards}
                  providers={providers}
                  busy={busy}
                  onClose={close}
                  onApply={(next) => {
                    syncVariableDefinitions(next)
                    update(next)
                    setEditing(true)
                  }}
                  onDuplicate={duplicateDashboard}
                  onDelete={deleteDashboard}
                  onImport={importDashboards}
                  onImportBundle={importBundle}
                  onReviewBundle={reviewBundle}
                  onRefreshQueries={refreshSavedQueries}
                />
              )}
              {panel === "widget" && currentWidget && (
                <WidgetEditor
                  key={currentWidget.id}
                  widget={currentWidget}
                  dashboards={dashboards.map(item => item.id === dashboard.id ? dashboard : item)}
                  providers={providers}
                  client={builderClient}
                  range={range}
                  queryFetcher={fetcher}
                  queryFields={currentWidget.id === queryFieldSnapshot?.widgetId && queryFieldSnapshot.fetcher === fetcher && queryFieldSnapshot.key === queryConnectionKey(currentWidget, range) ? queryFieldSnapshot.fields : undefined}
                  onClose={close}
                  onDraftValidityChange={setWidgetDraftValid}
                  onApply={(next) => {
                    update(current => ({
                      ...current,
                      widgets: current.widgets.map((w) =>
                        w.id === next.id ? next : w,
                      ),
                    }))
                  }}
                  onDelete={() => {
                    update({
                      ...dashboard,
                      widgets: dashboard.widgets.filter(
                        (w) => w.id !== currentWidget.id,
                      ),
                    })
                    close()
                  }}
                  onDuplicate={() => {
                    if (dashboard.widgets.length >= MAX_WIDGETS) {
                      setError("A dashboard supports up to 48 widgets.")
                      return
                    }
                    const copy = {
                      ...currentWidget,
                      id: `widget-${crypto.randomUUID()}`,
                      title: `${currentWidget.title.slice(0, 113)} (copy)`,
                      layout: {
                        ...currentWidget.layout,
                        x: 0,
                        y: Math.min(
                          1000,
                          Math.max(
                            ...dashboard.widgets.map(
                              (w) => w.layout.y + w.layout.h,
                            ),
                          ),
                        ),
                      },
                    }
                    update({
                      ...dashboard,
                      widgets: [...dashboard.widgets, copy],
                    })
                    selectWidget(copy.id)
                  }}
                  onMove={(dx, dy) => {
                    const layout = dashboard.widgets.map((widget) => ({
                      i: widget.id,
                      ...widget.layout,
                      ...(widget.id === currentWidget.id
                        ? {
                            x: Math.max(
                              0,
                              Math.min(
                                12 - widget.layout.w,
                                widget.layout.x + dx,
                              ),
                            ),
                            y: Math.max(
                              0,
                              Math.min(1000, widget.layout.y + dy),
                            ),
                          }
                        : {}),
                    }))
                    layoutUpdate(verticalCompactor.compact(layout, 12))
                  }}
                />
              )}
            </aside>
          )}
        </div>
        </section>
      </div>
    </div>
    </SavedQueryLibraryProvider>
  )
}

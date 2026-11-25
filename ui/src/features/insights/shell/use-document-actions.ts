import { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import { verticalCompactor, type Layout } from "react-grid-layout"
import { dashboardAsSent } from "../layout-compaction"
import { customTimeRangeSchema, newWidget, MAX_WIDGETS, type Dashboard, type Widget, isApplicationLink, type WidgetLink, type SavedQuery, type DashboardVariable, dashboardSchema, MAX_DASHBOARD_VARIABLES } from "../schema"
import { documentFingerprint } from "../fingerprint"
import type { WidgetDefinition } from "../widget-registry"
import { checksFromError } from "../client"
import { describeIgnoredLink, resolveDashboardVariables, resolveApplicationLink, resolveDrilldown, resolveLinkView, resolveSelectionBindings, type DashboardNavigation, type DrilldownContext } from "../drilldown"
import { readDashboardLink, serialiseDashboardView } from "../dashboard-view"
import { UNAPPLIED_CHART_NOTICE } from "./constants"
import type { AfterPanels } from "./types"

export function useDocumentActions(
  advanceEnd: AfterPanels["advanceEnd"],
  applyView: AfterPanels["applyView"],
  backend: AfterPanels["backend"],
  busy: AfterPanels["busy"],
  chartCommands: AfterPanels["chartCommands"],
  close: AfterPanels["close"],
  confirmation: AfterPanels["confirmation"],
  currentRoute: AfterPanels["currentRoute"],
  dashboard: AfterPanels["dashboard"],
  dashboards: AfterPanels["dashboards"],
  dirty: AfterPanels["dirty"],
  enterEdit: AfterPanels["enterEdit"],
  etags: AfterPanels["etags"],
  exitEdit: AfterPanels["exitEdit"],
  focusAfterSave: AfterPanels["focusAfterSave"],
  latestDocument: AfterPanels["latestDocument"],
  navigateFromChart: AfterPanels["navigateFromChart"],
  onOpenApplication: AfterPanels["onOpenApplication"],
  openRequest: AfterPanels["openRequest"],
  providers: AfterPanels["providers"],
  range: AfterPanels["range"],
  reflectView: AfterPanels["reflectView"],
  reset: AfterPanels["reset"],
  saved: AfterPanels["saved"],
  selectWidget: AfterPanels["selectWidget"],
  setBusy: AfterPanels["setBusy"],
  setDashboards: AfterPanels["setDashboards"],
  setError: AfterPanels["setError"],
  setExploring: AfterPanels["setExploring"],
  setLinkNotice: AfterPanels["setLinkNotice"],
  setMessage: AfterPanels["setMessage"],
  setMessageAction: AfterPanels["setMessageAction"],
  setMobileSidebar: AfterPanels["setMobileSidebar"],
  setReturnTo: AfterPanels["setReturnTo"],
  setSaveFindings: AfterPanels["setSaveFindings"],
  setSaveRevision: AfterPanels["setSaveRevision"],
  setSaved: AfterPanels["setSaved"],
  update: AfterPanels["update"],
  variableValues: AfterPanels["variableValues"],
  widgetDraftDirty: AfterPanels["widgetDraftDirty"],
  widgetDraftValid: AfterPanels["widgetDraftValid"],
) {
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
    enterEdit()
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
      enterEdit()
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
  function linkSavedQuery(query: SavedQuery) {
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
      enterEdit()
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
      // An example refuses a save over a stored copy that changed since this draft was opened.
      const etag = await backend.save(parsed, { saved, dashboards, etag: etags.current.get(parsed.id) })
      if (etag) etags.current.set(parsed.id, etag)
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
      setMessage(backend.copy.saved)
      // Apply and save moves focus to the chart's tile. A plain save moves it to Edit, or to the actions trigger on the phone.
      focusAfterSave.current = { widget: options.focusWidget }
      setSaveRevision((value) => value + 1)
      exitEdit()
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
  function confirmDiscard() {
    return confirmation.ask({ title: "Discard unsaved changes?", description: `Your unsaved changes to “${dashboard.title}” will be lost.`, action: "Discard changes" })
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
          : await backend.load(item)
      if (request !== openRequest.current) return false
      if (item.id !== dashboard.id && beforeLoad !== documentFingerprint(latestDocument.current))
        throw new Error("Your dashboard changed while the destination was loading. Open the link again when you are ready.")
      const nextState = typeof state === "function" ? state(active.dashboard) : state
      resolveDashboardVariables(active.dashboard, nextState.variables)
      // Validate the complete URL before changing the document or view state.
      serialiseDashboardView(nextState)
      if (active.etag) etags.current.set(item.id, active.etag)
      if (item.id !== dashboard.id) {
        backend.opened(dashboards, active.dashboard)
        reset(active.dashboard)
        setSaved(documentFingerprint(active.dashboard))
        exitEdit()
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
  return [
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
    linkSavedQuery,
  ] as const
}

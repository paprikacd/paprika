/* eslint-disable react-hooks/immutability -- code moved verbatim from InsightsWorkspace, which the React Compiler lint skips; its ref and setter patterns are reviewed there, not rewritten in a move */
import { useCallback, useEffect, useLayoutEffect } from "react"
import { OVERLAY_SELECTOR } from "../shortcuts"
import { builderPanelPlan } from "../responsive-layout"
import { UNAPPLIED_CHART_NOTICE } from "./constants"
import type { AfterDashboardData } from "./types"

export function usePanels(
  bundleImportActive: AfterDashboardData["bundleImportActive"],
  compactShell: AfterDashboardData["compactShell"],
  confirmation: AfterDashboardData["confirmation"],
  editing: AfterDashboardData["editing"],
  exploring: AfterDashboardData["exploring"],
  focusedWidget: AfterDashboardData["focusedWidget"],
  isMobile: AfterDashboardData["isMobile"],
  layoutRoot: AfterDashboardData["layoutRoot"],
  navigation: AfterDashboardData["navigation"],
  panel: AfterDashboardData["panel"],
  panelOpener: AfterDashboardData["panelOpener"],
  planRevision: AfterDashboardData["planRevision"],
  setEditing: AfterDashboardData["setEditing"],
  setExploring: AfterDashboardData["setExploring"],
  setMessage: AfterDashboardData["setMessage"],
  setMessageAction: AfterDashboardData["setMessageAction"],
  setMobileSidebar: AfterDashboardData["setMobileSidebar"],
  setPanel: AfterDashboardData["setPanel"],
  setPanelHidesSidebar: AfterDashboardData["setPanelHidesSidebar"],
  setSelected: AfterDashboardData["setSelected"],
  setSidebarOverride: AfterDashboardData["setSidebarOverride"],
  setWidePanel: AfterDashboardData["setWidePanel"],
  setWidgetDraftDirty: AfterDashboardData["setWidgetDraftDirty"],
  setWidgetPreview: AfterDashboardData["setWidgetPreview"],
  sidebar: AfterDashboardData["sidebar"],
  sidebarOpenWidth: AfterDashboardData["sidebarOpenWidth"],
  sidebarOverride: AfterDashboardData["sidebarOverride"],
  widgetDraftDirty: AfterDashboardData["widgetDraftDirty"],
  widgetOpener: AfterDashboardData["widgetOpener"],
) {
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
  return [
    close,
    leaveWidget,
    navigateFromChart,
    openBuilderPanel,
    selectWidget,
    showPanel,
  ] as const
}

/* eslint-disable react-hooks/immutability -- code moved verbatim from InsightsWorkspace, which the React Compiler lint skips; its ref and setter patterns are reviewed there, not rewritten in a move */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { MAX_WIDGETS, type Dashboard } from "../schema"
import { type QueryFieldSnapshot } from "../query-connections"
import { useBuilderPanelFocus } from "../use-builder-panel-focus"
import { isApplePlatform, useInsightsShortcuts, type ChartCommands } from "../use-insights-shortcuts"
import { type WidgetResultSnapshot } from "../canvas"
import { visibleTileControl } from "../tile-controls"
import { duplicateLayout, savedLayout } from "../layout-edit"
import { loadRepositoryWorkspace } from "./lazy-panels"
import { placementPhrase, panelOpenerElement } from "./navigation"
import type { AfterLiveSync } from "./types"

export function useTileActions(
  busy: AfterLiveSync["busy"],
  confirmation: AfterLiveSync["confirmation"],
  dashboard: AfterLiveSync["dashboard"],
  editing: AfterLiveSync["editing"],
  editorMounted: AfterLiveSync["editorMounted"],
  exploring: AfterLiveSync["exploring"],
  galleryMounted: AfterLiveSync["galleryMounted"],
  importingBundle: AfterLiveSync["importingBundle"],
  latestDocument: AfterLiveSync["latestDocument"],
  layoutRoot: AfterLiveSync["layoutRoot"],
  mountedPanels: AfterLiveSync["mountedPanels"],
  panel: AfterLiveSync["panel"],
  panelOpener: AfterLiveSync["panelOpener"],
  phoneViewport: AfterLiveSync["phoneViewport"],
  redo: AfterLiveSync["redo"],
  saveButton: AfterLiveSync["saveButton"],
  selected: AfterLiveSync["selected"],
  setError: AfterLiveSync["setError"],
  setMessage: AfterLiveSync["setMessage"],
  setMessageAction: AfterLiveSync["setMessageAction"],
  setShortcutsOpen: AfterLiveSync["setShortcutsOpen"],
  setWorkspace: AfterLiveSync["setWorkspace"],
  setWorkspaceFailed: AfterLiveSync["setWorkspaceFailed"],
  titleField: AfterLiveSync["titleField"],
  undo: AfterLiveSync["undo"],
  update: AfterLiveSync["update"],
  widgetDraftDirty: AfterLiveSync["widgetDraftDirty"],
  widgetOpener: AfterLiveSync["widgetOpener"],
  widgetPreview: AfterLiveSync["widgetPreview"],
  workspace: AfterLiveSync["workspace"],
  workspaceFailed: AfterLiveSync["workspaceFailed"],
) {
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
  }, [layoutRoot, titleField])
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
  return [
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
  ] as const
}

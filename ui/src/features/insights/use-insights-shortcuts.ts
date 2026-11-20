"use client"

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react"
import { matchShortcut, shouldYield } from "./shortcuts"

/** True on Apple platforms, where Command is the shortcut modifier. Insights is client-only, so navigator exists. */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
}

/** What the open chart editor lets shortcuts do. The editor registers it and clears it on unmount. */
export type ChartCommands = {
  undo: () => void
  redo: () => void
  apply: () => void
  /** Applies the draft, then saves the dashboard. It takes the same path as the Apply and save button. */
  applyAndSave: () => void
  /** False while the draft is stale or invalid, when Apply changes is disabled. */
  canApply: boolean
  /** False unless Apply and save has something to do: a valid current draft, and a chart or dashboard that has changed. */
  canApplyAndSave: boolean
}

export type InsightsShortcutTargets = {
  /** Dashboard edit mode. Shortcuts that change the dashboard act only while editing. */
  editing: boolean
  /** A chart editor is open. Undo and redo then belong to the chart, not the dashboard. */
  chartOpen: boolean
  /** The open chart editor's commands, or null when no chart is mounted. */
  chart: RefObject<ChartCommands | null>
  /** Shortcuts stay out of the way while a bundle imports, a save or load is running, or Explore owns the page. */
  blocked: boolean
  undoDashboard: () => void
  redoDashboard: () => void
  /** Runs the same path as the Save dashboard button, so its disabled and busy guards still apply. */
  save: () => void
  /** Removes the tile with this widget id, as one undoable change. */
  removeTile: (widgetId: string) => void
  /** Copies the saved tile with this widget id beside it, as one undoable change. */
  duplicateTile: (widgetId: string) => void
  /** Opens the keyboard shortcut list. */
  openShortcuts: () => void
}

/**
 * Document-level Insights shortcuts. The listener runs in the bubble phase, so CodeMirror, menus and
 * the tile's own capture-phase keys see a key press first, and shouldYield honours what they handled.
 * It acts only for key presses that land inside the Insights root, or on the page body after focus was
 * lost, so the console around Insights keeps its own shortcuts.
 */
export function useInsightsShortcuts(root: RefObject<HTMLElement | null>, targets: InsightsShortcutTargets) {
  const latest = useRef(targets)
  useLayoutEffect(() => {
    latest.current = targets
  })
  useEffect(() => {
    const apple = isApplePlatform()
    const onKeyDown = (event: KeyboardEvent) => {
      const container = root.current
      if (!container) return
      const target = event.target
      const inScope = target === document.body || target === document.documentElement || target === document ||
        (target instanceof Node && container.contains(target))
      if (!inScope) return
      // "?" opens the shortcut list. Printable keys keep the same rule as Delete: text entry and open overlays keep them.
      if (event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey && !shouldYield(event, "delete")) {
        event.preventDefault()
        latest.current.openShortcuts()
        return
      }
      const id = matchShortcut(event, apple)
      if (!id || shouldYield(event, id)) return
      const current = latest.current
      if (id === "save") {
        if (!current.editing) return
        event.preventDefault()
        if (!current.blocked && !event.repeat) current.save()
        return
      }
      if (id === "apply") {
        // Apply belongs to the open chart. Without one, or while its draft is stale or invalid, the key does nothing.
        const chart = current.chart.current
        if (!chart || !chart.canApply || current.blocked) return
        event.preventDefault()
        if (!event.repeat) chart.apply()
        return
      }
      if (id === "applyAndSave") {
        // Same guard as Apply changes: it needs an open chart whose draft is valid and current. The save then runs as Save dashboard does.
        const chart = current.chart.current
        if (!chart || !chart.canApplyAndSave || current.blocked) return
        event.preventDefault()
        if (!event.repeat) chart.applyAndSave()
        return
      }
      if (id === "delete") {
        // Only the tile itself, or its edit chip, owns the key. Text fields and the tile's own controls keep theirs.
        if (!current.editing || current.chartOpen || current.blocked || event.repeat) return
        if (!(target instanceof Element)) return
        const tile = target.closest<HTMLElement>("article[data-widget-id]")
        if (!tile || !(target === tile || target.hasAttribute("data-widget-edit") || target.hasAttribute("data-widget-actions"))) return
        event.preventDefault()
        current.removeTile(tile.dataset.widgetId ?? "")
        return
      }
      if (id === "duplicate") {
        // Mod+D is the browser's bookmark key, so it is taken only where Delete is: a focused tile or its chips in edit mode.
        // The open-overlay rule in shouldYield keeps it away from an open menu.
        if (!current.editing || current.chartOpen) return
        if (!(target instanceof Element)) return
        const tile = target.closest<HTMLElement>("article[data-widget-id]")
        if (!tile || !(target === tile || target.hasAttribute("data-widget-edit") || target.hasAttribute("data-widget-actions"))) return
        // In scope, the key is ours even when the copy is skipped: a held or blocked Mod+D must not reach the bookmark dialog.
        event.preventDefault()
        if (current.blocked || event.repeat) return
        current.duplicateTile(tile.dataset.widgetId ?? "")
        return
      }
      if (id === "undo" || id === "redo") {
        if (!current.editing) return
        if (current.chartOpen) {
          const chart = current.chart.current
          if (!chart) return
          event.preventDefault()
          if (current.blocked) return
          if (id === "undo") chart.undo()
          else chart.redo()
          return
        }
        event.preventDefault()
        if (current.blocked) return
        if (id === "undo") current.undoDashboard()
        else current.redoDashboard()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [root])
}

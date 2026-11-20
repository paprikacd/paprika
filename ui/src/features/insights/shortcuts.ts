// Keyboard shortcut core for Insights. Pure functions, no React. The dispatcher that
// attaches them to the document lives in use-insights-shortcuts.ts.

export type ShortcutId = "undo" | "redo" | "save" | "apply" | "delete"

export type ShortcutScope = "global" | "dashboard" | "chart" | "tile"

export type ShortcutDefinition = {
  id: ShortcutId
  label: string
  /** Label shown on Apple platforms. */
  mac: string
  /** Label shown everywhere else. */
  other: string
  /** Value for aria-keyshortcuts. */
  aria: string
  /** Where the shortcut applies. "global" routes by focus (chart history, then dashboard). */
  scope: ShortcutScope
}

export const SHORTCUTS: readonly ShortcutDefinition[] = [
  { id: "undo", label: "Undo", mac: "⌘Z", other: "Ctrl+Z", aria: "Control+Z Meta+Z", scope: "global" },
  { id: "redo", label: "Redo", mac: "⌘⇧Z", other: "Ctrl+Shift+Z or Ctrl+Y", aria: "Control+Shift+Z Meta+Shift+Z Control+Y", scope: "global" },
  { id: "save", label: "Save dashboard", mac: "⌘S", other: "Ctrl+S", aria: "Control+S Meta+S", scope: "dashboard" },
  { id: "apply", label: "Apply changes", mac: "⌘↵", other: "Ctrl+Enter", aria: "Control+Enter Meta+Enter", scope: "chart" },
  { id: "delete", label: "Remove tile", mac: "Delete / Backspace", other: "Delete / Backspace", aria: "Delete Backspace", scope: "tile" },
]

/** The subset of KeyboardEvent that matching reads. */
export type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode"
>

/**
 * Returns the shortcut the key press means, or undefined. Mod is Command on Apple
 * platforms and Control elsewhere; the other platform's modifier must be absent.
 * Alt is never part of a shortcut, which also keeps AltGr (Control+Alt on Windows) out.
 */
export function matchShortcut(event: ShortcutKeyEvent, isMac: boolean): ShortcutId | undefined {
  if (event.isComposing || event.keyCode === 229 || event.altKey) return undefined
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  if (!event.metaKey && !event.ctrlKey) {
    return (key === "Delete" || key === "Backspace") && !event.shiftKey ? "delete" : undefined
  }
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!mod) return undefined
  if (key === "z") return event.shiftKey ? "redo" : "undo"
  if (key === "y" && !isMac && !event.shiftKey) return "redo"
  if (key === "s" && !event.shiftKey) return "save"
  if (key === "Enter" && !event.shiftKey) return "apply"
  return undefined
}

/** Elements that keep their own meaning for a key. */
const FIELD_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
/**
 * Open overlays own the keyboard, so no Insights shortcut fires while one is open. A passive hover tooltip
 * is not one: it appears under the pointer while the user is still working, so it must not take Save or Undo.
 * Pinned tooltips use role="region" and are not overlays either.
 */
export const OVERLAY_SELECTOR = 'dialog[open], [role="dialog"], [role="listbox"], [role="menu"]'

export type ShortcutTargetEvent = { target: EventTarget | null; defaultPrevented: boolean }

/**
 * True when the shortcut must leave the key press to the element or overlay it landed on.
 * Plain fields keep undo, redo and delete, but save and apply still work there. CodeMirror
 * keeps its own undo, redo, apply and delete, but save still works there.
 */
export function shouldYield(event: ShortcutTargetEvent, id: ShortcutId): boolean {
  if (event.defaultPrevented) return true
  const element = event.target instanceof Element ? event.target : null
  const doc = element?.ownerDocument ?? (typeof document !== "undefined" ? document : null)
  if (doc?.querySelector(OVERLAY_SELECTOR)) return true
  if (!element) return false
  if (element.closest(".cm-editor")) return id !== "save"
  if (element.closest(FIELD_SELECTOR)) return id === "undo" || id === "redo" || id === "delete"
  return false
}

/** The visible label for a shortcut on the given platform, for hints and menus. */
export function labelFor(id: ShortcutId, isMac: boolean): string {
  const shortcut = SHORTCUTS.find((item) => item.id === id)
  if (!shortcut) throw new Error(`Unknown shortcut ${id}`)
  return isMac ? shortcut.mac : shortcut.other
}

/** The aria-keyshortcuts value for a shortcut. */
export function ariaKeyshortcutsFor(id: ShortcutId): string {
  const shortcut = SHORTCUTS.find((item) => item.id === id)
  if (!shortcut) throw new Error(`Unknown shortcut ${id}`)
  return shortcut.aria
}

/** A button hint that names the shortcut, for example "Undo (⌘Z)". */
export function hintFor(id: ShortcutId, isMac: boolean): string {
  const shortcut = SHORTCUTS.find((item) => item.id === id)
  if (!shortcut) throw new Error(`Unknown shortcut ${id}`)
  return `${shortcut.label} (${labelFor(id, isMac)})`
}

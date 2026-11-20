"use client"

import { useEffect, useId, useRef } from "react"
import { X } from "lucide-react"
import { GammaButton } from "./gamma/button"
import { lockBodyScroll } from "./gamma/scroll-lock"
import { labelFor, type ShortcutId } from "./shortcuts"
import styles from "./shortcut-list.module.css"

export type ShortcutGroup = { title: string; rows: { label: string; keys: string }[] }

/** The shortcut list, grouped by where each key applies. Keys follow the platform's modifier. */
export function shortcutGroups(isMac: boolean): ShortcutGroup[] {
  const keys = (id: ShortcutId) => labelFor(id, isMac)
  const alt = isMac ? "⌥ Arrow" : "Alt+Arrow"
  const altShift = isMac ? "⌥ ⇧ Arrow" : "Alt+Shift+Arrow"
  return [
    {
      title: "Dashboard",
      rows: [
        { label: "Undo", keys: keys("undo") },
        { label: "Redo", keys: keys("redo") },
        { label: "Save dashboard (while editing)", keys: keys("save") },
      ],
    },
    {
      title: "Chart editor",
      rows: [
        { label: "Undo and redo chart changes", keys: `${keys("undo")} and ${keys("redo")}` },
        { label: "Apply changes", keys: keys("apply") },
        { label: "Run the query, in the query text", keys: keys("apply") },
      ],
    },
    {
      title: "Tiles (editing, a focused tile)",
      rows: [
        { label: "Remove tile", keys: "Delete or Backspace" },
        { label: "Move tile", keys: alt },
        { label: "Resize tile", keys: altShift },
      ],
    },
    {
      title: "Help",
      rows: [{ label: "Show this list", keys: "?" }],
    },
  ]
}

/** A native modal list of the Insights shortcuts. The opener keeps focus on close, as the trace dialog does. */
export function ShortcutList({ isMac, onClose }: { isMac: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    const opener = document.activeElement
    element.showModal()
    close.current?.focus()
    const unlock = lockBodyScroll()
    return () => {
      const restore = element.contains(document.activeElement) || document.activeElement === document.body
      if (element.open) element.close()
      unlock()
      if (restore && opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header className={styles.header}>
        <h2 id={`${id}-title`}>Keyboard shortcuts</h2>
        <GammaButton ref={close} variant="quiet" size="sm" iconOnly aria-label="Close keyboard shortcuts" onClick={onClose}>
          <X size={17} aria-hidden="true" />
        </GammaButton>
      </header>
      <div className={styles.content}>
        {shortcutGroups(isMac).map((group) => (
          <section key={group.title} className={styles.group}>
            <h3>{group.title}</h3>
            <dl>
              {group.rows.map((row) => (
                <div key={row.label} className={styles.row}>
                  <dt>{row.label}</dt>
                  <dd><kbd>{row.keys}</kbd></dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </dialog>
  )
}

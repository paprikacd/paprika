"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type RefObject,
} from "react"

/**
 * The keyboard contract Gamma's menus share.
 *
 * The trigger owns the panel. Enter, Space or ArrowDown opens it and moves
 * focus to the first enabled entry; ArrowDown and ArrowUp walk the enabled
 * entries, Home and End jump to the ends; Escape and Tab close it and hand
 * focus back to the trigger; a pointer landing outside closes it without
 * stealing focus from wherever the pointer went.
 */
export interface MenuEntry {
  id: string
  disabled?: boolean
  /** A compact key hint, e.g. "P". Typing it while the menu is open selects the entry. */
  shortcut?: string
}

export interface MenuBehaviour<T extends MenuEntry> {
  itemRefs: React.RefObject<Array<HTMLElement | null>>
  openMenu: (focusFirst: boolean) => void
  closeMenu: (returnFocus: boolean) => void
  select: (entry: T) => void
  handleTriggerKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  handleEntryKeyDown: (event: KeyboardEvent<HTMLElement>, index: number) => void
}

export function useMenuBehaviour<T extends MenuEntry>({
  entries,
  open,
  onOpenChange,
  onSelect,
  triggerRef,
  panelRef,
}: {
  entries: readonly T[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (entry: T) => void
  triggerRef: RefObject<HTMLElement | null>
  panelRef: RefObject<HTMLElement | null>
}): MenuBehaviour<T> {
  const itemRefs = useRef<Array<HTMLElement | null>>([])
  const focusFirstOnOpen = useRef(false)

  const enabledIndexes = useMemo(
    () =>
      entries
        .map((entry, index) => (entry.disabled ? -1 : index))
        .filter((index) => index >= 0),
    [entries],
  )

  const focusEntry = useCallback((index: number) => {
    itemRefs.current[index]?.focus()
  }, [])

  useEffect(() => {
    if (!open || !focusFirstOnOpen.current) return
    focusFirstOnOpen.current = false
    const first = enabledIndexes[0]
    if (first !== undefined) focusEntry(first)
  }, [open, enabledIndexes, focusEntry])

  const openMenu = useCallback(
    (focusFirst: boolean) => {
      focusFirstOnOpen.current = focusFirst
      onOpenChange(true)
    },
    [onOpenChange],
  )

  const closeMenu = useCallback(
    (returnFocus: boolean) => {
      onOpenChange(false)
      if (returnFocus) triggerRef.current?.focus()
    },
    [onOpenChange, triggerRef],
  )

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null
      if (!target) return
      if (panelRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      // A pointer outside closes the menu but leaves focus where the pointer
      // went — taking it back would fight the click that closed the menu.
      onOpenChange(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [open, onOpenChange, panelRef, triggerRef])

  const handleTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        openMenu(true)
      }
    },
    [openMenu],
  )

  const step = useCallback(
    (from: number, direction: 1 | -1) => {
      if (enabledIndexes.length === 0) return undefined
      const position = enabledIndexes.indexOf(from)
      if (position === -1) return enabledIndexes[0]
      const next =
        (position + direction + enabledIndexes.length) % enabledIndexes.length
      return enabledIndexes[next]
    },
    [enabledIndexes],
  )

  const select = useCallback(
    (entry: T) => {
      if (entry.disabled) return
      onSelect(entry)
      closeMenu(true)
    },
    [closeMenu, onSelect],
  )

  const handleEntryKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>, index: number) => {
      // A menu is not a text surface: a printable key is always a shortcut, and
      // the hint beside the label only promises what this handles.
      if (
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        const match = entries.find(
          (entry) =>
            !entry.disabled &&
            entry.shortcut?.toLowerCase() === event.key.toLowerCase(),
        )
        if (match) {
          event.preventDefault()
          select(match)
          return
        }
      }

      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault()
          const next = step(index, 1)
          if (next !== undefined) focusEntry(next)
          return
        }
        case "ArrowUp": {
          event.preventDefault()
          const next = step(index, -1)
          if (next !== undefined) focusEntry(next)
          return
        }
        case "Home": {
          event.preventDefault()
          const first = enabledIndexes[0]
          if (first !== undefined) focusEntry(first)
          return
        }
        case "End": {
          event.preventDefault()
          const last = enabledIndexes[enabledIndexes.length - 1]
          if (last !== undefined) focusEntry(last)
          return
        }
        case "Escape": {
          event.preventDefault()
          closeMenu(true)
          return
        }
        case "Tab": {
          closeMenu(true)
          return
        }
        default:
      }
    },
    [closeMenu, enabledIndexes, focusEntry, entries, select, step],
  )

  return {
    itemRefs,
    openMenu,
    closeMenu,
    select,
    handleTriggerKeyDown,
    handleEntryKeyDown,
  }
}

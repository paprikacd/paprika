"use client"

import { Command } from "lucide-react"
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import { cn } from "@/lib/utils"

export interface QuickCommandItem {
  id: string
  label: string
  /** The section the item is listed under. */
  group: string
  description?: string
  /** Extra words the search also matches. */
  keywords?: readonly string[]
  shortcut?: string
}

export interface QuickCommandProps {
  items: readonly QuickCommandItem[]
  onSelect: (item: QuickCommandItem) => void
  /** Called with the typed query so the host can fetch its own results. */
  onQueryChange?: (query: string) => void
  /** Opens the dialog. Controlled when given. */
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  label?: string
  placeholder?: string
  emptyState?: ReactNode
  /**
   * Set when the host already filtered the list — the console does, because
   * the fleet index search is typo-tolerant and the local matcher is not.
   */
  filterItems?: boolean
  /** Binds ⌘/Ctrl K to the dialog. */
  shortcut?: boolean
  className?: string
}

const SHORTCUT_LABEL = "⌘K"

function matches(item: QuickCommandItem, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [item.label, item.group, item.description ?? "", ...(item.keywords ?? [])]
    .join(" ")
    .toLowerCase()
    .includes(needle)
}

/**
 * Gamma Quick command, adapted to the console's paper/steel vocabulary.
 *
 * A keyboard-first action launcher: one search field, grouped results, a
 * roving selection, and a shortcut that opens the same dialog from anywhere.
 * The dialog is native markup — a labelled `role="dialog"`, a combobox over a
 * listbox — so Escape, focus and assistive technology behave the way the
 * platform says they should.
 */
export function QuickCommand({
  items,
  onSelect,
  onQueryChange,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  label = "Search commands",
  placeholder = "Search commands…",
  emptyState = "Nothing matches that search.",
  filterItems = true,
  shortcut = false,
  className,
}: QuickCommandProps) {
  const baseId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [openInternal, setOpenInternal] = useState(defaultOpen)
  const controlled = openProp !== undefined
  const open = controlled ? openProp : openInternal
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)

  const setOpen = useCallback(
    (next: boolean) => {
      if (!controlled) setOpenInternal(next)
      onOpenChange?.(next)
    },
    [controlled, onOpenChange],
  )

  const visible = useMemo(
    () => (filterItems ? items.filter((item) => matches(item, query)) : items),
    [filterItems, items, query],
  )

  const groups = useMemo(() => {
    const order: string[] = []
    const buckets = new Map<string, QuickCommandItem[]>()
    for (const item of visible) {
      if (!buckets.has(item.group)) {
        buckets.set(item.group, [])
        order.push(item.group)
      }
      buckets.get(item.group)?.push(item)
    }
    return order.map((group) => ({ group, items: buckets.get(group) ?? [] }))
  }, [visible])

  // The active result follows the list, never the other way round: a shorter
  // result set cannot leave the selection pointing at a row that is gone.
  const index = Math.min(activeIndex, Math.max(visible.length - 1, 0))

  useEffect(() => {
    if (!open) return
    const previous = triggerRef.current
    inputRef.current?.focus()
    return () => {
      // The dialog gives focus back to whatever opened it.
      previous?.focus()
    }
  }, [open])

  useEffect(() => {
    if (!shortcut) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k") return
      if (!event.metaKey && !event.ctrlKey) return
      event.preventDefault()
      setOpen(!open)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [open, setOpen, shortcut])

  const choose = (item: QuickCommandItem) => {
    setOpen(false)
    onSelect(item)
  }

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const count = Math.max(visible.length, 1)
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActiveIndex((current) => (current + 1) % count)
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setActiveIndex((current) => (current - 1 + count) % count)
      return
    }
    if (event.key === "Home") {
      event.preventDefault()
      setActiveIndex(0)
      return
    }
    if (event.key === "End") {
      event.preventDefault()
      setActiveIndex(Math.max(visible.length - 1, 0))
      return
    }
    if (event.key === "Enter") {
      const item = visible[index]
      if (!item) return
      event.preventDefault()
      choose(item)
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      setOpen(false)
    }
  }

  const activeId = visible[index] ? `${baseId}-option-${visible[index].id}` : undefined

  return (
    <div className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex h-[26px] cursor-pointer items-center gap-1.5 border border-rule bg-card px-2",
          "font-mono text-meta text-muted-foreground hover:bg-inset hover:text-foreground",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          "pointer-coarse:h-11"
        )}
      >
        <Command className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
        <span className="hidden sm:inline">{label}</span>
        {shortcut ? (
          <kbd className="hidden rounded-[2px] border border-rule px-1 font-mono text-meta text-neutral-600 sm:inline">
            {SHORTCUT_LABEL}
          </kbd>
        ) : null}
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-100 flex items-start justify-center bg-foreground/20 px-4 pt-[12vh] pb-8"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={label}
            className="flex max-h-[70vh] w-full max-w-[520px] flex-col border border-rule-strong bg-card shadow-dropdown"
          >
            <div className="flex items-center gap-2 border-b border-rule px-3 py-2">
              <Command className="size-3.5 shrink-0 text-neutral-600" strokeWidth={1.5} aria-hidden="true" />
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded="true"
                aria-controls={`${baseId}-listbox`}
                aria-activedescendant={activeId}
                aria-autocomplete="list"
                value={query}
                placeholder={placeholder}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setActiveIndex(0)
                  onQueryChange?.(event.target.value)
                }}
                onKeyDown={handleInputKeyDown}
                className={cn(
                  "min-w-0 flex-1 border-0 bg-transparent text-console outline-none",
                  "placeholder:text-neutral-500"
                )}
              />
              <kbd className="flex-none rounded-[2px] border border-rule px-1 font-mono text-meta text-neutral-600">
                Esc
              </kbd>
            </div>

            <div
              id={`${baseId}-listbox`}
              role="listbox"
              aria-label={label}
              className="min-h-0 flex-1 overflow-y-auto py-1"
            >
              {groups.length === 0 ? (
                <p className="px-3 py-3 text-note text-muted-foreground">{emptyState}</p>
              ) : (
                groups.map((group) => (
                  <div key={group.group} role="group" aria-label={group.group}>
                    <p className="px-3 pt-1.5 pb-1 font-mono text-kicker tracking-[0.14em] text-neutral-600 uppercase">
                      {group.group}
                    </p>
                    {group.items.map((item) => {
                      const optionIndex = visible.indexOf(item)
                      const active = optionIndex === index
                      return (
                        <div
                          key={item.id}
                          id={`${baseId}-option-${item.id}`}
                          role="option"
                          aria-selected={active}
                          onPointerDown={(event) => {
                            event.preventDefault()
                            choose(item)
                          }}
                          onPointerEnter={() => setActiveIndex(optionIndex)}
                          className={cn(
                            "flex cursor-pointer items-center gap-3 px-3 py-1.5",
                            active ? "bg-inset" : "hover:bg-inset"
                          )}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-chip">{item.label}</span>
                            {item.description ? (
                              <span className="block truncate text-note text-muted-foreground">
                                {item.description}
                              </span>
                            ) : null}
                          </span>
                          {item.shortcut ? (
                            <span className="flex-none font-mono text-meta text-neutral-600">
                              {item.shortcut}
                            </span>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

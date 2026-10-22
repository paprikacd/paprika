"use client"

import { ChevronDown } from "lucide-react"
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"

import { cn } from "@/lib/utils"

import { useMenuBehaviour } from "./menu-behaviour"

export interface SplitButtonItem {
  id: string
  label: string
  description?: string
  shortcut?: string
  danger?: boolean
  disabled?: boolean
}

/**
 * Gamma Split button, adapted to the console's paper/steel vocabulary.
 *
 * The primary action stays one click away and the related actions live behind
 * the fused toggle: two separate controls inside one labelled group, so
 * opening the menu can never fire the primary action. The menu is portalled
 * nowhere — it anchors to the group and shifts or flips to stay inside the
 * viewport.
 */
export function SplitButton({
  label,
  onPrimary,
  items,
  menuLabel = "More actions",
  disabled = false,
  align = "end",
  describedBy,
  onSelect,
  className,
}: {
  label: string
  onPrimary: () => void
  items: readonly SplitButtonItem[]
  menuLabel?: string
  disabled?: boolean
  align?: "start" | "end"
  describedBy?: string
  onSelect?: (id: string) => void
  className?: string
}) {
  const toggleId = useId()
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  const {
    itemRefs,
    openMenu,
    closeMenu,
    select,
    handleTriggerKeyDown,
    handleEntryKeyDown,
  } = useMenuBehaviour({
      entries: items,
      open,
      onOpenChange: setOpen,
      onSelect: (item: SplitButtonItem) => onSelect?.(item.id),
      triggerRef,
      panelRef,
    })

  // The menu genuinely floats, so it is allowed to leave the group's column
  // but never the viewport. Measured after paint because the panel's height
  // depends on its copy, not on a fixed size; the correction is written to the
  // element's own style rather than to state, so opening never re-renders twice.
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!open || !panel) return
    panel.style.transform = ""
    panel.style.top = ""
    panel.style.bottom = ""
    const rect = panel.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return
    const edge = 8
    let shiftX = 0
    if (rect.right > window.innerWidth - edge) {
      shiftX = window.innerWidth - edge - rect.right
    }
    if (rect.left + shiftX < edge) {
      shiftX = edge - rect.left
    }
    if (shiftX !== 0) panel.style.transform = `translateX(${shiftX}px)`
    if (
      rect.bottom > window.innerHeight - edge &&
      rect.top > rect.height + edge
    ) {
      panel.style.top = "auto"
      panel.style.bottom = "calc(100% + 4px)"
    }
  }, [open])

  return (
    <div
      role="group"
      aria-label={label}
      className={cn("relative inline-flex min-w-0", className)}
    >
      <button
        type="button"
        disabled={disabled}
        aria-describedby={describedBy}
        onClick={onPrimary}
        className={cn(
          "inline-flex h-[30px] cursor-pointer items-center justify-center border border-primary bg-primary px-3.5",
          "font-cond text-label leading-[1.2] font-medium whitespace-nowrap text-primary-foreground",
          "hover:bg-steel-700 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          "pointer-coarse:h-11 pointer-coarse:px-4",
          "disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-primary"
        )}
      >
        {label}
      </button>
      <button
        ref={triggerRef}
        id={toggleId}
        type="button"
        disabled={disabled}
        aria-label={menuLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-describedby={describedBy}
        onClick={() => (open ? closeMenu(false) : openMenu(true))}
        onKeyDown={handleTriggerKeyDown}
        className={cn(
          "inline-flex h-[30px] w-[30px] cursor-pointer items-center justify-center border border-l-0 border-primary bg-primary",
          "text-primary-foreground hover:bg-steel-700",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          "pointer-coarse:h-11 pointer-coarse:w-11",
          "disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-primary",
          open && "bg-steel-700"
        )}
      >
        <ChevronDown className="size-3" strokeWidth={1.75} aria-hidden="true" />
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={menuId}
          role="menu"
          aria-labelledby={toggleId}
          className={cn(
            "absolute top-[calc(100%+4px)] z-50 min-w-[224px] border border-rule-strong bg-card shadow-dropdown",
            "motion-safe:animate-[menu-panel-in_120ms_var(--ease-out-quart)]",
            align === "end" ? "right-0" : "left-0"
          )}
        >
          {items.map((item, position) => (
            <button
              key={item.id}
              ref={(element) => {
                itemRefs.current[position] = element
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-disabled={item.disabled || undefined}
              onClick={() => select(item)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  select(item)
                  return
                }
                handleEntryKeyDown(event, position)
              }}
              className={cn(
                "flex w-full items-start gap-3 border-b border-rule-faint px-2.5 py-1.5 text-left text-chip last:border-b-0",
                "hover:bg-inset focus-visible:bg-inset focus-visible:outline-none",
                item.danger ? "text-status-failed-text" : "text-foreground",
                item.disabled && "cursor-not-allowed opacity-45"
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.label}</span>
                {item.description ? (
                  <span className="mt-0.5 block text-note leading-[1.4] text-muted-foreground">
                    {item.description}
                  </span>
                ) : null}
              </span>
              {item.shortcut ? (
                <span
                  aria-hidden="true"
                  className="mt-px flex-none font-mono text-meta text-neutral-600"
                >
                  {item.shortcut}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

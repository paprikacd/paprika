"use client"

import { MoreHorizontal } from "lucide-react"
import { useId, useRef, useState, type ReactNode } from "react"

import { cn } from "@/lib/utils"

import { useMenuBehaviour } from "./menu-behaviour"

export interface ActionMenuItem {
  id: string
  label: string
  /** A second line naming what the action does to the object. */
  description?: string
  /** A compact key hint for repeat users, e.g. "P". */
  shortcut?: string
  /** Destructive actions stay visible and semantic; they are not muted. */
  danger?: boolean
  disabled?: boolean
}

export interface ActionMenuGroup {
  id: string
  /** Names the group for assistive technology; omit when the group is obvious. */
  label?: string
  items: ActionMenuItem[]
}

/**
 * Gamma Action menu, adapted to the console's paper/steel vocabulary.
 *
 * A menu button for a compact set of row or object actions: the trigger stays
 * visible, the panel names what each action does, and a shortcut makes the
 * repeat case one keystroke. It is never the home for a single action or the
 * object's primary decision — keep that as its own visible button.
 */
export function ActionMenu({
  groups,
  label = "Actions",
  trigger,
  align = "start",
  open: openProp,
  defaultOpen = false,
  disabled = false,
  describedBy,
  onOpenChange,
  onSelect,
  className,
}: {
  groups: readonly ActionMenuGroup[]
  label?: string
  trigger?: ReactNode
  align?: "start" | "end"
  open?: boolean
  defaultOpen?: boolean
  disabled?: boolean
  describedBy?: string
  onOpenChange?: (open: boolean) => void
  onSelect?: (item: ActionMenuItem) => void
  className?: string
}) {
  const triggerId = useId()
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [openInternal, setOpenInternal] = useState(defaultOpen)
  const controlled = openProp !== undefined
  const open = controlled ? openProp : openInternal

  const entries = groups.flatMap((group) => group.items)

  const setOpen = (next: boolean) => {
    if (!controlled) setOpenInternal(next)
    onOpenChange?.(next)
  }

  const {
    itemRefs,
    openMenu,
    closeMenu,
    select,
    handleTriggerKeyDown,
    handleEntryKeyDown,
  } = useMenuBehaviour({
      entries,
      open,
      onOpenChange: setOpen,
      onSelect: (item: ActionMenuItem) => onSelect?.(item),
      triggerRef,
      panelRef,
    })

  // Positions are computed up front so the render body stays pure: each entry
  // needs a stable index into the shared ref array, across group boundaries.
  const groupOffsets = groups.map((_, groupIndex) =>
    groups
      .slice(0, groupIndex)
      .reduce((total, group) => total + group.items.length, 0),
  )

  return (
    <div className={cn("relative inline-flex", className)}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => (open ? closeMenu(false) : openMenu(true))}
        onKeyDown={handleTriggerKeyDown}
        className={cn(
          "inline-flex h-[26px] min-w-[26px] cursor-pointer items-center justify-center gap-1 border border-rule bg-card px-1.5",
          "text-muted-foreground hover:bg-inset hover:text-foreground",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          "pointer-coarse:size-11 pointer-coarse:justify-center pointer-coarse:px-0",
          "disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-card",
          open && "bg-inset text-foreground"
        )}
      >
        {trigger ?? (
          <MoreHorizontal className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
        )}
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          className={cn(
            "absolute top-[calc(100%+4px)] z-50 min-w-[224px] border border-rule-strong bg-card shadow-dropdown",
            "motion-safe:animate-[menu-panel-in_120ms_var(--ease-out-quart)]",
            align === "end" ? "right-0" : "left-0"
          )}
        >
          {groups.map((group, groupIndex) => (
            <div
              key={group.id}
              role="group"
              aria-label={group.label}
              className="border-b border-rule-faint last:border-b-0"
            >
              {group.label ? (
                <p className="px-2.5 pt-2 pb-1 font-mono text-kicker tracking-[0.14em] text-neutral-600 uppercase">
                  {group.label}
                </p>
              ) : null}
              {group.items.map((item, itemIndex) => {
                const position = groupOffsets[groupIndex] + itemIndex
                return (
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
                      "flex w-full items-start gap-3 px-2.5 py-1.5 text-left text-chip",
                      "focus-visible:bg-inset focus-visible:outline-none",
                      "hover:bg-inset",
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
                )
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

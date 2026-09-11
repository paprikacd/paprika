"use client"

import { ChevronDown, EyeOff } from "lucide-react"
import { useId, type ReactNode } from "react"

import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { cn } from "@/lib/utils"

import type { BoardId } from "./overview-layout"

/**
 * The chrome every overview board wears: the blueprint frame, a numbered
 * header, a collapse control and — in customise mode — a control that removes
 * the board from the page.
 *
 * The two mechanisms are deliberately separate. Collapsing keeps the board on
 * the page with its header readable; hiding takes it off entirely. Neither
 * changes what the board would say, so both are pure presentation.
 */
function OverviewBoard({
  id,
  index,
  title,
  meta,
  controls,
  open,
  onToggleOpen,
  customising,
  onHide,
  className,
  children,
}: {
  id: BoardId
  index: string
  title: string
  meta?: ReactNode
  controls?: ReactNode
  open: boolean
  onToggleOpen: () => void
  customising: boolean
  onHide: () => void
  className?: string
  children: ReactNode
}) {
  const bodyId = useId()

  return (
    <Blueprint
      data-board={id}
      aria-label={`${index} ${title}`}
      className={cn("min-w-0", className)}
    >
      <BoardHeader
        index={index}
        title={title}
        meta={meta}
        actions={
          <>
            {controls}
            {customising ? (
              <button
                type="button"
                onClick={onHide}
                aria-label={`Hide ${title} board`}
                className="inline-flex size-[22px] shrink-0 cursor-pointer items-center justify-center rounded-[2px] border border-status-failed-line bg-status-failed-fill text-status-failed-text hover:brightness-95 pointer-coarse:size-11"
              >
                <EyeOff className="size-3" strokeWidth={1.5} aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={onToggleOpen}
              aria-expanded={open}
              aria-controls={bodyId}
              aria-label={`${open ? "Collapse" : "Expand"} ${title} board`}
              className="inline-flex size-[22px] shrink-0 cursor-pointer items-center justify-center rounded-[2px] border border-rule bg-card text-muted-foreground hover:bg-inset pointer-coarse:size-11"
            >
              <ChevronDown
                className={cn(
                  "size-3 transition-transform",
                  !open && "-rotate-90"
                )}
                strokeWidth={1.5}
                aria-hidden="true"
              />
            </button>
          </>
        }
      />
      <div id={bodyId} hidden={!open}>
        {open ? children : null}
      </div>
    </Blueprint>
  )
}

/** A board that has nothing to say today, saying so rather than showing zero. */
function BoardEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="px-3.5 py-6 text-center text-note text-muted-foreground">
      {children}
    </p>
  )
}

/** The one-line explanatory strip several boards carry under their body. */
function BoardFootnote({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-rule-soft px-3.5 py-2 text-note text-muted-foreground",
        className
      )}
    >
      {children}
    </div>
  )
}

export { BoardEmpty, BoardFootnote, OverviewBoard }

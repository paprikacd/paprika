import { Inbox, type LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * Gamma EmptyState, adapted to the console. It explains the context and gives
 * one clear next action; it never invents data to fill the space. Use
 * `compact` inside a rail or board, and the default size for a whole pane.
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  compact = false,
  className,
}: {
  icon?: LucideIcon
  title: string
  description?: string
  action?: ReactNode
  compact?: boolean
  className?: string
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center justify-center px-5 text-center",
        compact ? "py-7" : "min-h-[22rem] py-12",
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex items-center justify-center border border-rule bg-inset text-neutral-600",
          compact ? "size-8" : "size-10"
        )}
      >
        <Icon className={compact ? "size-4" : "size-5"} strokeWidth={1.5} />
      </span>
      <p
        className={cn(
          "mt-3 font-cond font-semibold tracking-[0.02em] text-foreground",
          compact ? "text-name" : "text-board"
        )}
      >
        {title}
      </p>
      {description ? (
        <p className="mt-1 max-w-md text-note leading-[1.5] text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

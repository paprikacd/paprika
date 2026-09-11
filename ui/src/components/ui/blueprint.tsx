import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * The frame every board, figure and panel wears: square, hairline-bordered,
 * with `+` registration marks at the four corners. The marks are drawn from
 * pseudo-elements in `globals.css`; the four `<i>` children position them.
 *
 * They are decoration, so they stay out of the accessibility tree.
 */
function Blueprint({
  className,
  children,
  ...props
}: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="blueprint"
      className={cn("blueprint bg-card", className)}
      {...props}
    >
      <i aria-hidden className="corner tl" />
      <i aria-hidden className="corner tr" />
      <i aria-hidden className="corner bl" />
      <i aria-hidden className="corner br" />
      {children}
    </section>
  )
}

/**
 * A board's title bar. The index is a positional label — boards are referred
 * to by number in the overview — not an ordinal ranking of importance.
 */
function BoardHeader({
  index,
  title,
  meta,
  actions,
  className,
}: {
  index?: string
  title: string
  meta?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div
      data-slot="board-header"
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-rule py-1.5 pr-2.5 pl-3.5",
        className
      )}
    >
      <div className="flex min-w-0 items-baseline gap-2.5">
        {index ? (
          <span className="font-mono text-meta tracking-[0.14em] text-steel-600">
            {index}
          </span>
        ) : null}
        <h2 className="font-cond text-board font-semibold tracking-[0.04em] whitespace-nowrap uppercase">
          {title}
        </h2>
      </div>
      {meta || actions ? (
        <span className="ml-auto flex items-center gap-2.5">
          {meta ? (
            <span className="font-mono text-meta whitespace-nowrap text-muted-foreground">
              {meta}
            </span>
          ) : null}
          {actions}
        </span>
      ) : null}
    </div>
  )
}

export { Blueprint, BoardHeader }

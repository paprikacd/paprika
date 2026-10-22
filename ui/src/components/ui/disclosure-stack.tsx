"use client"

import { ChevronRight } from "lucide-react"
import { useId, useState, type ReactNode } from "react"

import { cn } from "@/lib/utils"

export interface DisclosureItem {
  id: string
  title: string
  /** A short state note shown beside the title, e.g. a status or a count. */
  meta?: ReactNode
  content: ReactNode
}

/**
 * Gamma Disclosure stack, adapted to the console's paper/steel vocabulary.
 *
 * A compact library of answers: each row names one question, states whether it
 * is open, and reveals one panel at a time without losing the others. Panels
 * live in the DOM so `aria-controls` always resolves; closed panels are hidden,
 * not unmounted into a dangling reference.
 */
export function DisclosureStack({
  items,
  mode = "single",
  defaultOpen = [],
  openIds: openIdsProp,
  onOpenChange,
  className,
}: {
  items: readonly DisclosureItem[]
  mode?: "single" | "multiple"
  defaultOpen?: readonly string[]
  openIds?: readonly string[]
  onOpenChange?: (openIds: string[]) => void
  className?: string
}) {
  const baseId = useId()
  const [openInternal, setOpenInternal] = useState<readonly string[]>(defaultOpen)
  const controlled = openIdsProp !== undefined
  const openIds = controlled ? openIdsProp : openInternal

  const setOpenIds = (next: string[]) => {
    if (!controlled) setOpenInternal(next)
    onOpenChange?.(next)
  }

  const toggle = (id: string) => {
    const isOpen = openIds.includes(id)
    if (mode === "single") {
      setOpenIds(isOpen ? [] : [id])
      return
    }
    setOpenIds(isOpen ? openIds.filter((openId) => openId !== id) : [...openIds, id])
  }

  return (
    <div data-slot="disclosure-stack" className={cn("min-w-0", className)}>
      {items.map((item) => {
        const isOpen = openIds.includes(item.id)
        const buttonId = `${baseId}-${item.id}-button`
        const panelId = `${baseId}-${item.id}-panel`
        return (
          <div key={item.id} className="border-b border-rule-soft last:border-b-0">
            <h3 className="m-0">
              <button
                type="button"
                id={buttonId}
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => toggle(item.id)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left",
                  "hover:bg-inset focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  isOpen && "bg-inset"
                )}
              >
                <ChevronRight
                  aria-hidden="true"
                  strokeWidth={1.75}
                  className={cn(
                    "size-3 shrink-0 text-neutral-600 motion-safe:transition-transform motion-safe:duration-150",
                    isOpen && "rotate-90"
                  )}
                />
                <span className="min-w-0 flex-1 truncate font-cond text-label font-semibold tracking-[0.02em]">
                  {item.title}
                </span>
                {item.meta ? <span className="flex-none">{item.meta}</span> : null}
              </button>
            </h3>
            <div
              id={panelId}
              role="region"
              aria-labelledby={buttonId}
              hidden={!isOpen}
              className="motion-safe:animate-[panel-reveal-in_140ms_var(--ease-out-quart)]"
            >
              {item.content}
            </div>
          </div>
        )
      })}
    </div>
  )
}

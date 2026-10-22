"use client"

import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react"

import { cn } from "@/lib/utils"

export type TooltipPlacement = "auto" | "top" | "bottom" | "left" | "right"

export interface TooltipProps {
  /** The short annotation. A phrase or one sentence, never a panel. */
  content: ReactNode
  /** The trigger. It keeps its own action; the tooltip only annotates it. */
  children: ReactElement<{ "aria-describedby"?: string }>
  placement?: TooltipPlacement
  /** Hover-open delay in milliseconds. Focus opens immediately. */
  delay?: number
  /** Grace period before a pointer-leave closes the bubble. */
  closeDelay?: number
  /** How long after closing a nearby trigger opens without waiting. */
  warmDuration?: number
  disabled?: boolean
  className?: string
}

const GAP = 6
const EDGE = 8

/**
 * Gamma Tooltip, adapted to the console's paper/steel vocabulary.
 *
 * An annotation, not a panel: it names a truncated value, an icon-only
 * action, or a piece of vocabulary the operator may not know yet. Hover opens
 * it after a short delay, focus opens it at once, Escape closes it without
 * moving focus, and the bubble is placed against the viewport so it stays
 * inside the frame. The bubble is fixed to the viewport, so an ancestor that
 * scrolls cannot clip it.
 */
export function Tooltip({
  content,
  children,
  placement = "auto",
  delay = 220,
  closeDelay = 90,
  warmDuration = 600,
  disabled = false,
  className,
}: TooltipProps) {
  const bubbleId = useId()
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLSpanElement>(null)
  const bubbleRef = useRef<HTMLSpanElement>(null)
  const openTimer = useRef<number | undefined>(undefined)
  const closeTimer = useRef<number | undefined>(undefined)
  const closedAt = useRef(0)

  const clearTimers = useCallback(() => {
    window.clearTimeout(openTimer.current)
    window.clearTimeout(closeTimer.current)
    openTimer.current = undefined
    closeTimer.current = undefined
  }, [])

  const close = useCallback(() => {
    clearTimers()
    // The warm handoff is measured from the moment the bubble left, so the
    // next trigger nearby opens without waiting again.
    closedAt.current = Date.now()
    setOpen(false)
  }, [clearTimers])

  const show = useCallback(() => {
    clearTimers()
    setOpen(true)
  }, [clearTimers])

  useEffect(() => () => clearTimers(), [clearTimers])

  // A pointer that lands outside the trigger closes the bubble, wherever the
  // pointer went — the tooltip never takes focus away from the work.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null
      if (target && wrapperRef.current?.contains(target)) return
      close()
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [open, close])

  // The bubble is measured after it renders, then placed against the
  // viewport: it flips to a side with room and slides along the edge.
  useLayoutEffect(() => {
    if (!open) return
    const bubble = bubbleRef.current
    const trigger = wrapperRef.current
    if (!bubble || !trigger) return
    const box = bubble.getBoundingClientRect()
    const anchor = trigger.getBoundingClientRect()

    const room = {
      top: anchor.top - EDGE,
      bottom: window.innerHeight - anchor.bottom - EDGE,
      left: anchor.left - EDGE,
      right: window.innerWidth - anchor.right - EDGE,
    }

    let side = placement
    if (side === "auto") {
      side =
        room.top >= box.height + GAP
          ? "top"
          : room.bottom >= box.height + GAP
            ? "bottom"
            : room.top >= room.bottom
              ? "top"
              : "bottom"
    } else {
      const needed =
        side === "top" || side === "bottom" ? box.height : box.width
      const opposite =
        side === "top"
          ? "bottom"
          : side === "bottom"
            ? "top"
            : side === "left"
              ? "right"
              : "left"
      if (room[side] < needed + GAP && room[opposite] >= needed + GAP) {
        side = opposite
      }
    }

    let left: number
    let top: number
    if (side === "top" || side === "bottom") {
      left = anchor.left + anchor.width / 2 - box.width / 2
      top = side === "top" ? anchor.top - box.height - GAP : anchor.bottom + GAP
    } else {
      left = side === "left" ? anchor.left - box.width - GAP : anchor.right + GAP
      top = anchor.top + anchor.height / 2 - box.height / 2
    }

    left = Math.min(Math.max(left, EDGE), window.innerWidth - box.width - EDGE)
    top = Math.min(Math.max(top, EDGE), window.innerHeight - box.height - EDGE)

    bubble.style.left = `${Math.round(left)}px`
    bubble.style.top = `${Math.round(top)}px`
  }, [open, placement, content])

  const handlePointerEnter = () => {
    if (disabled) return
    clearTimers()
    const warm = Date.now() - closedAt.current < warmDuration
    if (warm) {
      show()
      return
    }
    openTimer.current = window.setTimeout(show, delay)
  }

  const handlePointerLeave = () => {
    if (disabled) return
    clearTimers()
    closeTimer.current = window.setTimeout(close, closeDelay)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "Escape" || !open) return
    event.stopPropagation()
    close()
  }

  const trigger = cloneElement(children, {
    "aria-describedby": open ? bubbleId : undefined,
  })

  return (
    <span
      ref={wrapperRef}
      data-slot="tooltip"
      className={cn("relative inline-flex", className)}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocusCapture={() => {
        if (disabled) return
        show()
      }}
      onBlurCapture={() => {
        if (disabled) return
        close()
      }}
      onKeyDown={handleKeyDown}
    >
      {trigger}
      {open ? (
        <span
          ref={bubbleRef}
          id={bubbleId}
          role="tooltip"
          data-slot="tooltip-content"
          className={cn(
            "pointer-events-none fixed top-0 left-0 z-100 w-max max-w-[240px]",
            "border border-rule-strong bg-card px-2 py-1 text-note leading-[1.45] text-foreground shadow-dropdown",
            "motion-safe:animate-[tooltip-in_120ms_var(--ease-out-quart)]"
          )}
        >
          {content}
        </span>
      ) : null}
    </span>
  )
}

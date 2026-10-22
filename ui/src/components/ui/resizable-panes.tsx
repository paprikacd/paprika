"use client"

import {
  useCallback,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import { cn } from "@/lib/utils"

export interface ResizablePanesProps {
  left: ReactNode
  right: ReactNode
  /** Percentage of the group's width given to the left pane. */
  defaultRatio?: number
  minRatio?: number
  maxRatio?: number
  label?: string
  /** Controlled ratio. Omit to let the panes own it. */
  ratio?: number
  onRatioChange?: (ratio: number) => void
  /** Remembers the split under this key so a reload keeps the operator's rail. */
  storageKey?: string
  /** Below this viewport width the panes stack and the divider is hidden. */
  stackBelow?: number
  className?: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * A media query read through the store, so the first client render matches the
 * prerendered one and a resize never needs a layout effect.
 */
function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => {}
      }
      const list = window.matchMedia(query)
      list.addEventListener?.("change", onChange)
      return () => list.removeEventListener?.("change", onChange)
    },
    [query],
  )
  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false
    }
    return window.matchMedia(query).matches
  }, [query])
  const getServerSnapshot = useCallback(() => false, [])
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** The remembered split, read the same way the console reads the clock. */
function useStoredRatio(storageKey: string | undefined, fallback: number): number {
  const subscribe = useCallback((onChange: () => void) => {
    window.addEventListener("storage", onChange)
    return () => window.removeEventListener("storage", onChange)
  }, [])
  const getSnapshot = useCallback(() => {
    if (!storageKey) return fallback
    const stored = window.localStorage.getItem(storageKey)
    const parsed = Number(stored)
    return Number.isFinite(parsed) ? parsed : fallback
  }, [storageKey, fallback])
  const getServerSnapshot = useCallback(() => fallback, [fallback])
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/**
 * Gamma Resizable panes, adapted to the console's paper/steel vocabulary.
 *
 * Two panes and a divider that states the split: the content stays visible,
 * and both pointer and keyboard can move it without losing context. The
 * divider is a focusable separator, so it reports its position to assistive
 * technology and can be adjusted without a pointer at all.
 */
export function ResizablePanes({
  left,
  right,
  defaultRatio = 38,
  minRatio = 22,
  maxRatio = 72,
  label = "Resize panes",
  ratio: ratioProp,
  onRatioChange,
  storageKey,
  stackBelow = 1280,
  className,
}: ResizablePanesProps) {
  const groupId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const [override, setOverride] = useState<number | null>(null)
  const stored = useStoredRatio(storageKey, defaultRatio)
  const stacked = useMediaQuery(`(max-width: ${stackBelow - 1}px)`)

  const controlled = ratioProp !== undefined
  const ratio = controlled
    ? clamp(ratioProp, minRatio, maxRatio)
    : clamp(override ?? stored, minRatio, maxRatio)

  const setRatio = useCallback(
    (next: number) => {
      const clamped = clamp(next, minRatio, maxRatio)
      if (!controlled) setOverride(clamped)
      if (storageKey) window.localStorage.setItem(storageKey, String(clamped))
      onRatioChange?.(clamped)
    },
    [controlled, maxRatio, minRatio, onRatioChange, storageKey],
  )

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragging.current = true
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    if (rect.width === 0) return
    setRatio(((event.clientX - rect.left) / rect.width) * 100)
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 2
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault()
        setRatio(ratio - step)
        return
      case "ArrowRight":
        event.preventDefault()
        setRatio(ratio + step)
        return
      case "Home":
        event.preventDefault()
        setRatio(minRatio)
        return
      case "End":
        event.preventDefault()
        setRatio(maxRatio)
        return
      default:
    }
  }

  const rounded = Math.round(ratio)

  return (
    <div
      ref={containerRef}
      data-slot="resizable-panes"
      className={cn(
        "flex items-stretch",
        stacked ? "flex-col gap-4" : "flex-row gap-0",
        className
      )}
    >
      <div
        id={`${groupId}-left`}
        className="min-w-0"
        style={stacked ? undefined : { width: `${ratio}%` }}
      >
        {left}
      </div>

      {stacked ? null : (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={label}
          aria-valuemin={minRatio}
          aria-valuemax={maxRatio}
          aria-valuenow={rounded}
          aria-valuetext={`${rounded}% for the main pane, ${100 - rounded}% for the detail rail`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={handleKeyDown}
          onDoubleClick={() => setRatio(defaultRatio)}
          className={cn(
            "group mx-2 flex w-3 flex-none cursor-col-resize touch-none items-stretch justify-center",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "w-px bg-rule-strong transition-colors",
              "group-hover:bg-foreground/30 group-focus-visible:bg-primary"
            )}
          />
        </div>
      )}

      <div className="min-w-0 flex-1">{right}</div>
    </div>
  )
}

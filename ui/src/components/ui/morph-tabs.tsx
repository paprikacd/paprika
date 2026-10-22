"use client"

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react"

import { cn } from "@/lib/utils"

export interface MorphTab<T extends string> {
  id: T
  label: string
}

export type MorphTabDirection = "left" | "right"

/**
 * Gamma MorphTabs, adapted to the console's paper/steel vocabulary.
 *
 * The tab bar is a real tablist: roving tabindex, selection follows focus for
 * arrow/Home/End, and the panel relationship is wired by the caller's IDs. The
 * moving underline is the authored moment — a measured transform, not a
 * per-tab border that snaps. Panels opt into the directional reveal with
 * `MorphTabPanel`.
 */
export function MorphTabList<T extends string>({
  tabs,
  value,
  onValueChange,
  label,
  idPrefix,
  panelId,
  className,
}: {
  tabs: readonly MorphTab<T>[]
  value: T
  onValueChange: (value: T) => void
  label: string
  idPrefix: string
  panelId: string
  className?: string
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === value)
  )
  const [indicator, setIndicator] = useState({
    left: 0,
    width: 0,
    ready: false,
  })

  useEffect(() => {
    const measure = () => {
      const active = tabRefs.current[activeIndex]
      if (!active) return
      setIndicator({
        left: active.offsetLeft,
        width: active.offsetWidth,
        ready: true,
      })
    }
    measure()
    const list = listRef.current
    if (!list || typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure)
      return () => window.removeEventListener("resize", measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [activeIndex, tabs])

  const activate = (index: number) => {
    const next = tabs[index]
    if (!next) return
    onValueChange(next.id)
    tabRefs.current[index]?.focus()
  }

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    let nextIndex: number | null = null
    switch (event.key) {
      case "ArrowRight":
        nextIndex = (index + 1) % tabs.length
        break
      case "ArrowLeft":
        nextIndex = (index - 1 + tabs.length) % tabs.length
        break
      case "Home":
        nextIndex = 0
        break
      case "End":
        nextIndex = tabs.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    activate(nextIndex)
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      data-slot="morph-tablist"
      className={cn(
        "relative flex min-w-0 items-stretch overflow-x-auto border-b border-rule bg-card",
        className
      )}
    >
      {tabs.map((tab, index) => {
        const selected = index === activeIndex
        return (
          <button
            key={tab.id}
            ref={(element) => {
              tabRefs.current[index] = element
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-${tab.id}`}
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => onValueChange(tab.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              "relative z-10 h-9 shrink-0 cursor-pointer border-0 bg-transparent px-3 text-chip whitespace-nowrap",
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              selected
                ? "font-semibold text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        )
      })}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 left-0 h-0.5 bg-primary transition-[transform,width] duration-200 ease-out motion-reduce:transition-none"
        style={{
          transform: `translateX(${indicator.left}px)`,
          width: indicator.width,
          opacity: indicator.ready ? 1 : 0,
        }}
      />
    </div>
  )
}

/**
 * The tabpanel half of MorphTabs. The caller keys this by the active tab so a
 * direction change restarts the 180ms reveal. `prefers-reduced-motion` is
 * handled in `globals.css`; the state is never hidden by the transition.
 */
export function MorphTabPanel({
  id,
  labelledBy,
  direction,
  className,
  children,
}: {
  id: string
  labelledBy: string
  direction: MorphTabDirection
  className?: string
  children: ReactNode
}) {
  return (
    <div
      id={id}
      role="tabpanel"
      aria-labelledby={labelledBy}
      tabIndex={0}
      data-direction={direction}
      data-slot="morph-tabpanel"
      className={cn("morph-tab-panel outline-none", className)}
    >
      {children}
    </div>
  )
}

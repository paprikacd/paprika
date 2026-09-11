"use client"

import {
  useCallback,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react"

import { cn } from "@/lib/utils"

import { formatAge, type SurfaceGate } from "./rollout-model"

/**
 * Wall-clock time, but only after mount. The clock is external state, so it is
 * subscribed to rather than read during render: a prerendered age would
 * otherwise disagree with the hydrated one. Before the subscription runs the
 * snapshot is 0, and every age derived from it is omitted rather than wrong.
 */
export function useNow(intervalMs = 30_000): number {
  const snapshot = useRef(0)
  const subscribe = useCallback(
    (onChange: () => void) => {
      snapshot.current = Date.now()
      onChange()
      const timer = window.setInterval(() => {
        snapshot.current = Date.now()
        onChange()
      }, intervalMs)
      return () => window.clearInterval(timer)
    },
    [intervalMs],
  )
  return useSyncExternalStore(
    subscribe,
    () => snapshot.current,
    () => 0,
  )
}

/**
 * The furniture both rollout routes share: the page band, the console button,
 * and the two ways a surface admits it has less than it would like — a stale
 * badge over real-but-old numbers, and a greyed note where numbers would be.
 */

/** The white band every delivery screen opens with. */
export function PageBand({
  breadcrumb,
  title,
  badge,
  subline,
  actions,
}: {
  breadcrumb: ReactNode
  title: string
  badge?: ReactNode
  subline?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="border-b border-rule bg-card px-[22px] py-4">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0">
          <div className="font-mono text-meta text-neutral-600">
            {breadcrumb}
          </div>
          <div className="mt-[5px] flex flex-wrap items-center gap-3">
            <h1 className="font-cond text-title leading-none font-semibold tracking-[0.01em]">
              {title}
            </h1>
            {badge}
          </div>
          {subline ? (
            <div className="mt-[7px] font-mono text-note text-muted-foreground">
              {subline}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-none flex-wrap items-center gap-[7px]">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function PageBody({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 px-[22px] pt-[18px] pb-8",
        className,
      )}
    >
      {children}
    </div>
  )
}

type ConsoleButtonTone = "primary" | "secondary" | "destructive"

/**
 * The design's `.btn`: square, hairline, condensed. It is a separate control
 * from the shadcn `Button` because that one is rounded, `text-sm` and sans —
 * three properties this drawing does not have.
 */
export function ConsoleButton({
  tone = "secondary",
  className,
  ...props
}: { tone?: ConsoleButtonTone } & React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-[30px] cursor-pointer items-center justify-center gap-1.5 border px-3.5",
        "font-cond text-label leading-[1.2] font-medium whitespace-nowrap",
        "pointer-coarse:h-11 pointer-coarse:px-4",
        "disabled:cursor-not-allowed disabled:opacity-45",
        tone === "primary" &&
          "border-primary bg-primary text-primary-foreground hover:bg-steel-700",
        tone === "secondary" &&
          "border-rule bg-card text-foreground hover:bg-inset",
        tone === "destructive" &&
          "border-status-failed-line bg-card text-status-failed-text hover:bg-status-failed-fill",
        className,
      )}
      {...props}
    />
  )
}

/**
 * `STALE` is the one non-OK state that still carries real numerics, so the
 * numbers stay and the badge says how old they are. Without the age this would
 * be indistinguishable from current data.
 */
export function StaleBadge({
  gate,
  now,
}: {
  gate: SurfaceGate
  now: number
}) {
  const age = formatAge(gate.observedAtUnixMs, now)
  return (
    <span className="inline-flex items-center gap-[5px] rounded-[2px] border border-status-degraded-line bg-status-degraded-fill px-[7px] py-px text-meta font-semibold tracking-[0.04em] text-status-degraded-text uppercase">
      {age ? `Stale · ${age} old` : "Stale"}
    </span>
  )
}

/**
 * `NOT_AVAILABLE` and `ERROR`: the source exists but has nothing to say. The
 * surface stays, greyed, carrying the server's reason — never a zero.
 */
export function DegradedNote({
  reason,
  fallback,
}: {
  reason: string
  fallback: string
}) {
  return (
    <p className="bg-inset px-3.5 py-3 text-reason text-neutral-700">
      {reason || fallback}
    </p>
  )
}

/**
 * A cell the API did not fill. Visually blank on purpose — a dash or a zero
 * would read as a measurement — but named for assistive technology, which
 * would otherwise announce an unexplained empty cell.
 */
export function Absent({ label = "Not reported" }: { label?: string }) {
  return <span className="sr-only">{label}</span>
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="px-3.5 py-4 text-reason text-muted-foreground">{children}</p>
  )
}

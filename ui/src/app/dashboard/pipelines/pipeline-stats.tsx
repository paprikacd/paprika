"use client"

import { STATUS_TONES } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

import { formatDuration, type StatCell } from "./pipeline-model"

/**
 * The stats strip under the step graph. Cells are supplied, not invented:
 * a data class that is NOT_CONFIGURED produces no cell at all, so the strip
 * narrows rather than filling with zeros. That is why it is a flex row and
 * not a fixed four-column grid.
 */
export function PipelineStatStrip({
  cells,
  nowMs,
  className,
}: {
  cells: readonly StatCell[]
  nowMs: number
  className?: string
}) {
  if (cells.length === 0) return null

  return (
    <dl
      className={cn(
        "flex flex-wrap gap-px border-t border-rule bg-rule",
        className
      )}
    >
      {cells.map((cell) => (
        <div
          key={cell.key}
          className="min-w-[132px] flex-1 bg-card px-3.5 py-2.5"
        >
          <dt className="font-mono text-kicker tracking-[0.14em] text-neutral-600 uppercase">
            {cell.label}
          </dt>
          <dd className="mt-0.5">
            {cell.unavailableReason ? (
              <>
                <span className="font-cond text-card font-semibold text-neutral-500">
                  Unavailable
                </span>
                <span className="block text-meta text-neutral-600">
                  {cell.unavailableReason}
                </span>
              </>
            ) : (
              <>
                <span
                  className={cn(
                    "font-cond text-stat leading-none font-semibold tabular-nums",
                    cell.tone ? STATUS_TONES[cell.tone].text : undefined
                  )}
                >
                  {cell.value}
                </span>
                {cell.staleObservedAtMs ? (
                  <span className="ml-1.5 border border-status-degraded-line bg-status-degraded-fill px-1 align-middle text-kicker font-semibold tracking-[0.08em] text-status-degraded-text uppercase">
                    Stale {formatDuration(Math.max(0, nowMs - cell.staleObservedAtMs))}
                  </span>
                ) : null}
                {cell.note ? (
                  <span className="block text-meta text-neutral-600">
                    {cell.note}
                  </span>
                ) : null}
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

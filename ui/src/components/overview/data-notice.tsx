import type { DataSourceStatus } from "@/gen/paprika/v1/api_pb"
import { cn } from "@/lib/utils"

import { formatAge, isStale, isUnavailable } from "./data-state"

/**
 * What a configured-but-unanswerable data class looks like: the server's own
 * sentence, greyed, in the space the numbers would have occupied. The reason
 * is authored server-side and sanitized there, so it is safe to render.
 */
function UnavailableNote({
  reason,
  className,
}: {
  reason: string
  className?: string
}) {
  return (
    <p
      className={cn(
        "text-note leading-[1.45] text-neutral-600 italic",
        className
      )}
    >
      {reason || "This data is not available from this server."}
    </p>
  )
}

/**
 * `STALE` is the one non-OK state that still carries numbers. They are the last
 * good sample, so they are rendered — with their true age attached, never as
 * though they were current.
 */
function StaleBadge({
  observedAtUnixMs,
  now,
  className,
}: {
  observedAtUnixMs: bigint | number | undefined
  now: number
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 border border-status-degraded-line bg-status-degraded-fill px-1.5 text-meta font-semibold tracking-[0.04em] text-status-degraded-text uppercase",
        className
      )}
    >
      stale · {formatAge(observedAtUnixMs, now)}
    </span>
  )
}

/**
 * The two things a caller almost always wants beside a state-carrying figure:
 * an age badge when the sample is stale, and the reason when there is no
 * sample at all.
 */
function DataStateNote({
  source,
  now,
  className,
}: {
  source: DataSourceStatus | undefined
  now: number
  className?: string
}) {
  if (!source) return null
  if (isStale(source.state)) {
    return (
      <StaleBadge
        observedAtUnixMs={source.observedAtUnixMs}
        now={now}
        className={className}
      />
    )
  }
  if (isUnavailable(source.state)) {
    return (
      <UnavailableNote reason={source.unavailableReason} className={className} />
    )
  }
  return null
}

export { DataStateNote, StaleBadge, UnavailableNote }

"use client"

import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { StatusPill } from "@/components/ui/status-chip"
import { cn } from "@/lib/utils"

import {
  DataState,
  type ListRolloutHistoryResponse,
  type RolloutHistoryEntry,
} from "@/gen/paprika/v1/api_pb"

import {
  DegradedNote,
  EmptyNote,
  StaleBadge,
} from "./rollout-chrome"
import { numbersAreReal } from "@/lib/data-state"

import {
  formatDurationMs,
  rolloutOutcomeLabel,
  rolloutOutcomeTone,
  type SurfaceGate,
} from "./rollout-model"

/**
 * Completed rollouts over the recent window. The caller only mounts this board
 * once the `ROLLOUT_HISTORY` data class says the feed exists, so the states
 * handled here are the ones a live feed can still be in: greyed with a reason,
 * or real numbers carrying an age badge.
 */
export function RolloutHistoryBoard({
  gate,
  response,
  isPending,
  now,
}: {
  gate: SurfaceGate
  response: ListRolloutHistoryResponse | undefined
  isPending: boolean
  now: number
}) {
  const entries = response?.entries ?? []
  const stats = response?.stats

  return (
    <Blueprint>
      <BoardHeader
        title="Recent rollouts"
        meta={
          response?.retentionLimit
            ? `retains ${response.retentionLimit} records`
            : undefined
        }
        actions={
          gate.disposition === "stale" ? (
            <StaleBadge gate={gate} now={now} />
          ) : undefined
        }
      />

      {gate.disposition === "unavailable" ? (
        <DegradedNote
          reason={gate.reason}
          fallback="Rollout history is configured but currently unavailable."
        />
      ) : isPending ? (
        <EmptyNote>Loading completed rollouts…</EmptyNote>
      ) : (
        <>
          {/* `!== "absent"` is true for NOT_AVAILABLE and ERROR, in which the
              server zeroes its numerics — so the strip would report
              "COMPLETED 0 · SUCCEEDED 0 · FAILED 0" as though it had counted.
              Only OK and STALE carry real numbers. */}
          {stats && numbersAreReal(stats.state) ? (
            <StatsStrip stats={stats} />
          ) : null}
          {entries.length === 0 ? (
            <EmptyNote>
              No rollouts completed in this window.
            </EmptyNote>
          ) : (
            <HistoryTable entries={entries} now={now} />
          )}
          <Provenance response={response} />
        </>
      )}
    </Blueprint>
  )
}

function StatsStrip({
  stats,
}: {
  stats: NonNullable<ListRolloutHistoryResponse["stats"]>
}) {
  const cells: { label: string; value: string }[] = [
    { label: "COMPLETED", value: stats.total.toString() },
    { label: "SUCCEEDED", value: stats.succeeded.toString() },
    {
      label: "FAILED / ABORTED",
      value: (stats.failed + stats.aborted + stats.rolledBack).toString(),
    },
    { label: "MEDIAN", value: formatDurationMs(stats.medianDurationMs) },
    { label: "P90", value: formatDurationMs(stats.p90DurationMs) },
  ]
  return (
    <dl className="grid grid-cols-2 gap-px border-t border-rule bg-rule sm:grid-cols-3 lg:grid-cols-5">
      {cells.map((cell) => (
        <div key={cell.label} className="bg-card px-3.5 py-[9px]">
          <dt className="font-mono text-kicker tracking-[0.14em] text-neutral-600">
            {cell.label}
          </dt>
          <dd className="mt-0.5 font-cond text-stat font-semibold tabular-nums">
            {cell.value || <span className="sr-only">Not reported</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function HistoryTable({
  entries,
  now,
}: {
  entries: readonly RolloutHistoryEntry[]
  now: number
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <caption className="sr-only">
          Rollouts that finished in the selected window, newest first.
        </caption>
        <thead>
          <tr className="border-b border-rule-strong bg-muted">
            <Head>FINISHED</Head>
            <Head className="w-full max-w-0 text-left">APPLICATION</Head>
            <Head>STAGE</Head>
            <Head>STRATEGY</Head>
            <Head className="text-right">STEPS</Head>
            <Head className="text-right">TOOK</Head>
            <Head className="text-right">OUTCOME</Head>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, index) => {
            const finishedMs = Number(entry.finishedAtUnixMs)
            const iso = finishedMs
              ? new Date(finishedMs).toISOString()
              : ""
            const age =
              now && finishedMs ? formatDurationMs(now - finishedMs) : ""
            return (
              <tr
                key={`${entry.identity?.namespace}/${entry.identity?.name}/${index}`}
                className="border-b border-rule-soft"
              >
                <td className="px-3.5 py-2 font-mono text-meta whitespace-nowrap text-neutral-600">
                  {iso ? (
                    <time dateTime={iso}>{age ? `${age} ago` : iso}</time>
                  ) : (
                    <span className="sr-only">Not reported</span>
                  )}
                </td>
                <td className="w-full max-w-0 px-3.5 py-2">
                  <span className="block truncate font-cond text-label font-semibold tracking-[0.02em]">
                    {entry.application?.name || (
                      <span className="sr-only">Not reported</span>
                    )}
                  </span>
                  {entry.revision ? (
                    <span className="block truncate font-mono text-meta text-neutral-600">
                      {entry.revision}
                    </span>
                  ) : null}
                </td>
                <td className="px-3.5 py-2 text-note whitespace-nowrap text-muted-foreground">
                  {entry.stage || <span className="sr-only">Not reported</span>}
                </td>
                <td className="px-3.5 py-2 text-note whitespace-nowrap text-muted-foreground">
                  {entry.strategy || (
                    <span className="sr-only">Not reported</span>
                  )}
                </td>
                <td className="px-3.5 py-2 text-right font-mono text-note tabular-nums whitespace-nowrap">
                  {entry.stepsTotal
                    ? `${entry.stepsCompleted}/${entry.stepsTotal}`
                    : ""}
                </td>
                <td className="px-3.5 py-2 text-right font-mono text-note tabular-nums whitespace-nowrap">
                  {formatDurationMs(entry.durationMs)}
                </td>
                <td className="px-3.5 py-2 text-right whitespace-nowrap">
                  <StatusPill
                    tone={rolloutOutcomeTone(entry.outcome)}
                    label={rolloutOutcomeLabel(entry.outcome)}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * An aggregate over a retained window is not an aggregate over all time. The
 * sample size, the window start and the retention horizon are printed because
 * without them "median 8m" reads as a lifetime figure.
 */
function Provenance({
  response,
}: {
  response: ListRolloutHistoryResponse | undefined
}) {
  if (!response) return null
  const parts: string[] = []
  const stats = response.stats
  if (stats && stats.state === DataState.OK && stats.sampleSize) {
    parts.push(`aggregate over ${stats.sampleSize} retained records`)
  }
  const windowStart = Number(stats?.windowStartUnixMs ?? BigInt(0))
  if (windowStart) {
    parts.push(`since ${new Date(windowStart).toLocaleString()}`)
  }
  const horizon = Number(response.retentionHorizonUnixMs)
  if (horizon) {
    parts.push(
      `nothing retained before ${new Date(horizon).toLocaleDateString()}`,
    )
  }
  if (response.nextCursor) {
    parts.push("more records exist beyond this page")
  }
  if (parts.length === 0) return null
  return (
    <p className="border-t border-rule-soft px-3.5 py-2 font-mono text-meta text-neutral-600">
      {parts.join(" · ")}
    </p>
  )
}

function Head({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <th
      scope="col"
      className={cn(
        "h-7 px-3.5 font-mono text-kicker font-normal tracking-[0.14em] whitespace-nowrap text-muted-foreground",
        className ?? "text-left",
      )}
    >
      {children}
    </th>
  )
}

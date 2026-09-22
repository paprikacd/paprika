"use client"

import Link from "next/link"

import { StatusPill } from "@/components/ui/status-chip"
import {
  RolloutOutcome,
  type ListRolloutHistoryResponse,
  type Rollout,
  type RolloutHistoryEntry,
} from "@/gen/paprika/v1/api_pb"
import { STATUS_TONES, type StatusTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

import { BoardEmpty, BoardFootnote } from "./overview-board"
import { UnavailableNote } from "./data-notice"
import { formatAge, formatDuration, numbersAreReal, plural } from "./data-state"
import { rolloutHref } from "./overview-links"

/**
 * `ListRollouts` is unpaginated, so the board caps what it draws and links to
 * the rollouts view for the rest. A control plane mid-fleet-wide promotion must
 * not be able to put a thousand rows on the overview.
 */
export const MAX_IN_FLIGHT_ROWS = 6

/** A rollout is in flight while the controller is still acting on it. */
export function isInFlight(rollout: Rollout): boolean {
  return rollout.phase === "Progressing" || rollout.phase === "Paused"
}

function outcomeTone(outcome: RolloutOutcome): StatusTone {
  switch (outcome) {
    case RolloutOutcome.SUCCEEDED:
      return "healthy"
    case RolloutOutcome.ABORTED:
    case RolloutOutcome.FAILED:
      return "failed"
    case RolloutOutcome.ROLLED_BACK:
      return "degraded"
    case RolloutOutcome.SUPERSEDED:
      return "unknown"
    default:
      return "unknown"
  }
}

function outcomeLabel(outcome: RolloutOutcome): string {
  switch (outcome) {
    case RolloutOutcome.SUCCEEDED:
      return "Completed"
    case RolloutOutcome.ABORTED:
      return "Aborted"
    case RolloutOutcome.FAILED:
      return "Failed"
    case RolloutOutcome.ROLLED_BACK:
      return "Rolled back"
    case RolloutOutcome.SUPERSEDED:
      return "Superseded"
    default:
      return "Unknown"
  }
}

/** A step ladder: completed steps behind, the current step lit, the rest pending. */
function StepLadder({
  states,
  className,
}: {
  states: readonly StatusTone[]
  className?: string
}) {
  const last = Math.max(1, states.length - 1)
  return (
    <span
      aria-hidden="true"
      className={cn("flex items-end gap-px", className)}
    >
      {states.map((tone, index) => (
        <span
          key={index}
          style={{ height: `${8 + (index / last) * 14}px` }}
          className={cn(
            "flex-1 border",
            STATUS_TONES[tone].line,
            tone === "pending" ? "bg-transparent" : STATUS_TONES[tone].fill
          )}
        />
      ))}
    </span>
  )
}

/**
 * Board 04, in-flight tab — what the controller is doing right now.
 *
 * Every figure is read straight off the `Rollout`: the ladder is its canary
 * steps, the marker is `currentStep`, the weight is `currentWeight`. The design
 * also shows an analysis verdict per rollout ("1 metric failing"); that needs a
 * `ListAnalysisRuns` call per row, so the controller's own message is shown
 * instead of a verdict this board cannot substantiate.
 */
export function InFlightRollouts({ rollouts }: { rollouts: readonly Rollout[] }) {
  if (rollouts.length === 0) {
    return <BoardEmpty>No rollouts in flight.</BoardEmpty>
  }

  const shown = rollouts.slice(0, MAX_IN_FLIGHT_ROWS)

  return (
    <>
      <ul className="list-none">
        {shown.map((rollout) => {
          const steps = rollout.canarySteps
          const total = steps.length
          const states: StatusTone[] = steps.map((_step, index) => {
            if (index < rollout.currentStep) return "healthy"
            if (index > rollout.currentStep) return "pending"
            if (rollout.abort) return "failed"
            return rollout.paused ? "degraded" : "progressing"
          })
          // `currentWeight`, `replicas` and `canaryReadyReplicas` are bare
          // proto3 int32s: an unset field and a real zero decode identically.
          // A rollout with no canary steps has no canary, so those numbers say
          // nothing about it — reporting "0% canary weight" for a Rolling
          // rollout is an invented figure, not a measurement.
          const hasCanary = total > 0
          const detail =
            rollout.message ||
            (hasCanary
              ? `${rollout.canaryReadyReplicas} of ${rollout.replicas} canary ${plural(rollout.replicas, "pod")} ready`
              : "")
          return (
            <li
              key={`${rollout.namespace}/${rollout.name}`}
              className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)_auto] items-center gap-3.5 border-b border-rule-soft px-3.5 py-2.5"
            >
              <span className="min-w-0">
                <Link
                  href={rolloutHref(rollout.namespace, rollout.name)}
                  className="block truncate font-cond text-name font-semibold tracking-[0.02em] text-foreground"
                >
                  {rollout.name}
                </Link>
                <span className="mt-px block font-mono text-meta text-neutral-600">
                  {rollout.namespace}
                  {rollout.strategyType ? ` · ${rollout.strategyType}` : ""}
                </span>
              </span>
              <span className="min-w-0">
                {total > 0 ? <StepLadder states={states} className="h-5.5" /> : null}
                <span className="mt-1 flex justify-between gap-2.5 text-meta text-muted-foreground">
                  <span className="font-mono whitespace-nowrap">
                    {total > 0
                      ? `STEP ${Math.min(rollout.currentStep + 1, total)} / ${total}`
                      : "NO CANARY STEPS"}{" "}
                    · {rollout.phase.toUpperCase()}
                  </span>
                  <span className="truncate font-mono">{detail}</span>
                </span>
              </span>
              <span className="text-right">
                {hasCanary ? (
                  <>
                    <span className="block font-cond text-canary leading-none font-semibold tabular-nums">
                      {rollout.currentWeight}%
                    </span>
                    <span className="mt-0.5 block font-mono text-kicker tracking-[0.1em] text-neutral-600">
                      CANARY WEIGHT
                    </span>
                  </>
                ) : (
                  <span className="block font-mono text-meta whitespace-nowrap text-neutral-500">
                    no weighted traffic
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      {rollouts.length > shown.length ? (
        <BoardFootnote>
          <span>
            Showing {shown.length} of {rollouts.length} in flight.
          </span>
          <Link href="/dashboard/rollouts/" className="ml-auto whitespace-nowrap">
            Open all rollouts →
          </Link>
        </BoardFootnote>
      ) : null}
    </>
  )
}

/**
 * Board 04, recent tab — completed rollouts from the history recorder.
 *
 * The tab only exists when `DATA_CLASS_ROLLOUT_HISTORY` says a recorder does.
 * The stats strip carries its own `DataState` because an aggregate can be
 * missing while the individual records are fine.
 */
export function RecentRollouts({
  history,
  now,
}: {
  history: ListRolloutHistoryResponse
  now: number
}) {
  if (history.entries.length === 0) {
    return <BoardEmpty>No rollouts completed in this window.</BoardEmpty>
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-130 border-collapse text-left">
          <caption className="sr-only">
            Rollouts completed in the retention window
          </caption>
          <thead>
            <tr className="border-b border-rule-strong bg-neutral-200">
              {["Rollout", "Outcome", "Steps", "Took", "When"].map((label) => (
                <th
                  key={label}
                  scope="col"
                  className="px-2 py-1 font-mono text-kicker font-normal tracking-[0.14em] text-muted-foreground uppercase first:pl-3.5 last:pr-3.5"
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {history.entries.map((entry) => (
              <RecentRow key={entryKey(entry)} entry={entry} now={now} />
            ))}
          </tbody>
        </table>
      </div>
      <RecentStats history={history} now={now} />
    </>
  )
}

function entryKey(entry: RolloutHistoryEntry): string {
  const identity = entry.identity
  return identity
    ? `${identity.namespace}/${identity.name}`
    : `${entry.application?.name ?? ""}/${entry.startedAtUnixMs}`
}

function RecentRow({
  entry,
  now,
}: {
  entry: RolloutHistoryEntry
  now: number
}) {
  const tone = outcomeTone(entry.outcome)
  const spec = STATUS_TONES[tone]
  const total = Math.max(entry.stepsTotal, entry.stepsCompleted)
  const states: StatusTone[] = Array.from({ length: total }, (_value, index) => {
    if (index < entry.stepsCompleted) return "healthy"
    if (index === entry.stepsCompleted && tone !== "healthy") return tone
    return "pending"
  })
  const application = entry.application
  const name = application?.name ?? entry.rollout?.name ?? "unknown"

  return (
    <tr
      className={cn(
        "border-b border-rule-soft border-l-[3px]",
        spec.line,
        tone === "healthy" ? "bg-card" : spec.fill
      )}
    >
      <th scope="row" className="min-w-0 py-2 pr-2 pl-2.5 font-normal">
        <span className="flex items-baseline gap-1.5">
          {application ? (
            <Link
              href={rolloutHref(application.namespace, name)}
              className="truncate font-cond text-label font-semibold tracking-[0.02em] text-foreground"
            >
              {name}
            </Link>
          ) : (
            <span className="truncate font-cond text-label font-semibold tracking-[0.02em]">
              {name}
            </span>
          )}
          {entry.release?.name ? (
            <span className="font-mono text-meta text-neutral-600">
              {entry.release.name}
            </span>
          ) : null}
        </span>
        <span className="mt-px block truncate text-note text-muted-foreground">
          {entry.message ||
            entry.reason ||
            `${entry.stepsCompleted} of ${entry.stepsTotal} ${plural(entry.stepsTotal, "step")}${entry.strategy ? ` · ${entry.strategy}` : ""}`}
        </span>
      </th>
      <td className="px-2 py-2">
        <StatusPill tone={tone} label={outcomeLabel(entry.outcome)} />
      </td>
      <td className="px-2 py-2">
        {total > 0 ? <StepLadder states={states} className="h-3.5 w-20" /> : null}
        <span className="sr-only">
          {entry.stepsCompleted} of {entry.stepsTotal} steps completed
        </span>
      </td>
      <td className="px-2 py-2 text-right font-mono text-note tabular-nums">
        {formatDuration(entry.durationMs)}
      </td>
      <td className="py-2 pr-3.5 pl-2 text-right font-mono text-meta text-neutral-600">
        {formatAge(entry.finishedAtUnixMs, now)}
      </td>
    </tr>
  )
}

function RecentStats({
  history,
  now,
}: {
  history: ListRolloutHistoryResponse
  now: number
}) {
  const stats = history.stats
  if (!stats) return null
  if (!numbersAreReal(stats.state)) {
    return (
      <BoardFootnote>
        <UnavailableNote
          reason={
            stats.state === undefined
              ? "Rollout statistics are not available."
              : "Rollout statistics are not available from this server."
          }
        />
      </BoardFootnote>
    )
  }

  const window = stats.windowStartUnixMs
    ? `${formatDuration(now - Number(stats.windowStartUnixMs))} window`
    : "retention window"

  return (
    <BoardFootnote className="gap-x-4">
      <span>
        <span className="font-cond text-name font-semibold text-foreground">
          {stats.total.toString()}
        </span>{" "}
        rollouts · {window}
      </span>
      <span>
        <span className="font-cond text-name font-semibold text-status-healthy-text">
          {stats.succeeded.toString()}
        </span>{" "}
        completed
      </span>
      <span>
        <span className="font-cond text-name font-semibold text-status-failed-text">
          {stats.aborted.toString()}
        </span>{" "}
        aborted
      </span>
      <span>
        <span className="font-cond text-name font-semibold text-foreground">
          {formatDuration(stats.medianDurationMs)}
        </span>{" "}
        median · {stats.sampleSize.toString()} sampled
      </span>
    </BoardFootnote>
  )
}

"use client"

import { LifecyclePhaseState } from "@/gen/paprika/v1/api_pb"
import { STATUS_TONES, worstTone, type StatusTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

import { BoardFootnote } from "./overview-board"
import { plural } from "./data-state"

/**
 * The six phases, in `LifecyclePhase` order 1..6. The vector on a fleet row is
 * always six entries in this order, so position is the phase.
 */
const PHASE_LABELS = [
  "Source",
  "Build",
  "Test",
  "Render",
  "Deploy",
  "Verify",
] as const

/**
 * A phase state maps onto a status tone so the board reads in the same
 * vocabulary as everything else. `NOT_APPLICABLE` maps to nothing on purpose:
 * an application with no test stage is inert at Test, not unknown at Test, and
 * counting it either way would misstate the fleet.
 */
function toneOfPhaseState(state: LifecyclePhaseState): StatusTone | null {
  switch (state) {
    case LifecyclePhaseState.SUCCEEDED:
      return "healthy"
    case LifecyclePhaseState.RUNNING:
      return "progressing"
    case LifecyclePhaseState.BLOCKED:
      return "degraded"
    case LifecyclePhaseState.FAILED:
      return "failed"
    case LifecyclePhaseState.PENDING:
      return "pending"
    case LifecyclePhaseState.NOT_APPLICABLE:
      return null
    default:
      return "unknown"
  }
}

const DETAIL_ORDER: readonly { state: LifecyclePhaseState; word: string }[] = [
  { state: LifecyclePhaseState.FAILED, word: "failed" },
  { state: LifecyclePhaseState.BLOCKED, word: "blocked" },
  { state: LifecyclePhaseState.RUNNING, word: "running" },
  { state: LifecyclePhaseState.PENDING, word: "pending" },
  { state: LifecyclePhaseState.UNKNOWN, word: "not reported" },
  { state: LifecyclePhaseState.SUCCEEDED, word: "succeeded" },
  { state: LifecyclePhaseState.NOT_APPLICABLE, word: "not applicable" },
]

const MIX_ORDER: readonly StatusTone[] = [
  "failed",
  "degraded",
  "progressing",
  "pending",
  "unknown",
  "healthy",
]

export interface LifecyclePhaseSummary {
  index: string
  label: string
  /** Applications running, blocked or failing at this phase. */
  inFlight: number
  /** Applications the vector actually described at this phase. */
  described: number
  tone: StatusTone
  detail: string
  mix: readonly { tone: StatusTone; count: number }[]
}

/**
 * Rolls a set of six-entry lifecycle vectors up into one figure per phase.
 *
 * Every number here is a count of the vectors handed in — the caller states the
 * sample it drew them from, because a windowed aggregate presented as a fleet
 * total is exactly the lie the degraded-mode contract exists to prevent.
 */
export function summarizeLifecycle(
  vectors: readonly (readonly LifecyclePhaseState[])[]
): LifecyclePhaseSummary[] {
  return PHASE_LABELS.map((label, position) => {
    const tally = new Map<LifecyclePhaseState, number>()
    for (const vector of vectors) {
      const state = vector[position] ?? LifecyclePhaseState.UNSPECIFIED
      tally.set(state, (tally.get(state) ?? 0) + 1)
    }

    const countOf = (state: LifecyclePhaseState) => tally.get(state) ?? 0
    const inFlight =
      countOf(LifecyclePhaseState.RUNNING) +
      countOf(LifecyclePhaseState.BLOCKED) +
      countOf(LifecyclePhaseState.FAILED)

    const toneCounts = new Map<StatusTone, number>()
    let described = 0
    for (const [state, count] of tally) {
      const tone = toneOfPhaseState(state)
      if (tone === null) continue
      described += count
      toneCounts.set(tone, (toneCounts.get(tone) ?? 0) + count)
    }

    const detail = DETAIL_ORDER.filter(({ state }) => countOf(state) > 0)
      .slice(0, 3)
      .map(({ state, word }) => `${countOf(state)} ${word}`)
      .join(" · ")

    return {
      index: String(position + 1).padStart(2, "0"),
      label,
      inFlight,
      described,
      tone: worstTone([...toneCounts.keys()]),
      detail: detail || "nothing reported",
      mix: MIX_ORDER.flatMap((tone) => {
        const count = toneCounts.get(tone) ?? 0
        return count > 0 ? [{ tone, count }] : []
      }),
    }
  })
}

/**
 * Board 01 — the six delivery phases as one control plane rather than four
 * operators stitched together.
 *
 * The board only exists when a lifecycle projection does. It draws no phase it
 * cannot substantiate, which is why `sampleSize` and `total` are required
 * rather than optional: the reader is always told what the figures are counted
 * over.
 */
export function LifecycleBoard({
  phases,
  sampleSize,
  total,
}: {
  phases: readonly LifecyclePhaseSummary[]
  sampleSize: number
  total: bigint
}) {
  const complete = BigInt(sampleSize) >= total

  return (
    <>
      <ol className="grid list-none grid-cols-2 gap-px bg-rule sm:grid-cols-3 xl:grid-cols-6">
        {phases.map((phase, position) => {
          const spec = STATUS_TONES[phase.tone]
          return (
            <li
              key={phase.label}
              className={cn("min-w-0 px-3.5 pt-3 pb-3.5", spec.fill)}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className={cn(
                    "font-mono text-kicker tracking-[0.16em]",
                    spec.text
                  )}
                >
                  {phase.index}
                </span>
                {position < phases.length - 1 ? (
                  <span aria-hidden="true" className="text-note text-neutral-400">
                    ›
                  </span>
                ) : null}
              </div>
              <h3 className="mt-1.5 font-cond text-name font-semibold tracking-[0.08em] uppercase">
                {phase.label}
              </h3>
              <p
                aria-hidden="true"
                className={cn(
                  "mt-1.5 font-cond text-hero leading-none font-semibold tabular-nums",
                  spec.text
                )}
              >
                {phase.inFlight}
              </p>
              <p className="sr-only">
                {phase.inFlight} of {phase.described}{" "}
                {plural(phase.described, "application")} running, blocked or
                failing at {phase.label}
              </p>
              <p className="mt-1.5 text-note leading-[1.45] text-muted-foreground">
                {phase.detail}
              </p>
              <div aria-hidden="true" className="mt-2 flex h-[5px] gap-[3px]">
                {phase.mix.map((segment) => (
                  <span
                    key={segment.tone}
                    style={{ flexGrow: segment.count }}
                    className={cn("h-full", STATUS_TONES[segment.tone].bar)}
                  />
                ))}
              </div>
            </li>
          )
        })}
      </ol>
      <BoardFootnote>
        <span>
          CI, CD, traffic and verification are one reconciliation loop. Each
          figure counts applications running, blocked or failing at that phase
          {complete
            ? "."
            : `, across the ${sampleSize} highest-impact of ${total.toString()} indexed.`}
        </span>
      </BoardFootnote>
    </>
  )
}

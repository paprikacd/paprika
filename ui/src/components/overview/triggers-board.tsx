"use client"

import {
  SourceEventKind,
  SourceEventOutcome,
  type SourceEvent,
} from "@/gen/paprika/v1/api_pb"
import { cn } from "@/lib/utils"

import { BoardEmpty } from "./overview-board"
import { formatAge, plural } from "./data-state"

const KIND_TAGS: Record<SourceEventKind, string> = {
  [SourceEventKind.UNSPECIFIED]: "EVENT",
  [SourceEventKind.GIT_PUSH]: "GIT",
  [SourceEventKind.GIT_TAG]: "TAG",
  [SourceEventKind.OCI_PUSH]: "OCI",
  [SourceEventKind.S3_OBJECT]: "S3",
  [SourceEventKind.POLL_DETECTED]: "POLL",
  [SourceEventKind.MANUAL_SYNC]: "SYNC",
}

const OUTCOME_LABELS: Record<SourceEventOutcome, string> = {
  [SourceEventOutcome.UNSPECIFIED]: "recorded",
  [SourceEventOutcome.ACCEPTED]: "accepted",
  [SourceEventOutcome.NO_MATCH]: "matched nothing",
  [SourceEventOutcome.REJECTED]: "rejected",
  [SourceEventOutcome.FAILED]: "failed",
}

function isBadOutcome(outcome: SourceEventOutcome): boolean {
  return (
    outcome === SourceEventOutcome.REJECTED ||
    outcome === SourceEventOutcome.FAILED
  )
}

/** `acme/checkout-api@9f3a1c2 → main` — whichever parts the record actually has. */
export function eventReference(event: SourceEvent): string {
  const revision = event.commit?.shortRevision || ""
  const base = event.repositoryUrl || event.repository?.name || "unknown source"
  const head = revision ? `${base}@${revision}` : base
  return event.reference ? `${head} → ${event.reference}` : head
}

/**
 * What the event did downstream. The message is the recorder's own; the
 * fallback counts only the applications the record says it triggered, and says
 * "at least" when the record itself admits the list was truncated.
 */
export function eventEffect(event: SourceEvent): string {
  if (event.message) return event.message
  const count = event.triggeredApplicationCount
  if (count === 0) return OUTCOME_LABELS[event.outcome]
  const prefix = event.triggeredApplicationsTruncated ? "at least " : ""
  return `${OUTCOME_LABELS[event.outcome]} · ${prefix}${count} ${plural(count, "application")} triggered`
}

/**
 * Board 05 — what arrived from a source and what it set off.
 *
 * These are recorded events, not inferred ones: the board exists only when
 * `DATA_CLASS_SOURCE_EVENTS` reports a recorder, and it never guesses a push
 * from a revision that happens to have changed between polls.
 */
export function TriggersBoard({
  events,
  now,
}: {
  events: readonly SourceEvent[]
  now: number
}) {
  if (events.length === 0) {
    return <BoardEmpty>No source events in this window.</BoardEmpty>
  }

  return (
    <ol className="list-none">
      {events.map((event, position) => {
        const bad = isBadOutcome(event.outcome)
        return (
          <li
            key={event.identity ? `${event.identity.namespace}/${event.identity.name}` : `${event.deliveryId}-${position}`}
            className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-rule-soft px-3.5 py-2"
          >
            <span
              className={cn(
                "inline-flex h-[17px] items-center justify-center rounded-[2px] border border-rule bg-inset font-mono text-kicker tracking-[0.06em]",
                bad ? "text-status-failed-text" : "text-steel-700"
              )}
            >
              {KIND_TAGS[event.kind]}
            </span>
            <span className="min-w-0">
              <span className="block truncate font-mono text-note">
                {eventReference(event)}
              </span>
              <span className="mt-px block truncate text-note text-muted-foreground">
                {eventEffect(event)}
              </span>
            </span>
            <span className="font-mono text-meta whitespace-nowrap text-neutral-600">
              {formatAge(event.receivedAtUnixMs, now)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

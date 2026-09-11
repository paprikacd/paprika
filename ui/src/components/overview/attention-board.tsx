"use client"

import Link from "next/link"

import { StatusGlyph } from "@/components/ui/status-chip"
import {
  FleetCapability,
  FleetConnectionState,
  FleetHealth,
  FleetRolloutState,
  FleetSyncState,
  type ApplicationSummary,
} from "@/gen/paprika/v1/api_pb"
import type { FleetQueryState } from "@/lib/fleet-query"
import { STATUS_TONES, healthTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

import { BoardEmpty, BoardFootnote } from "./overview-board"
import { formatAge, plural } from "./data-state"
import {
  applicationHref,
  diffHref,
  inventoryHref,
  repositoryHref,
} from "./overview-links"

/**
 * Why an application is in the queue, said only in terms the fleet row can
 * substantiate.
 *
 * The design writes prose — "p99 latency 41% over baseline". The fleet index
 * carries no message field, and fetching one per row would be an N+1 across a
 * queue, so the reason is composed from the states that are actually on the
 * row. A shorter true sentence beats a longer invented one.
 */
export function attentionReason(application: ApplicationSummary): string {
  const parts: string[] = []

  if (application.repositoryConnection === FleetConnectionState.UNHEALTHY) {
    parts.push("Source unreachable — last good sync retained")
  }

  switch (application.health) {
    case FleetHealth.FAILED:
      parts.push("Workload failing")
      break
    case FleetHealth.MISSING:
      parts.push(
        application.missingResourceCount > 0
          ? `${application.missingResourceCount} ${plural(application.missingResourceCount, "resource")} missing from the cluster`
          : "Resources missing from the cluster"
      )
      break
    case FleetHealth.DEGRADED:
      parts.push("Health checks failing")
      break
    case FleetHealth.PROGRESSING:
      parts.push("Progressing")
      break
    default:
      break
  }

  if (application.blockedGateCount > 0) {
    parts.push(
      `${application.blockedGateCount} approval ${plural(application.blockedGateCount, "gate")} blocked`
    )
  }

  if (
    application.rolloutState === FleetRolloutState.PAUSED &&
    application.blockedGateCount === 0
  ) {
    parts.push("Rollout paused")
  }

  if (application.sync === FleetSyncState.OUT_OF_SYNC) {
    parts.push(
      application.driftCount > 0
        ? `${application.driftCount} ${plural(application.driftCount, "field")} drifted from the rendered manifest`
        : "Drifted from the rendered manifest"
    )
  }

  if (parts.length === 0) {
    return `Ranked by blast radius · ${application.resourceCount} ${plural(application.resourceCount, "resource")} managed`
  }
  return parts.slice(0, 2).join(" · ")
}

export interface AttentionAction {
  label: string
  href: string
}

/**
 * The action a row offers is a navigation, named for where it goes. Nothing
 * here mutates, so nothing here can be labelled with a verb it will not
 * perform — "Approve" appears only when the caller actually holds
 * `GATE_APPROVE` on that project, because the fleet row's capability list is
 * authorization-derived.
 */
export function attentionAction(
  application: ApplicationSummary,
  state: FleetQueryState
): AttentionAction {
  const identity = application.identity
  if (application.repositoryConnection === FleetConnectionState.UNHEALTHY) {
    return { label: "Fix source", href: repositoryHref(application.repository) }
  }
  if (
    application.blockedGateCount > 0 &&
    application.capabilities.includes(FleetCapability.GATE_APPROVE)
  ) {
    return { label: "Approve", href: applicationHref(identity) }
  }
  if (application.sync === FleetSyncState.OUT_OF_SYNC) {
    return { label: "Diff", href: diffHref(identity) }
  }
  if (
    application.rolloutState === FleetRolloutState.PROGRESSING ||
    application.rolloutState === FleetRolloutState.PAUSED
  ) {
    return { label: "Review", href: applicationHref(identity) }
  }
  void state
  return { label: "View", href: applicationHref(identity) }
}

/**
 * Board 03 — the server-ranked attention window.
 *
 * The ranking is `sort=impact` inside `GetSystemStatus`, so the order here is
 * the fleet service's order, not a client re-sort of one page. The board never
 * claims to show everything: `attentionTotal` and the queue link say how much
 * is behind it.
 */
export function AttentionBoard({
  applications,
  attentionTotal,
  hasMore,
  now,
  state,
}: {
  applications: readonly ApplicationSummary[]
  attentionTotal: bigint
  hasMore: boolean
  now: number
  state: FleetQueryState
}) {
  if (applications.length === 0) {
    return <BoardEmpty>Nothing in scope needs attention.</BoardEmpty>
  }

  return (
    <>
      <ol className="list-none">
        {applications.map((application, position) => {
          const identity = application.identity
          const tone = healthTone(application.health)
          const spec = STATUS_TONES[tone]
          const action = attentionAction(application, state)
          const name = identity?.name ?? "unknown"
          return (
            <li
              key={`${identity?.namespace ?? ""}/${name}`}
              className={cn(
                "grid grid-cols-[1.25rem_1rem_minmax(0,1fr)_auto_5rem] items-center gap-2 border-b border-rule-soft border-l-[3px] py-1.5 pr-3.5 pl-2.5",
                spec.line,
                position < 3 ? spec.fill : "bg-card"
              )}
            >
              <span className="font-mono text-meta text-neutral-500">
                {String(position + 1).padStart(2, "0")}
              </span>
              <StatusGlyph tone={tone} />
              <span className="min-w-0">
                <span className="flex items-baseline gap-1.5">
                  <Link
                    href={applicationHref(identity)}
                    className="truncate font-cond text-card font-semibold tracking-[0.02em] text-foreground"
                  >
                    {name}
                  </Link>
                  <span className="truncate font-mono text-meta text-neutral-500">
                    {identity?.namespace}
                  </span>
                </span>
                <span className="mt-px block truncate text-reason text-muted-foreground">
                  {attentionReason(application)}
                </span>
              </span>
              <span className="font-mono text-meta whitespace-nowrap text-neutral-600">
                {formatAge(application.lastTransitionUnixMs, now)}
              </span>
              <Link
                href={action.href}
                aria-label={`${action.label} — ${name}`}
                className={cn(
                  "inline-flex h-6 min-h-6 w-full items-center justify-center rounded-[2px] border bg-card text-micro font-semibold tracking-[0.02em] no-underline hover:bg-inset hover:no-underline pointer-coarse:h-11",
                  spec.line,
                  spec.text
                )}
              >
                {action.label}
              </Link>
            </li>
          )
        })}
      </ol>
      <BoardFootnote>
        <span>
          Showing {applications.length} of {attentionTotal.toString()} ranked by
          blast radius.
        </span>
        {hasMore ? (
          <Link
            href={inventoryHref(state, {
              view: "queue",
              sort: "impact",
              direction: "desc",
            })}
            className="ml-auto whitespace-nowrap"
          >
            Open the full queue →
          </Link>
        ) : null}
      </BoardFootnote>
    </>
  )
}

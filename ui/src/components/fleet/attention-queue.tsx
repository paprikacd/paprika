"use client"

import { useVirtualizer } from "@tanstack/react-virtual"
import { useCallback, useRef } from "react"

import {
  ApplicationCapabilityActions,
  FleetLoadMore,
  applicationKey,
  identityKey,
  observeMeasuredElementRect,
  releaseFocusOwnership,
  type ApplicationCollectionProps,
  useApplicationFocusAdapter,
} from "@/components/fleet/application-table"

export function AttentionQueue(props: ApplicationCollectionProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const itemTargets = useRef(new Map<string, HTMLElement>())
  const virtualizer = useVirtualizer({
    count: props.applications.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 116,
    overscan: 6,
    getItemKey: (index) => applicationKey(props.applications[index], index),
    initialRect: { width: 1120, height: 560 },
    observeElementRect: observeMeasuredElementRect,
    measureElement: (element) => element.getBoundingClientRect().height || 116,
  })
  const getTarget = useCallback(
    (key: string) => itemTargets.current.get(key) ?? null,
    [],
  )
  const scrollToIndex = useCallback(
    (index: number) => virtualizer.scrollToIndex(index, { align: "center" }),
    [virtualizer],
  )

  useApplicationFocusAdapter({
    presentation: "queue",
    applications: props.applications,
    coordinator: props.focusCoordinator,
    getResultsHeadingTarget: props.getResultsHeadingTarget,
    getTarget,
    scrollToIndex,
  })

  return (
    <section aria-label="Attention queue" className="min-w-0">
      <div className="border-b border-border bg-card px-4 py-3 sm:px-6">
        <p className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-primary">
          Server-ranked operator order
        </p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          The fleet service orders this queue. Every page remains in authoritative server order.
        </p>
      </div>
      <div
        ref={scrollRef}
        data-testid="attention-queue-scroll"
        className="h-[min(62vh,42rem)] min-h-80 overflow-auto border-b border-border bg-background"
      >
        <div className="sticky top-0 z-10 h-px overflow-hidden border-0 bg-card xl:h-auto xl:overflow-visible xl:border-b xl:border-border">
          <div
            aria-hidden="true"
            className="sr-only min-h-11 grid-cols-[3rem_minmax(16rem,1fr)_minmax(12rem,0.8fr)_minmax(10rem,1fr)] items-center gap-4 px-4 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground sm:px-6 xl:not-sr-only xl:grid"
          >
            <span>Rank</span>
            <span>Application</span>
            <span>Attention signals</span>
            <span>Authorized actions</span>
          </div>
        </div>
        <ol
          aria-label="Applications requiring attention"
          className="relative min-w-0"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const application = props.applications[virtualItem.index]
            const identity = application.identity
            const key = applicationKey(application, virtualItem.index)
            const factIdPrefix = identity
              ? `attention-fact-${virtualItem.index}-${identity.namespace}-${identity.name}`
              : `attention-fact-${virtualItem.index}-identity-unavailable`
            const rank = String(virtualItem.index + 1).padStart(2, "0")
            const reason = attentionReason(application)
            return (
              <li
                key={key}
                ref={(node) => {
                  if (node) {
                    itemTargets.current.set(key, node)
                    virtualizer.measureElement(node)
                  } else {
                    itemTargets.current.delete(key)
                  }
                }}
                data-index={virtualItem.index}
                data-row-key={key}
                data-testid={identity
                  ? `attention-row-${identity.namespace}-${identity.name}`
                  : `attention-row-identity-unavailable-${virtualItem.index}`}
                data-virtual-start={virtualItem.start}
                tabIndex={identity ? 0 : -1}
                aria-label={identity ? `${identity.namespace}/${identity.name}` : `Queue item ${virtualItem.index + 1}`}
                aria-posinset={virtualItem.index + 1}
                aria-setsize={Number(props.total)}
                onFocus={() => identity && props.onFocusedApplication(identity)}
                onBlur={(event) =>
                  releaseFocusOwnership(
                    event.currentTarget,
                    event.relatedTarget,
                    props.onFocusedApplication,
                  )
                }
                onClick={() => identity && props.onSelectApplication(identity)}
                onKeyDown={(event) => {
                  if (!identity || (event.key !== "Enter" && event.key !== " ")) return
                  event.preventDefault()
                  props.onSelectApplication(identity)
                }}
                className="absolute left-0 top-0 grid w-full grid-cols-[3rem_minmax(0,1fr)] items-start gap-x-3 gap-y-3 border-b border-border/70 px-4 py-4 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted sm:px-6 xl:grid-cols-[3rem_minmax(16rem,1fr)_minmax(12rem,0.8fr)_minmax(10rem,1fr)] xl:items-center xl:gap-4"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                <span className="col-span-2 flex min-w-0 items-start gap-3 xl:contents">
                  <span
                    role="group"
                    aria-labelledby={`${factIdPrefix}-rank-label ${factIdPrefix}-rank-value`}
                    className="flex w-12 shrink-0 flex-col gap-1 xl:w-auto"
                  >
                    <span
                      id={`${factIdPrefix}-rank-label`}
                      className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground xl:sr-only"
                    >
                      Queue rank
                    </span>
                    <span
                      id={`${factIdPrefix}-rank-value`}
                      className="font-mono text-lg font-semibold tabular-nums text-primary"
                    >
                      {rank}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1 xl:block">
                    <strong className="block truncate text-sm font-semibold text-foreground">
                      {identity?.name || "Unnamed application"}
                    </strong>
                    <span className="mt-1 block truncate font-mono text-[0.6875rem] text-muted-foreground">
                      {identity ? identityKey(identity) : "Identity unavailable"}
                    </span>
                  </span>
                </span>

                <span className="col-span-2 min-w-0 xl:col-span-1">
                  <span
                    role="group"
                    aria-labelledby={`${factIdPrefix}-reason-label ${factIdPrefix}-reason-value`}
                    className="block min-w-0"
                  >
                    <span
                      id={`${factIdPrefix}-reason-label`}
                      className="block font-mono text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground xl:sr-only"
                    >
                      Attention reason
                    </span>
                    <strong
                      id={`${factIdPrefix}-reason-value`}
                      className="mt-1 block truncate text-xs font-semibold text-warning xl:mt-0"
                    >
                      {reason}
                    </strong>
                  </span>

                  <span className="mt-3 grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 xl:mt-2">
                    <QueueFact
                      idPrefix={`${factIdPrefix}-target`}
                      label="Target"
                      value={application.currentClusterLabel || "No target"}
                    />
                    <QueueFact
                      idPrefix={`${factIdPrefix}-stage`}
                      label="Stage"
                      value={application.currentStage || "Stage unknown"}
                    />
                  </span>
                  <span className="mt-3 grid min-w-0 grid-cols-3 gap-x-3 xl:mt-2">
                    <QueueFact
                      idPrefix={`${factIdPrefix}-health`}
                      label="Health status"
                      value={humanize(application.health)}
                    />
                    <QueueFact
                      idPrefix={`${factIdPrefix}-sync`}
                      label="Sync status"
                      value={humanize(application.sync)}
                    />
                    <QueueFact
                      idPrefix={`${factIdPrefix}-resources`}
                      label="Resource count"
                      value={application.resourceCount.toLocaleString()}
                      tabular
                    />
                    <QueueFact
                      idPrefix={`${factIdPrefix}-drift`}
                      label="Drift count"
                      value={application.driftCount.toLocaleString()}
                      tabular
                    />
                    <QueueFact
                      idPrefix={`${factIdPrefix}-blocked`}
                      label="Blocked gate count"
                      value={application.blockedGateCount.toLocaleString()}
                      tabular
                    />
                  </span>
                </span>

                <span
                  className="col-span-2 min-w-0 xl:col-span-1"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <span className="mb-1 block font-mono text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground xl:sr-only">
                    Authorized actions
                  </span>
                  {identity ? (
                    <ApplicationCapabilityActions
                      identity={identity}
                      capabilities={application.capabilities}
                    />
                  ) : null}
                </span>
              </li>
            )
          })}
        </ol>
      </div>
      <FleetLoadMore
        loaded={props.applications.length}
        total={props.total}
        hasMore={props.hasMore}
        isLoadingMore={props.isLoadingMore}
        onLoadMore={props.onLoadMore}
      />
    </section>
  )
}

function QueueFact({
  idPrefix,
  label,
  value,
  tabular = false,
}: {
  idPrefix: string
  label: string
  value: string
  tabular?: boolean
}) {
  return (
    <span
      role="group"
      aria-labelledby={`${idPrefix}-label ${idPrefix}-value`}
      className="flex min-w-0 flex-col gap-1"
    >
      <span
        id={`${idPrefix}-label`}
        className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground xl:sr-only"
      >
        {label}
      </span>
      <span
        id={`${idPrefix}-value`}
        className={`truncate font-mono text-xs font-medium text-foreground${tabular ? " tabular-nums" : ""}`}
      >
        {value}
      </span>
    </span>
  )
}

const activeReleaseStates = new Set([
  "pending",
  "promoting",
  "canarying",
  "verifying",
  "awaiting_approval",
])
const activeRolloutStates = new Set(["pending", "progressing", "paused"])

function attentionReason(application: ApplicationCollectionProps["applications"][number]): string {
  if (application.health !== "healthy") return healthAttentionReason(application.health)
  if (application.blockedGateCount > 0) return `${application.blockedGateCount} blocked gates`
  if (activeReleaseStates.has(application.releaseState)) {
    return `Active release ${humanize(application.releaseState)}`
  }
  if (activeRolloutStates.has(application.rolloutState)) {
    return `Active rollout ${humanize(application.rolloutState)}`
  }
  return "No active attention signal"
}

function humanize(value: string): string {
  return value.replaceAll("_", " ")
}

function healthAttentionReason(health: string): string {
  const humanized = humanize(health).trim()
  const sentenceCased = humanized
    ? `${humanized.charAt(0).toUpperCase()}${humanized.slice(1)}`
    : "Unknown"
  return sentenceCased.toLowerCase().endsWith(" health")
    ? sentenceCased
    : `${sentenceCased} health`
}

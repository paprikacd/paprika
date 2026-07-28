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
          Server-ranked impact
        </p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          The fleet service orders this queue. Every page remains in authoritative server order.
        </p>
      </div>
      <div
        ref={scrollRef}
        className="h-[min(62vh,42rem)] min-h-80 overflow-auto border-b border-border bg-background"
      >
        <ol
          aria-label="Applications requiring attention"
          className="relative min-w-[42rem]"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const application = props.applications[virtualItem.index]
            const identity = application.identity
            const key = applicationKey(application, virtualItem.index)
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
                className="absolute left-0 top-0 grid w-full grid-cols-[3rem_minmax(16rem,1fr)_minmax(12rem,0.8fr)_minmax(10rem,1fr)] items-center gap-4 border-b border-border/70 px-4 py-4 transition-colors hover:bg-muted/50 focus-visible:bg-muted sm:px-6"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                <span
                  aria-hidden="true"
                  className="font-mono text-lg font-semibold tabular-nums text-primary"
                >
                  {String(virtualItem.index + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0">
                  <strong className="block truncate text-sm font-semibold text-foreground">
                    {identity?.name || "Unnamed application"}
                  </strong>
                  <span className="mt-1 block truncate font-mono text-[0.6875rem] text-muted-foreground">
                    {identity ? identityKey(identity) : "Identity unavailable"}
                  </span>
                </span>
                <span className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <span className="text-muted-foreground">Health</span>
                  <strong className="text-right font-mono font-medium text-foreground">
                    {application.health.replaceAll("_", " ")}
                  </strong>
                  <span className="text-muted-foreground">Drift</span>
                  <strong className="text-right font-mono font-medium tabular-nums text-foreground">
                    {application.driftCount}
                  </strong>
                  <span className="text-muted-foreground">Blocked</span>
                  <strong className="text-right font-mono font-medium tabular-nums text-foreground">
                    {application.blockedGateCount}
                  </strong>
                </span>
                <span onClick={(event) => event.stopPropagation()}>
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

"use client"

import { useVirtualizer } from "@tanstack/react-virtual"
import { useCallback, useRef } from "react"

import {
  applicationKey,
  identityKey,
  observeMeasuredElementRect,
  releaseFocusOwnership,
  useApplicationFocusAdapter,
  type ApplicationCollectionProps,
} from "@/components/fleet/application-collection"
import {
  attentionReasonOf,
  healthLabelOf,
  healthToneOf,
  projectLabelOf,
  targetLabelOf,
} from "@/components/fleet/fleet-rows"
import { StatusGlyph } from "@/components/ui/status-chip"
import { STATUS_TONES } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

const ROW_HEIGHT = 42
/** The first few entries carry the tone's tint; below that it is noise. */
const TINTED_ROWS = 3
const GRID = "28px 16px minmax(0,1.2fr) minmax(0,1fr) 140px minmax(0,1fr)"

/**
 * The queue is the flat, worst-first reading of the same rows. The order is
 * the server's — `sort=impact` — so paging never re-ranks under the operator,
 * and the rank number is the position in that authoritative order.
 */
export function AttentionQueue(props: ApplicationCollectionProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowTargets = useRef(new Map<string, HTMLElement>())
  const virtualizer = useVirtualizer({
    count: props.applications.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => applicationKey(props.applications[index], index),
    initialRect: { width: 1120, height: 560 },
    observeElementRect: observeMeasuredElementRect,
    measureElement: (element) => element.getBoundingClientRect().height || ROW_HEIGHT,
  })

  const getTarget = useCallback(
    (key: string) => rowTargets.current.get(key) ?? null,
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
      <div
        ref={scrollRef}
        role="table"
        aria-label="Attention queue"
        aria-rowcount={Number(props.total) + 1}
        aria-colcount={6}
        className="h-[min(62vh,42rem)] min-h-80 overflow-auto bg-background"
      >
        <div
          role="rowgroup"
          className="sticky top-0 z-10 min-w-[52rem] border-b border-rule-strong bg-muted"
        >
          <div
            role="row"
            aria-rowindex={1}
            className="grid h-7.5 items-center gap-3 px-5.5 font-mono text-kicker tracking-[0.14em] text-muted-foreground"
            style={{ gridTemplateColumns: GRID }}
          >
            <span role="columnheader" aria-colindex={1}>#</span>
            <span role="columnheader" aria-colindex={2}>
              <span className="sr-only">Health</span>
            </span>
            <span role="columnheader" aria-colindex={3}>APPLICATION</span>
            <span role="columnheader" aria-colindex={4}>TARGET</span>
            <span role="columnheader" aria-colindex={5}>PROJECT</span>
            <span role="columnheader" aria-colindex={6}>WHY</span>
          </div>
        </div>

        <div
          role="rowgroup"
          className="relative min-w-[52rem]"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const application = props.applications[virtualItem.index]
            if (!application) return null
            const identity = application.identity
            const key = applicationKey(application, virtualItem.index)
            const tone = healthToneOf(application.health)
            const spec = STATUS_TONES[tone]
            const rank = String(virtualItem.index + 1).padStart(2, "0")

            return (
              <div
                key={key}
                ref={(node) => {
                  if (node) {
                    rowTargets.current.set(key, node)
                    virtualizer.measureElement(node)
                  } else {
                    rowTargets.current.delete(key)
                  }
                }}
                data-index={virtualItem.index}
                data-row-key={key}
                role="row"
                aria-rowindex={virtualItem.index + 2}
                aria-label={
                  identity ? identityKey(identity) : `Queue row ${virtualItem.index + 1}`
                }
                tabIndex={identity ? 0 : -1}
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
                className={cn(
                  "absolute top-0 left-0 grid h-row w-full cursor-pointer items-center gap-3 border-b border-rule-soft px-5.5",
                  virtualItem.index < TINTED_ROWS ? spec.fill : "bg-card",
                  "hover:bg-inset focus-visible:bg-inset",
                )}
                style={{ gridTemplateColumns: GRID, transform: `translateY(${virtualItem.start}px)` }}
              >
                <span
                  aria-hidden
                  className={cn("absolute inset-y-0 left-0 w-1", spec.bar)}
                />
                <span
                  role="cell"
                  aria-colindex={1}
                  className="font-mono text-meta tabular-nums text-status-pending-text"
                >
                  {rank}
                </span>
                <span role="cell" aria-colindex={2}>
                  <StatusGlyph tone={tone} label={healthLabelOf(application.health)} />
                </span>
                <span role="cell" aria-colindex={3} className="min-w-0">
                  <span className="block truncate font-cond text-name font-semibold tracking-[0.02em]">
                    {identity?.name || "Unnamed application"}
                  </span>
                  <span className="block truncate font-mono text-meta text-neutral-600">
                    {identity ? identityKey(identity) : "Identity unavailable"}
                  </span>
                </span>
                <span
                  role="cell"
                  aria-colindex={4}
                  className="truncate font-mono text-note text-neutral-800"
                >
                  {targetLabelOf(application) || "No target"}
                </span>
                <span
                  role="cell"
                  aria-colindex={5}
                  className="truncate font-mono text-note text-muted-foreground"
                >
                  {projectLabelOf(application) || "—"}
                </span>
                <span
                  role="cell"
                  aria-colindex={6}
                  className="truncate text-reason text-muted-foreground"
                >
                  {attentionReasonOf(application)}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

"use client"

import { useVirtualizer } from "@tanstack/react-virtual"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useCallback, useEffect, useRef } from "react"

import type {
  FleetApplicationSummary,
  FleetCapability,
} from "@/lib/fleet-client"
import type {
  FleetApplicationIdentity,
  FleetFocusCoordinator,
  FleetFocusTarget,
} from "@/lib/fleet-focus"
import type { NamespacedKey } from "@/lib/fleet-query"
import { applicationURL } from "@/lib/release-query"
import { cn } from "@/lib/utils"

export interface ApplicationCollectionProps {
  applications: readonly FleetApplicationSummary[]
  total: bigint
  hasMore: boolean
  isLoadingMore: boolean
  onLoadMore: () => void | Promise<void>
  onSelectApplication: (identity: NamespacedKey) => void
  onFocusedApplication: (identity: NamespacedKey | null) => void
  focusCoordinator: FleetFocusCoordinator
  getResultsHeadingTarget: () => FleetFocusTarget | null
}

export function ApplicationTable(props: ApplicationCollectionProps) {
  const searchParams = useSearchParams()
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowTargets = useRef(new Map<string, HTMLElement>())
  const virtualizer = useVirtualizer({
    count: props.applications.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 76,
    overscan: 8,
    getItemKey: (index) => applicationKey(props.applications[index], index),
    initialRect: { width: 1120, height: 560 },
    observeElementRect: observeMeasuredElementRect,
    measureElement: (element) => element.getBoundingClientRect().height || 76,
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
    presentation: "table",
    applications: props.applications,
    coordinator: props.focusCoordinator,
    getResultsHeadingTarget: props.getResultsHeadingTarget,
    getTarget,
    scrollToIndex,
  })

  return (
    <section aria-label="Application inventory" className="min-w-0">
      <div
        ref={scrollRef}
        data-testid="application-table-scroll"
        role="table"
        aria-label="Applications"
        aria-rowcount={Number(props.total) + 1}
        aria-colcount={6}
        className="h-[min(62vh,42rem)] min-h-80 overflow-auto border-b border-border bg-background"
      >
        <div className="sticky top-0 z-10 h-px overflow-hidden border-0 bg-card xl:h-auto xl:overflow-visible xl:border-b xl:border-border">
          <div
            role="row"
            aria-rowindex={1}
            className="sr-only min-h-11 grid-cols-[minmax(15rem,1.5fr)_minmax(9rem,1fr)_8rem_8rem_7rem_minmax(10rem,1fr)] items-center gap-3 px-4 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground sm:px-6 xl:not-sr-only xl:grid"
          >
            <span role="columnheader" aria-colindex={1}>Application</span>
            <span role="columnheader" aria-colindex={2}>Target</span>
            <span role="columnheader" aria-colindex={3}>Health</span>
            <span role="columnheader" aria-colindex={4}>Sync</span>
            <span role="columnheader" aria-colindex={5}>Resources</span>
            <span role="columnheader" aria-colindex={6}>Authorized actions</span>
          </div>
        </div>

        <div
          role="rowgroup"
          className="relative"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const application = props.applications[virtualRow.index]
            const identity = application.identity
            const key = applicationKey(application, virtualRow.index)
            const factIdPrefix = identity
              ? `application-fact-${virtualRow.index}-${identity.namespace}-${identity.name}`
              : `application-fact-${virtualRow.index}-identity-unavailable`
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
                data-index={virtualRow.index}
                data-row-key={key}
                data-testid={identity
                  ? `application-row-${identity.namespace}-${identity.name}`
                  : `application-row-identity-unavailable-${virtualRow.index}`}
                data-virtual-start={virtualRow.start}
                role="row"
                aria-rowindex={virtualRow.index + 2}
                aria-label={identity ? `${identity.namespace}/${identity.name}` : `Application row ${virtualRow.index + 1}`}
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
                className="absolute left-0 top-0 grid w-full grid-cols-6 items-center gap-x-3 gap-y-3 border-b border-border/70 px-4 py-3 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:bg-muted sm:px-6 xl:grid-cols-[minmax(15rem,1.5fr)_minmax(9rem,1fr)_8rem_8rem_7rem_minmax(10rem,1fr)]"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <span role="cell" aria-colindex={1} className="col-span-6 min-w-0 xl:col-span-1">
                  <strong className="block truncate font-semibold text-foreground">
                    {identity?.name || "Unnamed application"}
                  </strong>
                  <span className="block truncate font-mono text-[0.6875rem] text-muted-foreground">
                    {identity ? `${identity.namespace}/${identity.name}` : "Identity unavailable"}
                  </span>
                </span>
                <span role="cell" aria-colindex={2} className="col-span-6 min-w-0 xl:col-span-1">
                  <span
                    role="group"
                    aria-labelledby={`${factIdPrefix}-target-label ${factIdPrefix}-target-value`}
                    className="block min-w-0"
                  >
                    <span
                      id={`${factIdPrefix}-target-label`}
                      className="block font-mono text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground xl:sr-only"
                    >
                      Target
                    </span>
                    <span
                      id={`${factIdPrefix}-target-value`}
                      className="block truncate text-foreground"
                    >
                      {application.currentClusterLabel || "No target"}
                    </span>
                  </span>
                  <span
                    role="group"
                    aria-labelledby={`${factIdPrefix}-stage-label ${factIdPrefix}-stage-value`}
                    className="mt-1 block min-w-0"
                  >
                    <span
                      id={`${factIdPrefix}-stage-label`}
                      className="block font-mono text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground xl:sr-only"
                    >
                      Stage
                    </span>
                    <span
                      id={`${factIdPrefix}-stage-value`}
                      className="block truncate text-xs text-muted-foreground"
                    >
                      {application.currentStage || "Stage unknown"}
                    </span>
                  </span>
                </span>
                <span
                  role="cell"
                  aria-colindex={3}
                  aria-labelledby={`${factIdPrefix}-health-label ${factIdPrefix}-health-value`}
                  className="col-span-2 flex min-w-0 flex-col gap-1 xl:col-span-1 xl:block"
                >
                  <span
                    id={`${factIdPrefix}-health-label`}
                    className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground xl:sr-only"
                  >
                    Health status
                  </span>
                  <StatusLabel id={`${factIdPrefix}-health-value`} value={application.health} />
                </span>
                <span
                  role="cell"
                  aria-colindex={4}
                  aria-labelledby={`${factIdPrefix}-sync-label ${factIdPrefix}-sync-value`}
                  className="col-span-2 flex min-w-0 flex-col gap-1 xl:col-span-1 xl:block"
                >
                  <span
                    id={`${factIdPrefix}-sync-label`}
                    className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground xl:sr-only"
                  >
                    Sync status
                  </span>
                  <StatusLabel id={`${factIdPrefix}-sync-value`} value={application.sync} />
                </span>
                <span
                  role="cell"
                  aria-colindex={5}
                  aria-labelledby={`${factIdPrefix}-resources-label ${factIdPrefix}-resources-value`}
                  className="col-span-2 flex min-w-0 flex-col gap-1 font-mono text-xs tabular-nums text-foreground xl:col-span-1 xl:block"
                >
                  <span
                    id={`${factIdPrefix}-resources-label`}
                    className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground xl:sr-only"
                  >
                    Resource count
                  </span>
                  <span id={`${factIdPrefix}-resources-value`}>
                    {application.resourceCount.toLocaleString()}
                  </span>
                </span>
                <span
                  role="cell"
                  aria-colindex={6}
                  className="col-span-6 min-w-0 xl:col-span-1"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <span className="mb-1 block font-mono text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground xl:sr-only">
                    Authorized actions
                  </span>
                  {identity ? (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Link
                        href={applicationURL(searchParams, identity)}
                        aria-label={`Open application ${identityKey(identity)}`}
                        className="inline-flex min-h-11 items-center rounded-md border border-border bg-background px-2.5 text-[0.6875rem] font-semibold text-foreground transition-colors hover:border-primary/50 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        Open
                      </Link>
                      <ApplicationCapabilityActions
                        identity={identity}
                        capabilities={application.capabilities}
                      />
                    </span>
                  ) : null}
                </span>
              </div>
            )
          })}
        </div>
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

export function ApplicationCapabilityActions({
  identity,
  capabilities,
}: {
  identity: NamespacedKey
  capabilities: readonly FleetCapability[]
}) {
  const key = identityKey(identity)
  const actions: readonly { capability: FleetCapability; label: string; short: string }[] = [
    { capability: "application_sync", label: `Sync ${key}`, short: "Sync" },
    { capability: "release_rollback", label: `Rollback ${key}`, short: "Rollback" },
    { capability: "gate_approve", label: `Approve gate for ${key}`, short: "Approve" },
    { capability: "pipeline_retry", label: `Retry pipeline for ${key}`, short: "Retry" },
  ]
  const visible = actions.filter((action) => capabilities.includes(action.capability))
  if (visible.length === 0) return null

  return (
    <span className="flex flex-wrap gap-1.5">
      {visible.map((action) => (
        <button
          key={action.capability}
          type="button"
          aria-label={action.label}
          disabled
          title="Open the application detail to perform this authorized action"
          className="min-h-11 rounded-md border border-border bg-secondary px-2.5 text-[0.6875rem] font-semibold text-secondary-foreground disabled:cursor-not-allowed disabled:opacity-70"
        >
          {action.short}
        </button>
      ))}
    </span>
  )
}

export function FleetLoadMore({
  loaded,
  total,
  hasMore,
  isLoadingMore,
  onLoadMore,
}: {
  loaded: number
  total: bigint
  hasMore: boolean
  isLoadingMore: boolean
  onLoadMore: () => void | Promise<void>
}) {
  return (
    <div
      data-testid="fleet-load-more-sentinel"
      className="flex flex-col gap-3 border-b border-border bg-card px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"
    >
      <p className="font-mono text-[0.6875rem] tabular-nums text-muted-foreground">
        {loaded.toLocaleString()} loaded / {total.toString()} indexed
      </p>
      {hasMore ? (
        <button
          type="button"
          disabled={isLoadingMore}
          onClick={() => void onLoadMore()}
          className="min-h-11 rounded-md bg-primary px-4 text-sm font-semibold text-background transition-colors hover:bg-primary/90 disabled:cursor-wait disabled:opacity-70"
          aria-label="Load 100 more applications"
        >
          {isLoadingMore ? "Loading next 100…" : "Load next 100"}
        </button>
      ) : (
        <span className="text-xs text-muted-foreground">End of authorized results</span>
      )}
    </div>
  )
}

export function useApplicationFocusAdapter({
  presentation,
  applications,
  coordinator,
  getResultsHeadingTarget,
  getTarget,
  scrollToIndex,
}: {
  presentation: "table" | "queue"
  applications: readonly FleetApplicationSummary[]
  coordinator: FleetFocusCoordinator
  getResultsHeadingTarget: () => FleetFocusTarget | null
  getTarget: (key: string) => FleetFocusTarget | null
  scrollToIndex: (index: number) => void
}) {
  useEffect(
    () =>
      coordinator.registerAdapter(presentation, {
        resolveApplicationTarget: async (identity, signal) => {
          const key = identityKey(identity)
          const current = getTarget(key)
          if (current) return current

          const index = applications.findIndex(
            (application) => application.identity && identityKey(application.identity) === key,
          )
          if (index < 0 || signal.aborted) return null
          scrollToIndex(index)

          for (let attempt = 0; attempt < 6; attempt += 1) {
            await nextFrame(signal)
            if (signal.aborted) return null
            const target = getTarget(key)
            if (target) return target
          }
          return null
        },
        resolveResultsHeadingTarget: () => getResultsHeadingTarget(),
      }),
    [applications, coordinator, getResultsHeadingTarget, getTarget, presentation, scrollToIndex],
  )
}

export function applicationKey(application: FleetApplicationSummary, index: number): string {
  return application.identity ? identityKey(application.identity) : `identity-unavailable:${index}`
}

export function identityKey(identity: FleetApplicationIdentity): string {
  return `${identity.namespace}/${identity.name}`
}

export function releaseFocusOwnership(
  currentTarget: HTMLElement,
  nextTarget: EventTarget | null,
  onFocusedApplication: (identity: NamespacedKey | null) => void,
): void {
  if (nextTarget instanceof Node && currentTarget.contains(nextTarget)) return
  if (
    nextTarget instanceof HTMLElement &&
    nextTarget.dataset.preserveFleetFocus === "true"
  ) {
    return
  }
  onFocusedApplication(null)
}

export function observeMeasuredElementRect(
  instance: { scrollElement: Element | null },
  callback: (rect: { width: number; height: number }) => void,
): (() => void) | undefined {
  const element = instance.scrollElement
  if (!element) return undefined

  const measure = () => {
    const rect = element.getBoundingClientRect()
    callback({
      width: rect.width || 1120,
      height: rect.height || 560,
    })
  }
  measure()

  if (typeof ResizeObserver === "undefined") return undefined
  const observer = new ResizeObserver(measure)
  observer.observe(element)
  return () => observer.disconnect()
}

function StatusLabel({ id, value }: { id?: string; value: string }) {
  const danger = value === "failed" || value === "degraded" || value === "out_of_sync"
  const healthy = value === "healthy" || value === "synced" || value === "complete"
  return (
    <span
      id={id}
      className={cn(
        "inline-flex min-h-6 items-center rounded-sm border px-2 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.08em]",
        danger && "border-destructive/40 bg-destructive/10 text-destructive",
        healthy && "border-success/40 bg-success/10 text-success",
        !danger && !healthy && "border-border bg-muted text-muted-foreground",
      )}
    >
      {value.replaceAll("_", " ")}
    </span>
  )
}

function nextFrame(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const complete = () => {
      signal.removeEventListener("abort", cancel)
      resolve()
    }
    const cancel = () => {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame)
      else clearTimeout(frame)
      complete()
    }
    const frame =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(complete)
        : window.setTimeout(complete, 16)
    signal.addEventListener("abort", cancel, { once: true })
  })
}

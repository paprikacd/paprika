"use client"

import { X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { ApplicationTable } from "@/components/fleet/application-table"
import { AttentionQueue } from "@/components/fleet/attention-queue"
import { FleetFilters } from "@/components/fleet/fleet-filters"
import { FleetHealthHeatmap } from "@/components/fleet/fleet-health-heatmap"
import { FleetMatrix } from "@/components/fleet/fleet-matrix"
import { FleetStateNotice } from "@/components/fleet/fleet-states"
import { FleetTreemap } from "@/components/fleet/fleet-treemap"
import type { FleetMapNode } from "@/lib/fleet-client"
import { useConnection } from "@/lib/connection-context"
import {
  createFleetFocusCoordinator,
  type FleetFocusCoordinator,
  type FleetFocusTarget,
} from "@/lib/fleet-focus"
import {
  type FleetQueryPatch,
  type FleetQueryState,
  type FleetView as FleetViewName,
  type NamespacedKey,
} from "@/lib/fleet-query"
import { useFleetRefresh } from "@/lib/fleet-refresh"
import { useFleetScope } from "@/lib/fleet-scope-context"
import {
  useFleetData,
  type FleetPresentationData,
} from "@/lib/use-fleet-data"

const presentations: readonly FleetViewName[] = ["heatmap", "treemap", "matrix"]

export function FleetView() {
  const { state, notices, patchQuery } = useFleetScope()
  const fleet = useFleetData(state)
  const { reportRequestOutcome } = useConnection()
  const [focusMessage, setFocusMessage] = useState("")
  const [queryNotice, setQueryNotice] = useState("")
  const headingRef = useRef<HTMLHeadingElement>(null)
  const summaryTargets = useRef(new Map<string, FleetFocusTarget>())
  const preserveFocusTransition = useRef(false)
  const [focusCoordinator] = useState(() =>
    createFleetFocusCoordinator({ announce: setFocusMessage }),
  )

  useFleetRefresh(fleet.refresh, {
    onRequestOutcome: reportRequestOutcome,
    refreshOnMount: false,
  })

  useEffect(() => {
    if (fleet.status === "loading" || fleet.status === "stale") return
    reportRequestOutcome(
      fleet.status === "ready" ||
        fleet.status === "empty" ||
        fleet.status === "partial",
    )
  }, [fleet.status, reportRequestOutcome])

  const patchState = patchQuery

  const hasSettledData =
    fleet.currentData !== undefined &&
    (fleet.status === "ready" || fleet.status === "empty" || fleet.status === "partial")
  const fleetReadyTotal = hasSettledData && fleet.currentData
    ? presentationTotal(fleet.currentData).toString()
    : undefined
  const derivedQueryNotice = useMemo(
    () =>
      notices.map((notice) => notice.message).join(" "),
    [notices],
  )

  useEffect(() => {
    if (!derivedQueryNotice) return
    // Keep the discarded-input notice visible across a later canonical
    // navigation until the operator explicitly dismisses it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQueryNotice((current) =>
      current === derivedQueryNotice ? current : derivedQueryNotice,
    )
  }, [derivedQueryNotice])

  const getResultsHeadingTarget = useCallback(
    (): FleetFocusTarget | null => headingRef.current,
    [],
  )

  useEffect(() => {
    const cleanups = presentations.map((presentation) =>
      focusCoordinator.registerAdapter(presentation, {
        resolveApplicationTarget: (identity) =>
          summaryTargets.current.get(`${presentation}:${identityKey(identity)}`) ?? null,
        resolveResultsHeadingTarget: getResultsHeadingTarget,
      }),
    )
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [focusCoordinator, getResultsHeadingTarget])

  useEffect(() => {
    void focusCoordinator.activatePresentation(state.view)
  }, [focusCoordinator, state.view])

  const focusedApplications = useMemo(() => {
    if (fleet.currentData?.kind === "applications") {
      return fleet.currentData.applications
        .map((application) => application.identity)
        .filter((identity): identity is NamespacedKey => Boolean(identity))
    }
    if (fleet.currentData?.kind === "map") {
      return mapApplicationIdentities(fleet.currentData.result.roots)
    }
    return undefined
  }, [fleet.currentData])

  useEffect(() => {
    if (focusedApplications) void focusCoordinator.updateResults(focusedApplications)
  }, [focusCoordinator, focusedApplications])

  const selectApplication = useCallback(
    (identity: NamespacedKey) => patchState({ selected: identity }),
    [patchState],
  )
  const trackApplicationFocus = useCallback(
    (identity: NamespacedKey | null) => {
      if (identity === null && preserveFocusTransition.current) return
      focusCoordinator.trackFocusedApplication(identity)
    },
    [focusCoordinator],
  )
  const registerSummaryTarget = useCallback(
    (
      view: "heatmap" | "treemap" | "matrix",
      identity: NamespacedKey,
      target: FleetFocusTarget | null,
    ) => {
      const key = `${view}:${identityKey(identity)}`
      if (target) summaryTargets.current.set(key, target)
      else summaryTargets.current.delete(key)
    },
    [],
  )

  return (
    <section
      aria-labelledby="applications-title"
      aria-busy={fleet.status === "loading" || fleet.status === "stale"}
      data-fleet-ready={fleetReadyTotal}
      onBlurCapture={(event) => {
        preserveFocusTransition.current =
          event.relatedTarget instanceof HTMLElement &&
          event.relatedTarget.dataset.preserveFleetFocus === "true"
      }}
      onFocusCapture={() => {
        preserveFocusTransition.current = false
      }}
      className="min-w-0 bg-background"
    >
      <header className="border-b border-border bg-background px-4 py-7 sm:px-6 lg:flex lg:items-end lg:justify-between lg:gap-8">
        <div>
          <p className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.18em] text-primary">
            Fleet inventory
          </p>
          <h1
            ref={headingRef}
            id="applications-title"
            tabIndex={-1}
            className="mt-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl"
          >
            Applications
          </h1>
        </div>
        <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground lg:mt-0 lg:text-right">
          Filter, compare, and troubleshoot every authorized deployment from one indexed snapshot.
        </p>
      </header>

      <FleetFilters
        state={state}
        facets={fleet.applicationFacets}
        onPatch={patchState}
      />

      {queryNotice ? (
        <div
          role="status"
          aria-label="Fleet query notice"
          aria-live="polite"
          className="flex items-center justify-between gap-3 border-b border-warning/30 bg-warning/10 pl-4 text-sm text-warning sm:pl-6"
        >
          <span className="py-3">{queryNotice}</span>
          <button
            type="button"
            aria-label="Dismiss fleet query notice"
            onClick={() => setQueryNotice("")}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center self-stretch text-warning transition-colors hover:bg-warning/10 hover:text-foreground"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      ) : null}

      <FleetStateNotice status={fleet.status} />

      {fleet.displayData ? (
        <FleetPresentation
          data={fleet.displayData}
          hasMore={fleet.hasMore}
          isLoadingMore={fleet.isLoadingMore}
          onLoadMore={fleet.loadMore}
          onSelectApplication={selectApplication}
          onFocusedApplication={trackApplicationFocus}
          state={state}
          onPatch={patchState}
          focusCoordinator={focusCoordinator}
          getResultsHeadingTarget={getResultsHeadingTarget}
          registerSummaryTarget={registerSummaryTarget}
        />
      ) : null}

      {focusMessage ? (
        <p
          role="status"
          aria-label="Fleet focus updates"
          aria-live="assertive"
          aria-atomic="true"
          className="sr-only"
        >
          {focusMessage}
        </p>
      ) : null}
    </section>
  )
}

function FleetPresentation({
  data,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onSelectApplication,
  onFocusedApplication,
  state,
  onPatch,
  focusCoordinator,
  getResultsHeadingTarget,
  registerSummaryTarget,
}: {
  data: FleetPresentationData
  hasMore: boolean
  isLoadingMore: boolean
  onLoadMore: () => Promise<void>
  onSelectApplication: (identity: NamespacedKey) => void
  onFocusedApplication: (identity: NamespacedKey | null) => void
  state: FleetQueryState
  onPatch: (patch: FleetQueryPatch) => void
  focusCoordinator: FleetFocusCoordinator
  getResultsHeadingTarget: () => FleetFocusTarget | null
  registerSummaryTarget: (
    view: "heatmap" | "treemap" | "matrix",
    identity: NamespacedKey,
    target: FleetFocusTarget | null,
  ) => void
}) {
  const registerTreemapTarget = useCallback(
    (identity: NamespacedKey, target: FleetFocusTarget | null) =>
      registerSummaryTarget("treemap", identity, target),
    [registerSummaryTarget],
  )
  const registerHeatmapTarget = useCallback(
    (identity: NamespacedKey, target: FleetFocusTarget | null) =>
      registerSummaryTarget("heatmap", identity, target),
    [registerSummaryTarget],
  )

  switch (data.kind) {
    case "applications": {
      const props = {
        applications: data.applications,
        total: data.total,
        hasMore,
        isLoadingMore,
        onLoadMore,
        onSelectApplication,
        onFocusedApplication,
        focusCoordinator,
        getResultsHeadingTarget,
      }
      return data.view === "queue" ? (
        <AttentionQueue {...props} />
      ) : (
        <ApplicationTable {...props} />
      )
    }
    case "map":
      return state.view === "heatmap" ? (
        <FleetHealthHeatmap
          result={data.result}
          density={state.density}
          labels={state.labels}
          sort={state.sort}
          direction={state.direction}
          selected={state.selected}
          onSelectApplication={onSelectApplication}
          onFocusedApplication={onFocusedApplication}
          registerTarget={registerHeatmapTarget}
        />
      ) : (
        <FleetTreemap
          result={data.result}
          zoom={state.zoom}
          selected={state.selected}
          onZoomChange={(zoom) => onPatch({ zoom })}
          onSelectApplication={onSelectApplication}
          onFocusedApplication={onFocusedApplication}
          registerTarget={registerTreemapTarget}
        />
      )
    case "matrix":
      return <FleetMatrix result={data.result} />
  }
}

function presentationTotal(data: FleetPresentationData): bigint {
  return data.kind === "applications" ? data.total : data.result.total
}

function identityKey(identity: NamespacedKey): string {
  return `${identity.namespace}/${identity.name}`
}

function mapApplicationIdentities(roots: readonly FleetMapNode[]): NamespacedKey[] {
  const identities: NamespacedKey[] = []
  const pending = [...roots]
  while (pending.length > 0) {
    const node = pending.pop()
    if (!node) continue
    if (node.application) identities.push(node.application)
    pending.push(...node.children)
  }
  return identities
}

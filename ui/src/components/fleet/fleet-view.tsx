"use client"

import { X } from "lucide-react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { ApplicationTable } from "@/components/fleet/application-table"
import { AttentionQueue } from "@/components/fleet/attention-queue"
import { FleetFilters } from "@/components/fleet/fleet-filters"
import { FleetMatrix } from "@/components/fleet/fleet-matrix"
import { FleetStateNotice } from "@/components/fleet/fleet-states"
import { FleetTreemap } from "@/components/fleet/fleet-treemap"
import type { FleetFacetBucket } from "@/lib/fleet-client"
import { useConnection } from "@/lib/connection-context"
import {
  createFleetFocusCoordinator,
  type FleetFocusCoordinator,
  type FleetFocusTarget,
} from "@/lib/fleet-focus"
import {
  mergeFleetQuery,
  parseFleetQuery,
  reconcileFleetQuery,
  serializeFleetQuery,
  type FleetFacetAvailability,
  type FleetQueryPatch,
  type FleetQueryState,
  type FleetView as FleetViewName,
  type NamespacedKey,
} from "@/lib/fleet-query"
import { useFleetRefresh } from "@/lib/fleet-refresh"
import {
  useFleetData,
  type FleetPresentationData,
} from "@/lib/use-fleet-data"

const presentations: readonly FleetViewName[] = ["treemap", "matrix"]

export function FleetView() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const rawQuery = searchParams.toString()
  const parsed = useMemo(() => parseFleetQuery(rawQuery), [rawQuery])
  const fleet = useFleetData(parsed.state)
  const { reportRequestOutcome } = useConnection()
  const [focusMessage, setFocusMessage] = useState("")
  const [queryNotice, setQueryNotice] = useState("")
  const headingRef = useRef<HTMLHeadingElement>(null)
  const lastCanonicalReplace = useRef("")
  const summaryTargets = useRef(new Map<string, HTMLElement>())
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

  const replaceState = useCallback(
    (state: FleetQueryState) => {
      const query = serializeFleetQuery(state).toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [pathname, router],
  )

  const patchState = useCallback(
    (patch: FleetQueryPatch) => {
      replaceState(mergeFleetQuery(parsed.state, patch))
    },
    [parsed.state, replaceState],
  )

  const hasSettledData =
    fleet.currentData !== undefined &&
    (fleet.status === "ready" || fleet.status === "empty" || fleet.status === "partial")
  const fleetReadyTotal = hasSettledData && fleet.currentData
    ? presentationTotal(fleet.currentData).toString()
    : undefined
  const settledFacets = useMemo(
    () => hasSettledData ? presentationFacets(fleet.currentData) : undefined,
    [fleet.currentData, hasSettledData],
  )
  const availability = useMemo(
    () =>
      settledFacets
        ? facetAvailability(settledFacets)
        : {},
    [settledFacets],
  )
  const reconciliation = useMemo(
    () => reconcileFleetQuery(parsed.state, availability),
    [availability, parsed.state],
  )
  const derivedQueryNotice = useMemo(
    () =>
      [...parsed.notices, ...reconciliation.notices]
        .map((notice) => notice.message)
        .join(" "),
    [parsed.notices, reconciliation.notices],
  )

  useEffect(() => {
    if (!derivedQueryNotice) return
    // The notice explains an automatic URL correction and must survive the
    // resulting navigation until the operator explicitly dismisses it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQueryNotice((current) =>
      current === derivedQueryNotice ? current : derivedQueryNotice,
    )
  }, [derivedQueryNotice])

  useEffect(() => {
    const canonical = serializeFleetQuery(reconciliation.state).toString()
    if (canonical === rawQuery) {
      lastCanonicalReplace.current = ""
      return
    }
    const replacementKey = `${rawQuery}\n${canonical}`
    if (lastCanonicalReplace.current === replacementKey) return
    lastCanonicalReplace.current = replacementKey
    replaceState(reconciliation.state)
  }, [rawQuery, reconciliation, replaceState])

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
    void focusCoordinator.activatePresentation(parsed.state.view)
  }, [focusCoordinator, parsed.state.view])

  const focusedApplications = useMemo(() => {
    if (fleet.currentData?.kind !== "applications") return undefined
    return fleet.currentData.applications
      .map((application) => application.identity)
      .filter((identity): identity is NamespacedKey => Boolean(identity))
  }, [fleet.currentData])

  useEffect(() => {
    if (focusedApplications) void focusCoordinator.updateResults(focusedApplications)
  }, [focusCoordinator, focusedApplications])

  const selectApplication = useCallback(
    (identity: NamespacedKey) => patchState({ selected: identity }),
    [patchState],
  )
  const trackApplicationFocus = useCallback(
    (identity: NamespacedKey | null) => focusCoordinator.trackFocusedApplication(identity),
    [focusCoordinator],
  )
  const registerSummaryTarget = useCallback(
    (
      view: "treemap" | "matrix",
      identity: NamespacedKey,
      target: HTMLElement | null,
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
        state={parsed.state}
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
          state={parsed.state}
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
    view: "treemap" | "matrix",
    identity: NamespacedKey,
    target: HTMLElement | null,
  ) => void
}) {
  const registerTreemapTarget = useCallback(
    (identity: NamespacedKey, target: HTMLElement | null) =>
      registerSummaryTarget("treemap", identity, target),
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
      return (
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

function facetAvailability(facets: readonly FleetFacetBucket[]): FleetFacetAvailability {
  const objects = (dimension: "project" | "cluster") =>
    uniqueObjects(
      facets
        .filter((facet) => facet.dimension === dimension)
        .map((facet) => facet.object)
        .filter((value): value is NamespacedKey => Boolean(value)),
    )
  const values = (dimension: FleetFacetBucket["dimension"]) =>
    [...new Set(
      facets
        .filter((facet) => facet.dimension === dimension)
        .map((facet) => facet.value)
        .filter((value): value is string => Boolean(value)),
    )]

  return {
    projects: objects("project"),
    clusters: objects("cluster"),
    stages: values("stage"),
    namespaces: values("namespace"),
    health: values("health") as FleetFacetAvailability["health"],
    sync: values("sync") as FleetFacetAvailability["sync"],
    release: values("release") as FleetFacetAvailability["release"],
    rollout: values("rollout") as FleetFacetAvailability["rollout"],
    sources: values("source_type") as FleetFacetAvailability["sources"],
  }
}

function presentationFacets(
  data: FleetPresentationData | undefined,
): readonly FleetFacetBucket[] {
  if (!data) return []
  return data.kind === "applications" ? data.facets : data.result.facets
}

function presentationTotal(data: FleetPresentationData): bigint {
  return data.kind === "applications" ? data.total : data.result.total
}

function uniqueObjects(values: readonly NamespacedKey[]): NamespacedKey[] {
  const unique = new Map<string, NamespacedKey>()
  values.forEach((value) => unique.set(identityKey(value), { ...value }))
  return [...unique.values()]
}

function identityKey(identity: NamespacedKey): string {
  return `${identity.namespace}/${identity.name}`
}

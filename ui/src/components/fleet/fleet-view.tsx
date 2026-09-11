"use client"

import { X } from "lucide-react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { ApplicationTable } from "@/components/fleet/application-table"
import { AttentionQueue } from "@/components/fleet/attention-queue"
import { useDataSources, type DataSourceMap } from "@/components/fleet/data-sources"
import { FacetToolbar } from "@/components/fleet/facet-toolbar"
import { FleetMatrix } from "@/components/fleet/fleet-matrix"
import { FleetStateNotice } from "@/components/fleet/fleet-states"
import { FleetTreemap } from "@/components/fleet/fleet-treemap"
import type { GroupDimension } from "@/components/fleet/fleet-rows"
import { usePublishConsoleScope } from "@/components/layout/console-header"
import { Seg } from "@/components/ui/seg"
import { useConnection } from "@/lib/connection-context"
import type { FleetFacetBucket } from "@/lib/fleet-client"
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
  type FleetGroup,
  type FleetQueryPatch,
  type FleetQueryState,
  type FleetView as FleetViewName,
  type NamespacedKey,
} from "@/lib/fleet-query"
import { FLEET_REFRESH_INTERVAL_MS, useFleetRefresh } from "@/lib/fleet-refresh"
import { useFleetData, type FleetPresentationData } from "@/lib/use-fleet-data"

const canvasPresentations: readonly FleetViewName[] = ["treemap", "matrix"]

/**
 * The accessible names are spelled out because a lone "Treemap" does not say
 * what the control does. `e2e/fleet-scale.spec.ts` also drives the fleet by
 * these names, so they are part of the contract.
 */
const VIEW_OPTIONS: readonly {
  value: FleetViewName
  label: string
  ariaLabel: string
}[] = [
  { value: "treemap", label: "Treemap", ariaLabel: "Show Treemap view" },
  { value: "matrix", label: "Matrix", ariaLabel: "Show Matrix view" },
  { value: "table", label: "Table", ariaLabel: "Show Table view" },
  { value: "queue", label: "Queue", ariaLabel: "Show Queue view" },
]

const GROUP_OPTIONS: readonly { value: GroupDimension; label: string }[] = [
  { value: "none", label: "None" },
  { value: "project", label: "Project" },
  { value: "cluster", label: "Cluster" },
  { value: "stage", label: "Stage" },
]

/** The matrix draws stage rows once the grouping is already a cluster axis. */
function rowsForGroup(group: FleetGroup): FleetGroup {
  return group === "cluster" || group === "stage" ? "stage" : group
}

export function FleetView() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const rawQuery = searchParams.toString()
  const parsed = useMemo(() => parseFleetQuery(rawQuery), [rawQuery])
  const fleet = useFleetData(parsed.state)
  const { sources } = useDataSources()
  const { reportRequestOutcome } = useConnection()
  const [focusMessage, setFocusMessage] = useState("")
  const [queryNotice, setQueryNotice] = useState("")
  // `group` is a URL enum with no "none" member, so switching grouping off is
  // a view preference held here rather than a query parameter.
  const [groupingOff, setGroupingOff] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const lastCanonicalReplace = useRef("")
  const treemapTargets = useRef(new Map<string, HTMLElement>())
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
  const fleetReadyTotal =
    hasSettledData && fleet.currentData
      ? presentationTotal(fleet.currentData).toString()
      : undefined
  const settledFacets = useMemo(
    () => (hasSettledData ? presentationFacets(fleet.currentData) : undefined),
    [fleet.currentData, hasSettledData],
  )
  const availability = useMemo(
    () => (settledFacets ? facetAvailability(settledFacets) : {}),
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
    const cleanups = canvasPresentations.map((presentation) =>
      focusCoordinator.registerAdapter(presentation, {
        resolveApplicationTarget: (identity) =>
          presentation === "treemap"
            ? treemapTargets.current.get(identityKey(identity)) ?? null
            : null,
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
  const registerTreemapTarget = useCallback(
    (identity: NamespacedKey, target: HTMLElement | null) => {
      const key = identityKey(identity)
      if (target) treemapTargets.current.set(key, target)
      else treemapTargets.current.delete(key)
    },
    [],
  )

  // Freshness is recorded when a settled result arrives, so the console header
  // reports the age of real data rather than the age of the component.
  const settledData = hasSettledData ? fleet.currentData : undefined
  const [refreshedAt, setRefreshedAt] = useState<number>()
  useEffect(() => {
    if (!settledData) return
    // Synchronising with the wall clock, which React cannot derive. The fleet
    // hook does not surface react-query's `dataUpdatedAt`; once it does, this
    // becomes a plain read.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRefreshedAt(Date.now())
  }, [settledData])

  const displayFacets = useMemo(
    () => presentationFacets(fleet.displayData),
    [fleet.displayData],
  )
  usePublishConsoleScope({
    facets: displayFacets as FleetFacetBucket[],
    indexGeneration: fleet.displayData
      ? presentationGeneration(fleet.displayData)
      : undefined,
    refreshedAt,
    isRefreshing: fleet.status === "loading" || fleet.status === "stale",
    intervalMs: FLEET_REFRESH_INTERVAL_MS,
  })

  const group: GroupDimension = groupingOff ? "none" : parsed.state.group
  const loaded =
    fleet.displayData?.kind === "applications"
      ? fleet.displayData.applications.length
      : undefined
  const total = fleet.displayData ? presentationTotal(fleet.displayData) : undefined

  return (
    <section
      aria-labelledby="applications-title"
      aria-busy={fleet.status === "loading" || fleet.status === "stale"}
      data-fleet-ready={fleetReadyTotal}
      className="min-w-0 bg-background"
    >
      <header className="flex flex-wrap items-end justify-between gap-x-5 gap-y-3 px-5.5 pt-4.5 pb-3.5">
        <div>
          <p className="font-mono text-kicker tracking-[0.2em] text-steel-600">
            FLEET INVENTORY
          </p>
          <h1
            ref={headingRef}
            id="applications-title"
            tabIndex={-1}
            className="mt-1 font-cond text-title font-semibold tracking-[0.01em] outline-none"
          >
            Applications
          </h1>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3.5">
          <span className="flex items-center gap-2">
            <span className="font-mono text-kicker tracking-[0.14em] whitespace-nowrap text-neutral-600">
              GROUP BY
            </span>
            <Seg
              label="Group by"
              className="h-7.5 pointer-coarse:h-11"
              options={GROUP_OPTIONS}
              value={group}
              onValueChange={(next) => {
                if (next === "none") {
                  setGroupingOff(true)
                  return
                }
                setGroupingOff(false)
                patchState({ group: next, rows: rowsForGroup(next) })
              }}
            />
          </span>
          <span
            data-preserve-fleet-focus="true"
            className="flex items-center gap-2"
          >
            <span className="font-mono text-kicker tracking-[0.14em] text-neutral-600">
              VIEW
            </span>
            <Seg
              label="View"
              className="h-7.5 pointer-coarse:h-11"
              options={VIEW_OPTIONS}
              value={parsed.state.view}
              onValueChange={(view) => patchState({ view })}
            />
          </span>
        </div>
      </header>

      <FacetToolbar
        state={parsed.state}
        facets={displayFacets}
        onPatch={patchState}
        summary={
          total === undefined
            ? undefined
            : loaded === undefined
              ? `${total.toString()} indexed`
              : `${loaded.toLocaleString()} loaded / ${total.toString()} indexed`
        }
      />

      {queryNotice ? (
        <div
          role="status"
          aria-label="Fleet query notice"
          aria-live="polite"
          className="flex items-center justify-between gap-3 border-b border-status-degraded-line bg-status-degraded-fill pl-5.5 text-note text-status-degraded-text"
        >
          <span className="py-2">{queryNotice}</span>
          <button
            type="button"
            aria-label="Dismiss fleet query notice"
            onClick={() => setQueryNotice("")}
            className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center self-stretch hover:bg-foreground/[0.06]"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      ) : null}

      <FleetStateNotice status={fleet.status} />

      {fleet.displayData ? (
        <FleetPresentation
          data={fleet.displayData}
          group={group}
          sources={sources}
          onSelectApplication={selectApplication}
          onFocusedApplication={trackApplicationFocus}
          state={parsed.state}
          onPatch={patchState}
          focusCoordinator={focusCoordinator}
          getResultsHeadingTarget={getResultsHeadingTarget}
          registerTreemapTarget={registerTreemapTarget}
        />
      ) : null}

      <FleetFooter
        loaded={loaded}
        total={total}
        hasMore={fleet.hasMore}
        isLoadingMore={fleet.isLoadingMore}
        onLoadMore={fleet.loadMore}
      />

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

/**
 * One bar under every presentation. It states what is loaded against what the
 * index holds, and reminds the reader that a facet count excludes its own
 * dimension — the number on a chip is what selecting it would give you.
 */
function FleetFooter({
  loaded,
  total,
  hasMore,
  isLoadingMore,
  onLoadMore,
}: {
  loaded: number | undefined
  total: bigint | undefined
  hasMore: boolean
  isLoadingMore: boolean
  onLoadMore: () => void | Promise<void>
}) {
  return (
    <div
      data-testid="fleet-load-more-sentinel"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-rule bg-muted px-5.5 py-2.5"
    >
      <p className="font-mono text-meta tabular-nums text-muted-foreground">
        {total === undefined
          ? "Waiting for the fleet index"
          : loaded === undefined
            ? `${total.toString()} indexed · facets are self-excluding`
            : `${loaded.toLocaleString()} loaded / ${total.toString()} indexed · facets are self-excluding`}
      </p>
      {loaded !== undefined && hasMore ? (
        <button
          type="button"
          disabled={isLoadingMore}
          onClick={() => void onLoadMore()}
          aria-label="Load 100 more applications"
          className="inline-flex h-7 cursor-pointer items-center border border-rule bg-card px-3 font-cond text-label font-semibold hover:bg-foreground/[0.07] disabled:cursor-wait disabled:opacity-70 pointer-coarse:h-11"
        >
          {isLoadingMore ? "Loading next 100…" : "Load next 100"}
        </button>
      ) : null}
    </div>
  )
}

function FleetPresentation({
  data,
  group,
  sources,
  onSelectApplication,
  onFocusedApplication,
  state,
  onPatch,
  focusCoordinator,
  getResultsHeadingTarget,
  registerTreemapTarget,
}: {
  data: FleetPresentationData
  group: GroupDimension
  sources: DataSourceMap | undefined
  onSelectApplication: (identity: NamespacedKey) => void
  onFocusedApplication: (identity: NamespacedKey | null) => void
  state: FleetQueryState
  onPatch: (patch: FleetQueryPatch) => void
  focusCoordinator: FleetFocusCoordinator
  getResultsHeadingTarget: () => FleetFocusTarget | null
  registerTreemapTarget: (identity: NamespacedKey, target: HTMLElement | null) => void
}) {
  switch (data.kind) {
    case "applications": {
      const props = {
        applications: data.applications,
        total: data.total,
        onSelectApplication,
        onFocusedApplication,
        focusCoordinator,
        getResultsHeadingTarget,
        sources,
      }
      return data.view === "queue" ? (
        <AttentionQueue {...props} />
      ) : (
        <ApplicationTable {...props} group={group} />
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
      return (
        <div className="px-5.5 py-4">
          <FleetMatrix
            result={data.result}
            meta={`${data.result.total.toString()} applications · generation ${data.result.indexGeneration.toString()}`}
          />
        </div>
      )
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
    [
      ...new Set(
        facets
          .filter((facet) => facet.dimension === dimension)
          .map((facet) => facet.value)
          .filter((value): value is string => Boolean(value)),
      ),
    ]

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

function presentationGeneration(data: FleetPresentationData): bigint {
  return data.kind === "applications"
    ? data.indexGeneration
    : data.result.indexGeneration
}

function uniqueObjects(values: readonly NamespacedKey[]): NamespacedKey[] {
  const unique = new Map<string, NamespacedKey>()
  values.forEach((value) => unique.set(identityKey(value), { ...value }))
  return [...unique.values()]
}

function identityKey(identity: NamespacedKey): string {
  return `${identity.namespace}/${identity.name}`
}

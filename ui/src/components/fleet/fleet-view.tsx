"use client"

import { X } from "lucide-react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  ApplicationTable,
  releaseFocusOwnership,
} from "@/components/fleet/application-table"
import { AttentionQueue } from "@/components/fleet/attention-queue"
import { FleetFilters } from "@/components/fleet/fleet-filters"
import { FleetStateNotice } from "@/components/fleet/fleet-states"
import type {
  FleetFacetBucket,
  FleetMapNode,
} from "@/lib/fleet-client"
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
import {
  useFleetData,
  type FleetMapData,
  type FleetMatrixData,
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
  const [focusMessage, setFocusMessage] = useState("")
  const [queryNotice, setQueryNotice] = useState("")
  const headingRef = useRef<HTMLHeadingElement>(null)
  const lastCanonicalReplace = useRef("")
  const summaryTargets = useRef(new Map<string, HTMLElement>())
  const [focusCoordinator] = useState(() =>
    createFleetFocusCoordinator({ announce: setFocusMessage }),
  )

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

  const hasSettledFacets =
    fleet.currentData !== undefined &&
    (fleet.status === "ready" || fleet.status === "empty" || fleet.status === "partial")
  const settledFacets = useMemo(
    () => hasSettledFacets ? presentationFacets(fleet.currentData) : undefined,
    [fleet.currentData, hasSettledFacets],
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

  return (
    <section
      aria-labelledby="applications-title"
      aria-busy={fleet.status === "loading" || fleet.status === "stale"}
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
          focusCoordinator={focusCoordinator}
          getResultsHeadingTarget={getResultsHeadingTarget}
          registerSummaryTarget={(view, identity, target) => {
            const key = `${view}:${identityKey(identity)}`
            if (target) summaryTargets.current.set(key, target)
            else summaryTargets.current.delete(key)
          }}
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
  focusCoordinator: FleetFocusCoordinator
  getResultsHeadingTarget: () => FleetFocusTarget | null
  registerSummaryTarget: (
    view: "treemap" | "matrix",
    identity: NamespacedKey,
    target: HTMLElement | null,
  ) => void
}) {
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
        <FleetMapSummary
          data={data}
          registerTarget={registerSummaryTarget}
          onSelectApplication={onSelectApplication}
          onFocusedApplication={onFocusedApplication}
        />
      )
    case "matrix":
      return <FleetMatrixSummary data={data} />
  }
}

function FleetMapSummary({
  data,
  registerTarget,
  onSelectApplication,
  onFocusedApplication,
}: {
  data: FleetMapData
  registerTarget: (
    view: "treemap",
    identity: NamespacedKey,
    target: HTMLElement | null,
  ) => void
  onSelectApplication: (identity: NamespacedKey) => void
  onFocusedApplication: (identity: NamespacedKey | null) => void
}) {
  const nodes = flattenMap(data.result.roots)
  return (
    <section role="region" aria-label="Fleet map summary" className="px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Treemap contract
          </p>
          <h2 className="mt-1 text-lg font-semibold text-foreground">Fleet map</h2>
        </div>
        <p className="font-mono text-xs tabular-nums text-muted-foreground">
          {data.result.total.toString()} applications · generation {data.result.indexGeneration.toString()}
        </p>
      </div>
      <div className="mt-4 grid gap-px overflow-hidden border border-border bg-border sm:grid-cols-2 xl:grid-cols-3">
        {nodes.slice(0, 12).map((node) => {
          const content = (
            <>
              <strong className="block truncate text-sm font-semibold text-foreground">{node.label}</strong>
              <span className="mt-2 block font-mono text-[0.6875rem] tabular-nums text-muted-foreground">
                {node.applicationCount.toString()} applications / {node.targetCount.toString()} targets
              </span>
            </>
          )
          return node.application ? (
            <button
              key={node.stableId}
              ref={(target) => registerTarget("treemap", node.application!, target)}
              type="button"
              onFocus={() => onFocusedApplication(node.application!)}
              onBlur={(event) =>
                releaseFocusOwnership(
                  event.currentTarget,
                  event.relatedTarget,
                  onFocusedApplication,
                )
              }
              onClick={() => onSelectApplication(node.application!)}
              className="min-h-20 bg-card px-4 py-3 text-left transition-colors hover:bg-muted focus-visible:bg-muted"
            >
              {content}
            </button>
          ) : (
            <div key={node.stableId} className="min-h-20 bg-card px-4 py-3">
              {content}
            </div>
          )
        })}
      </div>
      <p className="mt-4 text-xs leading-5 text-muted-foreground">
        Accessible summary of the current grouped fleet snapshot.
      </p>
    </section>
  )
}

function FleetMatrixSummary({ data }: { data: FleetMatrixData }) {
  return (
    <section role="region" aria-label="Fleet matrix summary" className="px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Sparse comparison
          </p>
          <h2 className="mt-1 text-lg font-semibold text-foreground">Fleet matrix</h2>
        </div>
        <p className="font-mono text-xs tabular-nums text-muted-foreground">
          {data.result.total.toString()} applications · {data.result.cells.length} populated cells
        </p>
      </div>
      <div className="mt-4 overflow-x-auto border border-border">
        <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
          <thead className="bg-card font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted-foreground">
            <tr>
              <th className="border-b border-border px-4 py-3">Row</th>
              <th className="border-b border-border px-4 py-3">Column</th>
              <th className="border-b border-border px-4 py-3">Applications</th>
              <th className="border-b border-border px-4 py-3">Targets</th>
            </tr>
          </thead>
          <tbody>
            {data.result.cells.slice(0, 20).map((cell) => (
              <tr key={`${cell.rowId}:${cell.columnId}`} className="border-b border-border/70 last:border-b-0">
                <td className="px-4 py-3 text-foreground">{headerLabel(data, "row", cell.rowId)}</td>
                <td className="px-4 py-3 text-foreground">{headerLabel(data, "column", cell.columnId)}</td>
                <td className="px-4 py-3 font-mono tabular-nums text-foreground">{cell.applicationCount.toString()}</td>
                <td className="px-4 py-3 font-mono tabular-nums text-foreground">{cell.targetCount.toString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
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

function uniqueObjects(values: readonly NamespacedKey[]): NamespacedKey[] {
  const unique = new Map<string, NamespacedKey>()
  values.forEach((value) => unique.set(identityKey(value), { ...value }))
  return [...unique.values()]
}

function identityKey(identity: NamespacedKey): string {
  return `${identity.namespace}/${identity.name}`
}

function flattenMap(nodes: readonly FleetMapNode[]): FleetMapNode[] {
  return nodes.flatMap((node) => [node, ...flattenMap(node.children)])
}

function headerLabel(data: FleetMatrixData, axis: "row" | "column", id: string): string {
  const headers = axis === "row" ? data.result.rows : data.result.columns
  return headers.find((header) => header.stableId === id)?.label || id
}

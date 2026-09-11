"use client"

import type { PromiseClient } from "@connectrpc/connect"
import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useMemo } from "react"

import {
  hasData,
  useDataSources,
  type DataSourceReading,
} from "@/app/dashboard/clusters/data-sources"
import { FleetStateNotice } from "@/components/fleet/fleet-states"
import { usePublishConsoleScope } from "@/components/layout/console-header"
import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { StatusPill } from "@/components/ui/status-chip"
import type { PaprikaService } from "@/gen/paprika/v1/api_connect"
import {
  Cluster,
  ClusterMode,
  ClusterPhase,
  DataClass,
  DataState,
  FleetConnectionState,
} from "@/gen/paprika/v1/api_pb"
import { getFleetClient } from "@/lib/fleet-client"
import {
  mergeFleetQuery,
  parseFleetQuery,
  serializeFleetQuery,
  type FleetQueryState,
} from "@/lib/fleet-query"
import { FLEET_REFRESH_INTERVAL_MS, useFleetRefresh } from "@/lib/fleet-refresh"
import { useConnection } from "@/lib/connection-context"
import { STATUS_TONES, type StatusTone } from "@/lib/status-tone"
import { useFleetData } from "@/lib/use-fleet-data"

/**
 * Clusters, as this server can actually describe them.
 *
 * Two very different things are called "the cluster list" and this page keeps
 * them apart on purpose.
 *
 * The first is the set of clusters the fleet index has applications in. That
 * is derived from the same facet buckets the scope bar uses, it is fleet-wide
 * and exact, and it is available today.
 *
 * The second is cluster *inventory* — nodes, pods, namespaces, versions,
 * regions — which comes from a collector that is not configured here. Its
 * `DataClass` reports `NOT_CONFIGURED`, so under the degraded-mode contract
 * that surface must be absent rather than zeroed: a table of clusters with
 * `0 nodes` in every row is a lie with a table around it. The board is
 * replaced by the server's own sentence about why, which doubles as the
 * instruction for making it appear.
 */

export type ClustersClient = Pick<
  PromiseClient<typeof PaprikaService>,
  "getDataSources" | "listClusters"
>

export interface ClustersViewProps {
  client?: ClustersClient
}

const MAX_LISTED_CLUSTERS = 60

const counter = new Intl.NumberFormat("en-US")

export function ClustersView({ client }: ClustersViewProps) {
  const resolved = useMemo(() => client ?? getFleetClient(), [client])
  const searchParams = useSearchParams()
  const { reportRequestOutcome } = useConnection()

  const raw = searchParams.toString()
  const state = useMemo(
    () =>
      mergeFleetQuery(parseFleetQuery(raw).state, {
        view: "matrix",
        rows: "project",
        columns: "cluster",
      }),
    [raw]
  )
  const fleet = useFleetData(state)
  useFleetRefresh(fleet.refresh, {
    onRequestOutcome: reportRequestOutcome,
    refreshOnMount: false,
  })

  const result =
    fleet.displayData?.kind === "matrix" ? fleet.displayData.result : undefined
  usePublishConsoleScope({
    facets: result?.facets,
    indexGeneration: result?.indexGeneration,
    // No `refreshedAt`: `useFleetData` does not surface the moment its query
    // resolved, and reading the clock during render would make the age a
    // property of the paint rather than of the data. The header falls back to
    // reporting the poll cadence, which is true either way.
    isRefreshing: fleet.isLoading || fleet.isStale,
    intervalMs: FLEET_REFRESH_INTERVAL_MS,
  })

  const referenced = useMemo(
    () =>
      fleet.applicationFacets.filter((facet) => facet.dimension === "cluster"),
    [fleet.applicationFacets]
  )

  const probe = useDataSources(resolved)
  const inventory = probe.reading(DataClass.CLUSTER_INVENTORY)
  const inventoryHasData = hasData(inventory?.state)

  const clusters = useQuery({
    queryKey: ["console", "clusters"],
    queryFn: async ({ signal }) => {
      const response = await resolved.listClusters({}, { signal })
      return response.clusters
    },
    // The probe decides whether this RPC is worth making at all. Asking for a
    // list the server has already said it cannot populate would only produce
    // an empty page to misread.
    enabled: inventoryHasData,
  })

  return (
    <div className="px-5 pt-4 pb-8">
      <header className="mb-4">
        <p className="font-mono text-kicker tracking-[0.2em] text-steel-600 uppercase">
          Sources
        </p>
        <h1 className="mt-1 font-cond text-title leading-none font-semibold tracking-[0.01em]">
          Clusters
        </h1>
      </header>

      <FleetStateNotice status={fleet.status} />

      {result ? (
        <Blueprint>
          <BoardHeader
            index="01"
            title="Clusters in the fleet index"
            meta={`${counter.format(referenced.length)} referenced · gen ${result.indexGeneration.toString()}`}
          />
          {referenced.length === 0 ? (
            <p role="status" className="px-3.5 py-6 text-reason text-muted-foreground">
              No cluster in this scope has an application targeting it.
            </p>
          ) : (
            <>
              <table
                aria-label="Clusters in the fleet index"
                className="w-full border-collapse text-left"
              >
                <thead>
                  <tr className="bg-inset">
                    <th
                      scope="col"
                      className="border-b border-rule-strong px-3.5 py-1.5 font-mono text-kicker font-normal tracking-[0.14em] text-muted-foreground uppercase"
                    >
                      Cluster
                    </th>
                    <th
                      scope="col"
                      className="border-b border-rule-strong px-3.5 py-1.5 text-right font-mono text-kicker font-normal tracking-[0.14em] text-muted-foreground uppercase"
                    >
                      Applications
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {referenced.slice(0, MAX_LISTED_CLUSTERS).map((facet) => (
                    // Keyed on the namespaced object, not the label: two
                    // clusters in different namespaces can share a name, and
                    // labels alone collide as React keys and read as duplicate
                    // rows.
                    <tr
                      key={
                        facet.object
                          ? `${facet.object.namespace}/${facet.object.name}`
                          : facet.label
                      }
                      className="border-b border-rule-soft last:border-b-0"
                    >
                      <th scope="row" className="px-3.5 py-2 font-normal">
                        <Link
                          href={clusterHref(state, facet.object)}
                          className="block font-cond text-name font-semibold tracking-[0.02em] text-foreground no-underline hover:underline"
                        >
                          {facet.label}
                        </Link>
                        {facet.object?.namespace ? (
                          <span className="block font-mono text-meta text-neutral-600">
                            {facet.object.namespace}
                          </span>
                        ) : null}
                      </th>
                      <td className="px-3.5 py-2 text-right font-mono text-console tabular-nums">
                        {counter.format(facet.count)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {referenced.length > MAX_LISTED_CLUSTERS ? (
                <p className="border-t border-rule px-3.5 py-2 text-note text-muted-foreground">
                  Showing the first {counter.format(MAX_LISTED_CLUSTERS)} of{" "}
                  {counter.format(referenced.length)} clusters.
                </p>
              ) : null}
            </>
          )}
        </Blueprint>
      ) : null}

      <div className="mt-4">
        <ClusterInventoryBoard
          reading={inventory}
          isProbing={probe.isLoading}
          probeFailed={probe.isError}
          clusters={clusters.data}
        />
      </div>
    </div>
  )
}

/**
 * The inventory board exists only when the data behind it does. Every other
 * `DataState` resolves to a sentence, never to a number.
 */
function ClusterInventoryBoard({
  reading,
  isProbing,
  probeFailed,
  clusters,
}: {
  reading: DataSourceReading | undefined
  isProbing: boolean
  probeFailed: boolean
  clusters: Cluster[] | undefined
}) {
  if (isProbing) {
    return (
      <p role="status" aria-live="polite" className="text-reason text-muted-foreground">
        Checking which data sources are configured.
      </p>
    )
  }

  if (probeFailed) {
    return (
      <Blueprint>
        <BoardHeader index="02" title="Cluster inventory" />
        <p role="alert" className="px-3.5 py-5 text-reason text-muted-foreground">
          Paprika could not read its data source capabilities, so this board is
          not shown. Nothing here is missing; it is unknown.
        </p>
      </Blueprint>
    )
  }

  // FORBIDDEN hides without implying the data is absent, and an unspecified
  // state is not an assertion about anything.
  if (
    reading === undefined ||
    reading.state === DataState.FORBIDDEN ||
    reading.state === DataState.UNSPECIFIED
  ) {
    return null
  }

  if (!hasData(reading.state)) {
    return (
      <Blueprint>
        <BoardHeader index="02" title="Cluster inventory" />
        <div role="status" className="px-3.5 py-5">
          <p className="text-reason text-neutral-800">
            {reading.unavailableReason ||
              "Cluster inventory is not available on this server."}
          </p>
          <p className="mt-2 font-mono text-meta text-muted-foreground">
            Node, pod and namespace counts are omitted rather than reported as
            zero.
          </p>
        </div>
      </Blueprint>
    )
  }

  const rows = clusters ?? []
  return (
    <Blueprint>
      <BoardHeader
        index="02"
        title="Cluster inventory"
        meta={reading.provider || undefined}
        actions={
          reading.state === DataState.STALE ? (
            <StatusPill tone="degraded" label={`stale · ${age(reading.observedAtUnixMs)} old`} />
          ) : undefined
        }
      />
      {rows.length === 0 ? (
        <p role="status" className="px-3.5 py-5 text-reason text-muted-foreground">
          The inventory source reports no clusters.
        </p>
      ) : (
        <table
          aria-label="Cluster inventory"
          className="w-full border-collapse text-left"
        >
          <thead>
            <tr className="bg-inset">
              {["Cluster", "Mode", "Connection", "Version", "Applications"].map(
                (heading, index) => (
                  <th
                    key={heading}
                    scope="col"
                    className={cellHeadClass(index > 3)}
                  >
                    {heading}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((cluster) => {
              const identity = cluster.identity
              const name = cluster.displayName || identity?.name || "unknown"
              return (
                <tr
                  key={`${identity?.namespace ?? ""}/${identity?.name ?? name}`}
                  className="border-b border-rule-soft last:border-b-0"
                >
                  <th scope="row" className="px-3.5 py-2 font-normal">
                    <span className="block font-cond text-name font-semibold tracking-[0.02em]">
                      {name}
                    </span>
                    {identity?.namespace ? (
                      <span className="block font-mono text-meta text-muted-foreground">
                        {identity.namespace}
                      </span>
                    ) : null}
                  </th>
                  <td className="px-3.5 py-2 font-mono text-note text-muted-foreground">
                    {clusterModeLabel(cluster.mode)}
                  </td>
                  <td className="px-3.5 py-2">
                    <StatusPill
                      tone={connectionTone(cluster.connection, cluster.phase)}
                      label={connectionLabel(cluster.connection)}
                    />
                  </td>
                  <td className="px-3.5 py-2 font-mono text-note text-muted-foreground">
                    {cluster.kubernetesVersion || "not reported"}
                  </td>
                  <td className="px-3.5 py-2 text-right font-mono text-console tabular-nums">
                    {counter.format(cluster.applicationCount)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Blueprint>
  )
}

function cellHeadClass(alignRight: boolean): string {
  return [
    "border-b border-rule-strong px-3.5 py-1.5 font-mono text-kicker font-normal tracking-[0.14em] text-muted-foreground uppercase",
    alignRight ? "text-right" : "",
  ]
    .filter(Boolean)
    .join(" ")
}

/**
 * A cluster facet always carries its object identity, which is what the
 * application list filters on. Without one there is nothing to narrow by, so
 * the link opens the unfiltered list rather than inventing a filter.
 */
function clusterHref(
  state: FleetQueryState,
  object: { namespace: string; name: string } | undefined
): string {
  const params = serializeFleetQuery(
    mergeFleetQuery(state, {
      view: "table",
      clusters: object ? [object] : [],
    })
  )
  return `/dashboard/applications/?${params.toString()}`
}

function clusterModeLabel(mode: ClusterMode): string {
  switch (mode) {
    case ClusterMode.IN_CLUSTER:
      return "in-cluster"
    case ClusterMode.DIRECT:
      return "direct"
    case ClusterMode.AGENT:
      return "agent"
    default:
      return "unknown"
  }
}

function connectionLabel(connection: FleetConnectionState): string {
  switch (connection) {
    case FleetConnectionState.HEALTHY:
      return "Connected"
    case FleetConnectionState.UNHEALTHY:
      return "Degraded"
    case FleetConnectionState.DISABLED:
      return "Disabled"
    case FleetConnectionState.NOT_CONFIGURED:
      return "Not configured"
    default:
      return STATUS_TONES.unknown.label
  }
}

function connectionTone(
  connection: FleetConnectionState,
  phase: ClusterPhase
): StatusTone {
  switch (connection) {
    case FleetConnectionState.HEALTHY:
      return phase === ClusterPhase.UNHEALTHY ? "degraded" : "healthy"
    case FleetConnectionState.UNHEALTHY:
      return "failed"
    case FleetConnectionState.DISABLED:
      return "pending"
    default:
      return "unknown"
  }
}

function age(observedAtUnixMs: bigint): string {
  const seconds = Math.max(0, Math.round((Date.now() - Number(observedAtUnixMs)) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

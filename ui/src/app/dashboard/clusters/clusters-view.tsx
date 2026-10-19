"use client"

import { Code, ConnectError, type PromiseClient } from "@connectrpc/connect"
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
import { CapacityMeter } from "@/components/overview/capacity-meter"
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
  ListClustersRequest,
  type ClusterNodePool,
  type ClusterSatellite,
} from "@/gen/paprika/v1/api_pb"
import { numbersAreReal } from "@/lib/data-state"
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
 * The first is the set of clusters the fleet index has applications in. It is
 * derived from the same facet buckets the scope bar uses, it is fleet-wide and
 * exact, and it is available today.
 *
 * The second is the registered `Cluster` objects themselves: mode, phase,
 * connection, management policies, node and pod counts, capacity meters, and
 * what a satellite last reported. `ListClusters` serves those for real, so the
 * board draws them — but each figure is gated on its own data class, because a
 * cluster whose node RBAC is denied still has a name and a policy set.
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

  const clusters = useQuery({
    queryKey: ["console", "clusters"],
    queryFn: ({ signal }) => listClusters(resolved, signal),
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
        <RegistrationsBoard
          reading={inventory}
          isProbing={probe.isLoading}
          clusters={clusters.data?.clusters}
          includesUnreferenced={clusters.data?.includesUnreferenced ?? false}
          failed={clusters.isError}
        />
      </div>
    </div>
  )
}

interface ClusterPage {
  clusters: Cluster[]
  includesUnreferenced: boolean
}

/**
 * `ListClusters` is asked for capacity and for unreferenced registrations.
 * Unreferenced is an admin read — an inventory of clusters nobody the caller
 * can see deploys to is a fact about the install, not about their workloads —
 * so a refusal downgrades the request instead of failing the page.
 */
async function listClusters(
  client: ClustersClient,
  signal: AbortSignal
): Promise<ClusterPage> {
  const full = new ListClustersRequest({
    includeCapacity: true,
    includeUnreferenced: true,
  })
  try {
    const response = await client.listClusters(full, { signal })
    return { clusters: response.clusters, includesUnreferenced: true }
  } catch (error) {
    if (error instanceof ConnectError && error.code === Code.PermissionDenied) {
      const response = await client.listClusters(
        new ListClustersRequest({ includeCapacity: true }),
        { signal }
      )
      return { clusters: response.clusters, includesUnreferenced: false }
    }
    throw error
  }
}

/**
 * The registrations board. Every figure is gated on its own source: node and
 * pod counts come from the inventory collector, the meters from capacity, the
 * policy chips from the Cluster spec. A cluster whose inventory is unavailable
 * still shows its policies and its connection — it just does not claim to know
 * how many nodes it has.
 */
function RegistrationsBoard({
  reading,
  isProbing,
  clusters,
  includesUnreferenced,
  failed,
}: {
  reading: DataSourceReading | undefined
  isProbing: boolean
  clusters: Cluster[] | undefined
  includesUnreferenced: boolean
  failed: boolean
}) {
  if (isProbing) {
    return (
      <p role="status" aria-live="polite" className="text-reason text-muted-foreground">
        Checking which data sources are configured.
      </p>
    )
  }

  if (failed) {
    return (
      <Blueprint>
        <BoardHeader index="02" title="Registered clusters" />
        <p role="alert" className="px-3.5 py-5 text-reason text-muted-foreground">
          Paprika could not read its cluster registrations, so this board is not
          shown. Nothing here is missing; it is unknown.
        </p>
      </Blueprint>
    )
  }

  const rows = clusters ?? []
  if (rows.length === 0) {
    return (
      <Blueprint>
        <BoardHeader index="02" title="Registered clusters" />
        <p role="status" className="px-3.5 py-5 text-reason text-muted-foreground">
          {includesUnreferenced
            ? "No cluster is registered on this control plane."
            : "No cluster registered in this scope has an application targeting it."}
        </p>
      </Blueprint>
    )
  }

  const stale = reading?.state === DataState.STALE
  return (
    <Blueprint>
      <BoardHeader
        index="02"
        title="Registered clusters"
        meta={`${counter.format(rows.length)} registered`}
        actions={
          stale && reading ? (
            <StatusPill
              tone="degraded"
              label={`inventory stale · ${age(reading.observedAtUnixMs)} old`}
            />
          ) : undefined
        }
      />
      <ul className="grid list-none grid-cols-1 gap-px bg-rule md:grid-cols-2 xl:grid-cols-3">
        {rows.map((cluster) => (
          <ClusterCard
            key={clusterKey(cluster)}
            cluster={cluster}
            inventoryReason={reading?.unavailableReason}
          />
        ))}
      </ul>
      {!includesUnreferenced ? (
        <p className="border-t border-rule px-3.5 py-2 text-note text-muted-foreground">
          Only clusters an application you can read deploys to are listed.
          Listing the whole registry requires admin.
        </p>
      ) : null}
    </Blueprint>
  )
}

function ClusterCard({
  cluster,
  inventoryReason,
}: {
  cluster: Cluster
  inventoryReason: string | undefined
}) {
  const identity = cluster.identity
  const name = cluster.displayName || identity?.name || "unknown"
  const inventory = cluster.inventory
  const inventoryReal = numbersAreReal(inventory?.state)
  const satellite = cluster.satellite

  return (
    <li className="bg-card px-3.5 py-3">
      <div className="flex items-start justify-between gap-2.5">
        <div>
          <Link
            href={clusterDetailHref(cluster)}
            className="font-cond text-card font-semibold tracking-[0.03em] text-foreground"
          >
            {name}
          </Link>
          {identity?.namespace ? (
            <span className="block font-mono text-meta text-neutral-600">
              {identity.namespace}
            </span>
          ) : null}
        </div>
        <StatusPill
          tone={connectionTone(cluster.connection, cluster.phase)}
          label={connectionLabel(cluster.connection)}
        />
      </div>

      <p className="mt-0.5 font-mono text-meta text-neutral-600">
        {[
          clusterModeLabel(cluster.mode),
          cluster.kubernetesVersion || "version not reported",
        ].join(" · ")}
      </p>

      <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-note text-muted-foreground">
        <Stat value={counter.format(cluster.applicationCount)} tail="apps" />
        <Stat value={counter.format(cluster.targetCount)} tail="targets" />
        {inventoryReal && inventory ? (
          <>
            <Stat
              value={`${counter.format(inventory.readyNodeCount)}/${counter.format(inventory.nodeCount)}`}
              tail="nodes ready"
            />
            <Stat
              value={`${counter.format(inventory.runningPodCount)}/${counter.format(inventory.podCount)}`}
              tail="pods running"
            />
          </>
        ) : null}
      </div>

      <PolicyChips policies={cluster.managementPolicies} />

      {satellite ? <SatelliteLine satellite={satellite} /> : null}

      {!inventoryReal && inventoryReason ? (
        <p className="mt-1.5 text-meta text-muted-foreground">
          Node and pod counts are unavailable: {inventoryReason}
        </p>
      ) : null}

      {cluster.capacity?.cpu || cluster.capacity?.memory ? (
        <div className="mt-3 flex flex-col gap-2.5 border-t border-rule-soft pt-2.5">
          {cluster.capacity.cpu ? (
            <CapacityMeter label="CPU" meter={cluster.capacity.cpu} />
          ) : null}
          {cluster.capacity.memory ? (
            <CapacityMeter label="MEMORY" meter={cluster.capacity.memory} />
          ) : null}
        </div>
      ) : null}

      <NodePools
        pools={cluster.provider?.nodePools}
        providerType={cluster.provider?.type}
      />
    </li>
  )
}

/**
 * Policies are shown as chips because the set answers "what will Paprika do
 * here". Empty is rendered explicitly: a cluster that grants nothing is a
 * deliberate configuration, and a blank row would read as missing data.
 */
function PolicyChips({ policies }: { policies: readonly string[] }) {
  if (policies.length === 0) {
    return (
      <p className="mt-2 font-mono text-meta text-degraded">
        policies: none — Paprika will not read or write this cluster
      </p>
    )
  }
  return (
    <ul
      className="mt-2 flex list-none flex-wrap gap-1"
      aria-label="Management policies"
    >
      {policies.map((policy) => (
        <li
          key={policy}
          className="border border-rule px-1.5 py-0.5 font-mono text-meta text-neutral-700"
        >
          {policy}
        </li>
      ))}
    </ul>
  )
}

/**
 * What the satellite last said it was doing. An empty `operatingState` means it
 * never reported one, and that is shown as "not reported" rather than inferred
 * from the age of `lastSeen`.
 */
function SatelliteLine({ satellite }: { satellite: ClusterSatellite }) {
  const parts = [
    satellite.autonomy ? `autonomy ${satellite.autonomy}` : "",
    satellite.operatingState || "state not reported",
    satellite.lastSeenUnixMs > BigInt(0)
      ? `seen ${age(satellite.lastSeenUnixMs)} ago`
      : "never reported",
  ].filter(Boolean)

  return (
    <p className="mt-1 font-mono text-meta text-neutral-600">
      satellite · {parts.join(" · ")}
    </p>
  )
}

function NodePools({
  pools,
  providerType,
}: {
  pools: readonly ClusterNodePool[] | undefined
  providerType: string | undefined
}) {
  if (!pools || pools.length === 0) {
    return null
  }
  return (
    <div className="mt-2 border-t border-rule-soft pt-2">
      <p className="font-mono text-kicker tracking-[0.14em] text-neutral-600 uppercase">
        {providerType ? `${providerType} node pools` : "node pools"}
      </p>
      <ul className="mt-1 list-none">
        {pools.map((pool) => (
          <li key={pool.name} className="font-mono text-meta text-neutral-700">
            {pool.name} · {counter.format(pool.nodeCount)} nodes
            {pool.machineType ? ` · ${pool.machineType}` : ""}
            {pool.autoScaled ? " · autoscaled" : ""}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Stat({ value, tail }: { value: string; tail: string }) {
  return (
    <span className="whitespace-nowrap">
      <span className="font-cond text-name font-semibold text-foreground tabular-nums">
        {value}
      </span>
      {tail ? ` ${tail}` : ""}
    </span>
  )
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

/** The detail page is scoped by the cluster's own identity. */
function clusterDetailHref(cluster: Cluster): string {
  const identity = cluster.identity
  if (!identity) {
    return "/dashboard/clusters/"
  }
  const params = new URLSearchParams({
    namespace: identity.namespace,
    name: identity.name,
  })
  return `/dashboard/clusters/detail/?${params.toString()}`
}

function clusterKey(cluster: Cluster): string {
  const identity = cluster.identity
  return identity ? `${identity.namespace}/${identity.name}` : cluster.server
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
      return "mode unknown"
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
  const seconds = Math.max(
    0,
    Math.round((Date.now() - Number(observedAtUnixMs)) / 1000)
  )
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

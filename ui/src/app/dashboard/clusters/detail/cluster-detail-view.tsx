"use client"

import type { PromiseClient } from "@connectrpc/connect"
import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useMemo } from "react"

import { CapacityMeter } from "@/components/overview/capacity-meter"
import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { StatusPill } from "@/components/ui/status-chip"
import type { PaprikaService } from "@/gen/paprika/v1/api_connect"
import {
  ClusterMode,
  ClusterPhase,
  DataState,
  FleetConnectionState,
  GetClusterRequest,
  type Cluster,
} from "@/gen/paprika/v1/api_pb"
import { getFleetClient } from "@/lib/fleet-client"
import { serializeFleetQuery, mergeFleetQuery, parseFleetQuery } from "@/lib/fleet-query"
import { STATUS_TONES, type StatusTone } from "@/lib/status-tone"

/**
 * One cluster registration, in full.
 *
 * The page exists because the board can only show a summary: a cluster's
 * management ceiling, what its satellite last reported, its node-pool shape and
 * its capacity meter each answer a different question, and an operator
 * debugging "why will nothing deploy here" needs all of them in one place.
 *
 * Every value renders from what the server sent. A field the control plane has
 * not observed stays absent with its state beside it — the page never fills a
 * gap with a zero.
 */

export type ClusterDetailClient = Pick<
  PromiseClient<typeof PaprikaService>,
  "getCluster"
>

export interface ClusterDetailViewProps {
  client?: ClusterDetailClient
}

export function ClusterDetailView({ client }: ClusterDetailViewProps) {
  const resolved = useMemo(() => client ?? getFleetClient(), [client])
  const searchParams = useSearchParams()
  const namespace = searchParams.get("namespace") ?? ""
  const name = searchParams.get("name") ?? ""

  const cluster = useQuery({
    queryKey: ["console", "cluster", namespace, name],
    queryFn: ({ signal }) =>
      resolved.getCluster(new GetClusterRequest({ namespace, name }), {
        signal,
      }),
    enabled: namespace !== "" && name !== "",
  })

  if (namespace === "" || name === "") {
    return (
      <Notice
        title="No cluster named"
        body="Open a cluster from the clusters page, or add ?namespace= and ?name= to the URL."
      />
    )
  }

  if (cluster.isError) {
    return (
      <Notice
        title="Cluster unavailable"
        body="Paprika could not read this cluster registration. Nothing here is missing; it is unknown."
      />
    )
  }

  const record = cluster.data?.cluster
  if (!record) {
    return <Notice title="Loading cluster" body={`Reading ${namespace}/${name}.`} />
  }

  return <ClusterDetail cluster={record} />
}

function ClusterDetail({ cluster }: { cluster: Cluster }) {
  const identity = cluster.identity
  const displayName = cluster.displayName || identity?.name || "unknown"

  return (
    <div className="px-5 pt-4 pb-8">
      <header className="mb-4">
        <p className="font-mono text-kicker tracking-[0.2em] text-steel-600 uppercase">
          Sources
        </p>
        <h1 className="mt-1 flex items-center gap-2.5 font-cond text-title leading-none font-semibold tracking-[0.01em]">
          {displayName}
          <StatusPill
            tone={connectionTone(cluster.connection, cluster.phase)}
            label={connectionLabel(cluster.connection)}
          />
        </h1>
        {identity ? (
          <p className="mt-1 font-mono text-meta text-neutral-600">
            {identity.namespace}/{identity.name} · {modeLabel(cluster.mode)}
            {cluster.kubernetesVersion
              ? ` · ${cluster.kubernetesVersion}`
              : " · version not reported"}
          </p>
        ) : null}
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Blueprint>
          <BoardHeader
            index="01"
            title="Management policies"
            meta={`${cluster.managementPolicies.length} granted`}
          />
          {cluster.managementPolicies.length === 0 ? (
            <p className="px-3.5 py-4 text-reason text-muted-foreground">
              This registration grants nothing. Paprika will not read from or
              write to this cluster.
            </p>
          ) : (
            <ul className="flex list-none flex-wrap gap-1 px-3.5 py-3">
              {cluster.managementPolicies.map((policy) => (
                <li
                  key={policy}
                  className="border border-rule px-1.5 py-0.5 font-mono text-meta text-neutral-700"
                >
                  {policy}
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-rule px-3.5 py-2 text-note text-muted-foreground">
            A stage may request less than this set and never more.
          </p>
        </Blueprint>

        {cluster.satellite ? (
          <Blueprint>
            <BoardHeader index="02" title="Satellite" />
            <dl className="grid grid-cols-2 gap-x-3.5 gap-y-1.5 px-3.5 py-3 text-note">
              <Field label="Autonomy" value={cluster.satellite.autonomy || "not reported"} />
              <Field
                label="Operating state"
                value={cluster.satellite.operatingState || "not reported"}
              />
              <Field label="Last seen" value={age(cluster.satellite.lastSeenUnixMs)} />
              <Field
                label="Autonomous since"
                value={
                  cluster.satellite.autonomousSinceUnixMs > BigInt(0)
                    ? new Date(
                        Number(cluster.satellite.autonomousSinceUnixMs)
                      ).toISOString()
                    : "not autonomous"
                }
              />
            </dl>
            {cluster.satellite.activeOverrides > 0 ? (
              <p className="border-t border-rule px-3.5 py-2 text-note text-degraded">
                {cluster.satellite.activeOverrides} local override
                {cluster.satellite.activeOverrides === 1 ? "" : "s"} taken during
                an outage have not been acknowledged.
              </p>
            ) : null}
          </Blueprint>
        ) : null}

        <Blueprint>
          <BoardHeader
            index="03"
            title="Capacity"
            meta={cluster.capacity?.usageProvider || undefined}
          />
          {cluster.capacity?.cpu || cluster.capacity?.memory ? (
            <div className="flex flex-col gap-3 px-3.5 py-3">
              {cluster.capacity.cpu ? (
                <CapacityMeter label="CPU" meter={cluster.capacity.cpu} />
              ) : null}
              {cluster.capacity.memory ? (
                <CapacityMeter label="MEMORY" meter={cluster.capacity.memory} />
              ) : null}
            </div>
          ) : (
            <p className="px-3.5 py-4 text-reason text-muted-foreground">
              No capacity source answered for this cluster.
            </p>
          )}
        </Blueprint>

        <Blueprint>
          <BoardHeader
            index="04"
            title="Inventory"
            meta={inventoryStateLabel(cluster.inventory?.state)}
          />
          {cluster.inventory && cluster.inventory.state === DataState.OK ? (
            <dl className="grid grid-cols-2 gap-x-3.5 gap-y-1.5 px-3.5 py-3 text-note">
              <Field
                label="Nodes"
                value={`${cluster.inventory.readyNodeCount} ready of ${cluster.inventory.nodeCount}`}
              />
              <Field
                label="Pods"
                value={`${cluster.inventory.runningPodCount} running of ${cluster.inventory.podCount}`}
              />
              <Field label="Namespaces" value={String(cluster.inventory.namespaceCount)} />
              <Field
                label="Regions"
                value={cluster.inventory.regions.join(", ") || "not reported"}
              />
              <Field
                label="Zones"
                value={cluster.inventory.zones.join(", ") || "not reported"}
              />
              <Field
                label="Kubelets"
                value={cluster.inventory.kubeletVersions.join(", ") || "not reported"}
              />
            </dl>
          ) : (
            <p className="px-3.5 py-4 text-reason text-muted-foreground">
              {cluster.inventory?.unavailableReason ||
                "Cluster inventory is not available for this registration."}
            </p>
          )}
        </Blueprint>
      </div>

      {cluster.provider?.nodePools?.length ? (
        <div className="mt-4">
          <Blueprint>
            <BoardHeader
              index="05"
              title={cluster.provider.type ? `${cluster.provider.type} node pools` : "Node pools"}
              meta={cluster.provider.region || undefined}
            />
            <table className="w-full border-collapse text-left" aria-label="Node pools">
              <thead>
                <tr className="bg-inset">
                  {["Pool", "Nodes", "Machine type", "Autoscaler"].map((heading) => (
                    <th
                      key={heading}
                      scope="col"
                      className="border-b border-rule-strong px-3.5 py-1.5 font-mono text-kicker font-normal tracking-[0.14em] text-muted-foreground uppercase"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cluster.provider.nodePools.map((pool) => (
                  <tr key={pool.name} className="border-b border-rule-soft last:border-b-0">
                    <th scope="row" className="px-3.5 py-2 font-normal">
                      {pool.name}
                    </th>
                    <td className="px-3.5 py-2 font-mono text-note tabular-nums">
                      {pool.nodeCount}
                    </td>
                    <td className="px-3.5 py-2 font-mono text-note text-muted-foreground">
                      {pool.machineType || "not reported"}
                    </td>
                    <td className="px-3.5 py-2 font-mono text-note text-muted-foreground">
                      {pool.autoScaled ? `${pool.minNodes}–${pool.maxNodes}` : "fixed"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Blueprint>
        </div>
      ) : null}

      <div className="mt-4">
        <Blueprint>
          <BoardHeader index="06" title="Applications on this cluster" />
          <p className="px-3.5 py-3 text-reason text-muted-foreground">
            <Link href={applicationsHref(cluster)} className="underline">
              Open the applications targeting this cluster
            </Link>
          </p>
        </Blueprint>
      </div>
    </div>
  )
}

function applicationsHref(cluster: Cluster): string {
  const identity = cluster.identity
  const state = parseFleetQuery("").state
  const params = serializeFleetQuery(
    mergeFleetQuery(state, {
      view: "table",
      clusters: identity ? [identity] : [],
    })
  )
  return `/dashboard/applications/?${params.toString()}`
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="font-mono text-kicker tracking-[0.14em] text-neutral-600 uppercase">
        {label}
      </dt>
      <dd className="font-mono text-note text-foreground">{value}</dd>
    </>
  )
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-5 pt-4 pb-8">
      <Blueprint>
        <BoardHeader index="01" title={title} />
        <p role="status" className="px-3.5 py-4 text-reason text-muted-foreground">
          {body}
        </p>
      </Blueprint>
    </div>
  )
}

function inventoryStateLabel(state: DataState | undefined): string | undefined {
  switch (state) {
    case DataState.OK:
      return "current"
    case DataState.STALE:
      return "stale"
    case DataState.NOT_CONFIGURED:
      return "not configured"
    case DataState.FORBIDDEN:
      return "forbidden"
    case DataState.ERROR:
      return "error"
    default:
      return undefined
  }
}

function modeLabel(mode: ClusterMode): string {
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

function age(epochMs: bigint): string {
  if (epochMs <= BigInt(0)) {
    return "never"
  }
  const seconds = Math.max(0, Math.round((Date.now() - Number(epochMs)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

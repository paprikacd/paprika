"use client"

import Link from "next/link"

import { StatusPill } from "@/components/ui/status-chip"
import {
  ClusterMode,
  CostBasis,
  FleetConnectionState,
  type Cluster,
  type CostSummary,
} from "@/gen/paprika/v1/api_pb"
import type { StatusTone } from "@/lib/status-tone"

import { CapacityMeter } from "./capacity-meter"
import { UnavailableNote } from "./data-notice"
import { numbersAreReal, plural } from "./data-state"
import { BoardEmpty, BoardFootnote } from "./overview-board"

const MODE_LABELS: Record<ClusterMode, string> = {
  [ClusterMode.UNSPECIFIED]: "",
  [ClusterMode.IN_CLUSTER]: "in-cluster",
  [ClusterMode.DIRECT]: "direct",
  [ClusterMode.AGENT]: "agent",
}

function connectionPill(
  connection: FleetConnectionState
): { tone: StatusTone; label: string } | null {
  switch (connection) {
    case FleetConnectionState.HEALTHY:
      return { tone: "healthy", label: "Connected" }
    case FleetConnectionState.UNHEALTHY:
      return { tone: "degraded", label: "Degraded" }
    case FleetConnectionState.DISABLED:
      return { tone: "unknown", label: "Disabled" }
    default:
      return null
  }
}

/**
 * Spend is only ever shown with its basis attached. A rate-card figure is an
 * estimate derived from requests or allocatable capacity; a billing figure is
 * what the invoice said. Rendering them identically would make an estimate
 * indistinguishable from a measurement.
 */
export function formatCost(cost: CostSummary | undefined): string | null {
  if (!cost || !numbersAreReal(cost.state)) return null
  const amount = new Intl.NumberFormat("en", {
    style: "currency",
    currency: cost.currency || "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(cost.monthlyAmount)
  const estimate =
    cost.basis === CostBasis.RATE_CARD_REQUESTED ||
    cost.basis === CostBasis.RATE_CARD_ALLOCATABLE
  return `${estimate ? "≈ " : ""}${amount}/mo`
}

/**
 * Board 06 — the clusters this control plane drives, and what is on them.
 *
 * The board exists only when a cluster projection does. Within it, every figure
 * is gated separately: node and pod counts come from the inventory collector,
 * the meters from the capacity collector, spend from a cost source. A cluster
 * whose node RBAC is denied still shows its name, its connection and its
 * application count — it just does not claim to know how many nodes it has.
 */
/**
 * A control plane can drive more clusters than a summary board should draw. The
 * board is a triage surface, not an inventory, so it shows a bounded worst-first
 * window and points at the full list — the same discipline the posture heatmap
 * and the rollouts board use.
 */
const MAX_CLUSTER_CELLS = 9

/** Degraded first, then disabled, then healthy: the ones needing a look lead. */
const CONNECTION_ORDER: Record<number, number> = {
  [FleetConnectionState.UNHEALTHY]: 0,
  [FleetConnectionState.DISABLED]: 1,
  [FleetConnectionState.HEALTHY]: 2,
}

function connectionRank(cluster: Cluster): number {
  return CONNECTION_ORDER[cluster.connection] ?? 3
}

export function ClustersBoard({ clusters }: { clusters: readonly Cluster[] }) {
  if (clusters.length === 0) {
    return <BoardEmpty>No clusters are registered in this scope.</BoardEmpty>
  }

  const ordered = [...clusters].sort(
    (left, right) => connectionRank(left) - connectionRank(right)
  )
  const shown = ordered.slice(0, MAX_CLUSTER_CELLS)

  return (
    <>
      <ul className="grid list-none grid-cols-1 gap-px bg-rule md:grid-cols-2 xl:grid-cols-3">
        {shown.map((cluster) => (
          <ClusterCell key={clusterKey(cluster)} cluster={cluster} />
        ))}
      </ul>
      <BoardFootnote className="gap-x-3.5 text-meta">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-[7px] w-3.5 bg-primary" />
          used
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-[11px] w-0.5 bg-foreground" />
          requested
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-[7px] w-3.5 border border-rule bg-neutral-200"
          />
          allocatable
        </span>
        <span className="ml-auto font-mono text-kicker text-neutral-500">
          {shown.length < clusters.length
            ? `${shown.length} of ${clusters.length} clusters · least healthy first · requests above 85% of allocatable are flagged`
            : "requests above 85% of allocatable are flagged"}
        </span>
      </BoardFootnote>
    </>
  )
}

function clusterKey(cluster: Cluster): string {
  const identity = cluster.identity
  return identity ? `${identity.namespace}/${identity.name}` : cluster.server
}

function ClusterCell({ cluster }: { cluster: Cluster }) {
  const identity = cluster.identity
  const name = cluster.displayName || identity?.name || "unknown"
  const pill = connectionPill(cluster.connection)
  const inventory = cluster.inventory
  const inventoryReal = inventory ? numbersAreReal(inventory.state) : false
  const capacity = cluster.capacity
  const cost = formatCost(cluster.cost)
  const meta = [MODE_LABELS[cluster.mode], cluster.kubernetesVersion]
    .filter(Boolean)
    .join(" · ")

  return (
    <li className="bg-card px-3.5 py-3">
      <div className="flex items-center justify-between gap-2.5">
        <Link
          href="/dashboard/map/"
          className="font-cond text-card font-semibold tracking-[0.03em] text-foreground"
        >
          {name}
        </Link>
        {pill ? <StatusPill tone={pill.tone} label={pill.label} /> : null}
      </div>
      {meta ? (
        <p className="mt-0.5 font-mono text-meta text-neutral-600">{meta}</p>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-note text-muted-foreground">
        <Stat value={cluster.applicationCount.toString()} tail="apps" />
        <Stat value={cluster.targetCount.toString()} tail="targets" />
        {inventoryReal && inventory ? (
          <>
            <Stat
              value={inventory.nodeCount.toString()}
              tail={plural(inventory.nodeCount, "node")}
            />
            <Stat
              value={inventory.podCount.toString()}
              tail={plural(inventory.podCount, "pod")}
            />
          </>
        ) : null}
        {cost ? <Stat value={cost} tail="" /> : null}
      </div>

      {!inventoryReal && inventory?.unavailableReason ? (
        <UnavailableNote className="mt-1.5" reason={inventory.unavailableReason} />
      ) : null}

      {capacity?.cpu || capacity?.memory ? (
        <div className="mt-3 flex flex-col gap-2.5 border-t border-rule-soft pt-2.5">
          {capacity.cpu ? (
            <CapacityMeter label="CPU" meter={capacity.cpu} />
          ) : null}
          {capacity.memory ? (
            <CapacityMeter label="MEMORY" meter={capacity.memory} />
          ) : null}
        </div>
      ) : null}
    </li>
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

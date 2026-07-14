import Link from "next/link"

import type {
  FleetApplicationSummary,
  FleetConnectionStatus,
  FleetFacetBucket,
  FleetHealthStatus,
} from "@/lib/fleet-client"
import type { FleetHealth, FleetRelease, FleetRollout } from "@/lib/fleet-query"
import { fleetDetailHref } from "@/lib/fleet-navigation"

export interface FleetOverviewProps {
  applications: readonly FleetApplicationSummary[]
  facets?: readonly FleetFacetBucket[]
  total: bigint
  inventoryHref?: string
  queueHref?: string
  selectedHealth?: readonly FleetHealth[]
  selectedRelease?: readonly FleetRelease[]
  selectedRollout?: readonly FleetRollout[]
  query?: string
}

const healthOrder: readonly FleetHealthStatus[] = [
  "healthy",
  "progressing",
  "degraded",
  "failed",
  "missing",
  "unknown",
]
const activeReleaseStates = new Set([
  "pending",
  "promoting",
  "canarying",
  "verifying",
  "awaiting_approval",
])
const activeRolloutStates = new Set(["pending", "progressing", "paused"])
const attentionReleaseStates = new Set(["failed", "awaiting_approval"])
const attentionRolloutStates = new Set(["paused", "degraded", "failed", "aborted"])

interface OverviewSummary {
  health: Map<string, bigint>
  activeReleases: bigint
  activeRollouts: bigint
  blockedGates: number
  repositoryFailures: number
  clusterFailures: number
  observabilityFailures: number
  attention: FleetApplicationSummary[]
}

export function FleetOverview({
  applications,
  facets = [],
  total,
  inventoryHref = "/dashboard/applications",
  queueHref = "/dashboard/applications?sort=impact&direction=desc&view=queue",
  selectedHealth = [],
  selectedRelease = [],
  selectedRollout = [],
  query = "",
}: FleetOverviewProps) {
  const summary = summarizeOverview(applications, facets, {
    health: selectedHealth,
    release: selectedRelease,
    rollout: selectedRollout,
  })

  return (
    <section aria-labelledby="fleet-overview-title" className="space-y-4">
      <div className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.18em] text-primary">
            Authorized fleet
          </p>
          <h2 id="fleet-overview-title" className="mt-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            Operations overview
          </h2>
        </div>
        <Link
          href={inventoryHref}
          className="inline-flex min-h-11 items-center justify-center border border-border bg-card px-4 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
        >
          Open application inventory
        </Link>
      </div>

      <section
        aria-labelledby="fleet-health-title"
        className="border border-border bg-card"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3 sm:px-5">
          <h3 id="fleet-health-title" className="text-sm font-semibold text-foreground">
            Fleet health posture
          </h3>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {total.toString()} applications
          </span>
        </div>
        <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 xl:grid-cols-6">
          {healthOrder.map((health) => (
            <div key={health} className="bg-background px-4 py-4">
              <span className="block text-xs capitalize text-muted-foreground">
                {healthLabel(health)}
              </span>
              <strong className="mt-1 block font-mono text-xl font-semibold tabular-nums text-foreground">
                {(summary.health.get(health) ?? BigInt(0)).toString()}
              </strong>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <section aria-labelledby="active-change-title" className="border border-border bg-card">
          <div className="border-b border-border px-4 py-3 sm:px-5">
            <p className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Change surface
            </p>
            <h3 id="active-change-title" className="mt-1 text-sm font-semibold text-foreground">
              Active delivery changes
            </h3>
          </div>
          <div className="grid grid-cols-3 gap-px bg-border">
            <OverviewCount label="Active releases" value={summary.activeReleases} />
            <OverviewCount label="Active rollouts" value={summary.activeRollouts} />
            <OverviewCount label="Blocked gates" value={BigInt(summary.blockedGates)} />
          </div>
          <p className="border-t border-border px-4 py-2 text-[0.6875rem] leading-5 text-muted-foreground sm:px-5">
            {applications.length} highest-impact applications loaded; blocked-gate count reflects this window.
          </p>
        </section>

        <section aria-labelledby="connection-failures-title" className="border border-border bg-card">
          <div className="border-b border-border px-4 py-3 sm:px-5">
            <p className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Dependency posture
            </p>
            <h3 id="connection-failures-title" className="mt-1 text-sm font-semibold text-foreground">
              Connection failures
            </h3>
          </div>
          <div className="grid grid-cols-3 gap-px bg-border">
            <OverviewCount label="Repository failures" value={BigInt(summary.repositoryFailures)} />
            <OverviewCount label="Cluster failures" value={BigInt(summary.clusterFailures)} />
            <OverviewCount label="Observability failures" value={BigInt(summary.observabilityFailures)} />
          </div>
          <p className="border-t border-border px-4 py-2 text-[0.6875rem] leading-5 text-muted-foreground sm:px-5">
            {applications.length} highest-impact applications loaded; connection counts reflect this window.{" "}
            Observability sources that are not configured are absent, not failed.
          </p>
        </section>
      </div>

      <section aria-labelledby="attention-title" className="border border-border bg-card">
        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-border px-4 py-3 sm:px-5">
          <div>
            <p className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-primary">
              Server-ranked impact
            </p>
            <h3 id="attention-title" className="mt-1 text-sm font-semibold text-foreground">
              Highest impact attention
            </h3>
          </div>
          <Link
            href={queueHref}
            className="min-h-11 content-center text-xs font-semibold text-primary hover:underline"
          >
            Open full queue
          </Link>
        </div>
        {summary.attention.length > 0 ? (
          <ol className="divide-y divide-border">
            {summary.attention.map((application, index) => {
              const identity = application.identity!
              return (
                <li key={`${identity.namespace}/${identity.name}`}>
                  <Link
                    href={fleetDetailHref("application", identity, new URLSearchParams(query))}
                    className="grid min-h-16 grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50 sm:px-5"
                  >
                    <span aria-hidden="true" className="font-mono text-sm font-semibold tabular-nums text-primary">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="min-w-0">
                      <strong className="block truncate text-sm font-semibold text-foreground">
                        {identity.name}
                      </strong>
                      <span className="mt-0.5 block truncate font-mono text-[0.6875rem] text-muted-foreground">
                        {identity.namespace}/{identity.name} · {attentionReason(application)}
                      </span>
                    </span>
                    <span className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      {application.health.replaceAll("_", " ")}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ol>
        ) : (
          <p role="status" className="px-4 py-8 text-center text-sm text-muted-foreground sm:px-5">
            No applications currently require attention.
          </p>
        )}
      </section>
    </section>
  )
}

function OverviewCount({ label, value }: { label: string; value: bigint }) {
  return (
    <div aria-label={label} className="min-w-0 bg-background px-3 py-4 sm:px-4">
      <span className="block text-[0.6875rem] leading-4 text-muted-foreground">{label}</span>
      <strong className="mt-1 block font-mono text-xl font-semibold tabular-nums text-foreground">
        {value.toString()}
      </strong>
    </div>
  )
}

function summarizeOverview(
  applications: readonly FleetApplicationSummary[],
  facets: readonly FleetFacetBucket[],
  selected: {
    health: readonly FleetHealth[]
    release: readonly FleetRelease[]
    rollout: readonly FleetRollout[]
  },
): OverviewSummary {
  const applicationHealth = new Map<string, bigint>()
  let activeReleases = BigInt(0)
  let activeRollouts = BigInt(0)
  let blockedGates = 0
  let repositoryFailures = 0
  let clusterFailures = 0
  let observabilityFailures = 0
  const attention: FleetApplicationSummary[] = []

  for (const application of applications) {
    const health = application.health === "unspecified" ? "unknown" : application.health
    applicationHealth.set(
      health,
      (applicationHealth.get(health) ?? BigInt(0)) + BigInt(1),
    )
    if (activeReleaseStates.has(application.releaseState)) activeReleases += BigInt(1)
    if (activeRolloutStates.has(application.rolloutState)) activeRollouts += BigInt(1)
    blockedGates += application.blockedGateCount
    if (connectionFailed(application.repositoryConnection)) repositoryFailures += 1
    if (application.targets.some((target) => connectionFailed(target.clusterConnection))) {
      clusterFailures += 1
    }
    if (connectionFailed(application.observabilityConnection)) observabilityFailures += 1
    if (application.identity && needsAttention(application) && attention.length < 5) {
      attention.push(application)
    }
  }

  const facetHealth = new Map<string, bigint>()
  let hasHealthFacets = false
  let hasReleaseFacets = false
  let hasRolloutFacets = false
  let facetActiveReleases = BigInt(0)
  let facetActiveRollouts = BigInt(0)
  const selectedHealth = new Set<string>(selected.health)
  const selectedRelease = new Set<string>(selected.release)
  const selectedRollout = new Set<string>(selected.rollout)
  for (const facet of facets) {
    if (facet.dimension === "health") {
      hasHealthFacets = true
      if (!facet.value || (selectedHealth.size > 0 && !selectedHealth.has(facet.value))) {
        continue
      }
      const health = facet.value === "unspecified" ? "unknown" : facet.value
      facetHealth.set(health, (facetHealth.get(health) ?? BigInt(0)) + facet.count)
    } else if (facet.dimension === "release") {
      hasReleaseFacets = true
      if (!facet.value || (selectedRelease.size > 0 && !selectedRelease.has(facet.value))) {
        continue
      }
      if (activeReleaseStates.has(facet.value)) facetActiveReleases += facet.count
    } else if (facet.dimension === "rollout") {
      hasRolloutFacets = true
      if (!facet.value || (selectedRollout.size > 0 && !selectedRollout.has(facet.value))) {
        continue
      }
      if (activeRolloutStates.has(facet.value)) facetActiveRollouts += facet.count
    }
  }

  return {
    health: hasHealthFacets ? facetHealth : applicationHealth,
    activeReleases: hasReleaseFacets ? facetActiveReleases : activeReleases,
    activeRollouts: hasRolloutFacets ? facetActiveRollouts : activeRollouts,
    blockedGates,
    repositoryFailures,
    clusterFailures,
    observabilityFailures,
    attention,
  }
}

function connectionFailed(status: FleetConnectionStatus): boolean {
  return status === "unhealthy" || status === "disabled"
}

function healthLabel(health: FleetHealthStatus): string {
  return health.charAt(0).toUpperCase() + health.slice(1).replaceAll("_", " ")
}

function needsAttention(application: FleetApplicationSummary): boolean {
  return (
    application.health === "degraded" ||
    application.health === "failed" ||
    application.health === "missing" ||
    application.sync === "out_of_sync" ||
    application.blockedGateCount > 0 ||
    attentionReleaseStates.has(application.releaseState) ||
    attentionRolloutStates.has(application.rolloutState) ||
    connectionFailed(application.repositoryConnection) ||
    connectionFailed(application.observabilityConnection) ||
    application.targets.some((target) => connectionFailed(target.clusterConnection))
  )
}

function attentionReason(application: FleetApplicationSummary): string {
  if (application.blockedGateCount > 0) return `${application.blockedGateCount} blocked gates`
  if (attentionReleaseStates.has(application.releaseState)) {
    return `release ${application.releaseState.replaceAll("_", " ")}`
  }
  if (attentionRolloutStates.has(application.rolloutState)) {
    return `rollout ${application.rolloutState.replaceAll("_", " ")}`
  }
  if (connectionFailed(application.repositoryConnection)) return "repository connection"
  if (application.targets.some((target) => connectionFailed(target.clusterConnection))) {
    return "cluster connection"
  }
  if (connectionFailed(application.observabilityConnection)) return "observability connection"
  if (application.sync === "out_of_sync") return "out of sync"
  return application.health.replaceAll("_", " ")
}

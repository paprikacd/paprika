"use client"

import Link from "next/link"
import { Clock3, Workflow } from "lucide-react"
import type { Application } from "@/gen/paprika/v1/api_pb"

import { FleetHealthHeatmap } from "@/components/fleet/fleet-health-heatmap"
import type { FleetMapResult } from "@/lib/fleet-client"
import { fleetHref, patchFleetSearchParams } from "@/lib/fleet-navigation"
import type {
  FleetDensity,
  FleetDirection,
  FleetLabelMode,
  FleetSort,
  NamespacedKey,
} from "@/lib/fleet-query"
import type { FleetDataStatus } from "@/lib/use-fleet-data"

export interface DashboardHealthMapProps {
  result?: FleetMapResult
  status?: FleetDataStatus
  fleetQuery?: string
  density?: FleetDensity
  labels?: FleetLabelMode
  sort?: FleetSort
  direction?: FleetDirection
  selected?: NamespacedKey | null
  onSelectApplication?: (identity: NamespacedKey) => void
  onFocusedApplication?: (identity: NamespacedKey | null) => void
  onRetry?: () => void
}

type ApplicationHealth = "Healthy" | "Degraded" | "Progressing" | "OutOfSync" | "Unknown"

function normalize(value: string) {
  return value.trim().toLowerCase()
}

function getHealthBucket(status: string): ApplicationHealth {
  const normalized = normalize(status)
  if (normalized.includes("degraded") || normalized.includes("failed") || normalized.includes("error")) {
    return "Degraded"
  }
  if (
    normalized.includes("progress") ||
    normalized.includes("canary") ||
    normalized.includes("running") ||
    normalized.includes("pending")
  ) {
    return "Progressing"
  }
  if (
    normalized.includes("outofsync") ||
    normalized.includes("out-of-sync") ||
    normalized.includes("out of sync")
  ) {
    return "OutOfSync"
  }
  if (
    normalized.includes("healthy") ||
    normalized.includes("succeeded") ||
    normalized.includes("complete")
  ) {
    return "Healthy"
  }
  return "Unknown"
}

export function getApplicationHealth(application: Application): ApplicationHealth {
  if (application.health) {
    const health = getHealthBucket(application.health)
    if (application.outOfSync > 0 && (health === "Healthy" || health === "Unknown")) {
      return "OutOfSync"
    }
    return health
  }
  if (application.outOfSync > 0) return "OutOfSync"
  if (application.phase) return getHealthBucket(application.phase)
  return "Unknown"
}

export function getApplicationIssue(application: Application) {
  const resourceIssue = application.resourceHealth?.find((resource) => {
    const health = getHealthBucket(resource.health)
    return health !== "Healthy" && health !== "Unknown"
  })
  if (resourceIssue?.message) return resourceIssue.message
  if (resourceIssue?.name) {
    return `${resourceIssue.kind || "Resource"} ${resourceIssue.name} is ${resourceIssue.health}`
  }

  const healthIssue = application.healthChecks?.find(
    (check) => check.status && getHealthBucket(check.status) !== "Healthy",
  )
  if (healthIssue?.message) return healthIssue.message
  if (application.outOfSync > 0) {
    return `${application.outOfSync} out-of-sync resource${application.outOfSync === 1 ? "" : "s"}`
  }
  return ""
}

export function DashboardHealthMap({
  result,
  status = result ? "ready" : "loading",
  fleetQuery = "",
  density = "auto",
  labels = "auto",
  sort = "health",
  direction = "desc",
  selected,
  onSelectApplication,
  onFocusedApplication,
  onRetry,
}: DashboardHealthMapProps) {
  const tableHref = applicationsTableHref(fleetQuery)
  const failed =
    status === "error" || status === "unavailable" || status === "unauthorized"
  const currentResult =
    status === "ready" || status === "empty" || status === "partial"
      ? result
      : undefined

  return (
    <section aria-labelledby="dashboard-health-map-title" className="p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Workflow className="size-4 text-primary" aria-hidden="true" />
            <h3 id="dashboard-health-map-title" className="text-sm font-semibold">
              Complete application health
            </h3>
          </div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Every authorized Application has equal visual weight; color and glyph show current health.
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs tabular-nums text-muted-foreground">
          <Clock3 className="size-3.5" aria-hidden="true" />
          {currentResult
            ? `${currentResult.total.toString()} applications in this complete map`
            : "Complete map unavailable"}
        </span>
      </div>

      <div className="mt-4">
        {failed ? (
          <HealthMapError tableHref={tableHref} onRetry={onRetry} />
        ) : status === "loading" || status === "stale" ? (
          <HealthMapLoading />
        ) : currentResult && currentResult.total > BigInt(0) ? (
          <FleetHealthHeatmap
            result={currentResult}
            density={density}
            labels={labels}
            sort={sort}
            direction={direction}
            selected={selected}
            onSelectApplication={onSelectApplication}
            onFocusedApplication={onFocusedApplication}
          />
        ) : currentResult?.total === BigInt(0) || status === "empty" ? (
          <HealthMapEmpty fleetQuery={fleetQuery} tableHref={tableHref} />
        ) : (
          <HealthMapError tableHref={tableHref} onRetry={onRetry} />
        )}
      </div>
    </section>
  )
}

function HealthMapLoading() {
  return (
    <div role="status" aria-label="Loading complete application health map" className="space-y-3">
      <div className="h-4 w-52 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      <div className="h-72 animate-pulse rounded bg-muted motion-reduce:animate-none" />
    </div>
  )
}

function HealthMapError({
  tableHref,
  onRetry,
}: {
  tableHref: string
  onRetry?: () => void
}) {
  return (
    <div
      role="alert"
      aria-label="Application health map unavailable"
      className="border border-destructive/40 bg-destructive/5 px-4 py-5"
    >
      <p className="text-sm font-semibold text-foreground">
        The complete fleet map could not be loaded
      </p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Search and other operational panels remain available while this view recovers.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm font-semibold">
        {onRetry ? (
          <button
            type="button"
            aria-label="Retry application health map"
            onClick={onRetry}
            className="min-h-11 text-primary hover:underline"
          >
            Retry
          </button>
        ) : null}
        <Link href={tableHref} aria-label="Open complete Table view" className="min-h-11 content-center text-primary hover:underline">
          Open complete Table
        </Link>
      </div>
    </div>
  )
}

function HealthMapEmpty({
  fleetQuery,
  tableHref,
}: {
  fleetQuery: string
  tableHref: string
}) {
  return (
    <div className="border border-border bg-card px-4 py-7 text-center">
      <p role="status" className="text-sm font-semibold text-foreground">
        No applications match this fleet scope
      </p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        The active scope is preserved. Clear it in one step or inspect the complete Table.
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-center gap-4 text-sm font-semibold">
        <Link href={clearScopeHref(fleetQuery)} aria-label="Clear fleet scope" className="min-h-11 content-center text-primary hover:underline">
          Clear fleet scope
        </Link>
        <Link href={tableHref} aria-label="Open complete Table view" className="min-h-11 content-center text-primary hover:underline">
          Open complete Table
        </Link>
      </div>
    </div>
  )
}

function applicationsTableHref(fleetQuery: string) {
  const table = patchFleetSearchParams(new URLSearchParams(fleetQuery), {
    selected: null,
    view: "table",
    zoom: "",
  })
  return fleetHref("/dashboard/applications", table)
}

function clearScopeHref(fleetQuery: string) {
  const cleared = patchFleetSearchParams(
    new URLSearchParams(fleetQuery),
    {
      projects: [],
      clusters: [],
      stages: [],
      namespaces: [],
    },
    { scopeChanged: true },
  )
  return fleetHref("/dashboard", cleared)
}

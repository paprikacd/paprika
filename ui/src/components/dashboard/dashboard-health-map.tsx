"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { ArrowUpRight, Clock3, Workflow } from "lucide-react"
import type { Application } from "@/gen/paprika/v1/api_pb"
import { mergeFleetQuery, parseFleetQuery, serializeFleetQuery } from "@/lib/fleet-query"

const PREVIEW_LIMIT = 8
const RESULTS_ID = "dashboard-health-map-results"

type HealthFilter = "All" | "Healthy" | "Degraded" | "Progressing" | "OutOfSync" | "Unknown"

interface DashboardHealthMapProps {
  applications: Application[]
  applicationTotal?: bigint
  fleetQuery?: string
  loading?: boolean
}

const healthFilters: HealthFilter[] = ["All", "Healthy", "Degraded", "Progressing", "OutOfSync", "Unknown"]

const filterLabels: Record<HealthFilter, string> = {
  All: "All",
  Healthy: "Healthy",
  Degraded: "Degraded",
  Progressing: "Progressing",
  OutOfSync: "Out of sync",
  Unknown: "Unknown",
}

const healthStyles: Record<Exclude<HealthFilter, "All">, { dot: string; tile: string; text: string; ring: string }> = {
  Healthy: {
    dot: "bg-emerald-500",
    tile: "bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25",
    text: "text-emerald-500",
    ring: "ring-emerald-500/25",
  },
  Degraded: {
    dot: "bg-rose-500",
    tile: "bg-rose-500/15 text-rose-500 hover:bg-rose-500/25",
    text: "text-rose-500",
    ring: "ring-rose-500/25",
  },
  Progressing: {
    dot: "bg-sky-500",
    tile: "bg-sky-500/15 text-sky-500 hover:bg-sky-500/25",
    text: "text-sky-500",
    ring: "ring-sky-500/25",
  },
  OutOfSync: {
    dot: "bg-amber-500",
    tile: "bg-amber-500/15 text-amber-500 hover:bg-amber-500/25",
    text: "text-amber-500",
    ring: "ring-amber-500/25",
  },
  Unknown: {
    dot: "bg-muted-foreground",
    tile: "bg-muted text-muted-foreground hover:bg-muted/80",
    text: "text-muted-foreground",
    ring: "ring-foreground/10",
  },
}

function normalize(value: string) {
  return value.trim().toLowerCase()
}

function getHealthBucket(status: string): Exclude<HealthFilter, "All"> {
  const normalized = normalize(status)
  if (normalized.includes("degraded") || normalized.includes("failed") || normalized.includes("error")) {
    return "Degraded"
  }
  if (normalized.includes("progress") || normalized.includes("canary") || normalized.includes("running") || normalized.includes("pending")) {
    return "Progressing"
  }
  if (normalized.includes("outofsync") || normalized.includes("out-of-sync") || normalized.includes("out of sync")) {
    return "OutOfSync"
  }
  if (normalized.includes("healthy") || normalized.includes("succeeded") || normalized.includes("complete")) {
    return "Healthy"
  }
  return "Unknown"
}

export function getApplicationHealth(application: Application): Exclude<HealthFilter, "All"> {
  if (application.health) {
    const health = getHealthBucket(application.health)
    if (application.outOfSync > 0 && (health === "Healthy" || health === "Unknown")) return "OutOfSync"
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
  if (resourceIssue?.name) return `${resourceIssue.kind || "Resource"} ${resourceIssue.name} is ${resourceIssue.health}`

  const healthIssue = application.healthChecks?.find((check) => check.status && getHealthBucket(check.status) !== "Healthy")
  if (healthIssue?.message) return healthIssue.message
  if (application.outOfSync > 0) {
    return `${application.outOfSync} out-of-sync resource${application.outOfSync === 1 ? "" : "s"}`
  }
  return ""
}

function applicationHref(application: Pick<Application, "namespace" | "name">) {
  return `/dashboard/application?namespace=${encodeURIComponent(application.namespace)}&name=${encodeURIComponent(application.name)}`
}

function statusCount(applications: Application[], filter: HealthFilter) {
  if (filter === "All") return applications.length
  return applications.filter((application) => getApplicationHealth(application) === filter).length
}

function applicationsTreemapHref(fleetQuery: string) {
  const current = parseFleetQuery(fleetQuery).state
  const treemap = mergeFleetQuery(current, {
    selected: null,
    view: "treemap",
    zoom: "",
  })
  const parameters = serializeFleetQuery(treemap)
  parameters.set("view", "treemap")
  return `/dashboard/applications?${parameters.toString()}`
}

function HealthMapTile({ application }: { application: Application }) {
  const health = getApplicationHealth(application)
  const issue = getApplicationIssue(application)
  const style = healthStyles[health]
  const resourceCount = application.resourceHealth?.length || application.resources?.length || 0

  return (
    <Link
      href={applicationHref(application)}
      aria-label={`${application.name} ${health} in ${application.namespace}`}
      className={`group flex min-h-24 flex-col justify-between rounded-lg p-3 ring-1 transition-all hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${style.tile} ${style.ring}`}
    >
      <span>
        <span className="flex items-start justify-between gap-2">
          <span className="min-w-0">
            <span className="block truncate font-mono text-sm font-semibold text-foreground">{application.name}</span>
            <span className="mt-0.5 block text-[11px] text-muted-foreground">ns/{application.namespace}</span>
          </span>
          <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${style.dot}`} />
        </span>
        {issue && <span className="mt-2 line-clamp-2 block text-xs text-foreground/75">{issue}</span>}
      </span>
      <span className="mt-3 flex items-center justify-between gap-2 text-[11px]">
        <span className={`font-medium ${style.text}`}>{health}</span>
        <span className="text-muted-foreground">
          {application.currentStage || application.phase || "stage unknown"}
          {resourceCount > 0 && ` / ${resourceCount} resources`}
        </span>
      </span>
    </Link>
  )
}

export function DashboardHealthMap({
  applications,
  applicationTotal,
  fleetQuery = "",
  loading = false,
}: DashboardHealthMapProps) {
  const [healthFilter, setHealthFilter] = useState<HealthFilter>("All")
  const [expanded, setExpanded] = useState(false)
  const filteredApplications = useMemo(
    () => healthFilter === "All"
      ? applications
      : applications.filter((application) => getApplicationHealth(application) === healthFilter),
    [applications, healthFilter],
  )
  const visibleApplications = expanded
    ? filteredApplications
    : filteredApplications.slice(0, PREVIEW_LIMIT)
  const canExpand = filteredApplications.length > PREVIEW_LIMIT

  function changeFilter(filter: HealthFilter) {
    setExpanded(false)
    setHealthFilter(filter)
  }

  return (
    <div className="p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Workflow className="size-4 text-primary" aria-hidden="true" />
            <h3 className="text-sm font-semibold">Application health map</h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Filter by status, then open an app tile for the full debug view.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground tabular-nums">
          <Clock3 className="size-3.5" aria-hidden="true" />
          {applicationTotal === undefined
            ? `${applications.length} apps loaded`
            : `${applications.length}/${applicationTotal.toString()} apps loaded`}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {healthFilters.map((filter) => {
          const selected = filter === healthFilter
          return (
            <button
              key={filter}
              type="button"
              aria-label={`Show ${filterLabels[filter]} applications`}
              aria-pressed={selected}
              onClick={() => changeFilter(filter)}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
                selected
                  ? "bg-foreground text-background"
                  : "bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground"
              }`}
            >
              {filter !== "All" && <span aria-hidden="true" className={`size-2 rounded-full ${healthStyles[filter].dot}`} />}
              {filterLabels[filter]}
              <span className="tabular-nums opacity-75">{statusCount(applications, filter)}</span>
            </button>
          )
        })}
      </div>

      <div className="mt-5">
        {loading ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((item) => (
              <div key={item} className="h-24 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : visibleApplications.length > 0 ? (
          <ul
            id={RESULTS_ID}
            role="list"
            aria-label="Application health map results"
            className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3"
          >
            {visibleApplications.map((application) => (
              <li key={`${application.namespace}/${application.name}`}>
                <HealthMapTile application={application} />
              </li>
            ))}
          </ul>
        ) : (
          <div id={RESULTS_ID} className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
            <p className="text-sm font-medium">No applications in this view</p>
            <p className="mt-1 text-xs text-muted-foreground">Change the health filter to inspect another status.</p>
          </div>
        )}
      </div>

      {!loading && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-4 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {visibleApplications.length} of {filteredApplications.length} loaded
            {applicationTotal !== undefined && ` · ${applicationTotal.toString()} indexed`}
          </span>
          <span className="flex flex-wrap items-center gap-3">
            {canExpand && (
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={RESULTS_ID}
                onClick={() => setExpanded((current) => !current)}
                className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                {expanded ? "Show compact preview" : `Show all ${filteredApplications.length} loaded applications`}
              </button>
            )}
            <Link
              href={applicationsTreemapHref(fleetQuery)}
              aria-label="View all applications as treemap"
              className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              View all as treemap
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          </span>
        </div>
      )}
    </div>
  )
}

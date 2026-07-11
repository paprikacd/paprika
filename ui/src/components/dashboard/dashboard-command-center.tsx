"use client"

import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react"
import Link from "next/link"
import type {
  Application,
  ApplicationSet,
  Pipeline,
  Policy,
  Release,
  Rollout,
} from "@/gen/paprika/v1/api_pb"
import {
  AlertCircle,
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  CircleDot,
  Clock3,
  GitBranch,
  History,
  Layers,
  Search,
  Shield,
  Workflow,
} from "lucide-react"

const RECENT_SEARCHES_KEY = "paprika-dashboard-recent-searches"
const MAX_RECENT_SEARCHES = 5
const MAX_SEARCH_RESULTS = 8

type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean }>

type SearchKind = "Application" | "Pipeline" | "Release" | "Rollout" | "Application Set" | "Policy"
type HealthFilter = "All" | "Healthy" | "Degraded" | "Progressing" | "OutOfSync" | "Unknown"

interface DashboardCommandCenterProps {
  applications: Application[]
  applicationTotal?: bigint
  pipelines: Pipeline[]
  releases: Release[]
  rollouts: Rollout[]
  applicationSets: ApplicationSet[]
  policies: Policy[]
  loading?: boolean
}

interface SearchItem {
  id: string
  kind: SearchKind
  name: string
  namespace?: string
  status?: string
  detail: string
  href: string
  tokens: string
  Icon: IconComponent
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

function appHref(application: Pick<Application, "namespace" | "name">) {
  return `/dashboard/application?namespace=${encodeURIComponent(application.namespace)}&name=${encodeURIComponent(application.name)}`
}

function namespacedDetailHref(base: string, item: { namespace?: string; name: string }) {
  if (!item.namespace) return base
  return `${base}?namespace=${encodeURIComponent(item.namespace)}&name=${encodeURIComponent(item.name)}`
}

function compactParts(parts: Array<string | number | boolean | undefined | null>) {
  return parts
    .filter((part) => part !== undefined && part !== null && part !== "" && part !== false)
    .map(String)
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

function getApplicationHealth(application: Application): Exclude<HealthFilter, "All"> {
  if (application.health) {
    const health = getHealthBucket(application.health)
    if (application.outOfSync > 0 && (health === "Healthy" || health === "Unknown")) return "OutOfSync"
    return health
  }
  if (application.outOfSync > 0) return "OutOfSync"
  if (application.phase) return getHealthBucket(application.phase)
  return "Unknown"
}

function getApplicationIssue(application: Application) {
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

function buildSearchItems({
  applications,
  pipelines,
  releases,
  rollouts,
  applicationSets,
  policies,
}: Omit<DashboardCommandCenterProps, "loading">): SearchItem[] {
  const items: SearchItem[] = []

  for (const application of applications) {
    const health = getApplicationHealth(application)
    const issue = getApplicationIssue(application)
    const tokenParts = compactParts([
      "application",
      application.name,
      application.namespace,
      application.phase,
      health,
      application.currentStage,
      application.pipelineRef,
      application.releaseRef,
      application.project,
      application.strategy,
      application.sourceRevision,
      issue,
    ])

    items.push({
      id: `application:${application.namespace}/${application.name}`,
      kind: "Application",
      name: application.name,
      namespace: application.namespace,
      status: health,
      detail: compactParts([
        `ns/${application.namespace}`,
        application.phase,
        application.currentStage && `stage ${application.currentStage}`,
        issue,
      ]).join(" - "),
      href: appHref(application),
      tokens: tokenParts.join(" ").toLowerCase(),
      Icon: Workflow,
    })
  }

  for (const pipeline of pipelines) {
    const stepCount = pipeline.steps?.length ?? 0
    items.push({
      id: `pipeline:${pipeline.namespace}/${pipeline.name}`,
      kind: "Pipeline",
      name: pipeline.name,
      namespace: pipeline.namespace,
      status: pipeline.phase,
      detail: compactParts([`ns/${pipeline.namespace}`, pipeline.phase, stepCount && `${stepCount} steps`]).join(" - "),
      href: namespacedDetailHref("/dashboard/pipelines/detail", pipeline),
      tokens: compactParts(["pipeline", pipeline.name, pipeline.namespace, pipeline.phase, stepCount]).join(" ").toLowerCase(),
      Icon: GitBranch,
    })
  }

  for (const release of releases) {
    const applicationHref = release.application
      ? `/dashboard/application?namespace=${encodeURIComponent(release.namespace)}&name=${encodeURIComponent(release.application)}`
      : "#releases"
    items.push({
      id: `release:${release.namespace}/${release.name}`,
      kind: "Release",
      name: release.name,
      namespace: release.namespace,
      status: release.phase,
      detail: compactParts([
        `ns/${release.namespace}`,
        release.phase,
        release.currentStage && `stage ${release.currentStage}`,
        release.application && `app ${release.application}`,
        release.target,
      ]).join(" - "),
      href: applicationHref,
      tokens: compactParts([
        "release",
        release.name,
        release.namespace,
        release.phase,
        release.currentStage,
        release.application,
        release.pipeline,
        release.target,
      ]).join(" ").toLowerCase(),
      Icon: Layers,
    })
  }

  for (const rollout of rollouts) {
    items.push({
      id: `rollout:${rollout.namespace}/${rollout.name}`,
      kind: "Rollout",
      name: rollout.name,
      namespace: rollout.namespace,
      status: rollout.phase,
      detail: compactParts([
        `ns/${rollout.namespace}`,
        rollout.phase,
        rollout.strategyType,
        rollout.currentWeight > 0 && `${rollout.currentWeight}% traffic`,
        rollout.message,
      ]).join(" - "),
      href: namespacedDetailHref("/dashboard/rollouts/detail", rollout),
      tokens: compactParts([
        "rollout",
        rollout.name,
        rollout.namespace,
        rollout.phase,
        rollout.strategyType,
        rollout.targetKind,
        rollout.targetName,
        rollout.message,
      ]).join(" ").toLowerCase(),
      Icon: Boxes,
    })
  }

  for (const applicationSet of applicationSets) {
    items.push({
      id: `applicationset:${applicationSet.namespace}/${applicationSet.name}`,
      kind: "Application Set",
      name: applicationSet.name,
      namespace: applicationSet.namespace,
      status: applicationSet.phase,
      detail: compactParts([
        `ns/${applicationSet.namespace}`,
        applicationSet.phase,
        `${applicationSet.applications} app${applicationSet.applications === 1 ? "" : "s"}`,
      ]).join(" - "),
      href: namespacedDetailHref("/dashboard/applicationsets/detail", applicationSet),
      tokens: compactParts([
        "application set",
        "applicationset",
        applicationSet.name,
        applicationSet.namespace,
        applicationSet.phase,
        applicationSet.applications,
      ]).join(" ").toLowerCase(),
      Icon: CircleDot,
    })
  }

  for (const policy of policies) {
    items.push({
      id: `policy:${policy.name}`,
      kind: "Policy",
      name: policy.name,
      status: policy.severity,
      detail: compactParts([policy.severity, policy.defaultAction, policy.description]).join(" - "),
      href: "#policies",
      tokens: compactParts(["policy", policy.name, policy.severity, policy.defaultAction, policy.description]).join(" ").toLowerCase(),
      Icon: Shield,
    })
  }

  return items
}

function getRecentSearches() {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === "string").slice(0, MAX_RECENT_SEARCHES)
  } catch {
    return []
  }
}

function getStatusCount(applications: Application[], filter: HealthFilter) {
  if (filter === "All") return applications.length
  return applications.filter((application) => getApplicationHealth(application) === filter).length
}

function SearchResult({ item, onSelect }: { item: SearchItem; onSelect: () => void }) {
  const Icon = item.Icon
  return (
    <li>
      <Link
        href={item.href}
        onClick={onSelect}
        aria-label={`${item.kind} ${item.name}${item.status ? ` ${item.status}` : ""}`}
        className="group flex min-h-14 items-center gap-3 rounded-lg px-3 py-2 ring-1 ring-transparent transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background ring-1 ring-foreground/10">
          <Icon className="size-4 text-primary" aria-hidden={true} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {item.kind}
            </span>
            <span className="truncate font-mono text-sm font-medium">{item.name}</span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{item.detail || "No status yet"}</span>
        </span>
        <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true" />
      </Link>
    </li>
  )
}

function HeatmapTile({ application }: { application: Application }) {
  const health = getApplicationHealth(application)
  const issue = getApplicationIssue(application)
  const style = healthStyles[health]
  const resourceCount = application.resourceHealth?.length || application.resources?.length || 0

  return (
    <Link
      href={appHref(application)}
      aria-label={`${application.name} ${health} in ${application.namespace}`}
      className={`group flex min-h-24 flex-col justify-between rounded-lg p-3 ring-1 transition-all hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${style.tile} ${style.ring}`}
    >
      <span>
        <span className="flex items-start justify-between gap-2">
          <span className="min-w-0">
            <span className="block truncate font-mono text-sm font-semibold text-foreground">{application.name}</span>
            <span className="mt-0.5 block text-[11px] text-muted-foreground">ns/{application.namespace}</span>
          </span>
          <span className={`size-2.5 shrink-0 rounded-full ${style.dot}`} />
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

export function DashboardCommandCenter({
  applications,
  applicationTotal,
  pipelines,
  releases,
  rollouts,
  applicationSets,
  policies,
  loading = false,
}: DashboardCommandCenterProps) {
  const [query, setQuery] = useState("")
  const [recentSearches, setRecentSearches] = useState<string[]>([])
  const [healthFilter, setHealthFilter] = useState<HealthFilter>("All")

  useEffect(() => {
    queueMicrotask(() => {
      const stored = getRecentSearches()
      if (stored.length > 0) {
        setRecentSearches(stored)
      }
    })
  }, [])

  const searchItems = useMemo(
    () => buildSearchItems({ applications, pipelines, releases, rollouts, applicationSets, policies }),
    [applications, pipelines, releases, rollouts, applicationSets, policies],
  )

  const normalizedQuery = normalize(query)
  const searchResults = useMemo(() => {
    if (!normalizedQuery) return []
    const terms = normalizedQuery.split(/\s+/).filter(Boolean)
    return searchItems
      .filter((item) => terms.every((term) => item.tokens.includes(term)))
      .sort((a, b) => {
        const aStarts = normalize(a.name).startsWith(normalizedQuery) ? 0 : 1
        const bStarts = normalize(b.name).startsWith(normalizedQuery) ? 0 : 1
        return aStarts - bStarts || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
      })
      .slice(0, MAX_SEARCH_RESULTS)
  }, [normalizedQuery, searchItems])

  const filteredApplications = useMemo(() => {
    if (healthFilter === "All") return applications
    return applications.filter((application) => getApplicationHealth(application) === healthFilter)
  }, [applications, healthFilter])

  const applicationsByNamespace = useMemo(() => {
    const grouped = new Map<string, Application[]>()
    for (const application of filteredApplications) {
      const namespace = application.namespace || "default"
      const current = grouped.get(namespace) ?? []
      current.push(application)
      grouped.set(namespace, current)
    }
    return Array.from(grouped.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([namespace, apps]) => [
        namespace,
        apps.sort((a, b) => getApplicationHealth(a).localeCompare(getApplicationHealth(b)) || a.name.localeCompare(b.name)),
      ] as const)
  }, [filteredApplications])

  const saveSearch = useCallback((value: string) => {
    const cleaned = value.trim()
    if (!cleaned) return
    setRecentSearches((previous) => {
      const next = [cleaned, ...previous.filter((item) => item.toLowerCase() !== cleaned.toLowerCase())].slice(
        0,
        MAX_RECENT_SEARCHES,
      )
      localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const unhealthyCount = applications.filter((application) => getApplicationHealth(application) !== "Healthy").length
  const healthyCount = applications.length - unhealthyCount

  return (
    <section
      aria-labelledby="dashboard-command-center-title"
      className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/10"
    >
      <div className="border-b border-border/70 px-5 py-4 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15">
                <Search className="size-4" aria-hidden="true" />
              </span>
                <h2 id="dashboard-command-center-title" className="text-xl font-semibold tracking-tight">
                  Cluster command center
                </h2>
            </div>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Search applications, releases, rollouts, pipelines, and policies from one control surface, then drill into app health.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-1 text-emerald-500 ring-1 ring-emerald-500/20">
              <CheckCircle2 className="size-3.5" aria-hidden="true" />
              {healthyCount} healthy
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 ring-1 ring-foreground/10">
              <AlertCircle className="size-3.5" aria-hidden="true" />
              {unhealthyCount} needs attention
            </span>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
        <div className="p-5 sm:p-6 lg:border-r lg:border-border/70">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              aria-label="Search operations"
              role="searchbox"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search apps, releases, rollouts, pipelines, policies..."
              className="h-14 w-full rounded-xl border border-border bg-background pl-10 pr-4 font-mono text-base outline-none transition-[border-color,box-shadow] placeholder:font-sans placeholder:text-muted-foreground focus:border-primary/60 focus:ring-4 focus:ring-primary/10"
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <History className="size-3.5" aria-hidden="true" />
              Latest searches
            </span>
            {recentSearches.length === 0 ? (
              <span className="text-xs text-muted-foreground/70">No recent searches</span>
            ) : (
              recentSearches.map((recent) => (
                <button
                  key={recent}
                  type="button"
                  aria-label={`Recent search ${recent}`}
                  onClick={() => setQuery(recent)}
                  className="rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  {recent}
                </button>
              ))
            )}
          </div>

          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Search results</h3>
              <span className="text-xs text-muted-foreground tabular-nums">
                {loading ? "Loading" : `${searchResults.length}/${searchItems.length}`}
              </span>
            </div>
            {loading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((item) => (
                  <div key={item} className="h-14 rounded-lg bg-muted animate-pulse" />
                ))}
              </div>
            ) : !normalizedQuery ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
                <p className="text-sm font-medium">Start with a name, namespace, or status</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Results can open app drilldowns, rollout detail, pipeline detail, and policy anchors.
                </p>
              </div>
            ) : searchResults.length > 0 ? (
              <ul role="list" aria-label="Search results" className="space-y-1.5">
                {searchResults.map((item) => (
                  <SearchResult key={item.id} item={item} onSelect={() => saveSearch(query)} />
                ))}
              </ul>
            ) : (
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
                <p className="text-sm font-medium">No matches</p>
                <p className="mt-1 text-xs text-muted-foreground">Try an app name, namespace, phase, rollout, or policy.</p>
              </div>
            )}
          </div>
        </div>

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
                ? `${applications.length} apps`
                : `${applications.length}/${applicationTotal.toString()} apps loaded`}
            </span>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {healthFilters.map((filter) => {
              const selected = filter === healthFilter
              const count = getStatusCount(applications, filter)
              return (
                <button
                  key={filter}
                  type="button"
                  aria-label={`Show ${filterLabels[filter]} applications`}
                  onClick={() => setHealthFilter(filter)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
                    selected
                      ? "bg-foreground text-background"
                      : "bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                  }`}
                >
                  {filter !== "All" && <span className={`size-2 rounded-full ${healthStyles[filter].dot}`} />}
                  {filterLabels[filter]}
                  <span className="tabular-nums opacity-75">{count}</span>
                </button>
              )
            })}
          </div>

          <div className="mt-5 space-y-4">
            {loading ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {[0, 1, 2, 3, 4, 5].map((item) => (
                  <div key={item} className="h-24 rounded-lg bg-muted animate-pulse" />
                ))}
              </div>
            ) : applicationsByNamespace.length > 0 ? (
              applicationsByNamespace.map(([namespace, apps]) => (
                <div key={namespace}>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="font-mono text-xs font-semibold text-foreground">{namespace}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {apps.length} app{apps.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {apps.map((application) => (
                      <HeatmapTile key={`${application.namespace}/${application.name}`} application={application} />
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
                <p className="text-sm font-medium">No applications in this view</p>
                <p className="mt-1 text-xs text-muted-foreground">Change the health filter to inspect another status.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

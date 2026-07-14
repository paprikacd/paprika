"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react"
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
  GitBranch,
  History,
  Layers,
  Search,
  Shield,
  Workflow,
} from "lucide-react"
import { fleetDetailHref, fleetHref, patchFleetSearchParams } from "@/lib/fleet-navigation"
import {
  DashboardHealthMap,
  getApplicationHealth,
  getApplicationIssue,
} from "@/components/dashboard/dashboard-health-map"
import type { FleetHealthStatus, FleetMapNode, FleetMapResult } from "@/lib/fleet-client"
import type {
  FleetDensity,
  FleetDirection,
  FleetLabelMode,
  FleetSort,
  NamespacedKey,
} from "@/lib/fleet-query"
import type { FleetDataStatus } from "@/lib/use-fleet-data"

const RECENT_SEARCHES_KEY = "paprika-dashboard-recent-searches"
const MAX_RECENT_SEARCHES = 5
const MAX_SEARCH_RESULTS = 8

type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean }>

type SearchKind = "Application" | "Pipeline" | "Release" | "Rollout" | "Application Set" | "Policy"

interface DashboardCommandCenterProps {
  applications: Application[]
  fleetMap?: FleetMapResult
  fleetMapStatus?: FleetDataStatus
  fleetDensity?: FleetDensity
  fleetLabels?: FleetLabelMode
  fleetSort?: FleetSort
  fleetDirection?: FleetDirection
  selectedApplication?: NamespacedKey | null
  onSelectApplication?: (identity: NamespacedKey) => void
  onFocusedApplication?: (identity: NamespacedKey | null) => void
  onRetryFleetMap?: () => void
  pipelines: Pipeline[]
  releases: Release[]
  rollouts: Rollout[]
  applicationSets: ApplicationSet[]
  policies: Policy[]
  loading?: boolean
  searchReleases?: (query: string, signal: AbortSignal) => Promise<Release[]>
  releaseQuery?: string
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

function releaseResultHref(releaseQuery: string, release: Pick<Release, "name" | "namespace">) {
  const current = new URLSearchParams(releaseQuery)
  const namespaces = release.namespace
    ? [...new Set([...current.getAll("namespace"), release.namespace])]
    : [...new Set(current.getAll("namespace"))]
  return fleetHref(
    "/dashboard/releases",
    patchFleetSearchParams(current, { namespaces, q: release.name }, { scopeChanged: true }),
  )
}

function compactParts(parts: Array<string | number | boolean | undefined | null>) {
  return parts
    .filter((part) => part !== undefined && part !== null && part !== "" && part !== false)
    .map(String)
}

function normalize(value: string) {
  return value.trim().toLowerCase()
}

function buildSearchItems({
  applications,
  pipelines,
  releases,
  rollouts,
  applicationSets,
  policies,
  releaseQuery = "",
}: Omit<DashboardCommandCenterProps, "loading" | "searchReleases">): SearchItem[] {
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
      href: fleetDetailHref("application", application, new URLSearchParams(releaseQuery)),
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
      href: pipeline.namespace
        ? fleetDetailHref("pipeline", pipeline, new URLSearchParams(releaseQuery))
        : fleetHref("/dashboard/pipelines/detail", new URLSearchParams(releaseQuery)),
      tokens: compactParts(["pipeline", pipeline.name, pipeline.namespace, pipeline.phase, stepCount]).join(" ").toLowerCase(),
      Icon: GitBranch,
    })
  }

  for (const release of releases) {
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
      href: releaseResultHref(releaseQuery, release),
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
      href: rollout.namespace
        ? fleetDetailHref("rollout", rollout, new URLSearchParams(releaseQuery))
        : fleetHref("/dashboard/rollouts/detail", new URLSearchParams(releaseQuery)),
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
      href: applicationSet.namespace
        ? fleetDetailHref("applicationset", applicationSet, new URLSearchParams(releaseQuery))
        : fleetHref("/dashboard/applicationsets/detail", new URLSearchParams(releaseQuery)),
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

function SearchResult({ item, onSelect }: { item: SearchItem; onSelect: () => void }) {
  const Icon = item.Icon
  return (
    <li>
      <Link
        href={item.href}
        onClick={onSelect}
        aria-label={`${item.kind} ${item.name}${item.status ? ` ${item.status}` : ""}`}
        className="group flex min-h-14 items-center gap-3 rounded-lg px-3 py-2 ring-1 ring-transparent transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

export function DashboardCommandCenter({
  applications,
  fleetMap,
  fleetMapStatus = fleetMap ? "ready" : "loading",
  fleetDensity = "auto",
  fleetLabels = "auto",
  fleetSort = "health",
  fleetDirection = "desc",
  selectedApplication,
  onSelectApplication,
  onFocusedApplication,
  onRetryFleetMap,
  pipelines,
  releases,
  rollouts,
  applicationSets,
  policies,
  loading = false,
  searchReleases,
  releaseQuery = "",
}: DashboardCommandCenterProps) {
  const [query, setQuery] = useState("")
  const [recentSearches, setRecentSearches] = useState<string[]>([])
  const releaseSearchContext = useMemo(
    () => ({ releaseQuery, searchReleases }),
    [releaseQuery, searchReleases],
  )
  const [remoteReleaseResult, setRemoteReleaseResult] = useState<{
    context: typeof releaseSearchContext | null
    query: string
    releases: Release[]
    failed: boolean
  }>({ context: null, query: "", releases: [], failed: false })
  const releaseRequestGeneration = useRef(0)

  useEffect(() => {
    queueMicrotask(() => {
      const stored = getRecentSearches()
      if (stored.length > 0) {
        setRecentSearches(stored)
      }
    })
  }, [])

  const normalizedQuery = normalize(query)
  const trimmedQuery = query.trim()
  const updateQuery = useCallback(
    (value: string) => {
      if (value.trim() !== trimmedQuery) {
        setRemoteReleaseResult({ context: null, query: "", releases: [], failed: false })
      }
      setQuery(value)
    },
    [trimmedQuery],
  )

  useEffect(() => {
    const generation = ++releaseRequestGeneration.current
    if (!searchReleases || !trimmedQuery) return

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void searchReleases(trimmedQuery, controller.signal).then(
        (nextReleases) => {
          if (controller.signal.aborted || releaseRequestGeneration.current !== generation) return
          setRemoteReleaseResult({
            context: releaseSearchContext,
            query: trimmedQuery,
            releases: nextReleases,
            failed: false,
          })
        },
        () => {
          if (controller.signal.aborted || releaseRequestGeneration.current !== generation) return
          setRemoteReleaseResult({
            context: releaseSearchContext,
            query: trimmedQuery,
            releases: [],
            failed: true,
          })
        },
      )
    }, 250)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [releaseSearchContext, searchReleases, trimmedQuery])

  const visibleRemoteReleases = useMemo(
    () =>
      remoteReleaseResult.context === releaseSearchContext &&
      remoteReleaseResult.query === trimmedQuery &&
      !remoteReleaseResult.failed
        ? remoteReleaseResult.releases
        : [],
    [releaseSearchContext, remoteReleaseResult, trimmedQuery],
  )
  const visibleReleaseSearchState =
    !searchReleases || !trimmedQuery
      ? "idle"
      : remoteReleaseResult.context !== releaseSearchContext ||
          remoteReleaseResult.query !== trimmedQuery
        ? "searching"
        : remoteReleaseResult.failed
          ? "error"
          : "idle"
  const mergedReleases = useMemo(() => {
    const byIdentity = new Map<string, Release>()
    for (const release of releases) {
      byIdentity.set(`${release.namespace}/${release.name}`, release)
    }
    for (const release of visibleRemoteReleases) {
      byIdentity.set(`${release.namespace}/${release.name}`, release)
    }
    return Array.from(byIdentity.values())
  }, [releases, visibleRemoteReleases])
  const searchItems = useMemo(
    () =>
      buildSearchItems({
        applications,
        pipelines,
        releases: mergedReleases,
        rollouts,
        applicationSets,
        policies,
        releaseQuery,
      }),
    [applications, pipelines, mergedReleases, rollouts, applicationSets, policies, releaseQuery],
  )

  const searchResults = useMemo(() => {
    if (!normalizedQuery) return []
    const terms = normalizedQuery.split(/\s+/).filter(Boolean)
    return searchItems
      .filter((item) => terms.every((term) => item.tokens.includes(term)))
      .sort((a, b) => {
        const aName = normalize(a.name)
        const bName = normalize(b.name)
        const aRank = aName === normalizedQuery ? 0 : aName.startsWith(normalizedQuery) ? 1 : 2
        const bRank = bName === normalizedQuery ? 0 : bName.startsWith(normalizedQuery) ? 1 : 2
        return aRank - bRank || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
      })
      .slice(0, MAX_SEARCH_RESULTS)
  }, [normalizedQuery, searchItems])

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

  const completeHealth = useMemo(() => completeHealthCounts(fleetMap), [fleetMap])

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
              {completeHealth ? completeHealth.healthy.toString() : "—"} healthy
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 ring-1 ring-foreground/10">
              <AlertCircle className="size-3.5" aria-hidden="true" />
              {completeHealth ? completeHealth.needsAttention.toString() : "—"} needs attention
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
              onChange={(event) => updateQuery(event.target.value)}
              placeholder="Search apps, releases, rollouts, pipelines, policies..."
              className="h-14 w-full rounded-xl border border-border bg-background pl-10 pr-4 font-mono text-base outline-none transition-[border-color,box-shadow] placeholder:font-sans placeholder:text-muted-foreground focus:border-ring focus:ring-4 focus:ring-ring"
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
                  onClick={() => updateQuery(recent)}
                  className="rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {recent}
                </button>
              ))
            )}
          </div>

          {visibleReleaseSearchState !== "idle" ? (
            <p role="status" aria-live="polite" className="mt-3 text-xs text-muted-foreground">
              {visibleReleaseSearchState === "searching"
                ? "Searching releases…"
                : "Release search unavailable"}
            </p>
          ) : null}

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

        <DashboardHealthMap
          result={fleetMap}
          status={fleetMapStatus}
          fleetQuery={releaseQuery}
          density={fleetDensity}
          labels={fleetLabels}
          sort={fleetSort}
          direction={fleetDirection}
          selected={selectedApplication}
          onSelectApplication={onSelectApplication}
          onFocusedApplication={onFocusedApplication}
          onRetry={onRetryFleetMap}
        />
      </div>
    </section>
  )
}

function completeHealthCounts(result: FleetMapResult | undefined): {
  healthy: bigint
  needsAttention: bigint
} | null {
  if (!result) return null
  let healthy = BigInt(0)
  let needsAttention = BigInt(0)
  let leaves = BigInt(0)

  const visit = (nodes: readonly FleetMapNode[]) => {
    for (const node of nodes) {
      if (node.kind === "application") {
        const health = strongestPositiveHealth(node)
        if (health === "healthy") healthy += BigInt(1)
        else needsAttention += BigInt(1)
        leaves += BigInt(1)
      }
      if (node.children.length > 0) visit(node.children)
    }
  }
  visit(result.roots)
  return leaves === result.total ? { healthy, needsAttention } : null
}

const healthSeverity: readonly FleetHealthStatus[] = [
  "failed",
  "degraded",
  "progressing",
  "missing",
  "unknown",
  "healthy",
  "unspecified",
]

function strongestPositiveHealth(node: FleetMapNode): FleetHealthStatus {
  for (const health of healthSeverity) {
    if (node.health.some((bucket) => bucket.health === health && bucket.count > BigInt(0))) {
      return health
    }
  }
  return "unknown"
}

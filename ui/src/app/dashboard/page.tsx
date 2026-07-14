"use client"

import { useSearchParams } from "next/navigation"
import { fleetDetailHref, fleetHref, patchFleetSearchParams } from "@/lib/fleet-navigation"
import {
  useState,
  memo,
  Component,
  Suspense,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react"
import Link from "next/link"
import { motion } from "framer-motion"
import { createPromiseClient } from "@connectrpc/connect"
import { createTransport } from "@/lib/transport"
import { PaprikaService } from "@/gen/paprika/v1/api_connect"
import {
  Application,
  FleetFilter,
  FleetGroupDimension,
  FleetHealth as FleetHealthProto,
  FleetObjectKey,
  FleetReleaseState as FleetReleaseStateProto,
  FleetRolloutState as FleetRolloutStateProto,
  FleetSourceType as FleetSourceTypeProto,
  FleetSizeMetric,
  FleetSyncState as FleetSyncStateProto,
} from "@/gen/paprika/v1/api_pb"
import type { Pipeline } from "@/gen/paprika/v1/api_pb"
import type { Release } from "@/gen/paprika/v1/api_pb"
import type { Rollout } from "@/gen/paprika/v1/api_pb"
import type { ApplicationSet } from "@/gen/paprika/v1/api_pb"
import type { Policy } from "@/gen/paprika/v1/api_pb"
import { PipelineCard } from "@/components/dashboard/pipeline-card"
import { DashboardCommandCenter } from "@/components/dashboard/dashboard-command-center"
import { FleetOverview } from "@/components/fleet/fleet-overview"
import { StatusBadge } from "@/components/ui/status-badge"
import { useConnection } from "@/lib/connection-context"
import { useFleetRefresh, useSingleFlightRefresh } from "@/lib/fleet-refresh"
import {
  mergeFleetQuery,
  type FleetQueryState,
} from "@/lib/fleet-query"
import { useFleetScope, type FleetScope } from "@/lib/fleet-scope-context"
import {
  buildRolloutApplicationAssociations,
  flattenMapApplicationAssociations,
  mergeScopedPipelines,
  planPipelineScopeRequests,
  rolloutMatchesFleetScope,
} from "@/lib/fleet-resource-scope"
import { overviewHeatmapState, useFleetData } from "@/lib/use-fleet-data"
import type { FleetApplicationSummary } from "@/lib/fleet-client"
import { ToastStack } from "@/components/notifications/toast-stack"
import {
  GitBranch,
  ListChecks,
  Layers,
  Activity,
  Rocket,
  AlertTriangle,
  Shield,
  FolderTree,
  ArrowUpRight,
} from "lucide-react"

const transport = createTransport()
const client = createPromiseClient(PaprikaService, transport)
const EMPTY_RELEASES: Release[] = []

const healthValues = {
  healthy: FleetHealthProto.HEALTHY,
  progressing: FleetHealthProto.PROGRESSING,
  degraded: FleetHealthProto.DEGRADED,
  failed: FleetHealthProto.FAILED,
  unknown: FleetHealthProto.UNKNOWN,
  missing: FleetHealthProto.MISSING,
} satisfies Record<FleetQueryState["health"][number], FleetHealthProto>

const syncValues = {
  synced: FleetSyncStateProto.SYNCED,
  out_of_sync: FleetSyncStateProto.OUT_OF_SYNC,
  unknown: FleetSyncStateProto.UNKNOWN,
} satisfies Record<FleetQueryState["sync"][number], FleetSyncStateProto>

const releaseValues = {
  pending: FleetReleaseStateProto.PENDING,
  promoting: FleetReleaseStateProto.PROMOTING,
  canarying: FleetReleaseStateProto.CANARYING,
  verifying: FleetReleaseStateProto.VERIFYING,
  complete: FleetReleaseStateProto.COMPLETE,
  failed: FleetReleaseStateProto.FAILED,
  rolled_back: FleetReleaseStateProto.ROLLED_BACK,
  superseded: FleetReleaseStateProto.SUPERSEDED,
  awaiting_approval: FleetReleaseStateProto.AWAITING_APPROVAL,
} satisfies Record<FleetQueryState["release"][number], FleetReleaseStateProto>

const rolloutValues = {
  pending: FleetRolloutStateProto.PENDING,
  progressing: FleetRolloutStateProto.PROGRESSING,
  paused: FleetRolloutStateProto.PAUSED,
  healthy: FleetRolloutStateProto.HEALTHY,
  degraded: FleetRolloutStateProto.DEGRADED,
  failed: FleetRolloutStateProto.FAILED,
  rolled_back: FleetRolloutStateProto.ROLLED_BACK,
  aborted: FleetRolloutStateProto.ABORTED,
} satisfies Record<FleetQueryState["rollout"][number], FleetRolloutStateProto>

const sourceValues = {
  git: FleetSourceTypeProto.GIT,
  helm: FleetSourceTypeProto.HELM,
  kustomize: FleetSourceTypeProto.KUSTOMIZE,
  s3: FleetSourceTypeProto.S3,
  oci: FleetSourceTypeProto.OCI,
  inline: FleetSourceTypeProto.INLINE,
} satisfies Record<FleetQueryState["sources"][number], FleetSourceTypeProto>

function dashboardReleaseFilter(state: FleetQueryState): FleetFilter {
  return new FleetFilter({
    projects: state.projects.map((project) => new FleetObjectKey(project)),
    clusters: state.clusters.map((cluster) => new FleetObjectKey(cluster)),
    stages: [...state.stages],
    namespaces: [...state.namespaces],
    health: state.health.map((value) => healthValues[value]),
    sync: state.sync.map((value) => syncValues[value]),
    releaseStates: state.release.map((value) => releaseValues[value]),
    rolloutStates: state.rollout.map((value) => rolloutValues[value]),
    sourceTypes: state.sources.map((value) => sourceValues[value]),
  })
}

function fleetScopeFilter(scope: FleetScope): FleetFilter {
  return new FleetFilter({
    projects: scope.projects.map((project) => new FleetObjectKey(project)),
    clusters: scope.clusters.map((cluster) => new FleetObjectKey(cluster)),
    stages: [...scope.stages],
    namespaces: [...scope.namespaces],
  })
}

function namespaceListRequests(namespaces: readonly string[]): Array<{ namespace?: string }> {
  const unique = [...new Set(namespaces.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  )
  return unique.length > 0 ? unique.map((namespace) => ({ namespace })) : [{}]
}

function resourceIdentity(namespace: string, name: string): string {
  return `${namespace}/${name}`
}

function mergeScopedRollouts(responses: readonly (readonly Rollout[])[]): Rollout[] {
  const seen = new Set<string>()
  const rollouts: Rollout[] = []
  for (const response of responses) {
    for (const rollout of response) {
      const identity = resourceIdentity(rollout.namespace, rollout.name)
      if (seen.has(identity)) continue
      seen.add(identity)
      rollouts.push(rollout)
    }
  }
  return rollouts
}

function requiresApplicationAssociation(scope: FleetScope): boolean {
  return scope.projects.length > 0 || scope.clusters.length > 0 || scope.stages.length > 0
}

async function loadScopedRollouts(scope: FleetScope, signal: AbortSignal): Promise<Rollout[]> {
  const requests = namespaceListRequests(scope.namespaces)
  const rolloutResponsesPromise = Promise.all(
    requests.map((request) => client.listRollouts(request, { signal })),
  )
  if (!requiresApplicationAssociation(scope)) {
    const rolloutResponses = await rolloutResponsesPromise
    return mergeScopedRollouts(
      rolloutResponses.map((response) => response.rollouts ?? []),
    )
  }

  const [rolloutResponses, releaseResponses, mapResponse] = await Promise.all([
    rolloutResponsesPromise,
    Promise.all(requests.map((request) => client.listReleases(request, { signal }))),
    client.queryFleetMap(
      {
        filter: fleetScopeFilter(scope),
        search: "",
        group: FleetGroupDimension.PROJECT,
        sizeMetric: FleetSizeMetric.RESOURCE_COUNT,
      },
      { signal },
    ),
  ])

  const rollouts = mergeScopedRollouts(
    rolloutResponses.map((response) => response.rollouts ?? []),
  )
  const releases = releaseResponses.flatMap((response) => response.releases ?? [])
  const applications = flattenMapApplicationAssociations(mapResponse.roots ?? [])
  if (BigInt(applications.length) !== mapResponse.total) {
    throw new Error("Fleet map did not contain every Application leaf")
  }
  const associations = buildRolloutApplicationAssociations(rollouts, releases, applications)
  return rollouts.filter((rollout) =>
    rolloutMatchesFleetScope(
      rollout,
      associations.get(resourceIdentity(rollout.namespace, rollout.name)),
      scope,
    ),
  )
}

type ScopedCollection<T> = {
  scopeKey: string
  items: T[]
}

const StatCard = memo(function StatCard({
  icon: Icon,
  label,
  value,
  loading,
}: {
  icon: typeof GitBranch
  label: string
  value: string | number
  loading?: boolean
}) {
  return (
    <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition-[box-shadow] hover:shadow-lg hover:shadow-foreground/5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary">
            <Icon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
              {label}
            </p>
            {loading ? (
              <div className="mt-1 h-6 w-14 rounded bg-muted animate-pulse" />
            ) : (
              <p className="text-xl font-semibold tracking-tight tabular-nums">{value}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})

function SkeletonCard() {
  return (
    <div className="rounded-xl bg-card p-5 space-y-3 ring-1 ring-foreground/10">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2 min-w-0 flex-1">
          <div className="h-4 w-28 rounded bg-muted animate-pulse" />
          <div className="h-3 w-20 rounded bg-muted animate-pulse" />
        </div>
        <div className="h-5 w-16 shrink-0 rounded-full bg-muted animate-pulse" />
      </div>
      <div className="h-1.5 rounded-full bg-muted animate-pulse" />
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="size-3 rounded-full bg-muted animate-pulse" />
            <div className="h-3 flex-1 rounded bg-muted animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}

const SectionError = memo(function SectionError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2">
      <AlertTriangle className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
      <p className="flex-1 text-xs text-destructive">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="text-xs font-medium text-destructive underline underline-offset-2 hover:text-destructive/80"
        >
          Retry
        </button>
      )}
    </div>
  )
})

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center gap-3 py-20 text-center">
          <p className="text-lg font-medium">Something went wrong</p>
          <p className="text-sm text-muted-foreground">
            An unexpected error occurred. Try refreshing the page.
          </p>
        </div>
      )
    }
    return this.props.children
  }
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<div role="status" className="px-6 py-8 text-sm text-muted-foreground">Loading operations overview…</div>}>
      <DashboardContent />
    </Suspense>
  )
}

function DashboardContent() {
  const searchParams = useSearchParams()
  const rawQuery = searchParams.toString()
  const { state: sharedFleetState } = useFleetScope()
  const sharedScope = useMemo<FleetScope>(
    () => ({
      projects: sharedFleetState.projects,
      clusters: sharedFleetState.clusters,
      stages: sharedFleetState.stages,
      namespaces: sharedFleetState.namespaces,
    }),
    [
      sharedFleetState.clusters,
      sharedFleetState.namespaces,
      sharedFleetState.projects,
      sharedFleetState.stages,
    ],
  )
  const scopeKey = useMemo(
    () =>
      JSON.stringify([
        sharedScope.projects,
        sharedScope.clusters,
        sharedScope.stages,
        sharedScope.namespaces,
      ]),
    [sharedScope],
  )
  const overviewFleetState = useMemo(
    () => overviewHeatmapState(sharedFleetState, new URLSearchParams(rawQuery)),
    [rawQuery, sharedFleetState],
  )
  const attentionFleetState = useMemo(
    () =>
      mergeFleetQuery(sharedFleetState, {
        view: "queue",
        sort: "impact",
        direction: "desc",
      }),
    [sharedFleetState],
  )
  const fleetMap = useFleetData(overviewFleetState)
  const attentionFleet = useFleetData(attentionFleetState)
  const refreshFleetMap = fleetMap.refresh
  const refreshAttentionFleet = attentionFleet.refresh
  const [pipelineData, setPipelineData] = useState<ScopedCollection<Pipeline> | null>(null)
  const [applicationSets, setApplicationSets] = useState<ApplicationSet[]>([])
  const [policies, setPolicies] = useState<Policy[]>([])
  const [rolloutData, setRolloutData] = useState<ScopedCollection<Rollout> | null>(null)
  const [loading, setLoading] = useState(true)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const requestGeneration = useRef(0)
  const activeController = useRef<AbortController | null>(null)
  const { reportRequestOutcome } = useConnection()
  const pipelines = pipelineData?.scopeKey === scopeKey ? pipelineData.items : []
  const rollouts = rolloutData?.scopeKey === scopeKey ? rolloutData.items : []
  const operationalLoading =
    loading || pipelineData?.scopeKey !== scopeKey || rolloutData?.scopeKey !== scopeKey

  const fetchData = useCallback(async () => {
    activeController.current?.abort()
    const controller = new AbortController()
    activeController.current = controller
    const generation = ++requestGeneration.current
    const requestScopeKey = scopeKey
    setErrors({})
    const pipelineRequests = planPipelineScopeRequests(sharedScope)
    const [pr, asr, por, ror] = await Promise.allSettled([
      Promise.all(
        pipelineRequests.map((request) =>
          client.listPipelines(request, { signal: controller.signal }),
        ),
      ).then((responses) =>
        mergeScopedPipelines(responses.map((response) => response.pipelines ?? [])),
      ),
      client.listApplicationSets({}, { signal: controller.signal }),
      client.listPolicies({}, { signal: controller.signal }),
      loadScopedRollouts(sharedScope, controller.signal),
    ])
    if (controller.signal.aborted || generation !== requestGeneration.current) return
    let anySuccess = false
    const next: Record<string, string> = {}

    if (pr.status === "fulfilled") {
      setPipelineData({ scopeKey: requestScopeKey, items: [...pr.value] })
      anySuccess = true
    } else {
      setPipelineData((current) =>
        current?.scopeKey === requestScopeKey
          ? current
          : { scopeKey: requestScopeKey, items: [] },
      )
      next.pipelines = pr.reason?.message ?? "Failed to load pipelines"
    }

    if (asr.status === "fulfilled") {
      setApplicationSets(asr.value.applicationsets)
      anySuccess = true
    } else {
      next.applicationSets = asr.reason?.message ?? "Failed to load application sets"
    }

    if (por.status === "fulfilled") {
      setPolicies(por.value.policies)
      anySuccess = true
    } else {
      next.policies = por.reason?.message ?? "Failed to load policies"
    }

    if (ror.status === "fulfilled") {
      setRolloutData({ scopeKey: requestScopeKey, items: ror.value })
      anySuccess = true
    } else {
      setRolloutData((current) =>
        current?.scopeKey === requestScopeKey
          ? current
          : { scopeKey: requestScopeKey, items: [] },
      )
      next.rollouts = ror.reason?.message ?? "Failed to load rollouts"
    }

    setErrors(next)
    setLoading(false)
    if (!anySuccess) throw new Error("dashboard refresh failed")
  }, [scopeKey, sharedScope])

  const performDashboardRefresh = useCallback(async () => {
    await Promise.all([fetchData(), refreshFleetMap(), refreshAttentionFleet()])
  }, [fetchData, refreshAttentionFleet, refreshFleetMap])
  const refreshDashboard = useSingleFlightRefresh(performDashboardRefresh)

  useFleetRefresh(refreshDashboard, { onRequestOutcome: reportRequestOutcome })

  const scopedRefresh = useRef(performDashboardRefresh)
  const scopedRefreshOutcome = useRef(reportRequestOutcome)
  const initialScope = useRef(scopeKey)
  useEffect(() => {
    scopedRefresh.current = performDashboardRefresh
  }, [performDashboardRefresh])
  useEffect(() => {
    scopedRefreshOutcome.current = reportRequestOutcome
  }, [reportRequestOutcome])
  useEffect(() => {
    if (initialScope.current === scopeKey) return
    initialScope.current = scopeKey
    void scopedRefresh.current().then(
      () => scopedRefreshOutcome.current(true),
      () => scopedRefreshOutcome.current(false),
    )
  }, [scopeKey])
  useEffect(
    () => () => {
      activeController.current?.abort()
    },
    [],
  )

  const manualRefresh = useCallback(() => {
    void refreshDashboard().then(
      () => reportRequestOutcome(true),
      () => reportRequestOutcome(false),
    )
  }, [refreshDashboard, reportRequestOutcome])

  const retryFleetMap = useCallback(() => {
    void refreshFleetMap().then(
      () => reportRequestOutcome(true),
      () => reportRequestOutcome(false),
    )
  }, [refreshFleetMap, reportRequestOutcome])

  const searchReleases = useCallback(
    async (query: string, signal: AbortSignal): Promise<Release[]> => {
      const response = await client.queryReleases(
        {
          filter: dashboardReleaseFilter(sharedFleetState),
          search: query,
          pageSize: 8,
          pageOffset: 0,
        },
        { signal },
      )
      return response.releases.slice(0, 8)
    },
    [sharedFleetState],
  )

  const runningCount = pipelines.filter((p) => p.phase === "Running").length
  const succeededCount = pipelines.filter((p) => p.phase === "Succeeded").length
  const failedCount = pipelines.filter((p) => p.phase === "Failed").length
  const fleetMapIsCurrent =
    fleetMap.status === "ready" ||
    fleetMap.status === "empty" ||
    fleetMap.status === "partial"
  const attentionIsCurrent =
    attentionFleet.status === "ready" ||
    attentionFleet.status === "empty" ||
    attentionFleet.status === "partial"
  const fleetMapData =
    fleetMapIsCurrent && fleetMap.currentData?.kind === "map"
      ? fleetMap.currentData
      : undefined
  const attentionApplications =
    attentionIsCurrent && attentionFleet.currentData?.kind === "applications"
      ? attentionFleet.currentData
      : undefined
  const commandApplications = useMemo(
    () => toDashboardApplications(attentionApplications?.applications ?? []),
    [attentionApplications?.applications],
  )
  const appCount = fleetMapData?.result.total.toString() ?? "—"
  const activeRolloutCount = rollouts.filter((r) => r.phase === "Progressing" || r.phase === "Paused").length
  const rawFleetParameters = useMemo(() => new URLSearchParams(rawQuery), [rawQuery])
  const inventoryHref = fleetHref("/dashboard/applications", rawFleetParameters)
  const queueHref = fleetHref(
    "/dashboard/applications",
    patchFleetSearchParams(rawFleetParameters, {
      view: "queue",
      sort: "impact",
      direction: "desc",
    }),
  )

  return (
    <ErrorBoundary>
      <div className="mx-auto max-w-7xl space-y-10 px-6 py-8">
        <h1 className="sr-only">Dashboard</h1>

        <FleetOverview
          result={fleetMapData?.result}
          attentionApplications={attentionApplications?.applications ?? []}
          attentionStatus={attentionFleet.status}
          inventoryHref={inventoryHref}
          queueHref={queueHref}
          selectedHealth={overviewFleetState.health}
          selectedRelease={overviewFleetState.release}
          selectedRollout={overviewFleetState.rollout}
          query={rawQuery}
        />

        <motion.div
          id="releases"
          className="scroll-mt-28 lg:scroll-mt-16"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.04, ease: [0.22, 1, 0.36, 1] }}
        >
          <DashboardCommandCenter
            applications={commandApplications}
            fleetMap={fleetMapData?.result}
            fleetMapStatus={fleetMap.status}
            fleetDensity={overviewFleetState.density}
            fleetLabels={overviewFleetState.labels}
            fleetSort={overviewFleetState.sort}
            fleetDirection={overviewFleetState.direction}
            selectedApplication={overviewFleetState.selected}
            onRetryFleetMap={retryFleetMap}
            pipelines={pipelines}
            releases={EMPTY_RELEASES}
            rollouts={rollouts}
            applicationSets={applicationSets}
            policies={policies}
            loading={operationalLoading}
            searchReleases={searchReleases}
            releaseQuery={rawQuery}
          />
          {errors.rollouts && (
            <div className="mt-3">
              <SectionError message={errors.rollouts} onRetry={manualRefresh} />
            </div>
          )}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
          className="grid gap-3 sm:grid-cols-3 lg:grid-cols-7">
          <StatCard icon={GitBranch} label="Pipelines" value={pipelines.length} loading={operationalLoading} />
          <StatCard icon={ListChecks} label="Running" value={runningCount} loading={operationalLoading} />
          <StatCard icon={Layers} label="Succeeded" value={succeededCount} loading={operationalLoading} />
          <StatCard icon={Activity} label="Failed" value={failedCount} loading={operationalLoading} />
          <StatCard icon={Rocket} label="Applications" value={appCount} loading={loading} />
          <StatCard icon={Activity} label="Rollouts" value={`${activeRolloutCount}/${rollouts.length}`} loading={operationalLoading} />
          <StatCard icon={FolderTree} label="App Sets" value={applicationSets.length} loading={loading} />
        </motion.div>

        <motion.section
          id="pipelines"
          className="scroll-mt-28 lg:scroll-mt-16"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold">Pipelines</h2>
              <span className="text-xs text-muted-foreground tabular-nums">
                {pipelines.length} total
              </span>
            </div>
          </div>
          {errors.pipelines && <SectionError message={errors.pipelines} onRetry={manualRefresh} />}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {operationalLoading
              ? [1, 2, 3].map((i) => <SkeletonCard key={i} />)
              : pipelines.map((p) => (
                  <PipelineCard key={`${p.namespace}/${p.name}`} pipeline={p} query={rawQuery} />
                ))}
            {!operationalLoading && pipelines.length === 0 && !errors.pipelines && (
              <div className="col-span-full flex flex-col items-center gap-3 py-16 text-center">
                <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                  <GitBranch className="size-4 text-muted-foreground" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-medium">No pipelines yet</p>
                  <p className="mt-1 text-xs text-muted-foreground max-w-sm">
                    Create a Pipeline resource in any namespace to get started
                  </p>
                </div>
              </div>
            )}
          </div>
        </motion.section>

        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold">Application Sets</h2>
              <span className="text-xs text-muted-foreground tabular-nums">
                {applicationSets.length} total
              </span>
            </div>
            {applicationSets.length > 0 && (
              <Link
                href={fleetHref("/dashboard/applicationsets", new URLSearchParams(rawQuery))}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                View all <ArrowUpRight className="size-3" />
              </Link>
            )}
          </div>
          {errors.applicationSets && <SectionError message={errors.applicationSets} onRetry={manualRefresh} />}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {loading
              ? [1, 2].map((i) => <SkeletonCard key={i} />)
              : applicationSets.map((set) => {
                  const detailHref = fleetDetailHref("applicationset", set, new URLSearchParams(rawQuery))
                  return (
                    <div key={`${set.namespace}/${set.name}`} className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition-[box-shadow] hover:shadow-lg hover:shadow-foreground/5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <Link href={detailHref} className="font-mono text-sm font-medium hover:text-primary">
                            {set.name}
                          </Link>
                          <p className="text-xs text-muted-foreground/70 mt-0.5">ns/{set.namespace}</p>
                        </div>
                        <StatusBadge status={set.phase} />
                      </div>
                      <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                        <Rocket className="size-3.5" aria-hidden="true" />
                        {set.applications} application{set.applications === 1 ? "" : "s"}
                      </div>
                    </div>
                  )
                })}
            {!loading && applicationSets.length === 0 && !errors.applicationSets && (
              <div className="col-span-full flex flex-col items-center gap-3 py-16 text-center">
                <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                  <FolderTree className="size-4 text-muted-foreground" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-medium">No application sets yet</p>
                  <p className="mt-1 text-xs text-muted-foreground max-w-sm">
                    Create an ApplicationSet resource to generate Applications from templates
                  </p>
                </div>
              </div>
            )}
          </div>
        </motion.section>

        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="mb-4 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold">Policies</h2>
              <span className="text-xs text-muted-foreground tabular-nums">
                {policies.length} total
              </span>
          </div>
          {errors.policies && <SectionError message={errors.policies} onRetry={manualRefresh} />}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {loading
              ? [1, 2].map((i) => <SkeletonCard key={i} />)
              : policies.map((p) => (
                  <div key={p.name} className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition-[box-shadow] hover:shadow-lg hover:shadow-foreground/5">
                    <div className="flex items-center gap-2.5">
                      <Shield className="size-4 text-primary" aria-hidden="true" />
                      <span className="font-mono text-sm font-medium">{p.name}</span>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{p.description || "No description"}</p>
                    <div className="mt-3 flex items-center gap-2">
                      <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{p.severity}</span>
                      <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{p.defaultAction || "enforce"}</span>
                    </div>
                  </div>
                ))}
            {!loading && policies.length === 0 && !errors.policies && (
              <div className="col-span-full flex flex-col items-center gap-3 py-16 text-center">
                <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                  <Shield className="size-4 text-muted-foreground" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-medium">No policies yet</p>
                  <p className="mt-1 text-xs text-muted-foreground max-w-sm">
                    Create a Policy resource to guard applies with CEL rules
                  </p>
                </div>
              </div>
            )}
          </div>
        </motion.section>
      </div>
      <ToastStack />
    </ErrorBoundary>
  )
}

function toDashboardApplications(
  applications: readonly FleetApplicationSummary[],
): Application[] {
  return applications.flatMap((summary) => {
    const identity = summary.identity
    if (!identity) return []
    return [
      new Application({
        name: identity.name,
        namespace: identity.namespace,
        phase: summary.releaseState,
        currentStage: summary.currentStage,
        revision: summary.sourceRevision,
        sourceRevision: summary.sourceRevision,
        synced: summary.sync === "synced",
        health: summary.health,
        outOfSync:
          summary.sync === "out_of_sync"
            ? Math.max(1, summary.driftCount)
            : summary.driftCount,
        project: summary.project
          ? `${summary.project.namespace}/${summary.project.name}`
          : "",
      }),
    ]
  })
}

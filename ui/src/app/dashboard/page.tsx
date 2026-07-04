"use client"

import { useState, useEffect, memo, Component, type ReactNode, useCallback, useRef } from "react"
import Link from "next/link"
import { createPromiseClient } from "@connectrpc/connect"
import { createConnectTransport } from "@connectrpc/connect-web"
import { PaprikaService } from "@/gen/paprika/v1/api_connect"
import type { Pipeline } from "@/gen/paprika/v1/api_pb"
import type { Release } from "@/gen/paprika/v1/api_pb"
import type { Application } from "@/gen/paprika/v1/api_pb"
import type { ApplicationSet } from "@/gen/paprika/v1/api_pb"
import type { Policy } from "@/gen/paprika/v1/api_pb"
import { PipelineCard } from "@/components/dashboard/pipeline-card"
import { ReleaseGrid } from "@/components/dashboard/release-table"
import { ApplicationCard } from "@/components/dashboard/application-card"
import { Card, CardContent } from "@/components/ui/card"
import { StatusBadge } from "@/components/ui/status-badge"
import { useConnection } from "@/lib/connection-context"
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
  Circle,
} from "lucide-react"

const transport = createConnectTransport({ baseUrl: "" })
const client = createPromiseClient(PaprikaService, transport)

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
    <div className="rounded-xl border border-border/40 bg-card p-4 transition-all hover:border-border/60">
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
    <div className="rounded-xl border border-border/40 bg-card p-5 space-y-3">
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
    <div className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2">
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
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [releases, setReleases] = useState<Release[]>([])
  const [applications, setApplications] = useState<Application[]>([])
  const [applicationSets, setApplicationSets] = useState<ApplicationSet[]>([])
  const [policies, setPolicies] = useState<Policy[]>([])
  const [loading, setLoading] = useState(true)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const { setConnected } = useConnection()

  const fetchPipelines = useCallback(() =>
    client.listPipelines({}).then(r => setPipelines(r.pipelines)), [])

  const fetchReleases = useCallback(() =>
    client.listReleases({}).then(r => setReleases(r.releases)), [])

  const fetchApplications = useCallback(() =>
    client.listApplications({}).then(r => setApplications(r.applications)), [])

  const fetchApplicationSets = useCallback(() =>
    client.listApplicationSets({}).then(r => setApplicationSets(r.applicationsets)), [])

  const fetchData = useCallback(() => {
    setErrors({})
    Promise.allSettled([
      client.listPipelines({}),
      client.listReleases({}),
      client.listApplications({}),
      client.listApplicationSets({}),
      client.listPolicies({}),
    ])
      .then(([pr, rr, ar, asr, por]) => {
        let anySuccess = false
        const next: Record<string, string> = {}

        if (pr.status === "fulfilled") {
          setPipelines(pr.value.pipelines)
          anySuccess = true
        } else {
          next.pipelines = pr.reason?.message ?? "Failed to load pipelines"
        }

        if (rr.status === "fulfilled") {
          setReleases(rr.value.releases)
          anySuccess = true
        } else {
          next.releases = rr.reason?.message ?? "Failed to load releases"
        }

        if (ar.status === "fulfilled") {
          setApplications(ar.value.applications)
          anySuccess = true
        } else {
          next.applications = ar.reason?.message ?? "Failed to load applications"
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

        setErrors(next)
        setConnected(anySuccess)
      })
      .catch(() => setConnected(false))
      .finally(() => setLoading(false))
  }, [setConnected])

  const refetchByEvent = useCallback((eventType: string) => {
    switch (eventType) {
      case "application":
        fetchApplications()
        fetchApplicationSets()
        break
      case "release":
        fetchReleases()
        fetchApplications()
        break
      default:
        fetchData()
    }
  }, [fetchApplications, fetchApplicationSets, fetchReleases, fetchData])

  const debounceRef = useRef<number | null>(null)
  const sseConnectedRef = useRef(true)
  const lastFetchRef = useRef(0)
  const MIN_FETCH_INTERVAL = 5000

  useEffect(() => {
    const timeout = setTimeout(() => fetchData(), 0)
    let fallback: ReturnType<typeof setInterval> | null = null

    const startFallback = () => {
      if (fallback != null) return
      fallback = setInterval(() => {
        if (!sseConnectedRef.current) {
          fetchData()
        }
      }, 60000)
    }
    const stopFallback = () => {
      if (fallback != null) {
        clearInterval(fallback)
        fallback = null
      }
    }

    const eventSource = new EventSource("/events?topic=dashboard")
    eventSource.onopen = () => {
      sseConnectedRef.current = true
      stopFallback()
    }
    eventSource.onmessage = (e) => {
      sseConnectedRef.current = true
      const now = Date.now()
      if (now - lastFetchRef.current < MIN_FETCH_INTERVAL) return
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current)
      }
      debounceRef.current = window.setTimeout(() => {
        lastFetchRef.current = Date.now()
        let eventType = "audit"
        try { const parsed = JSON.parse(e.data); if (typeof parsed.type === "string") eventType = parsed.type } catch {}
        refetchByEvent(eventType)
      }, 300)
    }
    eventSource.onerror = () => {
      sseConnectedRef.current = false
      startFallback()
    }

    return () => {
      clearTimeout(timeout)
      stopFallback()
      eventSource.close()
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current)
      }
    }
  }, [fetchData, refetchByEvent])

  const runningCount = pipelines.filter((p) => p.phase === "Running").length
  const succeededCount = pipelines.filter((p) => p.phase === "Succeeded").length
  const failedCount = pipelines.filter((p) => p.phase === "Failed").length
  const appCount = applications.length
  const releaseByName = new Map(releases.map((r) => [r.name, r]))

  return (
    <ErrorBoundary>
      <div className="mx-auto max-w-7xl space-y-10 px-6 py-8">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Pipeline operator overview
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard icon={GitBranch} label="Pipelines" value={pipelines.length} loading={loading} />
          <StatCard icon={ListChecks} label="Running" value={runningCount} loading={loading} />
          <StatCard icon={Layers} label="Succeeded" value={succeededCount} loading={loading} />
          <StatCard icon={Activity} label="Failed" value={failedCount} loading={loading} />
          <StatCard icon={Rocket} label="Applications" value={appCount} loading={loading} />
          <StatCard icon={FolderTree} label="App Sets" value={applicationSets.length} loading={loading} />
        </div>

        <section>
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold">Pipelines</h2>
              <span className="text-xs text-muted-foreground">
                {pipelines.length} total
              </span>
            </div>
          </div>
          {errors.pipelines && <SectionError message={errors.pipelines} onRetry={fetchData} />}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {loading
              ? [1, 2, 3].map((i) => <SkeletonCard key={i} />)
              : pipelines.map((p) => <PipelineCard key={p.name} pipeline={p} />)}
            {!loading && pipelines.length === 0 && !errors.pipelines && (
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
        </section>

        <section>
          <div className="mb-4 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold">Applications</h2>
            <span className="text-xs text-muted-foreground">
              {applications.length} total
            </span>
          </div>
          {errors.applications && <SectionError message={errors.applications} onRetry={fetchData} />}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {loading
              ? [1, 2].map((i) => <SkeletonCard key={i} />)
              : applications.map((a) => {
                  const release = a.releaseRef ? releaseByName.get(a.releaseRef) : undefined
                  return <ApplicationCard key={a.name} application={a} release={release} onSynced={fetchData} />
                })}
            {!loading && applications.length === 0 && !errors.applications && (
              <div className="col-span-full flex flex-col items-center gap-3 py-16 text-center">
                <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                  <Rocket className="size-4 text-muted-foreground" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-medium">No applications yet</p>
                  <p className="mt-1 text-xs text-muted-foreground max-w-sm">
                    Create an Application resource to deploy workloads across stages
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>

        <section>
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold">Application Sets</h2>
              <span className="text-xs text-muted-foreground">
                {applicationSets.length} total
              </span>
            </div>
            {applicationSets.length > 0 && (
              <Link
                href="/dashboard/applicationsets"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                View all <ArrowUpRight className="size-3" />
              </Link>
            )}
          </div>
          {errors.applicationSets && <SectionError message={errors.applicationSets} onRetry={fetchData} />}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {loading
              ? [1, 2].map((i) => <SkeletonCard key={i} />)
              : applicationSets.map((set) => {
                  const detailHref = `/dashboard/applicationsets/detail?namespace=${encodeURIComponent(set.namespace)}&name=${encodeURIComponent(set.name)}`
                  return (
                    <div key={`${set.namespace}/${set.name}`} className="rounded-xl border border-border/40 bg-card p-4 transition-all hover:border-border/60">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <Link href={detailHref} className="font-mono text-sm font-medium hover:text-primary">
                            {set.name}
                          </Link>
                          <p className="text-xs text-muted-foreground/70 mt-0.5">ns/{set.namespace}</p>
                        </div>
                        <StatusBadge status={set.phase} />
                      </div>
                      <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
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
        </section>

        <section>
          <div className="mb-4 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold">Releases</h2>
            <span className="text-xs text-muted-foreground">
              {releases.length} total
            </span>
          </div>
          {errors.releases && <SectionError message={errors.releases} onRetry={fetchData} />}
          {loading ? (
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {[1, 2].map((i) => (
                <div key={i} className="rounded-xl border border-border/40 bg-card p-4 space-y-3">
                  <div className="h-4 w-24 rounded bg-muted animate-pulse" />
                  <div className="grid grid-cols-2 gap-2">
                    <div className="h-10 rounded-lg bg-muted animate-pulse" />
                    <div className="h-10 rounded-lg bg-muted animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <ReleaseGrid releases={releases} />
          )}
        </section>

        <section>
          <div className="mb-4 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold">Policies</h2>
            <span className="text-xs text-muted-foreground">
              {policies.length} total
            </span>
          </div>
          {errors.policies && <SectionError message={errors.policies} onRetry={fetchData} />}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {loading
              ? [1, 2].map((i) => <SkeletonCard key={i} />)
              : policies.map((p) => (
                  <div key={p.name} className="rounded-xl border border-border/40 bg-card p-4 transition-all hover:border-border/60">
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
        </section>
      </div>
      <ToastStack />
    </ErrorBoundary>
  )
}

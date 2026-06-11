"use client"

import { useState, useEffect } from "react"
import { createPromiseClient } from "@connectrpc/connect"
import { createConnectTransport } from "@connectrpc/connect-web"
import { PaprikaService } from "@/gen/paprika/v1/api_connect"
import type { Pipeline } from "@/gen/paprika/v1/api_pb"
import type { Release } from "@/gen/paprika/v1/api_pb"
import type { Stage } from "@/gen/paprika/v1/api_pb"
import type { Application } from "@/gen/paprika/v1/api_pb"
import { PipelineCard } from "@/components/dashboard/pipeline-card"
import { ReleaseGrid } from "@/components/dashboard/release-table"
import { ApplicationCard } from "@/components/dashboard/application-card"
import { Card, CardContent } from "@/components/ui/card"
import { useConnection } from "@/lib/connection-context"
import {
  GitBranch,
  ListChecks,
  Layers,
  Activity,
  Loader2,
  RefreshCw,
  Rocket,
  AlertTriangle,
} from "lucide-react"

const transport = createConnectTransport({ baseUrl: "" })
const client = createPromiseClient(PaprikaService, transport)

function StatCard({
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
    <Card>
      <CardContent className="flex items-center gap-3 pt-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">{label}</p>
          {loading ? (
            <div className="mt-1 h-6 w-12 rounded bg-muted animate-pulse" />
          ) : (
            <p className="text-xl font-semibold tracking-tight">{value}</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function SkeletonCard() {
  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex items-start justify-between">
          <div className="space-y-2">
            <div className="h-4 w-32 rounded bg-muted animate-pulse" />
            <div className="h-3 w-24 rounded bg-muted animate-pulse" />
          </div>
          <div className="h-5 w-20 rounded-full bg-muted animate-pulse" />
        </div>
        <div className="h-1.5 rounded-full bg-muted animate-pulse" />
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="size-3.5 rounded-full bg-muted animate-pulse" />
              <div className="h-3 flex-1 rounded bg-muted animate-pulse" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function SectionError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2">
      <AlertTriangle className="size-4 shrink-0 text-destructive" />
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
}

export default function DashboardPage() {
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [releases, setReleases] = useState<Release[]>([])
  const [stages, setStages] = useState<Stage[]>([])
  const [applications, setApplications] = useState<Application[]>([])
  const [loading, setLoading] = useState(true)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const { setConnected } = useConnection()

  const fetchData = () => {
    setLoading(true)
    setErrors({})
    Promise.allSettled([
      client.listPipelines({}),
      client.listReleases({}),
      client.listStages({}),
      client.listApplications({}),
    ])
      .then(([pr, rr, sr, ar]) => {
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

        if (sr.status === "fulfilled") {
          setStages(sr.value.stages)
          anySuccess = true
        } else {
          next.stages = sr.reason?.message ?? "Failed to load stages"
        }

        if (ar.status === "fulfilled") {
          setApplications(ar.value.applications)
          anySuccess = true
        } else {
          next.applications = ar.reason?.message ?? "Failed to load applications"
        }

        setErrors(next)
        setConnected(anySuccess)
      })
      .catch(() => setConnected(false))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 10000)
    return () => clearInterval(interval)
  }, [])

  const runningCount = pipelines.filter((p) => p.phase === "Running").length
  const succeededCount = pipelines.filter((p) => p.phase === "Succeeded").length
  const failedCount = pipelines.filter((p) => p.phase === "Failed").length
  const appCount = applications.length

  return (
    <div className="mx-auto max-w-7xl space-y-8 px-6 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pipeline operator overview
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          icon={GitBranch}
          label="Total Pipelines"
          value={pipelines.length}
          loading={loading}
        />
        <StatCard
          icon={ListChecks}
          label="Running"
          value={runningCount}
          loading={loading}
        />
        <StatCard
          icon={Layers}
          label="Succeeded"
          value={succeededCount}
          loading={loading}
        />
        <StatCard
          icon={Activity}
          label="Failed"
          value={failedCount}
          loading={loading}
        />
        <StatCard
          icon={Rocket}
          label="Applications"
          value={appCount}
          loading={loading}
        />
      </div>

      <section id="pipelines">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Pipelines</h2>
            <p className="text-xs text-muted-foreground">
              {pipelines.length} pipeline{pipelines.length !== 1 ? "s" : ""} configured
            </p>
          </div>
        </div>
        {errors.pipelines && <SectionError message={errors.pipelines} onRetry={fetchData} />}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {loading
            ? [1, 2, 3].map((i) => <SkeletonCard key={i} />)
            : pipelines.map((p) => <PipelineCard key={p.name} pipeline={p} />)}
          {!loading && pipelines.length === 0 && !errors.pipelines && (
            <div className="col-span-full flex flex-col items-center gap-2 py-12 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-muted">
                <GitBranch className="size-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground">No pipelines yet</p>
              <p className="text-xs text-muted-foreground">
                Create a Pipeline resource in any namespace to get started
              </p>
            </div>
          )}
        </div>
      </section>

      <section id="applications">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Applications</h2>
            <p className="text-xs text-muted-foreground">
              {applications.length} application{applications.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
        {errors.applications && <SectionError message={errors.applications} onRetry={fetchData} />}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {loading
            ? [1, 2].map((i) => <SkeletonCard key={i} />)
            : applications.map((a) => <ApplicationCard key={a.name} application={a} onSynced={fetchData} />)}
          {!loading && applications.length === 0 && !errors.applications && (
            <div className="col-span-full flex flex-col items-center gap-2 py-12 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-muted">
                <Rocket className="size-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground">No applications yet</p>
              <p className="text-xs text-muted-foreground">
                Create an Application resource to deploy workloads across stages
              </p>
            </div>
          )}
        </div>
      </section>

      <section id="releases">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Releases</h2>
            <p className="text-xs text-muted-foreground">
              {releases.length} release{releases.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
        {errors.releases && <SectionError message={errors.releases} onRetry={fetchData} />}
        {loading ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2].map((i) => (
              <Card key={i}>
                <CardContent className="space-y-3 pt-4">
                  <div className="h-4 w-28 rounded bg-muted animate-pulse" />
                  <div className="grid grid-cols-2 gap-2">
                    <div className="h-12 rounded-lg bg-muted animate-pulse" />
                    <div className="h-12 rounded-lg bg-muted animate-pulse" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <ReleaseGrid releases={releases} />
        )}
      </section>
    </div>
  )
}
"use client"

import { Suspense, useCallback, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { ChevronLeft, Loader2 } from "lucide-react"

import { createPromiseClient } from "@connectrpc/connect"
import { createTransport } from "@/lib/transport"
import { PaprikaService } from "@/gen/paprika/v1/api_connect"
import type { Pipeline } from "@/gen/paprika/v1/api_pb"

import { Button } from "@/components/ui/button"
import { StatusBadge } from "@/components/ui/status-badge"
import { ArtifactCard } from "@/components/dashboard/artifact-card"
import { PipelineDAG } from "@/components/dashboard/pipeline-dag"
import { StepDetailPanel } from "@/components/dashboard/step-detail-panel"
import { useConnection } from "@/lib/connection-context"
import { usePipelineRefresh } from "@/lib/pipeline-refresh"
import { useStepArtifacts } from "@/lib/use-step-artifacts"

const transport = createTransport()
const client = createPromiseClient(PaprikaService, transport)

export default function PipelineDetailPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-6xl px-6 py-8"><div className="h-96 animate-pulse rounded bg-muted" /></div>}>
      <PipelineDetail />
    </Suspense>
  )
}

function PipelineDetail() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const namespace = searchParams.get("namespace") ?? ""
  const name = searchParams.get("name") ?? ""

  const [pipeline, setPipeline] = useState<Pipeline | null>(null)
  const [selectedStep, setSelectedStep] = useState<string | null>(null)
  const [logs, setLogs] = useState<string | null>(null)
  const [logsLoading, setLogsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const { reportRequestOutcome } = useConnection()

  const pipelineArtifacts = useStepArtifacts(pipeline?.artifacts ?? [], "")

  const fetchPipeline = useCallback(async () => {
    if (!namespace || !name) return
    setError(null)
    try {
      const response = await client.getPipeline({ namespace, name })
      setPipeline(response.pipeline ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load pipeline")
      throw err
    }
  }, [namespace, name])

  usePipelineRefresh(namespace, name, fetchPipeline, {
    onRequestOutcome: reportRequestOutcome,
  })

  useEffect(() => {
    if (!selectedStep || !namespace || !name) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLogsLoading(true)
    setLogs(null)
    client
      .getStepLogs({
        pipelineName: name,
        pipelineNamespace: namespace,
        stepName: selectedStep,
        tailLines: 100,
      })
      .then((res) => setLogs(res.logs))
      .catch(() => setLogs(null))
      .finally(() => setLogsLoading(false))
  }, [selectedStep, namespace, name])

  const handleRetry = useCallback(async () => {
    if (!selectedStep || !name || !namespace) return
    try {
      await client.retryStep({
        pipelineName: name,
        pipelineNamespace: namespace,
        stepName: selectedStep,
      })
      await fetchPipeline()
    } catch {
      // The next bounded refresh will reconcile a transient failure.
    }
  }, [selectedStep, name, namespace, fetchPipeline])

  const handleSkip = useCallback(async () => {
    if (!selectedStep || !name || !namespace) return
    try {
      await client.skipStep({
        pipelineName: name,
        pipelineNamespace: namespace,
        stepName: selectedStep,
      })
      await fetchPipeline()
    } catch {
      // The next bounded refresh will reconcile a transient failure.
    }
  }, [selectedStep, name, namespace, fetchPipeline])

  const handleCancel = useCallback(async () => {
    if (!name || !namespace) return
    setCancelling(true)
    try {
      await client.cancelPipeline({ name, namespace })
      await fetchPipeline()
    } catch {
      // The next bounded refresh will reconcile a transient failure.
    } finally {
      setCancelling(false)
    }
  }, [name, namespace, fetchPipeline])

  if (!namespace || !name) {
    return (
      <div className="mx-auto max-w-4xl py-8 text-center">
        <p className="text-muted-foreground">Missing namespace or name parameters</p>
        <Button variant="outline" className="mt-4" onClick={() => router.push("/dashboard")}>
          Back to Dashboard
        </Button>
      </div>
    )
  }

  if (error && !pipeline) {
    return (
      <div className="mx-auto max-w-4xl py-8">
        <div className="rounded-md border border-destructive/20 bg-destructive/5 p-4 text-destructive">
          {error}
          <Button variant="outline" size="sm" className="ml-4" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </div>
      </div>
    )
  }

  if (!pipeline) {
    return (
      <div className="mx-auto max-w-4xl py-8">
        <div className="space-y-4">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-96 animate-pulse rounded bg-muted" />
        </div>
      </div>
    )
  }

  const selectedStepObj = pipeline.steps?.find((s) => s.name === selectedStep) ?? null
  const selectedStatus = pipeline.stepStatuses?.find((s) => s.name === selectedStep) ?? null

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/dashboard")}>
            <ChevronLeft className="size-4" />
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{name}</h1>
            <p className="text-xs text-muted-foreground">ns/{namespace}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {pipeline.phase && <StatusBadge status={pipeline.phase} />}
          {pipeline.phase !== "Succeeded" && pipeline.phase !== "Failed" && pipeline.phase !== "Cancelled" && (
            <Button size="sm" variant="destructive" onClick={handleCancel} disabled={cancelling}>
              {cancelling ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
              Cancel
            </Button>
          )}
        </div>
      </div>

      {error ? (
        <div
          role="status"
          aria-live="polite"
          className="border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
        >
          Showing the last loaded pipeline state. Refresh failed: {error}
        </div>
      ) : null}

      <div className="flex gap-6">
        <div className="flex-1">
          <div className="rounded-lg border bg-card">
            <PipelineDAG
              steps={pipeline.steps ?? []}
              stepStatuses={pipeline.stepStatuses ?? []}
              selectedStep={selectedStep}
              onStepSelect={setSelectedStep}
            />
          </div>
        </div>
        <div className="w-96 shrink-0">
          <div className="h-[600px] rounded-lg border bg-card">
            <StepDetailPanel
              step={selectedStepObj}
              status={selectedStatus}
              logs={logs}
              logsLoading={logsLoading}
              onRetry={handleRetry}
              onSkip={handleSkip}
              artifacts={pipeline.artifacts}
            />
          </div>
        </div>
      </div>

      {pipelineArtifacts.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Pipeline Artifacts</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {pipelineArtifacts.map((a) => (
              <ArtifactCard key={a.name} artifact={a} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

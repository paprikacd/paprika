"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { Loader2 } from "lucide-react"

import {
  DataClass,
  DataState,
  type ArtifactRef,
  type Pipeline,
  type PipelineRunSummary,
} from "@/gen/paprika/v1/api_pb"
import { ArtifactCard } from "@/components/dashboard/artifact-card"
import { PipelineDAG } from "@/components/dashboard/pipeline-dag"
import { StepDetailPanel } from "@/components/dashboard/step-detail-panel"
import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { Button } from "@/components/ui/button"
import { StatusPill } from "@/components/ui/status-chip"
import { usePublishConsoleScope } from "@/components/layout/console-header"
import { useConnection } from "@/lib/connection-context"
import { FOCUSED_REFRESH_INTERVAL_MS } from "@/lib/fleet-refresh"
import { usePipelineRefresh } from "@/lib/pipeline-refresh"

import { pipelineApi, useDataSources, useNow } from "../pipeline-data"
import {
  availabilityOf,
  classAvailability,
  hasNumerics,
  isRenderable,
  isTerminalPhase,
  narrowAvailability,
  phaseLabel,
  phaseTone,
  pipelineStatCells,
  runProvenance,
  runStepByName,
  stepResourceLabel,
  defaultSelectedStep,
  type Availability,
} from "../pipeline-model"
import { PipelineStatStrip } from "../pipeline-stats"

const TAIL_LINES = 200

export default function PipelineDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="px-[22px] py-[18px]">
          <div className="h-96 animate-pulse bg-inset" />
        </div>
      }
    >
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
  const [run, setRun] = useState<PipelineRunSummary | null>(null)
  const [runState, setRunState] = useState<DataState | null>(null)
  const [runsReachable, setRunsReachable] = useState(true)
  const [selectedStep, setSelectedStep] = useState<string | null>(null)
  const [logState, setLogState] = useState<{ key: string; text: string | null } | null>(
    null
  )
  const [fullLogs, setFullLogs] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [refreshedAt, setRefreshedAt] = useState<number | undefined>(undefined)
  const { reportRequestOutcome } = useConnection()

  const dataSources = useDataSources()
  const runsClass = classAvailability(dataSources, DataClass.PIPELINE_RUNS)
  const commitClass = classAvailability(dataSources, DataClass.COMMIT_METADATA)
  const running = pipeline !== null && !isTerminalPhase(pipeline.phase)
  const nowMs = useNow(running)

  const fetchRuns = useCallback(async () => {
    if (!namespace || !name) return
    try {
      const response = await pipelineApi().listPipelineRuns({
        pipeline: { namespace, name },
        pageSize: 1,
      })
      setRunsReachable(true)
      setRunState(response.state)
      setRun(response.runs[0] ?? null)
    } catch {
      // A control plane that cannot answer at all is treated as if the class
      // were never configured: the run-derived surfaces disappear rather than
      // showing a number nobody stands behind.
      setRunsReachable(false)
      setRun(null)
      setRunState(null)
    }
  }, [namespace, name])

  const fetchPipeline = useCallback(async () => {
    if (!namespace || !name) return
    try {
      const response = await pipelineApi().getPipeline({ namespace, name })
      setPipeline(response.pipeline ?? null)
      setError(null)
      setRefreshedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load pipeline")
      throw err
    }
  }, [namespace, name])

  usePipelineRefresh(namespace, name, fetchPipeline, {
    onRequestOutcome: reportRequestOutcome,
  })

  // Run history is a separately-gated request on the same cadence. It only
  // becomes enabled once the capability probe says PIPELINE_RUNS can answer
  // with real numbers, so a control plane without run history never issues it.
  usePipelineRefresh(namespace, name, fetchRuns, {
    enabled: hasNumerics(runsClass),
  })

  usePublishConsoleScope({
    refreshedAt,
    isRefreshing: pipeline === null && error === null,
    intervalMs: FOCUSED_REFRESH_INTERVAL_MS,
  })

  const activeStep =
    selectedStep ?? (pipeline ? defaultSelectedStep(pipeline) : null)

  // Keyed on the request rather than mirrored into a loading flag, so the
  // effect never writes state synchronously and a late response for a step
  // the reader has already moved off cannot overwrite the current one.
  const logKey = `${namespace}/${name}/${activeStep ?? ""}/${fullLogs}`

  useEffect(() => {
    if (!activeStep || !namespace || !name) return
    let active = true
    pipelineApi()
      .getStepLogs({
        pipelineName: name,
        pipelineNamespace: namespace,
        stepName: activeStep,
        tailLines: fullLogs ? 0 : TAIL_LINES,
      })
      .then((res) => {
        if (active) setLogState({ key: logKey, text: res.logs })
      })
      .catch(() => {
        if (active) setLogState({ key: logKey, text: null })
      })
    return () => {
      active = false
    }
  }, [activeStep, namespace, name, fullLogs, logKey])

  const logsSettled = logState?.key === logKey
  const logs = logsSettled ? logState.text : null
  const logsLoading = Boolean(activeStep) && !logsSettled

  const handleSelectStep = useCallback((stepName: string) => {
    setSelectedStep(stepName)
    setFullLogs(false)
  }, [])

  const runMutation = useCallback(
    async (mutate: () => Promise<unknown>) => {
      try {
        await mutate()
        await fetchPipeline()
      } catch {
        // The next bounded refresh reconciles a transient failure.
      }
    },
    [fetchPipeline]
  )

  const handleRetry = useCallback(() => {
    if (!activeStep) return
    void runMutation(() =>
      pipelineApi().retryStep({
        pipelineName: name,
        pipelineNamespace: namespace,
        stepName: activeStep,
      })
    )
  }, [activeStep, name, namespace, runMutation])

  const handleSkip = useCallback(() => {
    if (!activeStep) return
    void runMutation(() =>
      pipelineApi().skipStep({
        pipelineName: name,
        pipelineNamespace: namespace,
        stepName: activeStep,
      })
    )
  }, [activeStep, name, namespace, runMutation])

  const handleCancel = useCallback(async () => {
    setCancelling(true)
    try {
      await runMutation(() => pipelineApi().cancelPipeline({ name, namespace }))
    } finally {
      setCancelling(false)
    }
  }, [name, namespace, runMutation])

  /**
   * The class-level probe and the response's own state are both binding, and
   * the narrower wins. An RPC that cannot be reached at all falls back to
   * absent — never to a zero.
   */
  const runsAvailability = useMemo<Availability>(() => {
    if (!isRenderable(runsClass)) return runsClass
    if (!runsReachable) return { kind: "absent" }
    if (runsClass.kind === "unavailable") return runsClass
    if (runState === null) return { kind: "absent" }
    return narrowAvailability(runsClass, availabilityOf(runState))
  }, [runsClass, runsReachable, runState])

  const runContext = useMemo(
    () => ({ availability: runsAvailability, run }),
    [runsAvailability, run]
  )

  const statCells = useMemo(
    () =>
      pipeline
        ? pipelineStatCells({ pipeline, nowMs: nowMs, runs: runContext })
        : [],
    [pipeline, nowMs, runContext]
  )

  const provenance = useMemo(
    () =>
      pipeline
        ? runProvenance({
            pipeline,
            nowMs: nowMs,
            runs: runContext,
            commit: commitClass,
          })
        : {},
    [pipeline, nowMs, runContext, commitClass]
  )

  if (!namespace || !name) {
    return (
      <div className="px-[22px] py-8">
        <p className="text-console text-muted-foreground">
          This link is missing the pipeline namespace or name.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => router.push("/dashboard/pipelines/")}
        >
          Back to pipelines
        </Button>
      </div>
    )
  }

  if (error && !pipeline) {
    return (
      <div className="px-[22px] py-8">
        <div
          role="alert"
          className="border border-status-failed-line bg-status-failed-fill px-4 py-3 text-console text-status-failed-text"
        >
          {error}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => void fetchPipeline()}
        >
          Try again
        </Button>
      </div>
    )
  }

  if (!pipeline) {
    return (
      <div className="px-[22px] py-8">
        <p className="sr-only" role="status">
          Loading pipeline {name}
        </p>
        <div className="h-8 w-48 animate-pulse bg-inset" />
        <div className="mt-4 h-96 animate-pulse bg-inset" />
      </div>
    )
  }

  const terminal = isTerminalPhase(pipeline.phase)
  const activeStepObj =
    pipeline.steps.find((step) => step.name === activeStep) ?? null
  const activeStatus =
    pipeline.stepStatuses.find((status) => status.name === activeStep) ?? null
  const resourceLabel = stepResourceLabel(
    runStepByName(run, activeStep ?? ""),
    runsAvailability
  )

  const subline = [
    provenance.runNumber,
    provenance.triggeredBy ? `by ${provenance.triggeredBy}` : undefined,
    provenance.commitShort
      ? `${provenance.commitShort}${provenance.commitMessage ? ` “${provenance.commitMessage}”` : ""}`
      : undefined,
    provenance.startedAgo ? `started ${provenance.startedAgo}` : undefined,
  ].filter(Boolean)

  return (
    <div>
      <div className="border-b border-rule bg-card px-[22px] py-4">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            <p className="font-mono text-meta text-neutral-600">
              <Link href="/dashboard/pipelines/" className="hover:underline">
                Pipelines
              </Link>{" "}
              / {pipeline.namespace} / {pipeline.name}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <h1 className="font-cond text-title leading-none font-semibold tracking-[0.01em]">
                {pipeline.name}
              </h1>
              <StatusPill
                tone={phaseTone(pipeline.phase)}
                label={phaseLabel(pipeline.phase)}
              />
            </div>
            {subline.length > 0 ? (
              <p className="mt-1.5 font-mono text-note text-neutral-700">
                {subline.join(" · ")}
              </p>
            ) : null}
          </div>
          {terminal ? null : (
            <Button
              variant="outline"
              size="sm"
              className="flex-none text-destructive"
              disabled={cancelling}
              onClick={() => void handleCancel()}
            >
              {cancelling ? (
                <Loader2 aria-hidden className="size-3 animate-spin" />
              ) : null}
              Cancel run
            </Button>
          )}
        </div>
      </div>

      {error ? (
        <div
          role="status"
          aria-live="polite"
          className="border-b border-status-degraded-line bg-status-degraded-fill px-[22px] py-2 text-note text-status-degraded-text"
        >
          Showing the last loaded pipeline state. Refresh failed: {error}
        </div>
      ) : null}

      <div className="grid items-start gap-4 px-[22px] pt-[18px] pb-8 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Blueprint>
          <BoardHeader
            title="Step graph"
            meta={`${pipeline.steps.length} steps · max parallel ${pipeline.maxParallel || 1}`}
          />
          <div className="overflow-x-auto">
            <PipelineDAG
              steps={pipeline.steps}
              stepStatuses={pipeline.stepStatuses}
              selectedStep={activeStep}
              onStepSelect={handleSelectStep}
              nowMs={nowMs}
              className="min-w-[640px]"
            />
          </div>
          <PipelineStatStrip cells={statCells} nowMs={nowMs} />
        </Blueprint>

        <div className="flex flex-col gap-3.5">
          <Blueprint>
            <StepDetailPanel
              step={activeStepObj}
              status={activeStatus}
              logs={logs}
              logsLoading={logsLoading}
              onRetry={handleRetry}
              onSkip={handleSkip}
              resourceLabel={resourceLabel}
              onLoadFullLogs={() => setFullLogs(true)}
              showingFullLogs={fullLogs}
              nowMs={nowMs}
            />
          </Blueprint>

          {pipeline.artifacts.length > 0 ? (
            <Blueprint>
              <BoardHeader title="Artifacts" meta={`${pipeline.artifacts.length}`} />
              <ul>
                {pipeline.artifacts.map((artifact) => (
                  <ArtifactCard
                    key={`${artifact.producingStep}/${artifact.name}`}
                    artifact={artifact}
                    extraMeta={testMeta(artifact, run, runsAvailability)}
                  />
                ))}
              </ul>
            </Blueprint>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/**
 * Test counts live in the PIPELINE_RUNS record, not on the artifact. They are
 * only attached to the report artifact when that class says they are real.
 */
function testMeta(
  artifact: ArtifactRef,
  run: PipelineRunSummary | null,
  runs: Availability
): string | undefined {
  if (!hasNumerics(runs) || !run?.tests) return undefined
  if (!hasNumerics(availabilityOf(run.tests.state))) return undefined
  if (!/junit|test|report/i.test(artifact.name)) return undefined
  const tests = run.tests
  const parts = [`${tests.total} tests`]
  if (tests.failed > 0) parts.push(`${tests.failed} failed`)
  if (tests.flaked > 0) parts.push(`${tests.flaked} flaked`)
  return parts.join(" · ")
}

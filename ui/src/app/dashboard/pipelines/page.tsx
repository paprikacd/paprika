"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Suspense, useCallback, useMemo, useState } from "react"

import {
  DataClass,
  type Pipeline,
  type PipelineRunSummary,
} from "@/gen/paprika/v1/api_pb"
import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { StatusGlyph, StatusPill } from "@/components/ui/status-chip"
import { usePublishConsoleScope } from "@/components/layout/console-header"
import { useConnection } from "@/lib/connection-context"
import { parseFleetQuery } from "@/lib/fleet-query"
import { FLEET_REFRESH_INTERVAL_MS, useFleetRefresh } from "@/lib/fleet-refresh"

import { pipelineApi, useDataSources } from "./pipeline-data"
import {
  availabilityOf,
  classAvailability,
  hasNumerics,
  indexLatestRuns,
  isRenderable,
  lastRunLabel,
  phaseLabel,
  phaseTone,
  pipelineKey,
  stepProgress,
} from "./pipeline-model"

/**
 * `ListPipelines` is unpaginated, so the page — not the server — is what
 * stands between a pathological namespace and an unusable DOM. The cap is
 * declared rather than implied, and the shortfall is stated on screen.
 */
const MAX_ROWS = 500

/** One history page, indexed client-side, rather than one RPC per pipeline. */
const RUN_HISTORY_PAGE_SIZE = 200

export default function PipelinesPage() {
  return (
    <Suspense fallback={<PipelinesSkeleton />}>
      <PipelinesList />
    </Suspense>
  )
}

function PipelinesSkeleton() {
  return (
    <div className="px-[22px] py-[18px]">
      <div className="h-64 animate-pulse bg-inset" />
    </div>
  )
}

function PipelinesList() {
  const searchParams = useSearchParams()
  const raw = searchParams.toString()
  const query = useMemo(() => parseFleetQuery(raw).state, [raw])
  const { reportRequestOutcome } = useConnection()

  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null)
  const [runs, setRuns] = useState<readonly PipelineRunSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refreshedAt, setRefreshedAt] = useState<number | undefined>(undefined)

  const dataSources = useDataSources()
  const runsClass = classAvailability(dataSources, DataClass.PIPELINE_RUNS)
  const runsColumnVisible = isRenderable(runsClass)
  const runsHaveNumbers = hasNumerics(runsClass)

  // `ListPipelines` takes a single project; the scope bar allows several.
  // Narrowing server-side is only correct when the scope is unambiguous.
  const project = query.projects.length === 1 ? query.projects[0].name : ""
  const namespace = query.namespaces.length === 1 ? query.namespaces[0] : undefined

  const refresh = useCallback(async () => {
    try {
      const response = await pipelineApi().listPipelines({ project, namespace })
      setPipelines(response.pipelines)
      setError(null)
      setRefreshedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load pipelines")
      throw err
    }
  }, [project, namespace])

  useFleetRefresh(refresh, { onRequestOutcome: reportRequestOutcome })

  // Run history is a separate, separately-gated request: it only fires once
  // the capability probe says PIPELINE_RUNS can answer with real numbers.
  const refreshRuns = useCallback(async () => {
    if (!runsHaveNumbers) {
      setRuns([])
      return
    }
    try {
      const history = await pipelineApi().listPipelineRuns({
        namespace,
        pageSize: RUN_HISTORY_PAGE_SIZE,
      })
      setRuns(hasNumerics(availabilityOf(history.state)) ? history.runs : [])
    } catch {
      setRuns([])
    }
  }, [namespace, runsHaveNumbers])

  useFleetRefresh(refreshRuns, { enabled: runsHaveNumbers })

  usePublishConsoleScope({
    refreshedAt,
    isRefreshing: pipelines === null && error === null,
    intervalMs: FLEET_REFRESH_INTERVAL_MS,
  })

  const latestRuns = useMemo(() => indexLatestRuns(runs), [runs])

  const matched = useMemo(() => {
    if (!pipelines) return []
    const needle = query.q.trim().toLowerCase()
    if (!needle) return pipelines
    return pipelines.filter(
      (pipeline) =>
        pipeline.name.toLowerCase().includes(needle) ||
        pipeline.namespace.toLowerCase().includes(needle)
    )
  }, [pipelines, query.q])

  const rows = matched.slice(0, MAX_ROWS)
  const hidden = matched.length - rows.length

  return (
    <div>
      <div className="border-b border-rule bg-card px-[22px] py-4">
        <p className="font-mono text-kicker tracking-[0.14em] text-steel-600 uppercase">
          Delivery
        </p>
        <h1 className="mt-1 font-cond text-title leading-none font-semibold tracking-[0.01em]">
          Pipelines
        </h1>
      </div>

      <div className="px-[22px] pt-[18px] pb-8">
        {error && !pipelines ? (
          <div
            role="alert"
            className="border border-status-failed-line bg-status-failed-fill px-4 py-3 text-console text-status-failed-text"
          >
            {error}
          </div>
        ) : null}

        {error && pipelines ? (
          <div
            role="status"
            aria-live="polite"
            className="mb-3 border border-status-degraded-line bg-status-degraded-fill px-4 py-2 text-note text-status-degraded-text"
          >
            Showing the last loaded pipelines. Refresh failed: {error}
          </div>
        ) : null}

        {pipelines === null && !error ? (
          <>
            <p className="sr-only" role="status">
              Loading pipelines
            </p>
            <PipelinesSkeleton />
          </>
        ) : null}

        {pipelines !== null ? (
          <Blueprint>
            <BoardHeader
              title="Pipelines"
              meta={`${matched.length} of ${pipelines.length} in scope`}
            />
            {rows.length === 0 ? (
              <p className="px-3.5 py-8 text-center text-console text-muted-foreground">
                No pipelines match this scope.
              </p>
            ) : (
              <table className="w-full border-collapse text-console">
                <caption className="sr-only">
                  Pipelines in the current scope
                </caption>
                <thead>
                  <tr className="border-b border-rule bg-inset text-left">
                    <th scope="col" className="w-8 py-1.5 pl-3.5">
                      <span className="sr-only">State</span>
                    </th>
                    <th
                      scope="col"
                      className="py-1.5 font-mono text-kicker font-normal tracking-[0.14em] text-neutral-600 uppercase"
                    >
                      Pipeline
                    </th>
                    <th
                      scope="col"
                      className="py-1.5 font-mono text-kicker font-normal tracking-[0.14em] text-neutral-600 uppercase"
                    >
                      Phase
                    </th>
                    <th
                      scope="col"
                      className="py-1.5 font-mono text-kicker font-normal tracking-[0.14em] text-neutral-600 uppercase"
                    >
                      Steps
                    </th>
                    {runsColumnVisible ? (
                      <th
                        scope="col"
                        className="py-1.5 pr-3.5 font-mono text-kicker font-normal tracking-[0.14em] text-neutral-600 uppercase"
                      >
                        Last run
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((pipeline) => {
                    const progress = stepProgress(pipeline)
                    const tone = phaseTone(pipeline.phase)
                    const run = latestRuns.get(
                      pipelineKey(pipeline.namespace, pipeline.name)
                    )
                    const lastRun = runsHaveNumbers ? lastRunLabel(run) : null
                    return (
                      <tr
                        key={pipelineKey(pipeline.namespace, pipeline.name)}
                        className="border-b border-rule-soft even:bg-zebra hover:bg-inset"
                      >
                        <td className="py-2 pl-3.5">
                          <StatusGlyph
                            tone={tone}
                            label={phaseLabel(pipeline.phase)}
                          />
                        </td>
                        <th scope="row" className="py-2 pr-3 text-left font-normal">
                          <Link
                            href={`/dashboard/pipelines/detail/?namespace=${encodeURIComponent(pipeline.namespace)}&name=${encodeURIComponent(pipeline.name)}`}
                            className="font-cond text-name font-semibold hover:underline"
                          >
                            {pipeline.name}
                          </Link>
                          <span className="block font-mono text-meta text-neutral-600">
                            {pipeline.namespace}
                          </span>
                        </th>
                        <td className="py-2 pr-3">
                          <StatusPill tone={tone} label={phaseLabel(pipeline.phase)} />
                        </td>
                        <td className="py-2 pr-3 font-mono text-note tabular-nums">
                          {progress.total > 0
                            ? `${progress.done}/${progress.total}`
                            : ""}
                        </td>
                        {runsColumnVisible ? (
                          <td className="py-2 pr-3.5 font-mono text-note text-neutral-700">
                            {lastRun ?? (
                              <span className="text-neutral-500">
                                {runsClass.kind === "unavailable"
                                  ? runsClass.reason
                                  : "No run recorded"}
                              </span>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            {hidden > 0 ? (
              <p
                role="status"
                className="border-t border-rule px-3.5 py-1.5 font-mono text-meta text-neutral-700"
              >
                {hidden} further pipelines not listed — narrow the scope to see them
              </p>
            ) : null}
          </Blueprint>
        ) : null}
      </div>
    </div>
  )
}

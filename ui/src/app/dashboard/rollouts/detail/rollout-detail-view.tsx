"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useMemo } from "react"

import { RolloutDebugPanel } from "@/components/dashboard/rollout-debug-panel"
import { usePublishConsoleScope } from "@/components/layout/console-header"
import { StatusPill } from "@/components/ui/status-chip"
import { rolloutLabel } from "@/lib/status-tone"
import { FOCUSED_REFRESH_INTERVAL_MS } from "@/lib/fleet-refresh"

import { AnalysisBoard } from "../analysis-board"
import { RolloutActions } from "../rollout-actions"
import { PageBand, PageBody, useNow } from "../rollout-chrome"
import { RolloutLog } from "../rollout-log"
import {
  activeStepNumber,
  analysisResultsFromConditions,
  buildAnalysisRows,
  formatDurationMs,
  rolloutPhaseState,
  rolloutPhaseTone,
  selectAnalysisRun,
} from "../rollout-model"
import {
  defaultRolloutClient,
  useAnalysisRuns,
  useDataSources,
  useRollout,
  type RolloutConsoleClient,
} from "../rollout-queries"
import { RolloutBoardSkeleton } from "../rollout-skeleton"
import { TrafficLadder } from "../traffic-ladder"

/**
 * The rollout detail screen: the traffic ladder from `canarySteps`, the
 * analysis table from the rollout's declared checks joined to whatever the
 * controller actually observed, and the log from `conditions[]`. Every board
 * draws only what the API returned for this object.
 */
export function RolloutDetailView({
  client = defaultRolloutClient(),
}: {
  client?: RolloutConsoleClient
} = {}) {
  const searchParams = useSearchParams()
  const namespace = searchParams.get("namespace") ?? ""
  const name = searchParams.get("name") ?? ""
  const now = useNow()

  const sources = useDataSources(client)
  const detail = useRollout(client, namespace, name)
  const rollout = detail.data?.rollout

  const analysisRuns = useAnalysisRuns(
    client,
    namespace,
    Boolean(rollout && rollout.analysisChecks.length > 0),
  )

  usePublishConsoleScope({
    indexGeneration: sources.indexGeneration,
    refreshedAt: detail.dataUpdatedAt || undefined,
    isRefreshing: detail.isFetching,
    intervalMs: FOCUSED_REFRESH_INTERVAL_MS,
  })

  const analysisRows = useMemo(() => {
    if (!rollout) return []
    const run = selectAnalysisRun(
      analysisRuns.data?.analysisRuns ?? [],
      rollout,
    )
    const results = run?.results.length
      ? run.results
      : analysisResultsFromConditions(rollout.conditions)
    return buildAnalysisRows(rollout.analysisChecks, results)
  }, [rollout, analysisRuns.data])

  const breadcrumb = (
    <>
      <Link href="/dashboard/rollouts/">Rollouts</Link>
      {namespace ? ` / ${namespace}` : ""}
      {name ? ` / ${name}` : ""}
    </>
  )

  if (detail.isPending) {
    return (
      <>
        <PageBand breadcrumb={breadcrumb} title={name || "Rollout"} />
        <PageBody>
          <RolloutBoardSkeleton label="Loading rollout" />
        </PageBody>
      </>
    )
  }

  if (detail.isError || !rollout) {
    return (
      <>
        <PageBand breadcrumb={breadcrumb} title={name || "Rollout"} />
        <PageBody>
          <p className="text-reason text-status-failed-text">
            {detail.isError
              ? "This rollout could not be loaded."
              : "No rollout matches that namespace and name."}
          </p>
        </PageBody>
      </>
    )
  }

  const stepNumber = activeStepNumber(rollout)
  const phaseLabel = rolloutLabel(rolloutPhaseState(rollout))
  const held = rollout.paused || rollout.phase === "Paused"
  const stepAge =
    now && rollout.currentStepStartedAt
      ? formatDurationMs(BigInt(now) - rollout.currentStepStartedAt)
      : ""

  const subline = [
    rollout.strategyType,
    rollout.targetKind ? `${rollout.targetKind}/${rollout.targetName}` : "",
    stepAge ? `${held ? "held" : "in step"} ${stepAge}` : "",
    rollout.message,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <>
      <PageBand
        breadcrumb={breadcrumb}
        title={rollout.name}
        badge={
          <StatusPill
            tone={rolloutPhaseTone(rollout)}
            label={
              stepNumber
                ? `${phaseLabel} at step ${stepNumber}`
                : phaseLabel
            }
          />
        }
        subline={subline || undefined}
        actions={
          <RolloutActions
            client={client}
            rollout={rollout}
            onCompleted={() => detail.refetch()}
          />
        }
      />
      <PageBody>
        <TrafficLadder rollout={rollout} />
        <div className="grid gap-4 xl:grid-cols-7">
          {analysisRows.length > 0 ? (
            <div className="min-w-0 xl:col-span-4">
              <AnalysisBoard rows={analysisRows} paused={held} />
            </div>
          ) : null}
          <div
            className={
              analysisRows.length > 0
                ? "min-w-0 xl:col-span-3"
                : "min-w-0 xl:col-span-7"
            }
          >
            <RolloutLog conditions={rollout.conditions} />
          </div>
        </div>
        <RolloutDebugPanel rollout={rollout} />
      </PageBody>
    </>
  )
}

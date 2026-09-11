"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useId, useMemo, useState } from "react"

import { usePublishConsoleScope } from "@/components/layout/console-header"
import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { Seg, type SegOption } from "@/components/ui/seg"
import { StatusPill } from "@/components/ui/status-chip"
import { DataClass, type Rollout } from "@/gen/paprika/v1/api_pb"
import { FLEET_REFRESH_INTERVAL_MS } from "@/lib/fleet-refresh"
import { rolloutLabel } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

import {
  ActionStatus,
  SETTLED_PHASES,
  useRolloutAction,
} from "./rollout-actions"
import {
  ConsoleButton,
  EmptyNote,
  PageBand,
  PageBody,
  useNow,
} from "./rollout-chrome"
import { RolloutHistoryBoard } from "./rollout-history-board"
import {
  findDataSource,
  gateFor,
  rolloutPhaseState,
  rolloutPhaseTone,
} from "./rollout-model"
import {
  RECENT_WINDOW_MS,
  defaultRolloutClient,
  useDataSources,
  useRolloutHistory,
  useRolloutList,
  type RolloutConsoleClient,
} from "./rollout-queries"
import { RolloutBoardSkeleton } from "./rollout-skeleton"

type Tab = "inflight" | "recent"

/**
 * How many rows the in-flight table will draw. `ListRollouts` is unpaginated,
 * so the ceiling is the console's, not the server's — and it is stated on the
 * page rather than hidden, because a silently truncated list is a lie about
 * the size of the fleet.
 */
const MAX_ROWS = 250

export function RolloutsView({
  client = defaultRolloutClient(),
}: {
  client?: RolloutConsoleClient
} = {}) {
  const searchParams = useSearchParams()
  const namespace = searchParams.get("namespace") ?? ""
  const requestedTab = searchParams.get("tab") === "recent" ? "recent" : "inflight"
  const [tab, setTab] = useState<Tab>(requestedTab)
  const now = useNow()
  const statusId = useId()

  const sources = useDataSources(client)
  const list = useRolloutList(client, namespace)
  const rollouts = useMemo(
    () => list.data?.rollouts ?? [],
    [list.data],
  )

  /**
   * The `ROLLOUT_HISTORY` probe decides whether the tab exists at all. When it
   * is NOT_CONFIGURED the feed is never queried and the option is never
   * offered — an empty "Recent · 7d" table would read as "no rollouts have
   * completed", which is a different and much worse claim than "nothing is
   * recording them".
   */
  const historyProbe = sources.reading(DataClass.ROLLOUT_HISTORY)
  const probeSettled = sources.isSettled
  const history = useRolloutHistory(
    client,
    namespace,
    RECENT_WINDOW_MS,
    probeSettled && gateFor(historyProbe).disposition !== "absent",
  )
  const historyGate = gateFor(historyProbe, history.data?.state)
  const historyOffered = probeSettled && historyGate.disposition !== "absent"
  const activeTab: Tab = tab === "recent" && !historyOffered ? "inflight" : tab

  usePublishConsoleScope({
    indexGeneration: sources.indexGeneration,
    refreshedAt: list.dataUpdatedAt || undefined,
    isRefreshing: list.isFetching || history.isFetching,
    intervalMs: FLEET_REFRESH_INTERVAL_MS,
  })

  const { pending, report, run } = useRolloutAction(() => list.refetch())

  const options: SegOption<Tab>[] = [
    {
      value: "inflight",
      label: "In flight",
      hint: list.isSuccess ? String(rollouts.length) : undefined,
    },
    ...(historyOffered
      ? [{ value: "recent" as const, label: "Recent · 7d" }]
      : []),
  ]

  return (
    <>
      <PageBand
        breadcrumb="Delivery / Rollouts"
        title="Rollouts"
        subline={
          namespace
            ? `namespace ${namespace}`
            : "every rollout the control plane is reconciling"
        }
        actions={
          options.length > 1 ? (
            <Seg
              options={options}
              value={activeTab}
              onValueChange={setTab}
              label="Rollout view"
              className="h-[30px]"
            />
          ) : undefined
        }
      />
      <PageBody>
        {activeTab === "recent" ? (
          <RolloutHistoryBoard
            gate={historyGate}
            response={history.data}
            isPending={history.isPending}
            now={now}
          />
        ) : list.isPending ? (
          <RolloutBoardSkeleton label="Loading rollouts" />
        ) : list.isError ? (
          <Blueprint>
            <BoardHeader title="In flight" />
            <p className="px-3.5 py-4 text-reason text-status-failed-text">
              Rollouts could not be loaded.
            </p>
          </Blueprint>
        ) : (
          <Blueprint>
            <BoardHeader
              title="In flight"
              meta={`${rollouts.length} ${rollouts.length === 1 ? "rollout" : "rollouts"}`}
            />
            {rollouts.length === 0 ? (
              <EmptyNote>
                No rollouts are in flight
                {namespace ? ` in ${namespace}` : ""}.
              </EmptyNote>
            ) : (
              <InFlightTable
                rollouts={rollouts.slice(0, MAX_ROWS)}
                client={client}
                pending={pending}
                run={run}
                statusId={statusId}
              />
            )}
            {rollouts.length > MAX_ROWS ? (
              <p className="border-t border-rule-soft px-3.5 py-2 font-mono text-meta text-neutral-600">
                {`showing the first ${MAX_ROWS} of ${rollouts.length} rollouts`}
              </p>
            ) : null}
          </Blueprint>
        )}
        <ActionStatus id={statusId} report={report} />
      </PageBody>
    </>
  )
}

function InFlightTable({
  rollouts,
  client,
  pending,
  run,
  statusId,
}: {
  rollouts: readonly Rollout[]
  client: RolloutConsoleClient
  pending: string | null
  run: (key: string, label: string, call: () => Promise<unknown>) => Promise<void>
  statusId: string
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <caption className="sr-only">
          Rollouts the control plane is currently reconciling.
        </caption>
        <thead>
          <tr className="border-b border-rule-strong bg-muted">
            <Head className="w-full max-w-0 text-left">ROLLOUT</Head>
            <Head>TARGET</Head>
            <Head>STRATEGY</Head>
            <Head className="text-right">STEP</Head>
            <Head className="text-right">WEIGHT</Head>
            <Head>PHASE</Head>
            <Head className="text-right">ACTIONS</Head>
          </tr>
        </thead>
        <tbody>
          {rollouts.map((rollout) => {
            const key = `${rollout.namespace}/${rollout.name}`
            const steps = rollout.canarySteps.length
            const settled = SETTLED_PHASES.has(rollout.phase)
            return (
              <tr key={key} className="border-b border-rule-soft">
                <td className="w-full max-w-0 px-3.5 py-2">
                  <Link
                    href={`/dashboard/rollouts/detail/?namespace=${encodeURIComponent(rollout.namespace)}&name=${encodeURIComponent(rollout.name)}`}
                    className="block truncate font-cond text-name font-semibold tracking-[0.02em]"
                  >
                    {rollout.name}
                  </Link>
                  <span className="block truncate font-mono text-meta text-neutral-600">
                    {rollout.namespace}
                  </span>
                </td>
                <td className="px-3.5 py-2 font-mono text-note whitespace-nowrap text-muted-foreground">
                  {rollout.targetKind ? (
                    `${rollout.targetKind}/${rollout.targetName}`
                  ) : (
                    <span className="sr-only">Not reported</span>
                  )}
                </td>
                <td className="px-3.5 py-2 text-note whitespace-nowrap">
                  {rollout.strategyType || (
                    <span className="sr-only">Not reported</span>
                  )}
                </td>
                <td className="px-3.5 py-2 text-right font-mono text-note tabular-nums whitespace-nowrap">
                  {steps > 0 ? (
                    `${Math.min(rollout.currentStep + 1, steps)} / ${steps}`
                  ) : (
                    <span className="sr-only">No steps declared</span>
                  )}
                </td>
                <td className="px-3.5 py-2 whitespace-nowrap">
                  <WeightCell rollout={rollout} />
                </td>
                <td className="px-3.5 py-2 whitespace-nowrap">
                  <StatusPill
                    tone={rolloutPhaseTone(rollout)}
                    label={rolloutLabel(rolloutPhaseState(rollout))}
                  />
                </td>
                <td className="px-3.5 py-2 text-right whitespace-nowrap">
                  <span className="inline-flex gap-1.5">
                    <ConsoleButton
                      disabled={pending !== null || settled}
                      aria-describedby={statusId}
                      aria-label={`Promote ${rollout.name}`}
                      onClick={() =>
                        run(`${key}:promote`, `Promote ${rollout.name}`, () =>
                          client.promoteRollout({
                            namespace: rollout.namespace,
                            name: rollout.name,
                          }),
                        )
                      }
                    >
                      Promote
                    </ConsoleButton>
                    <ConsoleButton
                      tone="destructive"
                      disabled={pending !== null || settled}
                      aria-describedby={statusId}
                      aria-label={`Abort ${rollout.name}`}
                      onClick={() =>
                        run(`${key}:abort`, `Abort ${rollout.name}`, () =>
                          client.abortRollout({
                            namespace: rollout.namespace,
                            name: rollout.name,
                          }),
                        )
                      }
                    >
                      Abort
                    </ConsoleButton>
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The weight, plus a bar of the same width. One element per row, so the table
 * stays a fixed cost per rollout however many are in flight.
 */
function WeightCell({ rollout }: { rollout: Rollout }) {
  if (rollout.canarySteps.length === 0) {
    return <span className="sr-only">No weighted traffic</span>
  }
  const weight = Math.min(Math.max(rollout.currentWeight, 0), 100)
  return (
    <span className="flex items-center justify-end gap-2">
      <span className="h-1.5 w-16 flex-none border border-rule bg-card">
        <span
          aria-hidden="true"
          style={{ width: `${weight}%` }}
          className="block h-full bg-primary"
        />
      </span>
      <span className="font-mono text-note tabular-nums">{weight}%</span>
    </span>
  )
}

function Head({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <th
      scope="col"
      className={cn(
        "h-7 px-3.5 font-mono text-kicker font-normal tracking-[0.14em] whitespace-nowrap text-muted-foreground",
        className ?? "text-left",
      )}
    >
      {children}
    </th>
  )
}

"use client"

import Link from "next/link"
import { useMemo, useState } from "react"

import { usePublishConsoleScope } from "@/components/layout/console-header"
import { Seg } from "@/components/ui/seg"
import { DataClass } from "@/gen/paprika/v1/api_pb"
import { fromQueryApplicationsResponse } from "@/lib/fleet-client"
import { useConnection } from "@/lib/connection-context"
import { FLEET_REFRESH_INTERVAL_MS, useFleetRefresh } from "@/lib/fleet-refresh"
import type { FleetQueryState } from "@/lib/fleet-query"
import { cn } from "@/lib/utils"

import { AttentionBoard } from "./attention-board"
import { ClustersBoard } from "./clusters-board"
import { StaleBadge, UnavailableNote } from "./data-notice"
import {
  dataSourceFor,
  formatAge,
  isStale,
  numbersAreReal,
  plural,
  surfaceExists,
} from "./data-state"
import { LifecycleBoard, summarizeLifecycle } from "./lifecycle-board"
import { BoardEmpty, OverviewBoard } from "./overview-board"
import {
  BOARD_DEFINITIONS,
  useOverviewLayout,
  type BoardId,
} from "./overview-layout"
import { inventoryHref } from "./overview-links"
import { PostureBoard } from "./posture-board"
import { InFlightRollouts, RecentRollouts, isInFlight } from "./rollouts-board"
import { TriggersBoard } from "./triggers-board"
import {
  useOverviewData,
  type OverviewClient,
} from "./use-overview-data"

const POSTURE_FORMATS = [
  { value: "bars" as const, label: "Bars" },
  { value: "heatmap" as const, label: "Heatmap" },
]

/**
 * The operations overview: six numbered boards over one fleet index.
 *
 * Boards 02 and 03 are exact — `GetSystemStatus` buckets the whole index
 * server-side and ranks the attention window there. Everything else is gated on
 * `GetDataSources`, so a board whose data class is not configured is absent
 * from the page rather than present and empty.
 */
export function OverviewView({
  state,
  client,
}: {
  state: FleetQueryState
  client?: OverviewClient
}) {
  const data = useOverviewData(state, client)
  const layout = useOverviewLayout()
  const [customising, setCustomising] = useState(false)
  const { reportRequestOutcome } = useConnection()

  // React Query already fetches on mount; this only adds the bounded poll.
  useFleetRefresh(data.refresh, {
    onRequestOutcome: reportRequestOutcome,
    refreshOnMount: false,
  })

  const page = useMemo(
    () =>
      data.applications
        ? fromQueryApplicationsResponse(data.applications)
        : undefined,
    [data.applications]
  )

  usePublishConsoleScope({
    facets: page?.facets,
    indexGeneration: data.indexGeneration,
    refreshedAt: data.refreshedAt,
    isRefreshing: data.isRefreshing,
    intervalMs: FLEET_REFRESH_INTERVAL_MS,
  })

  const now = data.refreshedAt ?? 0
  const status = data.systemStatus
  const sampled = useMemo(
    () => data.applications?.applications ?? [],
    [data.applications]
  )
  const total = status?.total ?? data.applications?.total ?? BigInt(0)

  const lifecycleSource = dataSourceFor(data.sources, DataClass.LIFECYCLE)
  const eventsSource = dataSourceFor(data.sources, DataClass.SOURCE_EVENTS)
  const historySource = dataSourceFor(data.sources, DataClass.ROLLOUT_HISTORY)
  const inventorySource = dataSourceFor(data.sources, DataClass.CLUSTER_INVENTORY)
  const capacitySource = dataSourceFor(data.sources, DataClass.CLUSTER_CAPACITY)

  const lifecycleVectors = useMemo(
    () =>
      sampled.flatMap((application) =>
        application.lifecycle ? [application.lifecycle.states] : []
      ),
    [sampled]
  )

  const visible = (id: BoardId) => !layout.isHidden(id)
  const showLifecycle = visible("lifecycle") && surfaceExists(lifecycleSource?.state)
  const showPosture = visible("posture")
  const showAttention = visible("attention")
  const showInflight = visible("inflight")
  const showTriggers = visible("triggers") && surfaceExists(eventsSource?.state)
  const showClusters =
    visible("clusters") &&
    (surfaceExists(inventorySource?.state) || surfaceExists(capacitySource?.state))

  const historyAvailable = surfaceExists(historySource?.state)
  const rolloutTab =
    historyAvailable && layout.layout.rolloutTab === "recent"
      ? "recent"
      : "inflight"
  const inFlight = data.rollouts.filter(isInFlight)

  const boardProps = (id: BoardId) => ({
    id,
    open: layout.isOpen(id),
    onToggleOpen: () => layout.toggleCollapsed(id),
    customising,
    onHide: () => layout.hide(id),
  })

  const definition = (id: BoardId) =>
    BOARD_DEFINITIONS.find((board) => board.id === id)!

  return (
    <div className="flex flex-col gap-5 px-5 pt-5 pb-8">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="font-mono text-kicker tracking-[0.2em] text-steel-600 uppercase">
            Fleet · all projects
          </p>
          <h1 className="mt-1 font-cond text-title leading-none font-semibold tracking-[0.01em]">
            Operations overview
          </h1>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setCustomising((current) => !current)}
            aria-pressed={customising}
            className={cn(
              "inline-flex h-8 cursor-pointer items-center border px-3 font-cond text-label font-semibold",
              customising
                ? "border-primary bg-primary text-primary-foreground"
                : "border-rule text-foreground hover:bg-foreground/[0.07]"
            )}
          >
            {customising ? "Done" : "Customise"}
          </button>
          <Link
            href={inventoryHref(state)}
            className="inline-flex h-8 items-center border border-primary bg-primary px-3 font-cond text-label font-semibold text-primary-foreground no-underline hover:no-underline"
          >
            Open inventory
          </Link>
        </div>
      </div>

      {customising ? (
        <div
          role="group"
          aria-label="Boards"
          className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border border-dashed border-primary bg-scope-active px-3.5 py-2.5"
        >
          <span className="font-mono text-kicker tracking-[0.16em] text-steel-800 uppercase">
            Boards
          </span>
          <div className="flex flex-wrap gap-1.5">
            {BOARD_DEFINITIONS.map((board) => {
              const shown = !layout.isHidden(board.id)
              return (
                <button
                  key={board.id}
                  type="button"
                  aria-pressed={shown}
                  onClick={() => layout.toggleHidden(board.id)}
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-1.5 rounded-[2px] border px-2 py-0.5 text-note font-semibold pointer-coarse:min-h-11",
                    shown
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-rule bg-card text-muted-foreground line-through"
                  )}
                >
                  <span aria-hidden="true" className="font-mono text-kicker opacity-70">
                    {board.index}
                  </span>
                  {board.chip}
                </button>
              )
            })}
          </div>
          <p className="flex-1 text-note text-steel-800">
            Click a board to show or hide it. Hidden boards keep their settings.
            Layout is saved in this browser.
          </p>
          <button
            type="button"
            onClick={layout.reset}
            className="cursor-pointer rounded-[2px] border border-primary bg-card px-2 py-0.5 text-note text-steel-800 hover:bg-scope-active"
          >
            Reset to default
          </button>
        </div>
      ) : null}

      {showLifecycle ? (
        <OverviewBoard
          {...boardProps("lifecycle")}
          index={definition("lifecycle").index}
          title={definition("lifecycle").title}
          meta={
            isStale(lifecycleSource?.state) ? (
              <StaleBadge
                observedAtUnixMs={lifecycleSource?.observedAtUnixMs}
                now={now}
              />
            ) : undefined
          }
        >
          {!numbersAreReal(lifecycleSource?.state) ? (
            <div className="px-3.5 py-4">
              <UnavailableNote reason={lifecycleSource?.unavailableReason ?? ""} />
            </div>
          ) : lifecycleVectors.length === 0 ? (
            <BoardEmpty>
              No lifecycle data reported for the applications in scope.
            </BoardEmpty>
          ) : (
            <LifecycleBoard
              phases={summarizeLifecycle(lifecycleVectors)}
              sampleSize={lifecycleVectors.length}
              total={total}
            />
          )}
        </OverviewBoard>
      ) : null}

      {showPosture || showAttention ? (
        <div
          className={cn(
            "grid gap-4",
            showPosture && showAttention
              ? "lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1.25fr)]"
              : "grid-cols-1"
          )}
        >
          {showPosture ? (
            <OverviewBoard
              {...boardProps("posture")}
              index={definition("posture").index}
              title={definition("posture").title}
              controls={
                <Seg
                  label="Health posture format"
                  options={POSTURE_FORMATS}
                  value={layout.layout.postureFormat}
                  onValueChange={(value) => layout.set({ postureFormat: value })}
                />
              }
            >
              {status ? (
                <PostureBoard
                  health={status.health}
                  total={total}
                  applications={sampled}
                  format={layout.layout.postureFormat}
                  heatGroup={layout.layout.heatGroup}
                  heatDetail={layout.layout.heatDetail}
                  onHeatGroupChange={(heatGroup) => layout.set({ heatGroup })}
                  onHeatDetailChange={(heatDetail) => layout.set({ heatDetail })}
                  state={state}
                />
              ) : (
                <BoardEmpty>Fleet status is loading.</BoardEmpty>
              )}
            </OverviewBoard>
          ) : null}

          {showAttention ? (
            <OverviewBoard
              {...boardProps("attention")}
              index={definition("attention").index}
              title={definition("attention").title}
              meta="ranked by blast radius"
            >
              {status ? (
                <AttentionBoard
                  applications={status.attention}
                  attentionTotal={status.attentionTotal}
                  hasMore={status.hasMoreAttention}
                  now={now}
                  state={state}
                />
              ) : (
                <BoardEmpty>Fleet status is loading.</BoardEmpty>
              )}
            </OverviewBoard>
          ) : null}
        </div>
      ) : null}

      {showInflight || showTriggers ? (
        <div
          className={cn(
            "grid gap-4",
            showInflight && showTriggers
              ? "lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]"
              : "grid-cols-1"
          )}
        >
          {showInflight ? (
            <OverviewBoard
              {...boardProps("inflight")}
              index={definition("inflight").index}
              title={definition("inflight").title}
              controls={
                historyAvailable ? (
                  <Seg
                    label="Rollout window"
                    options={[
                      {
                        value: "inflight" as const,
                        label: "In flight",
                        hint: String(inFlight.length),
                      },
                      { value: "recent" as const, label: "Recent", hint: "7d" },
                    ]}
                    value={rolloutTab}
                    onValueChange={(value) => layout.set({ rolloutTab: value })}
                  />
                ) : null
              }
            >
              {rolloutTab === "recent" ? (
                data.rolloutHistory &&
                numbersAreReal(data.rolloutHistory.state) ? (
                  <RecentRollouts history={data.rolloutHistory} now={now} />
                ) : (
                  <div className="px-3.5 py-4">
                    <UnavailableNote
                      reason={
                        data.rolloutHistory?.state !== undefined
                          ? (historySource?.unavailableReason ?? "")
                          : "Rollout history is loading."
                      }
                    />
                  </div>
                )
              ) : (
                <InFlightRollouts rollouts={inFlight} />
              )}
            </OverviewBoard>
          ) : null}

          {showTriggers ? (
            <OverviewBoard
              {...boardProps("triggers")}
              index={definition("triggers").index}
              title={definition("triggers").title}
              meta="last 24h"
            >
              {data.sourceEvents && numbersAreReal(data.sourceEvents.state) ? (
                <TriggersBoard events={data.sourceEvents.events} now={now} />
              ) : (
                <div className="px-3.5 py-4">
                  <UnavailableNote
                    reason={eventsSource?.unavailableReason ?? ""}
                  />
                </div>
              )}
            </OverviewBoard>
          ) : null}
        </div>
      ) : null}

      {showClusters ? (
        <OverviewBoard
          {...boardProps("clusters")}
          index={definition("clusters").index}
          title={definition("clusters").title}
          meta={
            capacitySource?.provider
              ? `${capacitySource.provider} · ${formatAge(capacitySource.observedAtUnixMs, now)} ago`
              : undefined
          }
        >
          <ClustersBoard clusters={data.clusters} />
        </OverviewBoard>
      ) : null}

      {data.isLoading ? (
        <p role="status" className="text-note text-muted-foreground">
          Loading the fleet index…
        </p>
      ) : null}

      {!data.isLoading && !status ? (
        <p role="status" className="text-note text-status-failed-text">
          Fleet status is unavailable. The console will retry.
        </p>
      ) : null}

      <p className="sr-only">
        {total.toString()} {plural(Number(total), "application")} indexed.
      </p>
    </div>
  )
}

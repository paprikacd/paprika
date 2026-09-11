"use client"

import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useCallback, useMemo } from "react"

import { FleetMatrix } from "@/components/fleet/fleet-matrix"
import { FleetStateNotice } from "@/components/fleet/fleet-states"
import { usePublishConsoleScope } from "@/components/layout/console-header"
import { Seg } from "@/components/ui/seg"
import { StatusGlyph } from "@/components/ui/status-chip"
import { useConnection } from "@/lib/connection-context"
import type { FleetHealthStatus, FleetMatrixHeader } from "@/lib/fleet-client"
import {
  mergeFleetQuery,
  parseFleetQuery,
  serializeFleetQuery,
  type FleetQueryState,
} from "@/lib/fleet-query"
import { FLEET_REFRESH_INTERVAL_MS, useFleetRefresh } from "@/lib/fleet-refresh"
import { STATUS_TONES, toneRank, type StatusTone } from "@/lib/status-tone"
import { useFleetData } from "@/lib/use-fleet-data"

/**
 * The fleet map: stages or projects down the side, clusters across the top,
 * and the health mix of every intersection in between. It is `QueryFleetMatrix`
 * rendered directly — rows, columns and cells map onto the grid one for one —
 * so the page never has to reconcile two sources of truth.
 *
 * The design draws one clickable square per application. The API returns
 * aggregates, not identities, so a square here stands for one target of a
 * known health rather than a named application, and a cell links to the
 * application list filtered to that intersection: the same destination, by a
 * route the wire can actually justify. That choice is also what keeps the
 * page bounded — see `FleetMatrix` for the caps.
 */

const ROW_OPTIONS = [
  { value: "stage" as const, label: "Stage" },
  { value: "project" as const, label: "Project" },
]

type RowDimension = (typeof ROW_OPTIONS)[number]["value"]

const HEALTH_TONE: Record<FleetHealthStatus, StatusTone> = {
  healthy: "healthy",
  progressing: "progressing",
  degraded: "degraded",
  failed: "failed",
  missing: "missing",
  unknown: "unknown",
  unspecified: "unknown",
}

export function FleetMapView() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { reportRequestOutcome } = useConnection()

  const raw = searchParams.toString()
  // The stage axis is this view's default, which is not the shared default for
  // the `rows` parameter, so an absent parameter is read as "stage" and every
  // change writes the value back explicitly.
  const rowsBy: RowDimension =
    searchParams.get("rows") === "project" ? "project" : "stage"
  const state = useMemo<FleetQueryState>(
    () =>
      mergeFleetQuery(parseFleetQuery(raw).state, {
        view: "matrix",
        rows: rowsBy,
        columns: "cluster",
      }),
    [raw, rowsBy]
  )

  const fleet = useFleetData(state)
  useFleetRefresh(fleet.refresh, {
    onRequestOutcome: reportRequestOutcome,
    refreshOnMount: false,
  })

  const result =
    fleet.displayData?.kind === "matrix" ? fleet.displayData.result : undefined
  usePublishConsoleScope({
    facets: result?.facets,
    indexGeneration: result?.indexGeneration,
    // No `refreshedAt`: `useFleetData` does not surface the moment its query
    // resolved, and reading the clock during render would make the age a
    // property of the paint rather than of the data. The header falls back to
    // reporting the poll cadence, which is true either way.
    isRefreshing: fleet.isLoading || fleet.isStale,
    intervalMs: FLEET_REFRESH_INTERVAL_MS,
  })

  const setRows = useCallback(
    (next: RowDimension) => {
      const params = serializeFleetQuery(mergeFleetQuery(state, { rows: next }))
      params.set("rows", next)
      router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [pathname, router, state]
  )

  const cellHref = useCallback(
    (row: FleetMatrixHeader, column: FleetMatrixHeader) => {
      const params = serializeFleetQuery(
        mergeFleetQuery(state, {
          view: "table",
          clusters: column.object ? [column.object] : [],
          stages: rowsBy === "stage" && row.value ? [row.value] : [],
          projects: rowsBy === "project" && row.object ? [row.object] : [],
        })
      )
      return `/dashboard/applications/?${params.toString()}`
    },
    [rowsBy, state]
  )

  const legend = useMemo(() => legendTones(result?.cells ?? []), [result])

  return (
    <div className="px-5 pt-4 pb-8">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-x-5 gap-y-3">
        <div>
          <p className="font-mono text-kicker tracking-[0.2em] text-steel-600 uppercase">
            Topology
          </p>
          <h1 className="mt-1 font-cond text-title leading-none font-semibold tracking-[0.01em]">
            Cluster &amp; fleet map
          </h1>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
          {legend.length > 0 ? (
            <ul aria-label="Health legend" className="flex items-center gap-2.5">
              {legend.map((tone) => (
                <li
                  key={tone}
                  className="inline-flex items-center gap-1.5 text-note text-muted-foreground"
                >
                  <StatusGlyph tone={tone} aria-hidden />
                  {STATUS_TONES[tone].label}
                </li>
              ))}
            </ul>
          ) : null}
          <Seg
            label="Group rows by"
            options={ROW_OPTIONS}
            value={rowsBy}
            onValueChange={setRows}
            className="h-7"
          />
        </div>
      </div>

      <FleetStateNotice status={fleet.status} />

      {result ? (
        <FleetMatrix
          result={result}
          label={rowsBy === "stage" ? "Stages by cluster" : "Projects by cluster"}
          cellHref={cellHref}
        />
      ) : null}

      <p className="mt-3 max-w-prose text-note text-muted-foreground">
        Each square is one target at one cluster, coloured and marked by its
        health. A cell holding more targets than fit reports one glyph per health
        state with its exact count instead. Selecting a cell opens the
        applications filtered to that intersection. Cluster node counts and
        regions are not part of the fleet index; the Clusters page reports
        whatever the inventory source provides.
      </p>
    </div>
  )
}

/**
 * The legend names the states actually on screen. A fixed legend would claim
 * the fleet has a state it does not, and hide one it does.
 */
function legendTones(
  cells: readonly { health: readonly { health: FleetHealthStatus; count: bigint }[] }[]
): StatusTone[] {
  const present = new Set<StatusTone>()
  for (const cell of cells) {
    for (const bucket of cell.health) {
      if (bucket.count > BigInt(0)) present.add(HEALTH_TONE[bucket.health] ?? "unknown")
    }
  }
  return [...present].sort((left, right) => toneRank(left) - toneRank(right))
}

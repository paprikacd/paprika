"use client"

import Link from "next/link"

import { StatusGlyph } from "@/components/ui/status-chip"
import {
  FleetHealth,
  type ApplicationSummary,
  type FleetHealthBucket,
} from "@/gen/paprika/v1/api_pb"
import type { FleetHealth as FleetHealthValue } from "@/lib/fleet-query"
import type { FleetQueryState } from "@/lib/fleet-query"
import { STATUS_TONES, healthTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

import { plural } from "./data-state"
import type { HeatDetail, HeatGroup, PostureFormat } from "./overview-layout"
import { inventoryHref } from "./overview-links"
import { PostureHeatmap } from "./posture-heatmap"

/**
 * The six health states in the order an operator scans them, with the query
 * value each one filters the inventory by. `UNSPECIFIED` is deliberately absent:
 * the server sends a fixed seven buckets and the unspecified one names no
 * state, so it would only ever render as a row with nothing behind it.
 */
const POSTURE_ROWS: readonly {
  health: FleetHealth
  query: FleetHealthValue
}[] = [
  { health: FleetHealth.HEALTHY, query: "healthy" },
  { health: FleetHealth.PROGRESSING, query: "progressing" },
  { health: FleetHealth.DEGRADED, query: "degraded" },
  { health: FleetHealth.FAILED, query: "failed" },
  { health: FleetHealth.MISSING, query: "missing" },
  { health: FleetHealth.UNKNOWN, query: "unknown" },
]

/**
 * Board 02 — how the fleet is doing, as counts or as a map.
 *
 * The counts come from `GetSystemStatus`, which buckets the whole index
 * server-side, so the bars are exact at any fleet size. The heatmap cannot be:
 * it draws a bounded window of the impact ranking and captions itself as such.
 */
export function PostureBoard({
  health,
  total,
  applications,
  format,
  heatGroup,
  heatDetail,
  onHeatGroupChange,
  onHeatDetailChange,
  state,
}: {
  health: readonly FleetHealthBucket[]
  total: bigint
  applications: readonly ApplicationSummary[]
  format: PostureFormat
  heatGroup: HeatGroup
  heatDetail: HeatDetail
  onHeatGroupChange: (group: HeatGroup) => void
  onHeatDetailChange: (detail: HeatDetail) => void
  state: FleetQueryState
}) {
  if (format === "heatmap") {
    return (
      <PostureHeatmap
        applications={applications}
        rankedTotal={total}
        group={heatGroup}
        detail={heatDetail}
        onGroupChange={onHeatGroupChange}
        onDetailChange={onHeatDetailChange}
      />
    )
  }

  const counts = new Map<FleetHealth, bigint>()
  for (const bucket of health) counts.set(bucket.health, bucket.count)
  const totalCount = Number(total)

  return (
    <ul aria-label="Applications by health" className="list-none">
      {POSTURE_ROWS.map(({ health: value, query }) => {
        const tone = healthTone(value)
        const spec = STATUS_TONES[tone]
        const count = Number(counts.get(value) ?? BigInt(0))
        const percent = totalCount > 0 ? (count / totalCount) * 100 : 0
        return (
          <li key={query}>
            <Link
              href={inventoryHref(state, { health: [query], view: "table" })}
              aria-label={`${spec.label} — ${count} of ${totalCount} ${plural(totalCount, "application")}`}
              className="grid h-10 grid-cols-[1rem_6rem_2.75rem_minmax(0,1fr)] items-center gap-2.5 border-b border-rule-soft px-3.5 text-foreground no-underline hover:bg-inset hover:no-underline"
            >
              <StatusGlyph tone={tone} label="" aria-hidden="true" />
              <span className="font-cond text-label font-medium tracking-[0.05em] uppercase">
                {spec.label}
              </span>
              <span className="text-right font-cond text-count font-semibold tabular-nums">
                {count}
              </span>
              <span
                aria-hidden="true"
                className="relative block h-[7px] bg-neutral-200"
              >
                <span
                  style={{ width: `${percent}%` }}
                  className={cn("absolute inset-y-0 left-0", spec.bar)}
                />
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

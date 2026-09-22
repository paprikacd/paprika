"use client"

import { Popover } from "@base-ui/react/popover"
import { Settings2, X } from "lucide-react"
import Link from "next/link"
import { useCallback, useRef, useState } from "react"

import { Seg } from "@/components/ui/seg"
import { StatusGlyph, StatusPill } from "@/components/ui/status-chip"
import { FleetHealth, type ApplicationSummary } from "@/gen/paprika/v1/api_pb"
import {
  STATUS_TONES,
  healthLabel,
  healthTone,
  syncLabel,
  toneRank,
  worstTone,
  type StatusTone,
} from "@/lib/status-tone"
import { cn } from "@/lib/utils"

import { plural } from "./data-state"
import type { HeatDetail, HeatGroup } from "./overview-layout"
import { applicationHref, keyOf } from "./overview-links"

/**
 * The heatmap is a fixed-size figure, not a rendering of the fleet.
 *
 * One DOM node per application does not survive ten thousand applications, so
 * the map draws a bounded window of the server's impact ranking and says so in
 * the caption. The cap is a constant rather than a prop default so no caller
 * can quietly raise it.
 */
export const MAX_HEAT_TILES = 48

export interface HeatTile {
  key: string
  name: string
  namespace: string
  project: string
  cluster: string
  stage: string
  tone: StatusTone
  health: string
  sync: string
  resourceCount: number
  identity: { namespace: string; name: string } | undefined
}

export interface HeatRow {
  key: string
  kicker: string
  label: string
  tiles: HeatTile[]
  unhealthy: number
  worst: StatusTone
  mix: readonly { tone: StatusTone; count: number }[]
}

const MIX_ORDER: readonly StatusTone[] = [
  "failed",
  "missing",
  "degraded",
  "progressing",
  "unknown",
  "pending",
  "healthy",
]

const GROUP_KICKERS: Record<HeatGroup, string> = {
  none: "FLEET",
  project: "PROJECT",
  cluster: "CLUSTER",
  stage: "STAGE",
  namespace: "NAMESPACE",
}

function groupKeyFor(
  application: ApplicationSummary,
  tile: HeatTile,
  group: HeatGroup
): string {
  switch (group) {
    case "project":
      return tile.project || "no project"
    case "cluster":
      return tile.cluster || "no cluster"
    case "stage":
      return tile.stage || "no stage"
    case "namespace":
      return application.identity?.namespace || "no namespace"
    default:
      return "all targets"
  }
}

/**
 * Turns the server's ranked window into grouped rows of tiles. One tile is one
 * *target* — the same unit the fleet row model calls a stage target — so an
 * application deployed to three clusters shows three tiles, and the row model
 * elsewhere still counts applications.
 */
export function buildHeatRows(
  applications: readonly ApplicationSummary[],
  group: HeatGroup,
  limit: number = MAX_HEAT_TILES
): { rows: HeatRow[]; shown: number; truncated: boolean } {
  const tiles: { tile: HeatTile; application: ApplicationSummary }[] = []
  let available = 0

  for (const application of applications) {
    const identity = application.identity
    const name = identity?.name ?? "unknown"
    const namespace = identity?.namespace ?? ""
    const project = keyOf(application.project)
    const targets = application.targets.length
      ? application.targets
      : [undefined]

    for (const target of targets) {
      available += 1
      if (tiles.length >= limit) continue
      // A target that has not reported its own health inherits the
      // application's rolled-up health rather than reading as unknown.
      const health =
        target && target.health !== FleetHealth.UNSPECIFIED
          ? target.health
          : application.health
      tiles.push({
        application,
        tile: {
          key: `${namespace}/${name}/${target?.stableId ?? application.currentStage}`,
          name,
          namespace,
          project,
          cluster:
            target?.clusterLabel ||
            keyOf(target?.cluster) ||
            application.currentClusterLabel,
          stage: target?.stage || application.currentStage,
          tone: healthTone(health),
          health: healthLabel(health),
          sync: syncLabel(application.sync),
          resourceCount: application.resourceCount,
          identity,
        },
      })
    }
  }

  const grouped = new Map<string, HeatTile[]>()
  for (const { tile, application } of tiles) {
    const key = groupKeyFor(application, tile, group)
    const bucket = grouped.get(key)
    if (bucket) bucket.push(tile)
    else grouped.set(key, [tile])
  }

  const rows: HeatRow[] = [...grouped.entries()].map(([key, rowTiles]) => {
    rowTiles.sort(
      (left, right) =>
        toneRank(left.tone) - toneRank(right.tone) ||
        left.name.localeCompare(right.name)
    )
    const counts = new Map<StatusTone, number>()
    for (const tile of rowTiles) {
      counts.set(tile.tone, (counts.get(tile.tone) ?? 0) + 1)
    }
    return {
      key,
      kicker: GROUP_KICKERS[group],
      label: key,
      tiles: rowTiles,
      unhealthy: rowTiles.filter((tile) => toneRank(tile.tone) < 3).length,
      worst: worstTone(rowTiles.map((tile) => tile.tone)),
      mix: MIX_ORDER.flatMap((tone) => {
        const count = counts.get(tone) ?? 0
        return count > 0 ? [{ tone, count }] : []
      }),
    }
  })

  rows.sort(
    (left, right) =>
      toneRank(left.worst) - toneRank(right.worst) ||
      left.label.localeCompare(right.label)
  )

  return {
    rows,
    shown: tiles.length,
    truncated: available > tiles.length,
  }
}

const GROUP_OPTIONS = [
  { value: "none" as const, label: "All" },
  { value: "project" as const, label: "Project" },
  { value: "cluster" as const, label: "Cluster" },
  { value: "stage" as const, label: "Stage" },
  { value: "namespace" as const, label: "Namespace" },
]

const DETAIL_OPTIONS = [
  { value: "full" as const, label: "Name + target" },
  { value: "name" as const, label: "Name" },
  { value: "compact" as const, label: "Compact" },
]

const LEGEND_TONES: readonly StatusTone[] = [
  "healthy",
  "progressing",
  "degraded",
  "failed",
]

export function PostureHeatmap({
  applications,
  rankedTotal,
  group,
  detail,
  onGroupChange,
  onDetailChange,
}: {
  applications: readonly ApplicationSummary[]
  rankedTotal: bigint
  group: HeatGroup
  detail: HeatDetail
  onGroupChange: (group: HeatGroup) => void
  onDetailChange: (detail: HeatDetail) => void
}) {
  const { rows, shown, truncated } = buildHeatRows(applications, group)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<string | null>(null)
  const [side, setSide] = useState<"left" | "right">("left")

  const activate = useCallback((key: string, element: HTMLElement) => {
    const container = bodyRef.current
    if (container) {
      const tile = element.getBoundingClientRect()
      const box = container.getBoundingClientRect()
      if (box.width > 0) {
        setSide(
          tile.left + tile.width / 2 > box.left + box.width / 2
            ? "right"
            : "left"
        )
      }
    }
    setActive(key)
  }, [])

  const summary = `${group === "none" ? "ungrouped" : `by ${group}`} · ${
    detail === "full" ? "name + target" : detail === "name" ? "name" : "compact"
  }`

  return (
    <div>
      <div className="flex items-center justify-between gap-2.5 border-b border-rule-soft py-1.5 pr-2.5 pl-3.5">
        <span className="truncate font-mono text-meta text-muted-foreground">
          {summary}
        </span>
        <Popover.Root>
          <Popover.Trigger
            aria-label="Heatmap settings"
            className="inline-flex size-[22px] shrink-0 cursor-pointer items-center justify-center rounded-[2px] border border-rule bg-card text-muted-foreground hover:bg-inset pointer-coarse:size-11 data-[popup-open]:border-primary data-[popup-open]:bg-scope-active data-[popup-open]:text-steel-800"
          >
            <Settings2 className="size-3" strokeWidth={1.5} aria-hidden="true" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner align="end" sideOffset={4}>
              <Popover.Popup className="z-[76] w-64 border border-rule-strong bg-card shadow-popover">
                <div className="flex items-center justify-between border-b border-rule px-3 py-1.5">
                  <Popover.Title className="font-cond text-label font-semibold tracking-[0.05em] uppercase">
                    Heatmap settings
                  </Popover.Title>
                  <Popover.Close
                    aria-label="Close heatmap settings"
                    className="cursor-pointer text-neutral-600 hover:text-foreground"
                  >
                    <X className="size-3" strokeWidth={1.5} aria-hidden="true" />
                  </Popover.Close>
                </div>
                <div className="flex flex-col gap-3 px-3 py-2.5">
                  <Seg
                    label="Group by"
                    options={GROUP_OPTIONS}
                    value={group}
                    onValueChange={onGroupChange}
                    className="h-6 flex-wrap"
                  />
                  <div>
                    <Seg
                      label="Tile detail"
                      options={DETAIL_OPTIONS}
                      value={detail}
                      onValueChange={onDetailChange}
                      className="h-6"
                    />
                    <p className="mt-1.5 text-micro leading-[1.45] text-muted-foreground">
                      Compact hides names and shows solid colour squares; every
                      tile keeps its full description for assistive technology.
                    </p>
                  </div>
                </div>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </div>

      <div ref={bodyRef} className="flex flex-col gap-3.5 px-3.5 py-3">
        {rows.map((row) => (
          <section key={row.key} aria-label={`${row.kicker} ${row.label}`}>
            {group === "none" ? null : (
              <div
                className={cn(
                  "flex min-w-0 items-baseline gap-2 border-b pb-1.5",
                  STATUS_TONES[row.worst].line
                )}
              >
                <span className="font-mono text-kicker tracking-[0.14em] text-neutral-600">
                  {row.kicker}
                </span>
                <h3 className="font-cond text-name font-semibold tracking-[0.03em] whitespace-nowrap">
                  {row.label}
                </h3>
                <span className="min-w-0 flex-1 truncate text-note text-muted-foreground">
                  {row.tiles.length} {plural(row.tiles.length, "target")} ·{" "}
                  {row.unhealthy > 0
                    ? `${row.unhealthy} unhealthy`
                    : "all healthy"}
                </span>
                <span
                  aria-hidden="true"
                  className="ml-auto flex h-1.5 w-15 flex-none gap-px"
                >
                  {row.mix.map((segment) => (
                    <span
                      key={segment.tone}
                      style={{ flexGrow: segment.count }}
                      className={STATUS_TONES[segment.tone].bar}
                    />
                  ))}
                </span>
              </div>
            )}
            <ul className="flex list-none flex-wrap gap-1.5 pt-2">
              {row.tiles.map((tile) => (
                <HeatTileCell
                  key={tile.key}
                  tile={tile}
                  detail={detail}
                  active={active === tile.key}
                  side={side}
                  onActivate={activate}
                  onDismiss={() => setActive(null)}
                />
              ))}
            </ul>
          </section>
        ))}

        {rows.length === 0 ? (
          <p className="py-4 text-center text-note text-muted-foreground">
            No targets in scope.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-rule-soft pt-2">
          {LEGEND_TONES.map((tone) => (
            <span
              key={tone}
              className="inline-flex items-center gap-1 text-meta text-muted-foreground"
            >
              <StatusGlyph tone={tone} />
              {STATUS_TONES[tone].label}
            </span>
          ))}
          <span className="ml-auto font-mono text-kicker whitespace-nowrap text-neutral-500">
            {shown} {plural(shown, "target")} shown
            {truncated ? ` · top ${applications.length} by impact` : ""} of{" "}
            {rankedTotal.toString()} indexed
          </span>
        </div>
      </div>
    </div>
  )
}

function HeatTileCell({
  tile,
  detail,
  active,
  side,
  onActivate,
  onDismiss,
}: {
  tile: HeatTile
  detail: HeatDetail
  active: boolean
  side: "left" | "right"
  onActivate: (key: string, element: HTMLElement) => void
  onDismiss: () => void
}) {
  const spec = STATUS_TONES[tile.tone]
  const compact = detail === "compact"
  const description = `${tile.name} · ${tile.cluster || "no cluster"} · ${tile.stage || "no stage"} — ${tile.health}, ${tile.sync}, ${tile.resourceCount} ${plural(tile.resourceCount, "resource")}`

  return (
    <li className="relative inline-flex">
      <Link
        href={applicationHref(tile.identity)}
        aria-label={description}
        onMouseEnter={(event) => onActivate(tile.key, event.currentTarget)}
        onMouseLeave={onDismiss}
        onFocus={(event) => onActivate(tile.key, event.currentTarget)}
        onBlur={onDismiss}
        className={cn(
          "box-border flex flex-col border no-underline hover:no-underline",
          spec.line,
          compact
            ? "size-6 items-center justify-center pointer-coarse:size-11"
            : detail === "name"
              ? "h-8 w-24 justify-center px-1.5 pointer-coarse:h-11"
              : "h-14 w-28 justify-between px-1.5 py-1",
          compact ? cn(spec.bar, "text-ink-on") : cn(spec.fill, spec.text),
          active && "shadow-tile-hover"
        )}
      >
        {compact ? (
          <span aria-hidden="true" className="text-note leading-none font-bold">
            {spec.glyph}
          </span>
        ) : (
          <span
            aria-hidden="true"
            className="flex items-center justify-between gap-1"
          >
            <span className="truncate font-cond text-console font-semibold tracking-[0.02em]">
              {tile.name}
            </span>
            <span className="flex-none text-note font-bold">{spec.glyph}</span>
          </span>
        )}
        {detail === "full" ? (
          <span
            aria-hidden="true"
            className="truncate font-mono text-kicker opacity-80"
          >
            {tile.cluster || tile.stage}
          </span>
        ) : null}
      </Link>

      {active ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-full z-70 mt-1.5 block w-68 border border-ink-rule bg-ink-surface text-ink-on shadow-tooltip",
            side === "right" ? "right-0" : "left-0"
          )}
        >
          <span className="flex items-center justify-between gap-2.5 border-b border-ink-rule px-2.5 py-2">
            <span className="font-cond text-name font-semibold tracking-[0.02em]">
              {tile.name}
            </span>
            <StatusPill tone={tile.tone} className="bg-card" />
          </span>
          <span className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 px-2.5 py-1.5 text-note">
            <span className="text-ink-accent">target</span>
            <span className="font-mono">
              {tile.cluster || "—"} · {tile.stage || "—"}
            </span>
            <span className="text-ink-accent">project</span>
            <span className="font-mono">{tile.project || "—"}</span>
            <span className="text-ink-accent">namespace</span>
            <span className="font-mono">{tile.namespace || "—"}</span>
            <span className="text-ink-accent">sync</span>
            <span className="font-mono">{tile.sync}</span>
            <span className="text-ink-accent">resources</span>
            <span className="font-mono">{tile.resourceCount} managed</span>
          </span>
        </span>
      ) : null}
    </li>
  )
}

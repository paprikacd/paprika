"use client"

import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronDown } from "lucide-react"
import { useCallback, useMemo, useRef, useState } from "react"

import {
  ApplicationCapabilityActions,
  applicationKey,
  identityKey,
  observeMeasuredElementRect,
  releaseFocusOwnership,
  useApplicationFocusAdapter,
  type ApplicationCollectionProps,
} from "@/components/fleet/application-collection"
import { dataSurface, type DataSurface } from "@/components/fleet/data-sources"
import {
  formatMonthlyCost,
  isCostEstimate,
  useApplicationCosts,
  type FleetCostResult,
} from "@/components/fleet/fleet-cost"
import {
  LIFECYCLE_PHASES,
  applicationLifecycle,
  lifecycleCellLabel,
  lifecyclePhaseTone,
  type FleetLifecycleVector,
} from "@/components/fleet/fleet-lifecycle"
import {
  groupApplications,
  groupMetaOf,
  healthLabelOf,
  healthToneOf,
  projectLabelOf,
  syncLabelOf,
  syncToneOf,
  type ApplicationGroup,
  type GroupDimension,
} from "@/components/fleet/fleet-rows"
import { StatusGlyph, StatusPill } from "@/components/ui/status-chip"
import type { FleetApplicationSummary } from "@/lib/fleet-client"
import { STATUS_TONES } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

const ROW_HEIGHT = 42
const GROUP_HEIGHT = 40

interface ColumnSpec {
  key: string
  header: string
  /** Grid track. */
  track: string
  /** Narrowest the track can be, for the table's horizontal scroll floor. */
  minPx: number
  align?: "right"
}

const COLUMN_SPECS: Record<string, ColumnSpec> = {
  application: {
    key: "application",
    header: "APPLICATION",
    track: "minmax(190px,1.3fr)",
    minPx: 190,
  },
  project: { key: "project", header: "PROJECT", track: "120px", minPx: 120 },
  target: {
    key: "target",
    header: "TARGET",
    track: "minmax(120px,1fr)",
    minPx: 120,
  },
  health: { key: "health", header: "HEALTH", track: "92px", minPx: 92 },
  sync: { key: "sync", header: "SYNC", track: "88px", minPx: 88 },
  lifecycle: { key: "lifecycle", header: "LIFECYCLE", track: "150px", minPx: 150 },
  resources: {
    key: "resources",
    header: "RES",
    track: "74px",
    minPx: 74,
    align: "right",
  },
  cost: {
    key: "cost",
    header: "COST/MO",
    track: "78px",
    minPx: 78,
    align: "right",
  },
  actions: { key: "actions", header: "ACTIONS", track: "118px", minPx: 118 },
}

type TableItem =
  | { kind: "group"; group: ApplicationGroup; open: boolean }
  | {
      kind: "row"
      application: FleetApplicationSummary
      /** Ordinal across every loaded application, for `aria-rowindex`. */
      ordinal: number
      zebra: boolean
    }

export interface ApplicationTableProps extends ApplicationCollectionProps {
  /** Which dimension the rows are grouped under, or `none`. */
  group: GroupDimension
}

export function ApplicationTable(props: ApplicationTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowTargets = useRef(new Map<string, HTMLElement>())
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  )

  const lifecycleSurface = dataSurface(props.sources, "lifecycle")
  const costSurface = dataSurface(props.sources, "cost")

  const identities = useMemo(
    () =>
      props.applications
        .map((application) => application.identity)
        .filter((identity) => identity !== undefined),
    [props.applications],
  )
  const costs = useApplicationCosts({
    identities,
    enabled: costSurface.present,
  })

  // A column exists only when the control plane can fill it. `NOT_CONFIGURED`
  // removes the column outright rather than filling it with blanks.
  // A surface the server keeps but cannot fill stays visible and greyed; a
  // surface it can fill but has no vector for has nothing to draw.
  const hasLifecycle =
    lifecycleSurface.present &&
    (!lifecycleSurface.numeric ||
      props.applications.some((application) => applicationLifecycle(application)))
  const hasCost = costSurface.present
  const columns = useMemo(
    () =>
      [
        COLUMN_SPECS.application,
        COLUMN_SPECS.project,
        COLUMN_SPECS.target,
        COLUMN_SPECS.health,
        COLUMN_SPECS.sync,
        hasLifecycle ? COLUMN_SPECS.lifecycle : undefined,
        COLUMN_SPECS.resources,
        hasCost ? COLUMN_SPECS.cost : undefined,
        COLUMN_SPECS.actions,
      ].filter((column) => column !== undefined),
    [hasCost, hasLifecycle],
  )
  const gridTemplateColumns = columns.map((column) => column.track).join(" ")
  const minWidth =
    columns.reduce((total, column) => total + column.minPx, 0) +
    12 * (columns.length - 1) +
    44

  const groups = useMemo(
    () => groupApplications(props.applications, props.group),
    [props.applications, props.group],
  )
  const items = useMemo(
    () => tableItems(groups, closedGroups, props.group !== "none"),
    [closedGroups, groups, props.group],
  )
  const rowItemIndex = useMemo(() => {
    const index = new Map<number, number>()
    items.forEach((item, position) => {
      if (item.kind === "row") index.set(item.ordinal, position)
    })
    return index
  }, [items])

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      items[index]?.kind === "group" ? GROUP_HEIGHT : ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => itemKey(items[index], index),
    initialRect: { width: 1120, height: 560 },
    observeElementRect: observeMeasuredElementRect,
    measureElement: (element) => element.getBoundingClientRect().height || ROW_HEIGHT,
  })

  const getTarget = useCallback(
    (key: string) => rowTargets.current.get(key) ?? null,
    [],
  )
  const scrollToIndex = useCallback(
    (ordinal: number) => {
      const position = rowItemIndex.get(ordinal)
      if (position === undefined) return
      virtualizer.scrollToIndex(position, { align: "center" })
    },
    [rowItemIndex, virtualizer],
  )

  useApplicationFocusAdapter({
    presentation: "table",
    applications: props.applications,
    coordinator: props.focusCoordinator,
    getResultsHeadingTarget: props.getResultsHeadingTarget,
    getTarget,
    scrollToIndex,
  })

  const toggleGroup = useCallback((key: string) => {
    setClosedGroups((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  return (
    <section aria-label="Application inventory" className="min-w-0">
      <SurfaceNotices lifecycle={lifecycleSurface} cost={costSurface} />

      <div
        ref={scrollRef}
        role="table"
        aria-label="Applications"
        aria-rowcount={Number(props.total) + 1}
        aria-colcount={columns.length}
        className="h-[min(62vh,42rem)] min-h-80 overflow-auto bg-background"
      >
        <div
          role="rowgroup"
          className="sticky top-0 z-10 border-b border-rule-strong bg-muted"
          style={{ minWidth }}
        >
          <div
            role="row"
            aria-rowindex={1}
            className="grid h-7.5 items-center gap-3 px-5.5"
            style={{ gridTemplateColumns }}
          >
            {columns.map((column, index) => (
              <span
                key={column.key}
                role="columnheader"
                aria-colindex={index + 1}
                className={cn(
                  "font-mono text-kicker tracking-[0.14em] text-muted-foreground",
                  column.align === "right" && "text-right",
                )}
              >
                {column.key === "cost" && isCostEstimate(costs.basis)
                  ? "COST/MO EST."
                  : column.header}
              </span>
            ))}
          </div>
        </div>

        <div
          role="rowgroup"
          className="relative"
          style={{ height: `${virtualizer.getTotalSize()}px`, minWidth }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const item = items[virtualItem.index]
            if (!item) return null
            const key = itemKey(item, virtualItem.index)

            if (item.kind === "group") {
              return (
                <GroupHeaderRow
                  key={key}
                  group={item.group}
                  open={item.open}
                  columnCount={columns.length}
                  onToggle={() => toggleGroup(item.group.key)}
                  start={virtualItem.start}
                  measure={virtualizer.measureElement}
                  index={virtualItem.index}
                />
              )
            }

            return (
              <ApplicationRow
                key={key}
                rowKey={key}
                application={item.application}
                ordinal={item.ordinal}
                zebra={item.zebra}
                columns={columns}
                gridTemplateColumns={gridTemplateColumns}
                costs={costs}
                costSurface={costSurface}
                lifecycleSurface={lifecycleSurface}
                start={virtualItem.start}
                index={virtualItem.index}
                measure={virtualizer.measureElement}
                registerTarget={(node) => {
                  if (node) rowTargets.current.set(key, node)
                  else rowTargets.current.delete(key)
                }}
                onSelect={props.onSelectApplication}
                onFocused={props.onFocusedApplication}
              />
            )
          })}
        </div>
      </div>
    </section>
  )
}

function GroupHeaderRow({
  group,
  open,
  columnCount,
  onToggle,
  start,
  index,
  measure,
}: {
  group: ApplicationGroup
  open: boolean
  columnCount: number
  onToggle: () => void
  start: number
  index: number
  measure: (node: Element | null) => void
}) {
  const tone = STATUS_TONES[group.worst]
  const meta = groupMetaOf(group)
  return (
    <div
      role="row"
      ref={measure}
      data-index={index}
      className={cn(
        "absolute top-0 left-0 flex h-10 w-full items-center border-y border-rule",
        tone.fill,
      )}
      style={{ transform: `translateY(${start}px)` }}
    >
      <span
        role="columnheader"
        aria-colindex={1}
        aria-colspan={columnCount}
        className="flex w-full items-center gap-3 px-5.5"
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${group.label}`}
          onClick={onToggle}
          className="inline-flex size-5 cursor-pointer items-center justify-center rounded-[2px] border border-rule bg-card text-muted-foreground hover:bg-inset pointer-coarse:size-11"
        >
          <ChevronDown
            aria-hidden="true"
            strokeWidth={1.5}
            className={cn(
              "size-3 transition-transform",
              !open && "-rotate-90",
            )}
          />
        </button>
        <StatusGlyph tone={group.worst} />
        {group.kicker ? (
          <span className="font-mono text-kicker tracking-[0.14em] text-neutral-600">
            {group.kicker}
          </span>
        ) : null}
        <span className="font-cond text-board font-semibold tracking-[0.03em]">
          {group.label}
        </span>
        <span className="text-note text-muted-foreground">{meta}</span>
        <span aria-hidden className="flex flex-1" />
        <span
          aria-hidden
          className="flex h-2 w-40 shrink-0 gap-px"
          title={group.mix
            .map((segment) => `${STATUS_TONES[segment.tone].label} ${segment.count}`)
            .join(" · ")}
        >
          {group.mix.map((segment) => (
            <span
              key={segment.tone}
              className={STATUS_TONES[segment.tone].bar}
              style={{ flex: segment.count }}
            />
          ))}
        </span>
      </span>
    </div>
  )
}

function ApplicationRow({
  rowKey,
  application,
  ordinal,
  zebra,
  columns,
  gridTemplateColumns,
  costs,
  costSurface,
  lifecycleSurface,
  start,
  index,
  measure,
  registerTarget,
  onSelect,
  onFocused,
}: {
  rowKey: string
  application: FleetApplicationSummary
  ordinal: number
  zebra: boolean
  columns: readonly ColumnSpec[]
  gridTemplateColumns: string
  costs: FleetCostResult
  costSurface: DataSurface
  lifecycleSurface: DataSurface
  start: number
  index: number
  measure: (node: Element | null) => void
  registerTarget: (node: HTMLElement | null) => void
  onSelect: (identity: { namespace: string; name: string }) => void
  onFocused: (identity: { namespace: string; name: string } | null) => void
}) {
  const identity = application.identity
  const healthTone = healthToneOf(application.health)
  const lifecycle = applicationLifecycle(application)
  const cost = identity ? costs.costs.get(identityKey(identity)) : undefined
  const colIndex = new Map(columns.map((column, position) => [column.key, position + 1]))

  return (
    <div
      ref={(node) => {
        registerTarget(node)
        if (node) measure(node)
      }}
      data-index={index}
      data-row-key={rowKey}
      role="row"
      aria-rowindex={ordinal + 2}
      aria-label={identity ? identityKey(identity) : `Application row ${ordinal + 1}`}
      tabIndex={identity ? 0 : -1}
      onFocus={() => identity && onFocused(identity)}
      onBlur={(event) =>
        releaseFocusOwnership(event.currentTarget, event.relatedTarget, onFocused)
      }
      onClick={() => identity && onSelect(identity)}
      onKeyDown={(event) => {
        if (!identity || (event.key !== "Enter" && event.key !== " ")) return
        event.preventDefault()
        onSelect(identity)
      }}
      className={cn(
        "absolute top-0 left-0 grid h-row w-full cursor-pointer items-center gap-3 border-b border-rule-soft px-5.5 text-left",
        zebra ? "bg-zebra" : "bg-card",
        "hover:bg-inset focus-visible:bg-inset",
      )}
      style={{ gridTemplateColumns, transform: `translateY(${start}px)` }}
    >
      <span role="cell" aria-colindex={colIndex.get("application")} className="min-w-0">
        <span className="flex items-center gap-1.75">
          <StatusGlyph tone={healthTone} label={healthLabelOf(application.health)} />
          <span className="truncate font-cond text-name font-semibold tracking-[0.02em]">
            {identity?.name || "Unnamed application"}
          </span>
        </span>
        <span className="block truncate pl-4.75 font-mono text-meta text-neutral-600">
          {identity ? identityKey(identity) : "Identity unavailable"}
        </span>
      </span>

      <span
        role="cell"
        aria-colindex={colIndex.get("project")}
        className="truncate font-mono text-note text-muted-foreground"
      >
        {projectLabelOf(application) || "—"}
      </span>

      <span role="cell" aria-colindex={colIndex.get("target")} className="min-w-0">
        <span className="block truncate font-cond text-label font-medium tracking-[0.02em]">
          {application.currentClusterLabel || "No target"}
        </span>
        <span className="block truncate font-mono text-meta text-neutral-600">
          {application.currentStage || "Stage unknown"}
        </span>
      </span>

      <span role="cell" aria-colindex={colIndex.get("health")}>
        <StatusPill tone={healthTone} label={healthLabelOf(application.health)} />
      </span>

      <span role="cell" aria-colindex={colIndex.get("sync")}>
        <StatusPill
          tone={syncToneOf(application.sync)}
          label={syncLabelOf(application.sync)}
        />
      </span>

      {colIndex.has("lifecycle") ? (
        <span role="cell" aria-colindex={colIndex.get("lifecycle")}>
          <LifecycleStrip vector={lifecycle} surface={lifecycleSurface} />
        </span>
      ) : null}

      <span
        role="cell"
        aria-colindex={colIndex.get("resources")}
        className="text-right font-mono text-note tabular-nums"
      >
        {application.resourceCount.toLocaleString()}
      </span>

      {colIndex.has("cost") ? (
        <span
          role="cell"
          aria-colindex={colIndex.get("cost")}
          className="text-right font-mono text-note tabular-nums text-muted-foreground"
        >
          <CostCell cost={cost} surface={costSurface} />
        </span>
      ) : null}

      <span
        role="cell"
        aria-colindex={colIndex.get("actions")}
        onClick={(event) => event.stopPropagation()}
      >
        {identity ? (
          <ApplicationCapabilityActions
            identity={identity}
            capabilities={application.capabilities}
          />
        ) : null}
      </span>
    </div>
  )
}

/**
 * Six cells, one per delivery phase. A row without a vector draws nothing —
 * six empty cells would assert six pending phases.
 */
function LifecycleStrip({
  vector,
  surface,
}: {
  vector: FleetLifecycleVector | undefined
  surface: DataSurface
}) {
  if (!vector || !surface.numeric) {
    return (
      <span className="font-mono text-meta text-neutral-500">
        {surface.numeric ? "no data" : "unavailable"}
      </span>
    )
  }
  const description = LIFECYCLE_PHASES.map((phase, index) =>
    lifecycleCellLabel(phase, vector.states[index]),
  )
  return (
    <span
      role="img"
      aria-label={`Lifecycle: ${description.join(", ")}`}
      className="flex gap-0.5"
    >
      {LIFECYCLE_PHASES.map((phase, index) => {
        const tone = lifecyclePhaseTone(vector.states[index])
        return (
          <span
            key={phase}
            title={description[index]}
            className={cn(
              "h-4 w-5 border",
              STATUS_TONES[tone].line,
              STATUS_TONES[tone].fill,
            )}
          />
        )
      })}
    </span>
  )
}

function CostCell({
  cost,
  surface,
}: {
  cost: { state: string; monthlyAmount: number; currency: string; unavailableReason: string } | undefined
  surface: DataSurface
}) {
  if (!surface.numeric || !cost || (cost.state !== "ok" && cost.state !== "stale")) {
    const reason = cost?.unavailableReason || surface.reason || "No figure for this application"
    return (
      <span aria-label={`Cost unavailable: ${reason}`} title={reason} className="text-neutral-500">
        —
      </span>
    )
  }
  return (
    <span>
      {formatMonthlyCost(cost.monthlyAmount, cost.currency)}
      {cost.state === "stale" ? (
        <span className="ml-1 text-meta text-neutral-500">stale</span>
      ) : null}
    </span>
  )
}

/**
 * A surface the server keeps but cannot fill says so once, above the table,
 * rather than repeating itself in every row.
 */
function SurfaceNotices({
  lifecycle,
  cost,
}: {
  lifecycle: DataSurface
  cost: DataSurface
}) {
  const notices = [
    lifecycle.present && !lifecycle.numeric
      ? `Lifecycle unavailable — ${lifecycle.reason || "the delivery projection is not reporting"}`
      : undefined,
    cost.present && !cost.numeric
      ? `Cost unavailable — ${cost.reason || "the cost source is not reporting"}`
      : undefined,
  ].filter((notice) => notice !== undefined)

  if (notices.length === 0) return null

  return (
    <p
      role="status"
      aria-live="polite"
      className="border-b border-rule bg-inset px-5.5 py-1.5 text-note text-muted-foreground"
    >
      {notices.join(" · ")}
    </p>
  )
}

function tableItems(
  groups: readonly ApplicationGroup[],
  closed: ReadonlySet<string>,
  showHeaders: boolean,
): TableItem[] {
  const items: TableItem[] = []
  let ordinal = 0
  for (const group of groups) {
    const open = !closed.has(group.key)
    if (showHeaders) items.push({ kind: "group", group, open })
    group.applications.forEach((application, index) => {
      if (open || !showHeaders) {
        items.push({
          kind: "row",
          application,
          ordinal,
          // Zebra restarts inside each group, so the row under every group
          // header is the light one.
          zebra: index % 2 === 1,
        })
      }
      ordinal += 1
    })
  }
  return items
}

function itemKey(item: TableItem | undefined, index: number): string {
  if (!item) return `item:${index}`
  return item.kind === "group"
    ? `group:${item.group.key}`
    : applicationKey(item.application, item.ordinal)
}

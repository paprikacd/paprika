"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type UIEvent,
} from "react"

import {
  clipHeatmapCells,
  hitTestHeatmap,
  layoutHeatmap,
  type HeatmapCellRect,
  type HeatmapGroupBand,
  type HeatmapLayoutResult,
} from "@/components/fleet/heatmap-layout"
import { createTreemapCanvasMetrics } from "@/components/fleet/treemap-layout"
import {
  navigateTreemapSelection,
  retainTreemapSelection,
  type TreemapNavigationKey,
} from "@/components/fleet/treemap-navigation"
import {
  fitTreemapLabel,
  TREEMAP_HEALTH_PRESENTATION,
} from "@/components/fleet/treemap-presentation"
import type {
  FleetHealthStatus,
  FleetMapNode,
  FleetMapResult,
} from "@/lib/fleet-client"
import {
  fleetDetailHref,
  fleetHref,
  patchFleetSearchParams,
} from "@/lib/fleet-navigation"
import type {
  FleetDensity,
  FleetDirection,
  FleetLabelMode,
  FleetSort,
  NamespacedKey,
} from "@/lib/fleet-query"

const DEFAULT_VIEWPORT = { width: 960, height: 520 }
const TOOLTIP_WIDTH = 248
const TOOLTIP_HEIGHT = 144
const TOOLTIP_INSET = 8
const CELL_INSET = 0.75
const NAVIGATION_KEYS = new Set<TreemapNavigationKey>([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
])

const HEALTH_ORDER: readonly FleetHealthStatus[] = [
  "failed",
  "degraded",
  "progressing",
  "missing",
  "unknown",
  "healthy",
  "unspecified",
]

const HEALTH_STYLE: Readonly<
  Record<
    FleetHealthStatus,
    { fill: string; border: string; glyph: string; label: string; dash: readonly number[] }
  >
> = {
  healthy: {
    fill: "#273126",
    border: "#70906a",
    ...TREEMAP_HEALTH_PRESENTATION.healthy,
    dash: [],
  },
  progressing: {
    fill: "#332e22",
    border: "#b8904b",
    ...TREEMAP_HEALTH_PRESENTATION.progressing,
    dash: [3, 2],
  },
  degraded: {
    fill: "#382922",
    border: "#c77752",
    ...TREEMAP_HEALTH_PRESENTATION.degraded,
    dash: [5, 2],
  },
  failed: {
    fill: "#382324",
    border: "#bd5c5c",
    ...TREEMAP_HEALTH_PRESENTATION.failed,
    dash: [1, 2],
  },
  unknown: {
    fill: "#2b2926",
    border: "#827b73",
    ...TREEMAP_HEALTH_PRESENTATION.unknown,
    dash: [2, 3],
  },
  missing: {
    fill: "#292623",
    border: "#776f67",
    ...TREEMAP_HEALTH_PRESENTATION.missing,
    dash: [6, 3],
  },
  unspecified: {
    fill: "#292724",
    border: "#716b64",
    glyph: "·",
    label: "Unspecified",
    dash: [1, 4],
  },
}

export interface FleetHealthHeatmapProps {
  result: FleetMapResult
  density?: FleetDensity
  labels?: FleetLabelMode
  sort?: FleetSort
  direction?: FleetDirection
  selected?: NamespacedKey | null
  onSelectApplication?: (identity: NamespacedKey) => void
  onFocusedApplication?: (identity: NamespacedKey | null) => void
}

interface TooltipState {
  cell: HeatmapCellRect
  x: number
  y: number
}

interface ApplicationDescription {
  title: string
  fields: readonly string[]
}

interface LocalSelection {
  stableId: string | null
  cleared: boolean
  selectedKey: string
}

type LayoutAttempt =
  | { layout: HeatmapLayoutResult; error: null }
  | { layout: null; error: string }

export function FleetHealthHeatmap({
  result,
  density = "auto",
  labels = "auto",
  sort = "health",
  direction = "desc",
  selected,
  onSelectApplication,
  onFocusedApplication,
}: FleetHealthHeatmapProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const query = searchParams.toString()
  const instanceId = useId()
  const instructionsId = `${instanceId}-instructions`
  const activeApplicationId = `${instanceId}-active`
  const controllerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const controllerFocusedRef = useRef(false)
  const selectedKey = selected ? `${selected.namespace}\u0000${selected.name}` : ""
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT)
  const [scrollTop, setScrollTop] = useState(0)
  const [localSelection, setLocalSelection] = useState<LocalSelection>({
    stableId: null,
    cleared: false,
    selectedKey,
  })
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const [paintError, setPaintError] = useState<string | null>(null)

  const tableHref = useMemo(() => {
    const table = patchFleetSearchParams(new URLSearchParams(query), {
      selected: null,
      view: "table",
    })
    return fleetHref("/dashboard/applications", table)
  }, [query])

  const attempt = useMemo<LayoutAttempt>(() => {
    try {
      return {
        layout: layoutHeatmap({
          roots: result.roots,
          width: viewport.width,
          viewportHeight: viewport.height,
          scrollTop: 0,
          density,
          labels,
          sort,
          direction,
        }),
        error: null,
      }
    } catch (error) {
      return { layout: null, error: errorMessage(error, "Heatmap layout failed") }
    }
  }, [density, direction, labels, result.roots, sort, viewport])

  const layout = attempt.layout
  const normalizedScrollTop = layout
    ? clampScrollTop(scrollTop, layout.virtualHeight, viewport.height)
    : 0
  const visibleCells = useMemo(
    () =>
      layout
        ? clipHeatmapCells(
            layout.cells,
            layout.virtualHeight,
            normalizedScrollTop,
            viewport.height,
          )
        : [],
    [layout, normalizedScrollTop, viewport.height],
  )
  const visibleGroups = useMemo(
    () =>
      layout
        ? visibleGroupBands(layout.groups, normalizedScrollTop, viewport.height)
        : [],
    [layout, normalizedScrollTop, viewport.height],
  )
  const selectedStableId = layout
    ? findApplicationStableId(layout.cells, selected)
    : null
  const localSelectionIsCurrent =
    localSelection.selectedKey === selectedKey
  const retainedActive = layout && localSelectionIsCurrent
    ? retainTreemapSelection(localSelection.stableId, layout.cells)
    : null
  const hasLocalSelection =
    localSelectionIsCurrent && (retainedActive !== null || localSelection.cleared)
  const effectiveActiveId =
    (hasLocalSelection ? retainedActive : selectedStableId) ??
    (hasLocalSelection && localSelection.cleared
      ? null
      : layout?.cells[0]?.stableId ?? null)
  const activeCell =
    layout?.cells.find((cell) => cell.stableId === effectiveActiveId) ?? null
  const legend = useMemo(
    () => (layout ? completeHealthLegend(layout.cells) : []),
    [layout],
  )
  const canvas = useMemo(
    () =>
      createTreemapCanvasMetrics(
        viewport.width,
        viewport.height,
        typeof window === "undefined" ? 1 : window.devicePixelRatio,
      ),
    [viewport],
  )

  useEffect(() => {
    const controller = controllerRef.current
    if (!controller) return

    const measure = () => {
      const width = controller.clientWidth
      const height = controller.clientHeight
      if (width <= 0 || height <= 0) return
      setViewport((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      )
    }
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    observer?.observe(controller)
    const frame = window.requestAnimationFrame(measure)
    window.addEventListener("resize", measure)
    return () => {
      observer?.disconnect()
      window.cancelAnimationFrame(frame)
      window.removeEventListener("resize", measure)
    }
  }, [])

  useEffect(() => {
    if (!layout || layout.layoutCount === 0 || attempt.error || paintError) return
    const reportPaintError = (message: string) => {
      queueMicrotask(() => {
        setPaintError((current) => current ?? message)
      })
    }
    const element = canvasRef.current
    const context = element?.getContext("2d")
    if (!element || !context) {
      reportPaintError("Canvas rendering is unavailable in this browser.")
      return
    }

    try {
      element.width = canvas.pixelWidth
      element.height = canvas.pixelHeight
      element.style.width = `${canvas.cssWidth}px`
      element.style.height = `${canvas.cssHeight}px`
      context.setTransform(canvas.scaleX, 0, 0, canvas.scaleY, 0, 0)
      drawHeatmap(
        context,
        visibleCells,
        visibleGroups,
        effectiveActiveId,
        normalizedScrollTop,
        canvas.cssWidth,
        canvas.cssHeight,
      )
    } catch (error) {
      reportPaintError(errorMessage(error, "Canvas rendering failed"))
    }
  }, [
    attempt.error,
    canvas,
    effectiveActiveId,
    layout,
    normalizedScrollTop,
    paintError,
    visibleCells,
    visibleGroups,
  ])

  const focusCell = useCallback(
    (cell: HeatmapCellRect | null) => {
      if (!cell) return
      setLocalSelection({
        stableId: cell.stableId,
        cleared: false,
        selectedKey,
      })
      onFocusedApplication?.(cell.node.application ?? null)
      if (layout) scrollCellIntoView(controllerRef.current, cell, layout, viewport.height, setScrollTop)
    },
    [layout, onFocusedApplication, selectedKey, viewport.height],
  )

  const activateCell = useCallback(
    (cell: HeatmapCellRect | null) => {
      const identity = cell?.node.application
      if (!cell || !identity) return
      focusCell(cell)
      onSelectApplication?.(identity)
      router.push(fleetDetailHref("application", identity, new URLSearchParams(query)))
    },
    [focusCell, onSelectApplication, query, router],
  )

  const hitFromPointer = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const controller = controllerRef.current
      if (!controller) return null
      const pointer = contentPointer(controller, event)
      return hitTestHeatmap(
        visibleCells,
        pointer.x + controller.scrollLeft,
        pointer.y + normalizedScrollTop,
      )
    },
    [normalizedScrollTop, visibleCells],
  )

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const cell = hitFromPointer(event)
      if (!cell) {
        setTooltip(null)
        return
      }
      focusCell(cell)
      const controller = controllerRef.current
      if (!controller) return
      const pointer = contentPointer(controller, event)
      setTooltip({
        cell,
        x: clamp(pointer.x + 12, TOOLTIP_INSET, viewport.width - TOOLTIP_WIDTH),
        y: clamp(pointer.y + 12, TOOLTIP_INSET, viewport.height - TOOLTIP_HEIGHT),
      })
    },
    [focusCell, hitFromPointer, viewport],
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!layout) return
      if (NAVIGATION_KEYS.has(event.key as TreemapNavigationKey)) {
        event.preventDefault()
        const nextId = navigateTreemapSelection(
          layout.cells,
          effectiveActiveId,
          event.key as TreemapNavigationKey,
        )
        focusCell(layout.cells.find((cell) => cell.stableId === nextId) ?? null)
        return
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        activateCell(activeCell)
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        setLocalSelection({
          stableId: null,
          cleared: true,
          selectedKey,
        })
        setTooltip(null)
        onFocusedApplication?.(null)
      }
    },
    [
      activateCell,
      activeCell,
      effectiveActiveId,
      focusCell,
      layout,
      onFocusedApplication,
      selectedKey,
    ],
  )

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (!layout) return
      const next = clampScrollTop(
        event.currentTarget.scrollTop,
        layout.virtualHeight,
        viewport.height,
      )
      if (event.currentTarget.scrollTop !== next) event.currentTarget.scrollTop = next
      setScrollTop(next)
      setTooltip(null)
    },
    [layout, viewport.height],
  )

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      if (event.currentTarget.contains(event.relatedTarget)) return
      controllerFocusedRef.current = false
      onFocusedApplication?.(null)
    },
    [onFocusedApplication],
  )

  const error = attempt.error ?? paintError
  if (error) return <HeatmapFallback error={error} tableHref={tableHref} />
  if (!layout || layout.layoutCount === 0) return <HeatmapEmpty tableHref={tableHref} />

  return (
    <section role="region" aria-label="Application health heatmap" className="min-w-0">
      <HeatmapLegend entries={legend} />
      <div
        ref={controllerRef}
        role="application"
        aria-label="Fleet health heatmap"
        aria-describedby={`${instructionsId} ${activeApplicationId}`}
        tabIndex={0}
        data-heatmap-input-count={layout.inputCount}
        data-heatmap-layout-count={layout.layoutCount}
        data-heatmap-layout-digest={layout.digest}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          controllerFocusedRef.current = true
          onFocusedApplication?.(activeCell?.node.application ?? null)
        }}
        onBlur={handleBlur}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => {
          setTooltip(null)
          if (!controllerFocusedRef.current) onFocusedApplication?.(null)
        }}
        onClick={(event) => activateCell(hitFromPointer(event))}
        className="relative mt-3 h-[clamp(20rem,52vh,36rem)] min-h-40 w-full overflow-auto border border-border bg-[#171614] outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <div
          aria-hidden="true"
          className="relative min-w-full"
          style={{ height: Math.max(layout.virtualHeight, viewport.height) }}
        >
          <canvas
            ref={canvasRef}
            data-testid="fleet-health-heatmap-canvas"
            aria-hidden="true"
            className="pointer-events-none sticky left-0 top-0 block"
          />
        </div>
        {tooltip ? (
          <HeatmapTooltip tooltip={tooltip} scrollTop={normalizedScrollTop} />
        ) : null}
      </div>

      <VisibleGroupSummaries groups={visibleGroups} />
      <div className="mt-3 flex flex-col gap-2 border-l-2 border-primary/70 bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p
          id={activeApplicationId}
          role="status"
          aria-label="Active heatmap application"
          aria-live="polite"
          aria-atomic="true"
          className="text-sm text-foreground"
        >
          {activeCell ? <ActiveApplicationSummary cell={activeCell} /> : "No application selected"}
        </p>
        <div className="text-xs leading-5 text-muted-foreground sm:max-w-lg sm:text-right">
          <p id={instructionsId}>
            Use arrows, Home, and End to inspect the fleet. Enter opens Application detail; Escape clears focus.
          </p>
          <Link href={tableHref} className="font-semibold text-primary hover:underline">
            Open complete Table
          </Link>
        </div>
      </div>
    </section>
  )
}

function HeatmapFallback({ error, tableHref }: { error: string; tableHref: string }) {
  return (
    <section
      role="alert"
      aria-label="Heatmap unavailable"
      className="border border-destructive/40 bg-destructive/5 px-5 py-6"
    >
      <h3 className="text-sm font-semibold text-foreground">Heatmap unavailable</h3>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
        {boundedText(error, 240)} The complete Table remains available for every
        authorized Application.
      </p>
      <Link
        href={tableHref}
        className="mt-3 inline-flex min-h-11 items-center font-semibold text-primary hover:underline"
      >
        Open complete Table
      </Link>
    </section>
  )
}

function HeatmapEmpty({ tableHref }: { tableHref: string }) {
  return (
    <section className="border border-border bg-card px-5 py-8 text-center">
      <p role="status" className="text-sm font-medium text-foreground">
        No applications match the active fleet scope.
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        Adjust scope or filters, or inspect the complete semantic inventory.
      </p>
      <Link
        href={tableHref}
        className="mt-3 inline-flex min-h-11 items-center font-semibold text-primary hover:underline"
      >
        Open complete Table
      </Link>
    </section>
  )
}

function HeatmapLegend({
  entries,
}: {
  entries: readonly { health: FleetHealthStatus; count: number }[]
}) {
  if (entries.length === 0) return null
  return (
    <ul
      aria-label="Heatmap health legend"
      className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground"
    >
      {entries.map(({ health, count }) => {
        const style = HEALTH_STYLE[health]
        return (
          <li key={health} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-flex size-5 items-center justify-center border border-current font-mono text-[0.6875rem] font-bold leading-none text-foreground"
            >
              {style.glyph}
            </span>
            <span>{style.label} {count}</span>
          </li>
        )
      })}
    </ul>
  )
}

function VisibleGroupSummaries({ groups }: { groups: readonly HeatmapGroupBand[] }) {
  if (groups.length === 0) return null
  return (
    <ul
      aria-label="Visible heatmap groups"
      className="mt-2 flex max-h-24 flex-wrap gap-x-4 gap-y-1 overflow-auto font-mono text-[0.6875rem] text-muted-foreground"
    >
      {groups.map((group) => (
        <li key={group.stableId}>{groupSummary(group)}</li>
      ))}
    </ul>
  )
}

function HeatmapTooltip({
  tooltip,
  scrollTop,
}: {
  tooltip: TooltipState
  scrollTop: number
}) {
  const description = describeApplication(tooltip.cell)

  return (
    <div
      role="tooltip"
      aria-label="Application health details"
      onPointerMove={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onScroll={(event) => event.stopPropagation()}
      className="pointer-events-auto absolute z-20 w-[15.5rem] overscroll-contain overflow-y-auto border border-border bg-popover px-3 py-2 text-xs leading-5 text-popover-foreground shadow-xl"
      style={{
        left: tooltip.x,
        top: tooltip.y + scrollTop,
        maxHeight: TOOLTIP_HEIGHT,
      }}
    >
      <strong className="block truncate text-sm font-semibold">{description.title}</strong>
      {description.fields.map((field) => (
        <span key={field} className="block truncate">{field}</span>
      ))}
    </div>
  )
}

function ActiveApplicationSummary({ cell }: { cell: HeatmapCellRect }) {
  const description = describeApplication(cell)
  return (
    <>
      <strong className="block font-semibold">{description.title}</strong>
      <span className="mt-1 block text-xs leading-5 text-muted-foreground">
        {description.fields.join(" · ")}
      </span>
    </>
  )
}

function drawHeatmap(
  context: CanvasRenderingContext2D,
  cells: readonly HeatmapCellRect[],
  groups: readonly HeatmapGroupBand[],
  activeStableId: string | null,
  scrollTop: number,
  width: number,
  height: number,
) {
  context.clearRect(0, 0, width, height)
  drawGroupHeaders(context, groups, scrollTop, width, height)

  for (const cell of cells) {
    const y = cell.y - scrollTop
    const drawWidth = Math.max(0, cell.width - CELL_INSET * 2)
    const drawHeight = Math.max(0, cell.height - CELL_INSET * 2)
    if (drawWidth <= 0 || drawHeight <= 0) continue

    const style = HEALTH_STYLE[dominantHealth(cell.node)]
    context.fillStyle = style.fill
    context.strokeStyle = activeStableId === cell.stableId ? "#ef873f" : style.border
    context.lineWidth = activeStableId === cell.stableId ? 2.5 : 1
    context.setLineDash([...style.dash])
    context.fillRect(cell.x + CELL_INSET, y + CELL_INSET, drawWidth, drawHeight)
    context.strokeRect(cell.x + CELL_INSET, y + CELL_INSET, drawWidth, drawHeight)
    context.setLineDash([])

    if (cell.width >= 12 && cell.height >= 12) {
      context.fillStyle = "#f4efe8"
      context.font = "700 9px ui-monospace, SFMono-Regular, monospace"
      context.textBaseline = "alphabetic"
      context.fillText(style.glyph, cell.x + 2, y + Math.min(cell.height - 2, 10))
    }

    if (!cell.showLabel || cell.width < 8 || cell.height < 8) continue
    context.save()
    context.beginPath()
    context.rect(cell.x + 1, y + 1, Math.max(0, cell.width - 2), Math.max(0, cell.height - 2))
    context.clip()
    context.fillStyle = "#f4efe8"
    context.font = "600 10px Instrument Sans, ui-sans-serif, sans-serif"
    context.textBaseline = "alphabetic"
    const fitted = fitTreemapLabel(
      cell.node.label,
      cell.width,
      2,
      (label) => context.measureText(label).width,
    )
    if (fitted) context.fillText(fitted, cell.x + 2, y + Math.max(8, cell.height - 2))
    context.restore()
  }
}

function drawGroupHeaders(
  context: CanvasRenderingContext2D,
  groups: readonly HeatmapGroupBand[],
  scrollTop: number,
  width: number,
  height: number,
) {
  for (const group of groups) {
    if (
      group.y + group.headerHeight <= scrollTop ||
      group.y >= scrollTop + height
    ) {
      continue
    }
    const y = group.y - scrollTop
    const visibleHeight = Math.max(0, group.headerHeight)
    context.fillStyle = "#201e1b"
    context.strokeStyle = "#4a4540"
    context.lineWidth = 1
    context.setLineDash([])
    context.fillRect(0, y, width, visibleHeight)
    context.strokeRect(0, y, width, visibleHeight)
    context.fillStyle = "#d8d0c7"
    context.font = "600 10px ui-monospace, SFMono-Regular, monospace"
    context.textBaseline = "alphabetic"
    const label = fitTreemapLabel(
      `▦ ${groupSummary(group)}`,
      width,
      16,
      (value) => context.measureText(value).width,
    )
    if (label) context.fillText(label, 8, y + 14)
  }
}

function visibleGroupBands(
  groups: readonly HeatmapGroupBand[],
  scrollTop: number,
  viewportHeight: number,
): HeatmapGroupBand[] {
  const bottom = scrollTop + viewportHeight
  return groups.filter(
    (group) => group.y < bottom && group.y + group.height > scrollTop,
  )
}

function completeHealthLegend(
  cells: readonly HeatmapCellRect[],
): Array<{ health: FleetHealthStatus; count: number }> {
  const counts = new Map<FleetHealthStatus, number>()
  for (const cell of cells) {
    const health = dominantHealth(cell.node)
    counts.set(health, (counts.get(health) ?? 0) + 1)
  }
  return HEALTH_ORDER
    .filter((health) => (counts.get(health) ?? 0) > 0)
    .map((health) => ({ health, count: counts.get(health)! }))
}

function dominantHealth(node: FleetMapNode): FleetHealthStatus {
  return (
    HEALTH_ORDER.find((health) =>
      node.health.some(
        (bucket) => bucket.health === health && bucket.count > BigInt(0),
      ),
    ) ?? "unspecified"
  )
}

function groupSummary(group: HeatmapGroupBand): string {
  const applications = `${group.cellCount} application${group.cellCount === 1 ? "" : "s"}`
  const distribution = group.health
    .filter((bucket) => bucket.count > BigInt(0))
    .map((bucket) => `${HEALTH_STYLE[bucket.health].label} ${bucket.count.toString()}`)
  return [group.label, applications, ...distribution].join(" · ")
}

function describeApplication(cell: HeatmapCellRect): ApplicationDescription {
  const node = cell.node
  const metadata = node.applicationMetadata
  const identity = node.application
  const fields = [
    identity?.namespace
      ? `Namespace ${boundedText(identity.namespace, 120)}`
      : null,
    metadata?.project
      ? `Project ${boundedText(objectKey(metadata.project), 160)}`
      : null,
    metadata?.currentCluster
      ? `Cluster ${boundedText(objectKey(metadata.currentCluster), 160)}`
      : null,
    metadata?.currentStage
      ? `Stage ${boundedText(metadata.currentStage, 120)}`
      : null,
    `Health ${HEALTH_STYLE[dominantHealth(node)].label}`,
    metadata ? `Sync ${humanize(metadata.sync)}` : null,
    metadata ? `Release ${humanize(metadata.release)}` : null,
    metadata ? `Rollout ${humanize(metadata.rollout)}` : null,
    metadata ? `${metadata.managedResources.toString()} managed resources` : null,
    metadata?.lastTransitionUnixMs !== undefined
      ? `Last transition ${formatTimestamp(metadata.lastTransitionUnixMs)}`
      : null,
    metadata?.issueSummary
      ? `Issue ${boundedText(metadata.issueSummary, 240)}`
      : null,
  ].filter((field): field is string => Boolean(field))

  return {
    title: boundedText(node.label, 160),
    fields,
  }
}

function findApplicationStableId(
  cells: readonly HeatmapCellRect[],
  selected: NamespacedKey | null | undefined,
): string | null {
  if (!selected) return null
  return (
    cells.find(
      (cell) =>
        cell.node.application?.namespace === selected.namespace &&
        cell.node.application.name === selected.name,
    )?.stableId ?? null
  )
}

function scrollCellIntoView(
  controller: HTMLDivElement | null,
  cell: HeatmapCellRect,
  layout: HeatmapLayoutResult,
  viewportHeight: number,
  update: (scrollTop: number) => void,
) {
  if (!controller) return
  const current = clampScrollTop(controller.scrollTop, layout.virtualHeight, viewportHeight)
  let next = current
  if (cell.y < current) {
    const group = layout.groups.find((candidate) => candidate.stableId === cell.groupStableId)
    next = Math.max(0, group?.y ?? cell.y)
  } else if (cell.y + cell.height > current + viewportHeight) {
    next = cell.y + cell.height - viewportHeight
  }
  next = clampScrollTop(next, layout.virtualHeight, viewportHeight)
  if (next === current) return
  controller.scrollTop = next
  update(next)
}

function clampScrollTop(scrollTop: number, virtualHeight: number, viewportHeight: number): number {
  const maximum = Math.max(0, virtualHeight - viewportHeight)
  if (!Number.isFinite(scrollTop) || scrollTop <= 0) return 0
  return Math.min(scrollTop, maximum)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

function contentPointer(
  controller: HTMLElement,
  event: { clientX: number; clientY: number },
): { x: number; y: number } {
  const bounds = controller.getBoundingClientRect()
  return {
    x: event.clientX - bounds.left - controller.clientLeft,
    y: event.clientY - bounds.top - controller.clientTop,
  }
}

function objectKey(value: NamespacedKey): string {
  return `${value.namespace}/${value.name}`
}

function humanize(value: string): string {
  const normalized = value.replaceAll("_", " ").trim()
  return normalized ? `${normalized[0]!.toUpperCase()}${normalized.slice(1)}` : "Unspecified"
}

function formatTimestamp(value: bigint): string {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return "Unknown"
  const timestamp = new Date(numeric)
  return Number.isNaN(timestamp.getTime()) ? "Unknown" : timestamp.toISOString()
}

function boundedText(value: string, maximumLength: number): string {
  const normalized = value.trim().replaceAll(/\s+/gu, " ")
  if (normalized.length <= maximumLength) return normalized
  return `${normalized.slice(0, Math.max(0, maximumLength - 1)).trimEnd()}…`
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

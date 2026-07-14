"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react"

import {
  hitTestTreemap,
  layoutTreemap,
  resolveTreemapMotion,
  type TreemapRectangle,
} from "@/components/fleet/treemap-layout"
import {
  navigateTreemapSelection,
  retainTreemapSelection,
  type TreemapNavigationKey,
} from "@/components/fleet/treemap-navigation"
import {
  createTreemapHealthLegend,
  fitTreemapLabel,
  TREEMAP_HEALTH_PRESENTATION,
} from "@/components/fleet/treemap-presentation"
import type {
  FleetHealthStatus,
  FleetMapResult,
} from "@/lib/fleet-client"
import type { FleetFocusTarget } from "@/lib/fleet-focus"
import type { NamespacedKey } from "@/lib/fleet-query"

const DEFAULT_VIEWPORT = { width: 960, height: 520 }
const NAVIGATION_KEYS = new Set<TreemapNavigationKey>([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
])

const HEALTH_STYLE: Record<
  FleetHealthStatus,
  { fill: string; border: string; glyph: string; label: string }
> = {
  healthy: { fill: "#273126", border: "#70906a", ...TREEMAP_HEALTH_PRESENTATION.healthy },
  progressing: { fill: "#332e22", border: "#b8904b", ...TREEMAP_HEALTH_PRESENTATION.progressing },
  degraded: { fill: "#382922", border: "#c77752", ...TREEMAP_HEALTH_PRESENTATION.degraded },
  failed: { fill: "#382324", border: "#bd5c5c", ...TREEMAP_HEALTH_PRESENTATION.failed },
  unknown: { fill: "#2b2926", border: "#827b73", ...TREEMAP_HEALTH_PRESENTATION.unknown },
  missing: { fill: "#292623", border: "#776f67", ...TREEMAP_HEALTH_PRESENTATION.missing },
  unspecified: { fill: "#292724", border: "#716b64", glyph: "·", label: "Unspecified" },
}

export interface FleetTreemapProps {
  result: FleetMapResult
  zoom: string
  selected?: NamespacedKey | null
  onZoomChange: (zoom: string) => void
  onSelectApplication: (identity: NamespacedKey) => void
  onFocusedApplication: (identity: NamespacedKey | null) => void
  registerTarget?: (identity: NamespacedKey, target: FleetFocusTarget | null) => void
}

export function FleetTreemap({
  result,
  zoom,
  selected,
  onZoomChange,
  onSelectApplication,
  onFocusedApplication,
  registerTarget,
}: FleetTreemapProps) {
  const controllerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT)
  const [activeStableId, setActiveStableId] = useState<string | null>(null)
  const [tooltip, setTooltip] = useState<{
    rectangle: TreemapRectangle
    x: number
    y: number
  } | null>(null)
  const reducedMotion = usePrefersReducedMotion()
  const motion = resolveTreemapMotion(reducedMotion)
  const layout = useMemo(
    () =>
      layoutTreemap(
        result.roots,
        {
          ...viewport,
          devicePixelRatio:
            typeof window === "undefined" ? 1 : window.devicePixelRatio,
        },
        { zoom },
      ),
    [result.roots, viewport, zoom],
  )
  const selectedStableId = useMemo(
    () => findApplicationStableId(layout.rectangles, selected),
    [layout.rectangles, selected],
  )
  const retainedActive = retainTreemapSelection(activeStableId, layout.rectangles)
  const effectiveActiveId =
    selectedStableId ??
    retainedActive ??
    layout.rectangles.find((rectangle) => rectangle.selectable)?.stableId ??
    null
  const activeRectangle =
    layout.rectangles.find(
      (rectangle) => rectangle.stableId === effectiveActiveId,
    ) ?? null
  const legend = useMemo(
    () => createTreemapHealthLegend(layout.scope.roots),
    [layout.scope.roots],
  )

  useEffect(() => {
    const controller = controllerRef.current
    if (!controller) return

    let frame = 0
    const measure = () => {
      const bounds = controller.getBoundingClientRect()
      if (bounds.width <= 0 || bounds.height <= 0) return
      setViewport((current) =>
        current.width === bounds.width && current.height === bounds.height
          ? current
          : { width: bounds.width, height: bounds.height },
      )
    }
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure)
    observer?.observe(controller)
    frame = window.requestAnimationFrame(measure)
    window.addEventListener("resize", measure)
    return () => {
      observer?.disconnect()
      window.cancelAnimationFrame(frame)
      window.removeEventListener("resize", measure)
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context) return

    canvas.width = layout.canvas.pixelWidth
    canvas.height = layout.canvas.pixelHeight
    canvas.style.width = `${layout.canvas.cssWidth}px`
    canvas.style.height = `${layout.canvas.cssHeight}px`
    context.setTransform(layout.canvas.scaleX, 0, 0, layout.canvas.scaleY, 0, 0)
    drawTreemap(
      context,
      layout.rectangles,
      effectiveActiveId,
      layout.canvas.cssWidth,
      layout.canvas.cssHeight,
    )
  }, [effectiveActiveId, layout])

  const focusRectangle = useCallback(
    (rectangle: TreemapRectangle) => {
      const identity = rectangle.node.application
      if (!identity) return
      setActiveStableId(rectangle.stableId)
      onFocusedApplication(identity)
    },
    [onFocusedApplication],
  )

  useEffect(() => {
    if (!registerTarget) return
    const targets: Array<{ identity: NamespacedKey; target: FleetFocusTarget }> = []

    for (const rectangle of layout.rectangles) {
      const identity = rectangle.node.application
      if (!identity) continue
      const target: FleetFocusTarget = {
        focus: () => {
          const controller = controllerRef.current
          if (!controller) return
          controller.focus()
          focusRectangle(rectangle)
        },
      }
      targets.push({ identity, target })
      registerTarget(identity, target)
    }

    return () => targets.forEach(({ identity }) => registerTarget(identity, null))
  }, [focusRectangle, layout.rectangles, registerTarget])

  const selectRectangle = useCallback(
    (rectangle: TreemapRectangle | null) => {
      const identity = rectangle?.node.application
      if (!rectangle || !identity) return
      setActiveStableId(rectangle.stableId)
      onSelectApplication(identity)
      onFocusedApplication(identity)
    },
    [onFocusedApplication, onSelectApplication],
  )

  const hitFromPointer = useCallback(
    (event: { clientX: number; clientY: number }): TreemapRectangle | null => {
      const bounds = controllerRef.current?.getBoundingClientRect()
      if (!bounds) return null
      return hitTestTreemap(
        layout.rectangles,
        event.clientX - bounds.left,
        event.clientY - bounds.top,
      )
    },
    [layout.rectangles],
  )

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const rectangle = hitFromPointer(event)
      if (!rectangle) {
        setTooltip(null)
        return
      }
      const bounds = controllerRef.current?.getBoundingClientRect()
      setTooltip({
        rectangle,
        x: event.clientX - (bounds?.left ?? 0),
        y: event.clientY - (bounds?.top ?? 0),
      })
    },
    [hitFromPointer],
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (NAVIGATION_KEYS.has(event.key as TreemapNavigationKey)) {
        event.preventDefault()
        const nextStableId = navigateTreemapSelection(
          layout.rectangles,
          effectiveActiveId,
          event.key as TreemapNavigationKey,
        )
        const next =
          layout.rectangles.find(
            (rectangle) => rectangle.stableId === nextStableId,
          ) ?? null
        selectRectangle(next)
        return
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        selectRectangle(activeRectangle)
        return
      }
      if (event.key === "Escape" && zoom) {
        event.preventDefault()
        onZoomChange("")
      }
    },
    [activeRectangle, effectiveActiveId, layout.rectangles, onZoomChange, selectRectangle, zoom],
  )

  const handleFocus = useCallback(() => {
    onFocusedApplication(activeRectangle?.node.application ?? null)
  }, [activeRectangle, onFocusedApplication])

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        onFocusedApplication(null)
      }
    },
    [onFocusedApplication],
  )

  const activeDetail = activeRectangle
    ? describeRectangle(activeRectangle)
    : "No application is selected."

  return (
    <section
      role="region"
      aria-label="Fleet map"
      className="px-4 py-6 sm:px-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-primary">
            Impact topology
          </p>
          <h2 className="mt-1 text-lg font-semibold text-foreground">Fleet treemap</h2>
        </div>
        <p className="font-mono text-xs tabular-nums text-muted-foreground">
          {result.total.toString()} applications · generation {result.indexGeneration.toString()}
        </p>
      </div>

      {legend.length > 0 ? (
        <ul
          aria-label="Treemap health legend"
          className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground"
        >
          {legend.map((entry) => (
            <li key={entry.health} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                data-health-glyph={entry.health}
                className="inline-flex size-5 items-center justify-center border border-current font-mono text-[0.6875rem] font-bold leading-none text-foreground"
              >
                {entry.glyph}
              </span>
              <span>{entry.label}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {layout.scope.breadcrumbs.length > 0 ? (
        <p className="mt-3 font-mono text-xs text-muted-foreground">
          Scope / {layout.scope.breadcrumbs.map((node) => node.label).join(" / ")}
          <span className="ml-2 text-foreground">Press Escape to return.</span>
        </p>
      ) : null}

      <div
        ref={controllerRef}
        role="application"
        aria-label="Fleet treemap"
        aria-describedby="fleet-treemap-instructions fleet-treemap-selection"
        tabIndex={0}
        data-motion={motion.animate ? "enabled" : "reduced"}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setTooltip(null)}
        onClick={(event) => selectRectangle(hitFromPointer(event))}
        onDoubleClick={(event) => {
          const rectangle = hitFromPointer(event)
          if (rectangle?.node.kind === "group") {
            onZoomChange(rectangle.stableId)
          }
        }}
        className="relative mt-4 h-[clamp(28rem,60vh,44rem)] min-h-[28rem] w-full cursor-crosshair overflow-hidden border border-border bg-[#171614] outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <canvas ref={canvasRef} aria-hidden="true" className="block" />
        {tooltip ? (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 max-w-64 border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xl"
            style={{
              left: Math.min(tooltip.x + 12, Math.max(8, viewport.width - 240)),
              top: Math.min(tooltip.y + 12, Math.max(8, viewport.height - 72)),
            }}
          >
            {describeRectangle(tooltip.rectangle)}
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex flex-col gap-2 border-l-2 border-primary/70 bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p
          id="fleet-treemap-selection"
          role="status"
          aria-label="Treemap selection"
          aria-live="polite"
          aria-atomic="true"
          className="text-sm text-foreground"
        >
          {activeDetail}
        </p>
        <p
          id="fleet-treemap-instructions"
          className="text-xs leading-5 text-muted-foreground sm:max-w-md sm:text-right"
        >
          Tap or click a cell. For keyboard navigation, use arrows, Home, and End. Table presentation is the complete semantic equivalent.
        </p>
      </div>
    </section>
  )
}

function drawTreemap(
  context: CanvasRenderingContext2D,
  rectangles: readonly TreemapRectangle[],
  activeStableId: string | null,
  width: number,
  height: number,
) {
  context.clearRect(0, 0, width, height)
  for (const rectangle of rectangles) {
    if (rectangle.width <= 0 || rectangle.height <= 0) continue
    const health = dominantHealth(rectangle)
    const style = HEALTH_STYLE[health]
    const isGroup = rectangle.node.kind === "group"
    const inset = isGroup ? 0.5 : 1
    context.fillStyle = isGroup ? "#201e1b" : style.fill
    context.strokeStyle = activeStableId === rectangle.stableId ? "#ef873f" : style.border
    context.lineWidth = activeStableId === rectangle.stableId ? 2.5 : 1
    context.fillRect(
      rectangle.x + inset,
      rectangle.y + inset,
      Math.max(0, rectangle.width - inset * 2),
      Math.max(0, rectangle.height - inset * 2),
    )
    context.strokeRect(
      rectangle.x + inset,
      rectangle.y + inset,
      Math.max(0, rectangle.width - inset * 2),
      Math.max(0, rectangle.height - inset * 2),
    )

    const labelY = rectangle.y + (isGroup ? 14 : 18)
    if (rectangle.width >= 52 && rectangle.height >= 18) {
      context.save()
      context.beginPath()
      context.rect(rectangle.x + 2, rectangle.y + 2, Math.max(0, rectangle.width - 4), Math.max(0, rectangle.height - 4))
      context.clip()
      context.fillStyle = "#f4efe8"
      context.font = isGroup
        ? "600 10px ui-monospace, SFMono-Regular, monospace"
        : "600 12px Instrument Sans, ui-sans-serif, sans-serif"
      context.textBaseline = "alphabetic"
      const fittedLabel = fitTreemapLabel(
        isGroup ? `▦ ${rectangle.node.label}` : `${style.glyph} ${rectangle.node.label}`,
        rectangle.width,
        16,
        (label) => context.measureText(label).width,
      )
      if (fittedLabel) context.fillText(fittedLabel, rectangle.x + 8, labelY)
      if (!isGroup && rectangle.width >= 110 && rectangle.height >= 38) {
        context.fillStyle = "#b8b0a7"
        context.font = "10px ui-monospace, SFMono-Regular, monospace"
        const fittedDetail = fitTreemapLabel(
          `${style.label} · ${rectangle.node.targetCount.toString()} target${rectangle.node.targetCount === BigInt(1) ? "" : "s"}`,
          rectangle.width,
          16,
          (label) => context.measureText(label).width,
        )
        if (fittedDetail) context.fillText(fittedDetail, rectangle.x + 8, labelY + 16)
      }
      context.restore()
    }
  }
}

function dominantHealth(rectangle: TreemapRectangle): FleetHealthStatus {
  const priority: readonly FleetHealthStatus[] = [
    "failed",
    "degraded",
    "missing",
    "progressing",
    "unknown",
    "healthy",
    "unspecified",
  ]
  return (
    priority.find((health) =>
      rectangle.node.health.some(
        (bucket) => bucket.health === health && bucket.count > BigInt(0),
      ),
    ) ?? "unspecified"
  )
}

function describeRectangle(rectangle: TreemapRectangle): string {
  const health = HEALTH_STYLE[dominantHealth(rectangle)].label
  const applications = rectangle.node.applicationCount
  const targets = rectangle.node.targetCount
  return `${rectangle.node.label}. ${health}. ${applications.toString()} application${applications === BigInt(1) ? "" : "s"}, ${targets.toString()} target${targets === BigInt(1) ? "" : "s"}.`
}

function findApplicationStableId(
  rectangles: readonly TreemapRectangle[],
  selected: NamespacedKey | null | undefined,
): string | null {
  if (!selected) return null
  return (
    rectangles.find(
      (rectangle) =>
        rectangle.node.application?.namespace === selected.namespace &&
        rectangle.node.application.name === selected.name,
    )?.stableId ?? null
  )
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window === "undefined"
      ? true
      : window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  )

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => setReduced(query.matches)
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])

  return reduced
}

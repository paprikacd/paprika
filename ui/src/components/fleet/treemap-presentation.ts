import type { FleetHealthStatus, FleetMapNode } from "@/lib/fleet-client"

export type TreemapLegendHealth = Exclude<FleetHealthStatus, "unspecified">

export interface TreemapHealthLegendEntry {
  health: TreemapLegendHealth
  label: string
  glyph: string
}

const TREEMAP_HEALTH_ORDER: readonly TreemapLegendHealth[] = [
  "failed",
  "degraded",
  "progressing",
  "missing",
  "unknown",
  "healthy",
]

export const TREEMAP_HEALTH_PRESENTATION: Readonly<
  Record<TreemapLegendHealth, Omit<TreemapHealthLegendEntry, "health">>
> = {
  failed: { label: "Failed", glyph: "×" },
  degraded: { label: "Degraded", glyph: "!" },
  progressing: { label: "Progressing", glyph: "↻" },
  missing: { label: "Missing", glyph: "∅" },
  unknown: { label: "Unknown", glyph: "?" },
  healthy: { label: "Healthy", glyph: "✓" },
}

const LEGEND_HEALTH = new Set<TreemapLegendHealth>(TREEMAP_HEALTH_ORDER)
const ELLIPSIS = "…"
const GRAPHEME_SEGMENTER =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null

export function collectVisibleTreemapHealth(
  roots: readonly FleetMapNode[],
): TreemapLegendHealth[] {
  const present = new Set<TreemapLegendHealth>()
  const pending = [...roots]

  while (pending.length > 0) {
    const node = pending.pop()
    if (!node) continue
    for (const bucket of node.health) {
      if (bucket.count > BigInt(0) && isLegendHealth(bucket.health)) {
        present.add(bucket.health)
      }
    }
    for (const child of node.children) pending.push(child)
  }

  return TREEMAP_HEALTH_ORDER.filter((health) => present.has(health))
}

export function createTreemapHealthLegend(
  roots: readonly FleetMapNode[],
): TreemapHealthLegendEntry[] {
  return collectVisibleTreemapHealth(roots).map((health) => ({
    health,
    ...TREEMAP_HEALTH_PRESENTATION[health],
  }))
}

export function fitTreemapLabel(
  label: string,
  availableWidth: number,
  padding: number,
  measureText: (label: string) => number,
): string {
  const width = Number.isFinite(availableWidth) ? Math.max(0, availableWidth) : 0
  const inset = Number.isFinite(padding) ? Math.max(0, padding) : 0
  if (measureText(label) + inset <= width) return label
  if (measureText(ELLIPSIS) + inset > width) return ""

  const segments = segmentGraphemes(label)
  let low = 0
  let high = Math.max(0, segments.length - 1)
  let fittingPrefixLength = 0

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = `${segments.slice(0, middle + 1).join("")}${ELLIPSIS}`
    if (measureText(candidate) + inset <= width) {
      fittingPrefixLength = middle + 1
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  return `${segments.slice(0, fittingPrefixLength).join("")}${ELLIPSIS}`
}

function isLegendHealth(health: FleetHealthStatus): health is TreemapLegendHealth {
  return LEGEND_HEALTH.has(health as TreemapLegendHealth)
}

function segmentGraphemes(label: string): string[] {
  if (GRAPHEME_SEGMENTER) {
    return Array.from(
      GRAPHEME_SEGMENTER.segment(label),
      (segment) => segment.segment,
    )
  }
  return Array.from(label)
}

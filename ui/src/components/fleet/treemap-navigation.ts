import type { TreemapRectangle } from "@/components/fleet/treemap-layout"

const POSITION_EPSILON = 1e-9

export type TreemapNavigationKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown"
  | "Home"
  | "End"

export type TreemapNavigationRectangle = Pick<
  TreemapRectangle,
  "stableId" | "x" | "y" | "width" | "height" | "selectable"
>

/**
 * Implements one-controller spatial navigation for the Canvas presentation.
 * A missing selection starts at the first cell; a blocked arrow retains the
 * current stable ID instead of unexpectedly wrapping.
 */
export function navigateTreemapSelection(
  rectangles: readonly TreemapNavigationRectangle[],
  selectedStableId: string | null,
  key: TreemapNavigationKey,
): string | null {
  const candidates = navigableRectangles(rectangles)
  if (candidates.length === 0) return null

  const readingOrder = [...candidates].sort(compareReadingOrder)
  if (key === "Home") return readingOrder[0]?.stableId ?? null
  if (key === "End") return readingOrder.at(-1)?.stableId ?? null

  const current = candidates.find((rectangle) => rectangle.stableId === selectedStableId)
  if (!current) return readingOrder[0]?.stableId ?? null

  const nearest = candidates
    .filter(
      (candidate) =>
        candidate.stableId !== current.stableId && liesInDirection(current, candidate, key),
    )
    .map((candidate) => ({ candidate, score: directionalScore(current, candidate, key) }))
    .sort(
      (left, right) =>
        left.score.distance - right.score.distance ||
        left.score.centerDistance - right.score.centerDistance ||
        left.score.primary - right.score.primary ||
        left.score.cross - right.score.cross ||
        left.candidate.stableId.localeCompare(right.candidate.stableId),
    )[0]?.candidate

  return nearest?.stableId ?? current.stableId
}

/** Returns the same logical selection only while that selectable cell exists. */
export function retainTreemapSelection(
  selectedStableId: string | null,
  rectangles: readonly TreemapNavigationRectangle[],
): string | null {
  if (!selectedStableId) return null
  return navigableRectangles(rectangles).some(
    (rectangle) => rectangle.stableId === selectedStableId,
  )
    ? selectedStableId
    : null
}

function navigableRectangles(
  rectangles: readonly TreemapNavigationRectangle[],
): TreemapNavigationRectangle[] {
  return rectangles.filter(
    (rectangle) =>
      rectangle.selectable &&
      Number.isFinite(rectangle.x) &&
      Number.isFinite(rectangle.y) &&
      Number.isFinite(rectangle.width) &&
      Number.isFinite(rectangle.height) &&
      rectangle.width > 0 &&
      rectangle.height > 0,
  )
}

function compareReadingOrder(
  left: TreemapNavigationRectangle,
  right: TreemapNavigationRectangle,
): number {
  return left.y - right.y || left.x - right.x || left.stableId.localeCompare(right.stableId)
}

function liesInDirection(
  current: TreemapNavigationRectangle,
  candidate: TreemapNavigationRectangle,
  key: Exclude<TreemapNavigationKey, "Home" | "End">,
): boolean {
  const currentCenter = center(current)
  const candidateCenter = center(candidate)

  switch (key) {
    case "ArrowLeft":
      return candidateCenter.x < currentCenter.x - POSITION_EPSILON
    case "ArrowRight":
      return candidateCenter.x > currentCenter.x + POSITION_EPSILON
    case "ArrowUp":
      return candidateCenter.y < currentCenter.y - POSITION_EPSILON
    case "ArrowDown":
      return candidateCenter.y > currentCenter.y + POSITION_EPSILON
  }
}

function directionalScore(
  current: TreemapNavigationRectangle,
  candidate: TreemapNavigationRectangle,
  key: Exclude<TreemapNavigationKey, "Home" | "End">,
): { distance: number; centerDistance: number; primary: number; cross: number } {
  let primary: number
  let cross: number

  switch (key) {
    case "ArrowLeft":
      primary = Math.max(0, current.x - (candidate.x + candidate.width))
      cross = intervalDistance(
        current.y,
        current.y + current.height,
        candidate.y,
        candidate.y + candidate.height,
      )
      break
    case "ArrowRight":
      primary = Math.max(0, candidate.x - (current.x + current.width))
      cross = intervalDistance(
        current.y,
        current.y + current.height,
        candidate.y,
        candidate.y + candidate.height,
      )
      break
    case "ArrowUp":
      primary = Math.max(0, current.y - (candidate.y + candidate.height))
      cross = intervalDistance(
        current.x,
        current.x + current.width,
        candidate.x,
        candidate.x + candidate.width,
      )
      break
    case "ArrowDown":
      primary = Math.max(0, candidate.y - (current.y + current.height))
      cross = intervalDistance(
        current.x,
        current.x + current.width,
        candidate.x,
        candidate.x + candidate.width,
      )
      break
  }

  const currentCenter = center(current)
  const candidateCenter = center(candidate)
  return {
    distance: Math.hypot(primary, cross),
    centerDistance: Math.hypot(
      candidateCenter.x - currentCenter.x,
      candidateCenter.y - currentCenter.y,
    ),
    primary,
    cross,
  }
}

function center(rectangle: TreemapNavigationRectangle): { x: number; y: number } {
  return {
    x: rectangle.x + rectangle.width / 2,
    y: rectangle.y + rectangle.height / 2,
  }
}

function intervalDistance(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number,
): number {
  if (firstEnd < secondStart) return secondStart - firstEnd
  if (secondEnd < firstStart) return firstStart - secondEnd
  return 0
}

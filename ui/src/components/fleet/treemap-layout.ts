import { hierarchy, treemap, treemapBinary } from "d3-hierarchy"

import type { FleetMapNode } from "@/lib/fleet-client"

const DEFAULT_GAP = 1
const DEFAULT_GROUP_HEADER_HEIGHT = 20
const DEFAULT_MOTION_DURATION_MS = 180
const MAX_DEVICE_PIXEL_RATIO = 4
const BOUNDARY_EPSILON = 1e-9

export interface TreemapViewport {
  width: number
  height: number
  devicePixelRatio?: number
}

export interface TreemapLayoutOptions {
  zoom?: string
  gap?: number
  groupHeaderHeight?: number
}

export interface TreemapCanvasMetrics {
  cssWidth: number
  cssHeight: number
  pixelWidth: number
  pixelHeight: number
  scaleX: number
  scaleY: number
  devicePixelRatio: number
}

export interface TreemapRectangle {
  stableId: string
  parentStableId: string | null
  node: FleetMapNode
  depth: number
  x: number
  y: number
  width: number
  height: number
  selectable: boolean
}

export interface TreemapScope {
  zoom: string
  roots: readonly FleetMapNode[]
  breadcrumbs: readonly FleetMapNode[]
}

export interface TreemapLayoutResult {
  rectangles: readonly TreemapRectangle[]
  scope: TreemapScope
  canvas: TreemapCanvasMetrics
}

export interface TreemapMotion {
  animate: boolean
  durationMs: number
}

interface SyntheticRoot {
  stableId: ""
  children: readonly FleetMapNode[]
}

type LayoutDatum = FleetMapNode | SyntheticRoot

/**
 * Produces a deterministic hierarchy in CSS-pixel coordinates. The backing
 * canvas dimensions are returned separately so drawing code can set a DPR
 * transform without changing hit-test or navigation coordinates.
 */
export function layoutTreemap(
  roots: readonly FleetMapNode[],
  viewport: TreemapViewport,
  options: TreemapLayoutOptions = {},
): TreemapLayoutResult {
  const canvas = createTreemapCanvasMetrics(
    viewport.width,
    viewport.height,
    viewport.devicePixelRatio,
  )
  const scope = resolveTreemapScope(roots, options.zoom)

  if (canvas.cssWidth === 0 || canvas.cssHeight === 0 || scope.roots.length === 0) {
    return { rectangles: [], scope, canvas }
  }

  const synthetic: SyntheticRoot = { stableId: "", children: scope.roots }
  const root = hierarchy<LayoutDatum>(synthetic, (datum) => datum.children)
    .sum((datum) => {
      if (!isFleetMapNode(datum) || datum.children.length > 0) return 0
      return normalizedWeight(datum.effectiveWeight)
    })
    .sort((left, right) => {
      const byWeight = (right.value ?? 0) - (left.value ?? 0)
      return byWeight || left.data.stableId.localeCompare(right.data.stableId)
    })

  const gap = normalizedSpacing(options.gap, DEFAULT_GAP)
  const groupHeaderHeight = normalizedSpacing(
    options.groupHeaderHeight,
    DEFAULT_GROUP_HEADER_HEIGHT,
  )

  const laidOut = treemap<LayoutDatum>()
    .tile(treemapBinary)
    .size([canvas.cssWidth, canvas.cssHeight])
    .paddingInner(gap)
    .paddingTop((node) =>
      node.depth > 0 && node.children && node.children.length > 0 ? groupHeaderHeight : 0,
    )(root)

  const rectangles = laidOut
    .descendants()
    .filter((entry) => isFleetMapNode(entry.data))
    .map<TreemapRectangle>((entry) => {
      const node = entry.data as FleetMapNode
      const parent = entry.parent?.data
      return {
        stableId: node.stableId,
        parentStableId: parent && isFleetMapNode(parent) ? parent.stableId : null,
        node,
        depth: Math.max(0, entry.depth - 1),
        x: entry.x0,
        y: entry.y0,
        width: Math.max(0, entry.x1 - entry.x0),
        height: Math.max(0, entry.y1 - entry.y0),
        selectable: node.kind === "application",
      }
    })

  return { rectangles, scope, canvas }
}

export function createTreemapCanvasMetrics(
  width: number,
  height: number,
  requestedDevicePixelRatio = 1,
): TreemapCanvasMetrics {
  const cssWidth = normalizedDimension(width)
  const cssHeight = normalizedDimension(height)
  const devicePixelRatio = normalizedDevicePixelRatio(requestedDevicePixelRatio)
  const pixelWidth = Math.round(cssWidth * devicePixelRatio)
  const pixelHeight = Math.round(cssHeight * devicePixelRatio)

  return {
    cssWidth,
    cssHeight,
    pixelWidth,
    pixelHeight,
    scaleX: cssWidth > 0 ? pixelWidth / cssWidth : devicePixelRatio,
    scaleY: cssHeight > 0 ? pixelHeight / cssHeight : devicePixelRatio,
    devicePixelRatio,
  }
}

/**
 * Selects a subtree for presentation only. No fleet filters are accepted or
 * returned, which keeps semantic zoom independent of authorization scope.
 */
export function resolveTreemapScope(
  roots: readonly FleetMapNode[],
  requestedZoom?: string | null,
): TreemapScope {
  const zoom = requestedZoom?.trim() ?? ""
  if (!zoom) return { zoom: "", roots, breadcrumbs: [] }

  const breadcrumbs = findNodePath(roots, zoom)
  if (!breadcrumbs) return { zoom: "", roots, breadcrumbs: [] }

  return {
    zoom,
    roots: [breadcrumbs[breadcrumbs.length - 1]!],
    breadcrumbs,
  }
}

/** A deliberately narrow patch for the shared URL query state. */
export function semanticZoomPatch(stableId: string | null | undefined): Readonly<{ zoom: string }> {
  return { zoom: stableId?.trim() ?? "" }
}

/**
 * Returns the deepest rectangle under a CSS-pixel point. Sibling bounds are
 * half-open, except for the outer right/bottom edges, so shared edges always
 * resolve to the cell beginning at that edge.
 */
export function hitTestTreemap(
  rectangles: readonly TreemapRectangle[],
  x: number,
  y: number,
): TreemapRectangle | null {
  if (rectangles.length === 0 || !Number.isFinite(x) || !Number.isFinite(y)) return null

  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const rectangle of rectangles) {
    maxX = Math.max(maxX, rectangle.x + rectangle.width)
    maxY = Math.max(maxY, rectangle.y + rectangle.height)
  }

  let match: TreemapRectangle | null = null
  for (const rectangle of rectangles) {
    if (
      !containsAxis(x, rectangle.x, rectangle.x + rectangle.width, maxX) ||
      !containsAxis(y, rectangle.y, rectangle.y + rectangle.height, maxY)
    ) {
      continue
    }

    if (!match || isPreferredHit(rectangle, match)) match = rectangle
  }

  return match
}

export function resolveTreemapMotion(reducedMotion: boolean): TreemapMotion {
  return reducedMotion
    ? { animate: false, durationMs: 0 }
    : { animate: true, durationMs: DEFAULT_MOTION_DURATION_MS }
}

function findNodePath(
  roots: readonly FleetMapNode[],
  stableId: string,
): FleetMapNode[] | null {
  const pending = roots
    .slice()
    .reverse()
    .map((node) => ({ node, path: [node] }))

  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) break
    if (current.node.stableId === stableId) return current.path

    for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
      const child = current.node.children[index]
      if (child) pending.push({ node: child, path: [...current.path, child] })
    }
  }

  return null
}

function isFleetMapNode(datum: LayoutDatum): datum is FleetMapNode {
  return "kind" in datum
}

function normalizedWeight(weight: number): number {
  return Number.isFinite(weight) && weight > 0 ? weight : 1
}

function normalizedSpacing(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  return Number.isFinite(value) ? Math.max(0, value) : fallback
}

function normalizedDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function normalizedDevicePixelRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  return Math.min(value, MAX_DEVICE_PIXEL_RATIO)
}

function containsAxis(value: number, start: number, end: number, outerEnd: number): boolean {
  if (value < start || value > end) return false
  if (value < end) return true
  return approximatelyEqual(end, outerEnd)
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= BOUNDARY_EPSILON
}

function isPreferredHit(candidate: TreemapRectangle, current: TreemapRectangle): boolean {
  if (candidate.depth !== current.depth) return candidate.depth > current.depth
  if (candidate.selectable !== current.selectable) return candidate.selectable
  return candidate.stableId.localeCompare(current.stableId) < 0
}

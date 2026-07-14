import type {
  FleetHealthStatus,
  FleetMapNode,
  FleetReleaseStatus,
  FleetRolloutStatus,
  FleetSyncStatus,
} from "@/lib/fleet-client"
import type {
  FleetDensity,
  FleetDirection,
  FleetLabelMode,
  FleetSort,
  NamespacedKey,
} from "@/lib/fleet-query"

export type FleetSortField = FleetSort
export type FleetSortDirection = FleetDirection

export const HEATMAP_MIN_CELL_SIZE = 6
export const HEATMAP_COMPACT_CELL_SIZE = 12
export const HEATMAP_COMFORTABLE_CELL_SIZE = 52
export const HEATMAP_AUTO_MAX_CELL_SIZE = HEATMAP_COMFORTABLE_CELL_SIZE
export const HEATMAP_AUTO_LABEL_MIN_CELL_SIZE = 52
export const HEATMAP_GROUP_HEADER_HEIGHT = 20
export const HEATMAP_GROUP_GAP = 8

const DIRECT_ROOT_GROUP_ID = "paprika:heatmap:direct-applications"
const DIRECT_ROOT_GROUP_LABEL = "Applications"
const FNV_64_OFFSET = BigInt("14695981039346656037")
const FNV_64_PRIME = BigInt("1099511628211")
const UINT64_MASK = BigInt("18446744073709551615")
const ZERO = BigInt(0)
const ONE = BigInt(1)

const HEALTH_SEVERITY: Readonly<Record<FleetHealthStatus, number>> = {
  unspecified: 0,
  healthy: 1,
  unknown: 2,
  missing: 3,
  progressing: 4,
  degraded: 5,
  failed: 6,
}

const HEALTH_PRESENTATION_ORDER: readonly FleetHealthStatus[] = [
  "failed",
  "degraded",
  "progressing",
  "missing",
  "unknown",
  "healthy",
  "unspecified",
]

const SYNC_ORDER: Readonly<Record<FleetSyncStatus, number>> = {
  unspecified: 0,
  synced: 1,
  out_of_sync: 2,
  unknown: 3,
}

const RELEASE_ORDER: Readonly<Record<FleetReleaseStatus, number>> = {
  unspecified: 0,
  pending: 1,
  promoting: 2,
  canarying: 3,
  verifying: 4,
  complete: 5,
  failed: 6,
  rolled_back: 7,
  superseded: 8,
  awaiting_approval: 9,
}

const ROLLOUT_ORDER: Readonly<Record<FleetRolloutStatus, number>> = {
  unspecified: 0,
  pending: 1,
  progressing: 2,
  paused: 3,
  healthy: 4,
  degraded: 5,
  failed: 6,
  rolled_back: 7,
  aborted: 8,
}

const ACTIVE_RELEASE = new Set<FleetReleaseStatus>([
  "pending",
  "promoting",
  "canarying",
  "verifying",
  "awaiting_approval",
])
const ACTIVE_ROLLOUT = new Set<FleetRolloutStatus>([
  "pending",
  "progressing",
  "paused",
])

export interface HeatmapLayoutInput {
  roots: readonly FleetMapNode[]
  width: number
  viewportHeight: number
  scrollTop: number
  density: FleetDensity
  labels: FleetLabelMode
  sort: FleetSortField
  direction: FleetSortDirection
}

/** One logical, virtual-CSS-pixel cell. Drawing code may inset it visually. */
export interface HeatmapCellRect {
  stableId: string
  groupStableId: string
  node: FleetMapNode
  x: number
  y: number
  width: number
  height: number
  row: number
  column: number
  showLabel: boolean
  selectable: true
}

export interface HeatmapGroupBand {
  stableId: string
  label: string
  node?: FleetMapNode
  x: number
  y: number
  width: number
  height: number
  headerHeight: number
  cellCount: number
  columnCount: number
  rowCount: number
  startIndex: number
  endIndex: number
  health: readonly FleetMapNode["health"][number][]
}

export interface HeatmapLayoutResult {
  cells: readonly HeatmapCellRect[]
  visibleCells: readonly HeatmapCellRect[]
  groups: readonly HeatmapGroupBand[]
  virtualHeight: number
  viewportHeight: number
  scrollTop: number
  cellSize: number
  inputCount: number
  layoutCount: number
  digest: string
}

interface HeatmapBandInput {
  stableId: string
  label: string
  node?: FleetMapNode
  applications: FleetMapNode[]
}

/**
 * Computes complete heatmap geometry without sampling or mutating the map tree.
 * Bands are ordered by stable ID and sorting applies only within each band.
 */
export function layoutHeatmap(input: HeatmapLayoutInput): HeatmapLayoutResult {
  validateLayoutWidth(input.width)
  validateViewportDimension(input.viewportHeight, "viewportHeight")

  const bands = collectBands(input.roots)
  const inputCount = bands.reduce((count, band) => count + band.applications.length, 0)
  const cellSize = selectCellSize(
    bands,
    input.width,
    input.viewportHeight,
    input.density,
  )
  const showLabel = labelEligibility(input.labels, cellSize)
  const cells: HeatmapCellRect[] = []
  const groups: HeatmapGroupBand[] = []
  let y = 0

  for (const band of bands) {
    if (groups.length > 0) y += HEATMAP_GROUP_GAP

    const applications = [...band.applications].sort((left, right) =>
      compareFleetMapApplications(left, right, input.sort, input.direction),
    )
    const columns = columnsForWidth(input.width, cellSize)
    const columnCount = Math.min(columns, applications.length)
    const rowCount = Math.ceil(applications.length / columns)
    const startIndex = cells.length
    const cellTop = y + HEATMAP_GROUP_HEADER_HEIGHT

    for (let index = 0; index < applications.length; index += 1) {
      const node = applications[index]!
      const row = Math.floor(index / columns)
      const column = index % columns
      cells.push({
        stableId: node.stableId,
        groupStableId: band.stableId,
        node,
        x: column * cellSize,
        y: cellTop + row * cellSize,
        width: cellSize,
        height: cellSize,
        row,
        column,
        showLabel,
        selectable: true,
      })
    }

    const height = HEATMAP_GROUP_HEADER_HEIGHT + rowCount * cellSize
    groups.push({
      stableId: band.stableId,
      label: band.label,
      node: band.node,
      x: 0,
      y,
      width: input.width,
      height,
      headerHeight: HEATMAP_GROUP_HEADER_HEIGHT,
      cellCount: applications.length,
      columnCount,
      rowCount,
      startIndex,
      endIndex: cells.length,
      health: applicationHealthDistribution(applications),
    })
    y += height
  }

  const virtualHeight = y
  const scrollTop = normalizedScrollTop(input.scrollTop, virtualHeight, input.viewportHeight)
  const visibleCells = clipHeatmapCells(
    cells,
    virtualHeight,
    scrollTop,
    input.viewportHeight,
  )
  const digest = heatmapStableIdDigest(cells.map((cell) => cell.stableId))

  return {
    cells,
    visibleCells,
    groups,
    virtualHeight,
    viewportHeight: input.viewportHeight,
    scrollTop,
    cellSize,
    inputCount,
    layoutCount: cells.length,
    digest,
  }
}

/**
 * Clips precomputed virtual geometry with strict overlap. Negative/NaN scroll
 * starts at zero; positive infinity and overscroll clamp to the final viewport.
 */
export function clipHeatmapCells(
  cells: readonly HeatmapCellRect[],
  virtualHeight: number,
  scrollTop: number,
  viewportHeight: number,
): readonly HeatmapCellRect[] {
  validateViewportDimension(viewportHeight, "viewportHeight")
  if (!Number.isFinite(virtualHeight) || virtualHeight < 0) {
    throw new RangeError("virtualHeight must be a finite non-negative number")
  }
  if (cells.length === 0 || virtualHeight === 0) return []

  const top = normalizedScrollTop(scrollTop, virtualHeight, viewportHeight)
  const bottom = top + viewportHeight
  const first = firstCellEndingAfter(cells, top)
  const visible: HeatmapCellRect[] = []
  for (let index = first; index < cells.length; index += 1) {
    const cell = cells[index]!
    if (cell.y >= bottom) break
    if (cell.y + cell.height > top) visible.push(cell)
  }
  return visible
}

/**
 * Hit-tests virtual CSS coordinates. Shared logical edges are half-open so the
 * cell to the right/below wins; the overall right and bottom edges are inclusive.
 */
export function hitTestHeatmap(
  cells: readonly HeatmapCellRect[],
  x: number,
  y: number,
): HeatmapCellRect | null {
  if (cells.length === 0 || !Number.isFinite(x) || !Number.isFinite(y)) return null

  for (let index = cells.length - 1; index >= 0; index -= 1) {
    const cell = cells[index]!
    if (
      containsCoordinate(x, cell.x, cell.x + cell.width) &&
      containsCoordinate(y, cell.y, cell.y + cell.height)
    ) {
      return cell
    }
  }
  return null
}

/** Returns a versioned, opaque FNV-1a-64 digest of a sorted UTF-8 ID multiset. */
export function heatmapStableIdDigest(stableIds: readonly string[]): string {
  let hash = FNV_64_OFFSET
  const encoder = new TextEncoder()
  const sorted = [...stableIds].sort(compareText)

  for (const stableId of sorted) {
    const bytes = encoder.encode(stableId)
    hash = hashUint32(hash, bytes.length)
    for (const byte of bytes) hash = hashByte(hash, byte)
  }

  return `hm1-${hash.toString(16).padStart(16, "0")}`
}

function collectBands(roots: readonly FleetMapNode[]): HeatmapBandInput[] {
  validateStableIds(roots)

  const occupied = collectStableIds(roots)
  const bands: HeatmapBandInput[] = []
  const directApplications: FleetMapNode[] = []

  for (const root of roots) {
    if (root.kind === "application") {
      collectApplicationDescendants(root, directApplications)
      continue
    }
    const applications: FleetMapNode[] = []
    collectApplicationDescendants(root, applications)
    if (applications.length === 0) continue
    bands.push({
      stableId: root.stableId,
      label: root.label,
      node: root,
      applications,
    })
  }

  if (directApplications.length > 0) {
    bands.push({
      stableId: collisionFreeSyntheticId(occupied),
      label: DIRECT_ROOT_GROUP_LABEL,
      applications: directApplications,
    })
  }

  return bands.sort((left, right) => compareText(left.stableId, right.stableId))
}

function validateStableIds(roots: readonly FleetMapNode[]): void {
  const applications = new Set<string>()
  const groups = new Set<string>()
  const all = new Map<string, FleetMapNode["kind"]>()
  const pending = [...roots]

  while (pending.length > 0) {
    const node = pending.pop()
    if (!node) continue
    const ownSet = node.kind === "application" ? applications : groups
    const ownLabel = node.kind === "application" ? "application" : "group"
    if (ownSet.has(node.stableId)) {
      throw new Error(`duplicate ${ownLabel} stable ID: ${node.stableId}`)
    }
    const otherKind = all.get(node.stableId)
    if (otherKind !== undefined) {
      throw new Error(`duplicate node stable ID across ${otherKind} and ${node.kind}: ${node.stableId}`)
    }
    ownSet.add(node.stableId)
    all.set(node.stableId, node.kind)
    for (const child of node.children) pending.push(child)
  }
}

function collectStableIds(roots: readonly FleetMapNode[]): Set<string> {
  const result = new Set<string>()
  const pending = [...roots]
  while (pending.length > 0) {
    const node = pending.pop()
    if (!node) continue
    result.add(node.stableId)
    for (const child of node.children) pending.push(child)
  }
  return result
}

function collectApplicationDescendants(root: FleetMapNode, result: FleetMapNode[]): void {
  const pending = [root]
  while (pending.length > 0) {
    const node = pending.pop()
    if (!node) continue
    if (node.kind === "application") result.push(node)
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index]
      if (child) pending.push(child)
    }
  }
}

function collisionFreeSyntheticId(occupied: ReadonlySet<string>): string {
  let candidate = DIRECT_ROOT_GROUP_ID
  let suffix = 1
  while (occupied.has(candidate)) {
    candidate = `${DIRECT_ROOT_GROUP_ID}:${suffix}`
    suffix += 1
  }
  return candidate
}

function selectCellSize(
  bands: readonly HeatmapBandInput[],
  width: number,
  viewportHeight: number,
  density: FleetDensity,
): number {
  if (density === "compact") return Math.min(HEATMAP_COMPACT_CELL_SIZE, width)
  if (density === "comfortable") return Math.min(HEATMAP_COMFORTABLE_CELL_SIZE, width)

  for (let size = HEATMAP_AUTO_MAX_CELL_SIZE; size >= HEATMAP_MIN_CELL_SIZE; size -= 1) {
    if (virtualHeightForSize(bands, width, size) <= viewportHeight) return Math.min(size, width)
  }
  return Math.min(HEATMAP_MIN_CELL_SIZE, width)
}

function virtualHeightForSize(
  bands: readonly HeatmapBandInput[],
  width: number,
  cellSize: number,
): number {
  if (bands.length === 0) return 0
  const columns = columnsForWidth(width, cellSize)
  let height = Math.max(0, bands.length - 1) * HEATMAP_GROUP_GAP
  for (const band of bands) {
    height +=
      HEATMAP_GROUP_HEADER_HEIGHT + Math.ceil(band.applications.length / columns) * cellSize
  }
  return height
}

function columnsForWidth(width: number, cellSize: number): number {
  return Math.max(1, Math.floor(width / cellSize))
}

function labelEligibility(labels: FleetLabelMode, cellSize: number): boolean {
  if (labels === "all") return true
  if (labels === "none") return false
  return cellSize >= HEATMAP_AUTO_LABEL_MIN_CELL_SIZE
}

export function compareFleetMapApplications(
  left: FleetMapNode,
  right: FleetMapNode,
  sort: FleetSortField,
  direction: FleetSortDirection,
): number {
  let selected = compareSelectedField(left, right, sort)
  if (direction === "desc") selected = -selected
  if (selected !== 0) return selected

  const identity = compareObjectKey(applicationIdentity(left), applicationIdentity(right))
  if (identity !== 0) return identity
  return compareText(left.stableId, right.stableId)
}

function compareSelectedField(
  left: FleetMapNode,
  right: FleetMapNode,
  sort: FleetSortField,
): number {
  switch (sort) {
    case "name":
    case "relevance":
      // Map leaves have no relevance score; canonical identity is the explicit fallback.
      return compareObjectKey(applicationIdentity(left), applicationIdentity(right))
    case "project":
      return compareObjectKey(left.applicationMetadata?.project, right.applicationMetadata?.project)
    case "cluster":
      return compareObjectKey(
        left.applicationMetadata?.currentCluster,
        right.applicationMetadata?.currentCluster,
      )
    case "stage":
      return compareText(
        left.applicationMetadata?.currentStage ?? "",
        right.applicationMetadata?.currentStage ?? "",
      )
    case "health":
      return compareNumber(healthSeverity(left), healthSeverity(right))
    case "sync":
      return compareNumber(
        SYNC_ORDER[left.applicationMetadata?.sync ?? "unspecified"],
        SYNC_ORDER[right.applicationMetadata?.sync ?? "unspecified"],
      )
    case "release":
      return compareNumber(
        RELEASE_ORDER[left.applicationMetadata?.release ?? "unspecified"],
        RELEASE_ORDER[right.applicationMetadata?.release ?? "unspecified"],
      )
    case "rollout":
      return compareNumber(
        ROLLOUT_ORDER[left.applicationMetadata?.rollout ?? "unspecified"],
        ROLLOUT_ORDER[right.applicationMetadata?.rollout ?? "unspecified"],
      )
    case "resource_count":
      return compareBigInt(resourceCount(left), resourceCount(right))
    case "last_transition":
      return compareBigInt(lastTransition(left), lastTransition(right))
    case "impact":
      // QueryFleetMap omits relevance and the server's full impact tuple. Use only
      // deterministic leaf metadata and never imply QueryApplications equivalence.
      return compareImpact(left, right)
  }
}

function compareImpact(left: FleetMapNode, right: FleetMapNode): number {
  const numberFields: readonly [number, number][] = [
    [healthSeverity(left), healthSeverity(right)],
    [activeChange(left) ? 1 : 0, activeChange(right) ? 1 : 0],
  ]
  for (const [leftValue, rightValue] of numberFields) {
    const compared = compareNumber(leftValue, rightValue)
    if (compared !== 0) return compared
  }

  const bigintFields: readonly [bigint, bigint][] = [
    [left.applicationMetadata?.missingResources ?? ZERO, right.applicationMetadata?.missingResources ?? ZERO],
    [left.applicationMetadata?.driftedResources ?? ZERO, right.applicationMetadata?.driftedResources ?? ZERO],
    [resourceCount(left), resourceCount(right)],
    [lastTransition(left), lastTransition(right)],
  ]
  for (const [leftValue, rightValue] of bigintFields) {
    const compared = compareBigInt(leftValue, rightValue)
    if (compared !== 0) return compared
  }
  return 0
}

function applicationIdentity(node: FleetMapNode): NamespacedKey | undefined {
  return node.application
}

function compareObjectKey(left: NamespacedKey | undefined, right: NamespacedKey | undefined): number {
  const namespace = compareText(left?.namespace ?? "", right?.namespace ?? "")
  if (namespace !== 0) return namespace
  return compareText(left?.name ?? "", right?.name ?? "")
}

function resourceCount(node: FleetMapNode): bigint {
  return node.applicationMetadata?.managedResources ?? node.resourceWeight
}

function lastTransition(node: FleetMapNode): bigint {
  return node.applicationMetadata?.lastTransitionUnixMs ?? ZERO
}

function activeChange(node: FleetMapNode): boolean {
  const release = node.applicationMetadata?.release ?? "unspecified"
  const rollout = node.applicationMetadata?.rollout ?? "unspecified"
  return ACTIVE_RELEASE.has(release) || ACTIVE_ROLLOUT.has(rollout)
}

function applicationHealth(node: FleetMapNode): FleetHealthStatus {
  let strongest: FleetHealthStatus = "unspecified"
  for (const bucket of node.health) {
    if (bucket.count <= ZERO) continue
    if (HEALTH_SEVERITY[bucket.health] > HEALTH_SEVERITY[strongest]) strongest = bucket.health
  }
  return strongest
}

function healthSeverity(node: FleetMapNode): number {
  return HEALTH_SEVERITY[applicationHealth(node)]
}

function applicationHealthDistribution(
  applications: readonly FleetMapNode[],
): FleetMapNode["health"] {
  const counts = new Map<FleetHealthStatus, bigint>()
  for (const application of applications) {
    const health = applicationHealth(application)
    counts.set(health, (counts.get(health) ?? ZERO) + ONE)
  }
  return HEALTH_PRESENTATION_ORDER
    .filter((health) => (counts.get(health) ?? ZERO) > ZERO)
    .map((health) => ({ health, count: counts.get(health)! }))
}

function normalizedScrollTop(
  scrollTop: number,
  virtualHeight: number,
  viewportHeight: number,
): number {
  const maxScroll = Math.max(0, virtualHeight - viewportHeight)
  if (scrollTop === Number.POSITIVE_INFINITY) return maxScroll
  if (!Number.isFinite(scrollTop) || scrollTop <= 0) return 0
  return Math.min(scrollTop, maxScroll)
}

function firstCellEndingAfter(cells: readonly HeatmapCellRect[], top: number): number {
  let low = 0
  let high = cells.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const cell = cells[middle]!
    if (cell.y + cell.height > top) high = middle
    else low = middle + 1
  }
  return low
}

function containsCoordinate(value: number, start: number, end: number): boolean {
  return value >= start && value <= end
}

function validateLayoutWidth(value: number): void {
  if (!Number.isFinite(value) || value < HEATMAP_MIN_CELL_SIZE) {
    throw new RangeError(`width must be finite and at least ${HEATMAP_MIN_CELL_SIZE}`)
  }
}

function validateViewportDimension(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite positive number`)
  }
}

function hashUint32(hash: bigint, value: number): bigint {
  let result = hash
  result = hashByte(result, (value >>> 24) & 0xff)
  result = hashByte(result, (value >>> 16) & 0xff)
  result = hashByte(result, (value >>> 8) & 0xff)
  return hashByte(result, value & 0xff)
}

function hashByte(hash: bigint, value: number): bigint {
  return ((hash ^ BigInt(value)) * FNV_64_PRIME) & UINT64_MASK
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareNumber(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

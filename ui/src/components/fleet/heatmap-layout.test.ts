import { describe, expect, it } from "vitest"

import {
  HEATMAP_AUTO_LABEL_MIN_CELL_SIZE,
  HEATMAP_AUTO_MAX_CELL_SIZE,
  HEATMAP_COMFORTABLE_CELL_SIZE,
  HEATMAP_COMPACT_CELL_SIZE,
  HEATMAP_GROUP_GAP,
  HEATMAP_GROUP_HEADER_HEIGHT,
  HEATMAP_MIN_CELL_SIZE,
  clipHeatmapCells,
  heatmapStableIdDigest,
  hitTestHeatmap,
  layoutHeatmap,
  type HeatmapCellRect,
  type HeatmapLayoutInput,
  type HeatmapLayoutResult,
} from "@/components/fleet/heatmap-layout"
import type {
  FleetHealthStatus,
  FleetMapApplicationMetadata,
  FleetMapNode,
  FleetReleaseStatus,
  FleetRolloutStatus,
  FleetSyncStatus,
} from "@/lib/fleet-client"
import {
  FLEET_SORT_VALUES,
} from "@/lib/fleet-query"

const HEALTH: readonly FleetHealthStatus[] = [
  "healthy",
  "progressing",
  "degraded",
  "failed",
  "unknown",
  "missing",
]
const SYNC: readonly FleetSyncStatus[] = [
  "synced",
  "out_of_sync",
  "unknown",
  "unspecified",
]
const RELEASE: readonly FleetReleaseStatus[] = [
  "pending",
  "promoting",
  "canarying",
  "verifying",
  "complete",
  "failed",
  "rolled_back",
  "superseded",
  "awaiting_approval",
  "unspecified",
]
const ROLLOUT: readonly FleetRolloutStatus[] = [
  "pending",
  "progressing",
  "paused",
  "healthy",
  "degraded",
  "failed",
  "rolled_back",
  "aborted",
  "unspecified",
]

const BASE_INPUT = {
  width: 320,
  viewportHeight: 240,
  scrollTop: 0,
  density: "compact",
  labels: "auto",
  sort: "health",
  direction: "desc",
} as const satisfies Omit<HeatmapLayoutInput, "roots">

describe("layoutHeatmap completeness", () => {
  it.each([0, 1, 250, 10_000])(
    "lays out the exact %i-leaf stable-ID multiset without sampling",
    (count) => {
      const roots = makeForest(count, Math.min(11, Math.max(1, count)))
      const inputIds = applicationStableIds(roots).sort(compareText)

      const result = layout(roots, {
        width: 960,
        viewportHeight: 540,
        density: "compact",
      })
      const outputIds = result.cells.map((cell) => cell.stableId).sort(compareText)

      expect(outputIds).toEqual(inputIds)
      expect(result.inputCount).toBe(count)
      expect(result.layoutCount).toBe(count)
      expect(result.cells).toHaveLength(count)
      expect(new Set(outputIds).size).toBe(count)
      expect(result.digest).toBe(heatmapStableIdDigest(outputIds))
      expect(result.groups.reduce((sum, group) => sum + group.cellCount, 0)).toBe(count)
      expect(result.cells.every(isFinitePositiveCell)).toBe(true)
    },
    20_000,
  )

  it("fails closed for duplicate Application stable IDs instead of silently deduplicating", () => {
    const roots = [
      groupNode("group", [
        applicationNode(1, { stableId: "duplicate" }),
        applicationNode(2, { stableId: "duplicate" }),
      ]),
    ]

    expect(() => layout(roots)).toThrow(/duplicate application stable id.*duplicate/i)
  })

  it("fails closed for duplicate top-level group stable IDs", () => {
    const roots = [
      groupNode("duplicate-group", [applicationNode(1)]),
      groupNode("duplicate-group", [applicationNode(2)]),
    ]

    expect(() => layout(roots)).toThrow(/duplicate group stable id.*duplicate-group/i)
  })

  it("recursively collects nested Application descendants and shares one synthetic band for direct roots", () => {
    const directA = applicationNode(1)
    const directB = applicationNode(2)
    const nested = groupNode("outer", [
      groupNode("inner", [applicationNode(3), applicationNode(4)]),
    ])

    const result = layout([directB, nested, directA])

    expect(result.cells.map((cell) => cell.stableId).sort(compareText)).toEqual(
      [directA.stableId, directB.stableId, "app-000003", "app-000004"].sort(compareText),
    )
    expect(result.groups).toHaveLength(2)
    const directGroupIds = new Set(
      result.cells
        .filter((cell) => cell.stableId === directA.stableId || cell.stableId === directB.stableId)
        .map((cell) => cell.groupStableId),
    )
    expect(directGroupIds.size).toBe(1)
    expect(result.groups.map((group) => group.stableId)).toContain([...directGroupIds][0])
  })

  it("does not mutate frozen roots, descendants, metadata, or child order", () => {
    const roots = deepFreeze(makeForest(48, 4))
    const before = geometrySourceSnapshot(roots)

    expect(() => layout(roots, { sort: "project", direction: "desc" })).not.toThrow()
    expect(geometrySourceSnapshot(roots)).toEqual(before)
  })
})

describe("layoutHeatmap deterministic order and digest", () => {
  it("uses health severity then canonical namespace/name for the health-desc default", () => {
    const nodes = [
      applicationNode(1, { stableId: "healthy", health: healthBuckets("healthy") }),
      applicationNode(2, { stableId: "unknown", health: healthBuckets("unknown") }),
      applicationNode(3, { stableId: "missing", health: healthBuckets("missing") }),
      applicationNode(4, { stableId: "progressing", health: healthBuckets("progressing") }),
      applicationNode(5, { stableId: "degraded", health: healthBuckets("degraded") }),
      applicationNode(6, {
        stableId: "failed-z",
        application: { namespace: "apps", name: "z-failed" },
        health: healthBuckets("failed"),
      }),
      applicationNode(7, {
        stableId: "failed-a",
        application: { namespace: "apps", name: "a-failed" },
        health: healthBuckets("failed"),
      }),
    ]

    const result = layout([groupNode("health", nodes)], {
      sort: "health",
      direction: "desc",
    })

    expect(result.cells.map((cell) => cell.stableId)).toEqual([
      "failed-a",
      "failed-z",
      "degraded",
      "progressing",
      "missing",
      "unknown",
      "healthy",
    ])
  })

  it("returns identical bands, cell geometry, and digest for repeats and shuffled equivalents", () => {
    const roots = makeForest(250, 9)
    const shuffled = reverseForest(roots)

    const first = layout(roots, { density: "comfortable", width: 777, viewportHeight: 333 })
    const repeated = layout(roots, { density: "comfortable", width: 777, viewportHeight: 333 })
    const reordered = layout(shuffled, { density: "comfortable", width: 777, viewportHeight: 333 })

    expect(geometrySignature(repeated)).toEqual(geometrySignature(first))
    expect(geometrySignature(reordered)).toEqual(geometrySignature(first))
    expect(repeated.digest).toBe(first.digest)
    expect(reordered.digest).toBe(first.digest)
  })

  it("keeps the multiset digest invariant across sort, direction, density, resize, scroll, and labels", () => {
    const roots = makeForest(250, 7)
    const baseline = layout(roots).digest
    const variants: Partial<Omit<HeatmapLayoutInput, "roots">>[] = [
      { sort: "name", direction: "asc" },
      { sort: "resource_count", direction: "desc" },
      { density: "auto", width: 1_240, viewportHeight: 720 },
      { density: "comfortable", width: 480, viewportHeight: 180 },
      { scrollTop: 1_000_000 },
      { labels: "all" },
      { labels: "none" },
    ]

    for (const variant of variants) expect(layout(roots, variant).digest).toBe(baseline)
    expect(layout(roots, { width: 96 }).cells.map(rectSignature)).not.toEqual(
      layout(roots, { width: 640 }).cells.map(rectSignature),
    )
  })

  it("produces a versioned opaque digest over sorted UTF-8 IDs and preserves multiplicity", () => {
    const once = heatmapStableIdDigest(["apps/éclair", "apps/checkout"])

    expect(heatmapStableIdDigest(["apps/checkout", "apps/éclair"])).toBe(once)
    expect(heatmapStableIdDigest(["apps/checkout", "apps/éclair", "apps/éclair"])).not.toBe(once)
    expect(once).toMatch(/^hm1-[0-9a-f]{16}$/u)
    expect(once).not.toContain("checkout")
    expect(once).not.toContain("éclair")
  })

  it("defines a deterministic total order for every supported sort and direction", () => {
    const roots = [groupNode("sorts", makeSortFixture())]
    const shuffled = reverseForest(roots)

    for (const sort of FLEET_SORT_VALUES) {
      const ascending = layout(roots, { sort, direction: "asc" })
      const ascendingAgain = layout(shuffled, { sort, direction: "asc" })
      const descending = layout(roots, { sort, direction: "desc" })
      const descendingAgain = layout(shuffled, { sort, direction: "desc" })

      expect(cellOrder(ascending), `${sort} ascending repeat`).toEqual(cellOrder(ascendingAgain))
      expect(cellOrder(descending), `${sort} descending repeat`).toEqual(cellOrder(descendingAgain))
      expect(cellOrder(descending), `${sort} direction`).not.toEqual(cellOrder(ascending))
    }
  })

  it("uses canonical identity for relevance and a documented map-only impact tuple", () => {
    const identityFirst = applicationNode(1, {
      stableId: "z-stable",
      application: { namespace: "apps", name: "a-identity" },
      health: healthBuckets("healthy"),
    })
    const identityLast = applicationNode(2, {
      stableId: "a-stable",
      application: { namespace: "apps", name: "z-identity" },
      health: healthBuckets("failed"),
    })
    const roots = [groupNode("fallbacks", [identityLast, identityFirst])]

    expect(cellOrder(layout(roots, { sort: "relevance", direction: "asc" }))).toEqual([
      "z-stable",
      "a-stable",
    ])
    expect(cellOrder(layout(roots, { sort: "impact", direction: "desc" }))).toEqual([
      "a-stable",
      "z-stable",
    ])
  })

  it("compares resource and transition BigInts directly beyond Number precision", () => {
    const base = BigInt(Number.MAX_SAFE_INTEGER)
    const lower = applicationNode(1, {
      stableId: "lower",
      resourceWeight: base + BigInt(1),
      applicationMetadata: metadata(1, {
        managedResources: base + BigInt(1),
        lastTransitionUnixMs: base + BigInt(1),
      }),
    })
    const higher = applicationNode(2, {
      stableId: "higher",
      resourceWeight: base + BigInt(2),
      applicationMetadata: metadata(2, {
        managedResources: base + BigInt(2),
        lastTransitionUnixMs: base + BigInt(2),
      }),
    })
    const roots = [groupNode("bigints", [higher, lower])]

    expect(cellOrder(layout(roots, { sort: "resource_count", direction: "asc" }))).toEqual([
      "lower",
      "higher",
    ])
    expect(cellOrder(layout(roots, { sort: "last_transition", direction: "desc" }))).toEqual([
      "higher",
      "lower",
    ])
  })

  it("sorts malformed leaves with missing identity, metadata, and health deterministically", () => {
    const malformed = applicationNode(1, {
      stableId: "malformed",
      application: undefined,
      applicationMetadata: undefined,
      health: [
        { health: "failed", count: BigInt(0) },
        { health: "unspecified", count: BigInt(1) },
      ],
    })
    const normal = applicationNode(2)
    const roots = [groupNode("malformed-group", [normal, malformed])]

    for (const sort of FLEET_SORT_VALUES) {
      expect(() => layout(roots, { sort })).not.toThrow()
      expect(cellOrder(layout(roots, { sort }))).toEqual(cellOrder(layout(reverseForest(roots), { sort })))
    }
  })
})

describe("layoutHeatmap density, bands, labels, and virtual extent", () => {
  it("uses named compact/comfortable thresholds and retains every cell in every density", () => {
    const roots = makeForest(250, 5)
    const compact = layout(roots, { density: "compact" })
    const comfortable = layout(roots, { density: "comfortable" })
    const auto = layout(roots, { density: "auto" })

    expect(HEATMAP_MIN_CELL_SIZE).toBe(6)
    expect(compact.cellSize).toBe(HEATMAP_COMPACT_CELL_SIZE)
    expect(comfortable.cellSize).toBe(HEATMAP_COMFORTABLE_CELL_SIZE)
    expect(HEATMAP_COMFORTABLE_CELL_SIZE).toBeGreaterThan(HEATMAP_COMPACT_CELL_SIZE)
    expect(HEATMAP_COMPACT_CELL_SIZE).toBeGreaterThan(HEATMAP_MIN_CELL_SIZE)
    for (const result of [compact, comfortable, auto]) {
      expect(result.layoutCount).toBe(250)
      expect(new Set(result.cells.map((cell) => cell.width))).toEqual(new Set([result.cellSize]))
      expect(new Set(result.cells.map((cell) => cell.height))).toEqual(new Set([result.cellSize]))
    }
  })

  it("makes Auto choose the largest complete integer size, then virtualize at the 6px floor", () => {
    const sparse = makeForest(1, 1)
    const medium = makeForest(120, 1)
    const dense = makeForest(10_000, 1)

    expect(layout(sparse, { density: "auto", width: 300, viewportHeight: 300 }).cellSize).toBe(
      HEATMAP_AUTO_MAX_CELL_SIZE,
    )

    const fitted = layout(medium, { density: "auto", width: 300, viewportHeight: 150 })
    expect(fitted.cellSize).toBeGreaterThan(HEATMAP_MIN_CELL_SIZE)
    expect(fitted.cellSize).toBeLessThan(HEATMAP_AUTO_MAX_CELL_SIZE)
    expect(fitted.virtualHeight).toBeLessThanOrEqual(150)
    expect(expectedVirtualHeight(medium, 300, fitted.cellSize + 1)).toBeGreaterThan(150)

    const virtualized = layout(dense, { density: "auto", width: 300, viewportHeight: 150 })
    expect(virtualized.cellSize).toBe(HEATMAP_MIN_CELL_SIZE)
    expect(virtualized.virtualHeight).toBeGreaterThan(150)
    expect(virtualized.layoutCount).toBe(10_000)
  }, 20_000)

  it("builds stable non-overlapping bands from actual leaves rather than lying aggregates", () => {
    const roots = makeForest(250, 7).map((root) => ({
      ...root,
      applicationCount: BigInt(999_999),
      health: [{ health: "healthy" as const, count: BigInt(999_999) }],
    }))
    const result = layout(roots, { width: 211, density: "compact" })
    const shuffled = layout(reverseForest(roots), { width: 211, density: "compact" })

    expect(result.groups.map(bandSignature)).toEqual(shuffled.groups.map(bandSignature))
    expect(result.groups.map((group) => group.stableId)).toEqual(
      [...result.groups.map((group) => group.stableId)].sort(compareText),
    )
    expect(result.groups.reduce((sum, group) => sum + group.cellCount, 0)).toBe(250)
    expect(result.groups.at(-1)!.y + result.groups.at(-1)!.height).toBe(result.virtualHeight)

    for (let index = 1; index < result.groups.length; index += 1) {
      const previous = result.groups[index - 1]!
      const current = result.groups[index]!
      expect(current.y).toBe(previous.y + previous.height + HEATMAP_GROUP_GAP)
    }
    for (const group of result.groups) {
      const groupCells = result.cells.slice(group.startIndex, group.endIndex)
      expect(groupCells).toHaveLength(group.cellCount)
      expect(groupCells.every((cell) => cell.groupStableId === group.stableId)).toBe(true)
      expect(groupCells.every((cell) => cell.y >= group.y + HEATMAP_GROUP_HEADER_HEIGHT)).toBe(true)
      expect(groupCells.every((cell) => cell.y + cell.height <= group.y + group.height)).toBe(true)
      expect(group.health).toEqual(actualHealthDistribution(groupCells))
      expect(group.health.reduce((sum, bucket) => sum + bucket.count, BigInt(0))).toBe(
        BigInt(group.cellCount),
      )
    }
  })

  it("makes label eligibility depend only on the requested label mode and readable threshold", () => {
    const roots = makeForest(8, 1)
    const autoCompact = layout(roots, { density: "compact", labels: "auto" })
    const autoComfortable = layout(roots, { density: "comfortable", labels: "auto" })
    const forced = layout(makeForest(80, 1), {
      density: "auto",
      labels: "all",
      width: 60,
      viewportHeight: 40,
    })
    const hidden = layout(roots, { density: "comfortable", labels: "none" })

    expect(HEATMAP_COMPACT_CELL_SIZE).toBeLessThan(HEATMAP_AUTO_LABEL_MIN_CELL_SIZE)
    expect(HEATMAP_COMFORTABLE_CELL_SIZE).toBeGreaterThanOrEqual(
      HEATMAP_AUTO_LABEL_MIN_CELL_SIZE,
    )
    expect(autoCompact.cells.every((cell) => !cell.showLabel)).toBe(true)
    expect(autoComfortable.cells.every((cell) => cell.showLabel)).toBe(true)
    expect(forced.cellSize).toBe(HEATMAP_MIN_CELL_SIZE)
    expect(forced.cells.every((cell) => cell.showLabel)).toBe(true)
    expect(hidden.cells.every((cell) => !cell.showLabel)).toBe(true)
  })

  it("reflows complete geometry across widths and clips only the viewport projection", () => {
    const roots = makeForest(250, 3)
    const narrow = layout(roots, { width: 96, viewportHeight: 120, density: "compact" })
    const wide = layout(roots, { width: 640, viewportHeight: 120, density: "compact" })
    const tallViewport = layout(roots, { width: 640, viewportHeight: 400, density: "compact" })

    expect(narrow.layoutCount).toBe(250)
    expect(wide.layoutCount).toBe(250)
    expect(narrow.digest).toBe(wide.digest)
    expect(narrow.virtualHeight).toBeGreaterThan(wide.virtualHeight)
    expect(tallViewport.cells.map(rectSignature)).toEqual(wide.cells.map(rectSignature))
    expect(tallViewport.visibleCells.length).toBeGreaterThan(wide.visibleCells.length)
  })

  it.each(["auto", "compact", "comfortable"] as const)(
    "clamps %s cells to a valid container narrower than the preferred size",
    (density) => {
      const width = 8
      const result = layout(makeForest(3, 1), {
        density,
        width,
        viewportHeight: 400,
      })

      expect(result.cellSize).toBe(width)
      expect(result.groups.every((group) => group.width === width)).toBe(true)
      expect(result.cells.every((cell) => cell.x + cell.width <= width)).toBe(true)
    },
  )

  it("rejects a positive width below the 6px complete-geometry floor", () => {
    expect(() => layout(makeForest(1, 1), { width: HEATMAP_MIN_CELL_SIZE - 0.01 })).toThrow(
      /width.*at least 6/i,
    )
  })

  it.each([
    { width: 0, viewportHeight: 100 },
    { width: -1, viewportHeight: 100 },
    { width: Number.NaN, viewportHeight: 100 },
    { width: Number.POSITIVE_INFINITY, viewportHeight: 100 },
    { width: 100, viewportHeight: 0 },
    { width: 100, viewportHeight: -1 },
    { width: 100, viewportHeight: Number.NaN },
    { width: 100, viewportHeight: Number.POSITIVE_INFINITY },
  ])("rejects invalid viewport dimensions $width x $viewportHeight", (viewport) => {
    expect(() => layout(makeForest(1, 1), viewport)).toThrow(RangeError)
  })
})

describe("clipHeatmapCells and hitTestHeatmap", () => {
  it("returns strict-overlap visible cells while preserving complete memoizable geometry", () => {
    const roots = makeForest(30, 1)
    const base = layout(roots, {
      width: HEATMAP_COMFORTABLE_CELL_SIZE * 2,
      viewportHeight: HEATMAP_COMFORTABLE_CELL_SIZE,
      density: "comfortable",
      scrollTop: HEATMAP_GROUP_HEADER_HEIGHT,
    })
    const nextRowScroll = HEATMAP_GROUP_HEADER_HEIGHT + HEATMAP_COMFORTABLE_CELL_SIZE
    const next = layout(roots, {
      width: HEATMAP_COMFORTABLE_CELL_SIZE * 2,
      viewportHeight: HEATMAP_COMFORTABLE_CELL_SIZE,
      density: "comfortable",
      scrollTop: nextRowScroll,
    })

    expect(base.cells.map(rectSignature)).toEqual(next.cells.map(rectSignature))
    expect(base.visibleCells).toEqual(
      clipHeatmapCells(base.cells, base.virtualHeight, HEATMAP_GROUP_HEADER_HEIGHT, base.viewportHeight),
    )
    expect(base.visibleCells.every((cell) => cell.y + cell.height > HEATMAP_GROUP_HEADER_HEIGHT)).toBe(true)
    expect(base.visibleCells.every((cell) => cell.y < nextRowScroll)).toBe(true)
    expect(next.visibleCells.some((cell) => base.visibleCells.includes(cell))).toBe(false)
  })

  it("clamps negative, non-finite, and overscroll positions to the virtual extent", () => {
    const roots = makeForest(80, 1)
    const zero = layout(roots, { viewportHeight: 80, scrollTop: 0 })
    const negative = layout(roots, { viewportHeight: 80, scrollTop: -500 })
    const nan = layout(roots, { viewportHeight: 80, scrollTop: Number.NaN })
    const maxScroll = Math.max(0, zero.virtualHeight - zero.viewportHeight)
    const end = layout(roots, { viewportHeight: 80, scrollTop: maxScroll })
    const overscroll = layout(roots, { viewportHeight: 80, scrollTop: 1_000_000 })
    const infinity = layout(roots, { viewportHeight: 80, scrollTop: Number.POSITIVE_INFINITY })

    expect(cellOrder(negative, true)).toEqual(cellOrder(zero, true))
    expect(cellOrder(nan, true)).toEqual(cellOrder(zero, true))
    expect(cellOrder(overscroll, true)).toEqual(cellOrder(end, true))
    expect(cellOrder(infinity, true)).toEqual(cellOrder(end, true))
  })

  it("clips exact viewport boundaries with half-open overlap", () => {
    const roots = makeForest(8, 1)
    const full = layout(roots, {
      width: HEATMAP_COMFORTABLE_CELL_SIZE * 2,
      viewportHeight: HEATMAP_COMFORTABLE_CELL_SIZE,
      density: "comfortable",
    })
    const firstRowTop = HEATMAP_GROUP_HEADER_HEIGHT
    const secondRowTop = firstRowTop + HEATMAP_COMFORTABLE_CELL_SIZE
    const firstRow = clipHeatmapCells(
      full.cells,
      full.virtualHeight,
      firstRowTop,
      HEATMAP_COMFORTABLE_CELL_SIZE,
    )
    const secondRow = clipHeatmapCells(
      full.cells,
      full.virtualHeight,
      secondRowTop,
      HEATMAP_COMFORTABLE_CELL_SIZE,
    )

    expect(firstRow.every((cell) => cell.y === firstRowTop)).toBe(true)
    expect(secondRow.every((cell) => cell.y === secondRowTop)).toBe(true)
    expect(firstRow.some((cell) => secondRow.includes(cell))).toBe(false)
  })

  it("uses abutting logical rectangles and resolves shared edges/corners to right/lower cells", () => {
    const size = HEATMAP_COMFORTABLE_CELL_SIZE
    const result = layout(makeForest(4, 1), {
      width: size * 2,
      viewportHeight: size * 3,
      density: "comfortable",
    })
    const [topLeft, topRight, bottomLeft, bottomRight] = result.cells

    expect(topRight!.x).toBe(topLeft!.x + topLeft!.width)
    expect(bottomLeft!.y).toBe(topLeft!.y + topLeft!.height)
    expect(hitTestHeatmap(result.cells, topLeft!.x, topLeft!.y)).toBe(topLeft)
    expect(hitTestHeatmap(result.cells, topRight!.x, topRight!.y)).toBe(topRight)
    expect(hitTestHeatmap(result.cells, bottomRight!.x, bottomRight!.y)).toBe(bottomRight)
    expect(
      hitTestHeatmap(result.cells, topLeft!.x + topLeft!.width, topLeft!.y + topLeft!.height),
    ).toBe(bottomRight)
    expect(
      hitTestHeatmap(
        result.cells,
        bottomRight!.x + bottomRight!.width,
        bottomRight!.y + bottomRight!.height,
      ),
    ).toBe(bottomRight)
    expect(hitTestHeatmap(result.cells, topLeft!.x, HEATMAP_GROUP_HEADER_HEIGHT - 1)).toBeNull()
    expect(hitTestHeatmap(result.cells, -0.01, topLeft!.y)).toBeNull()
    expect(hitTestHeatmap(result.cells, Number.NaN, topLeft!.y)).toBeNull()
    expect(hitTestHeatmap(result.cells, Number.POSITIVE_INFINITY, topLeft!.y)).toBeNull()
  })

  it("keeps the exposed right edge of a partial final row hittable", () => {
    const size = HEATMAP_COMFORTABLE_CELL_SIZE
    const result = layout(makeForest(3, 1), {
      width: size * 2,
      viewportHeight: size * 3,
      density: "comfortable",
    })
    const finalRowCell = result.cells[2]!

    expect(finalRowCell.column).toBe(0)
    expect(
      hitTestHeatmap(
        result.cells,
        finalRowCell.x + finalRowCell.width,
        finalRowCell.y + finalRowCell.height / 2,
      ),
    ).toBe(finalRowCell)
  })
})

function layout(
  roots: readonly FleetMapNode[],
  overrides: Partial<Omit<HeatmapLayoutInput, "roots">> = {},
): HeatmapLayoutResult {
  return layoutHeatmap({ roots, ...BASE_INPUT, ...overrides })
}

function makeForest(count: number, requestedGroupCount: number): FleetMapNode[] {
  if (count === 0) return []
  const groupCount = Math.max(1, Math.min(count, requestedGroupCount))
  const children = Array.from({ length: groupCount }, () => [] as FleetMapNode[])
  for (let index = 0; index < count; index += 1) children[index % groupCount]!.push(applicationNode(index))
  return children.map((applications, index) => groupNode(`group-${pad(index)}`, applications))
}

function makeSortFixture(): FleetMapNode[] {
  return Array.from({ length: 24 }, (_, index) => {
    const node = applicationNode(index)
    return {
      ...node,
      stableId: `stable-${pad((index * 17) % 24)}`,
      application: {
        namespace: `ns-${pad((index * 5) % 7)}`,
        name: `service-${pad((index * 11) % 24)}`,
      },
      health: healthBuckets(HEALTH[(index * 5) % HEALTH.length]!),
      resourceWeight: BigInt((index * 19) % 101),
      applicationMetadata: metadata(index, {
        project: { namespace: `tenant-${(index * 3) % 4}`, name: `project-${(index * 7) % 9}` },
        currentCluster: { namespace: `fleet-${(index * 2) % 3}`, name: `cluster-${(index * 5) % 11}` },
        currentStage: ["dev", "test", "staging", "production"][(index * 3) % 4]!,
        sync: SYNC[(index * 3) % SYNC.length]!,
        release: RELEASE[(index * 7) % RELEASE.length]!,
        rollout: ROLLOUT[(index * 5) % ROLLOUT.length]!,
        driftedResources: BigInt((index * 13) % 17),
        missingResources: BigInt((index * 11) % 13),
        managedResources: BigInt((index * 19) % 101),
        lastTransitionUnixMs: BigInt((index * 23) % 107),
      }),
    }
  })
}

function applicationNode(index: number, overrides: Partial<FleetMapNode> = {}): FleetMapNode {
  const health = HEALTH[index % HEALTH.length]!
  return {
    stableId: `app-${pad(index)}`,
    kind: "application",
    label: `service-${pad(index)}`,
    application: { namespace: `namespace-${index % 13}`, name: `service-${pad(index)}` },
    applicationCount: BigInt(1),
    targetCount: BigInt(1),
    health: healthBuckets(health),
    resourceWeight: BigInt((index % 97) + 1),
    requestRateWeight: (index % 29) + 0.5,
    effectiveWeight: (index % 97) + 1,
    usedResourceFallback: false,
    children: [],
    applicationMetadata: metadata(index),
    ...overrides,
  }
}

function metadata(
  index: number,
  overrides: Partial<FleetMapApplicationMetadata> = {},
): FleetMapApplicationMetadata {
  return {
    project: { namespace: `tenant-${index % 5}`, name: `project-${index % 17}` },
    currentCluster: { namespace: `fleet-${index % 3}`, name: `cluster-${index % 19}` },
    currentStage: ["development", "staging", "production"][index % 3]!,
    sync: SYNC[index % SYNC.length]!,
    release: RELEASE[index % RELEASE.length]!,
    rollout: ROLLOUT[index % ROLLOUT.length]!,
    driftedResources: BigInt(index % 11),
    missingResources: BigInt(index % 7),
    managedResources: BigInt((index % 97) + 1),
    lastTransitionUnixMs: BigInt(1_700_000_000_000 + index),
    issueSummary: index % 4 === 0 ? `Issue ${index}` : undefined,
    ...overrides,
  }
}

function groupNode(stableId: string, children: FleetMapNode[]): FleetMapNode {
  return {
    stableId,
    kind: "group",
    label: stableId,
    applicationCount: BigInt(children.length),
    targetCount: BigInt(children.length),
    health: [],
    resourceWeight: BigInt(children.length),
    requestRateWeight: children.length,
    effectiveWeight: children.length,
    usedResourceFallback: false,
    children,
  }
}

function healthBuckets(health: FleetHealthStatus): FleetMapNode["health"] {
  return [{ health, count: BigInt(1) }]
}

function applicationStableIds(roots: readonly FleetMapNode[]): string[] {
  const result: string[] = []
  const pending = [...roots]
  while (pending.length > 0) {
    const node = pending.pop()
    if (!node) continue
    if (node.kind === "application") result.push(node.stableId)
    for (const child of node.children) pending.push(child)
  }
  return result
}

function reverseForest(roots: readonly FleetMapNode[]): FleetMapNode[] {
  return [...roots].reverse().map(reverseNode)
}

function reverseNode(node: FleetMapNode): FleetMapNode {
  return { ...node, children: [...node.children].reverse().map(reverseNode) }
}

function expectedVirtualHeight(roots: readonly FleetMapNode[], width: number, cellSize: number): number {
  const directCount = roots.filter((root) => root.kind === "application").length
  const groupedCounts = roots
    .filter((root) => root.kind !== "application")
    .map((root) => applicationStableIds([root]).length)
    .filter((count) => count > 0)
  const bandCounts = directCount > 0 ? [...groupedCounts, directCount] : groupedCounts
  if (bandCounts.length === 0) return 0
  const columns = Math.max(1, Math.floor(width / cellSize))
  return (
    bandCounts.reduce(
      (sum, count) => sum + HEATMAP_GROUP_HEADER_HEIGHT + Math.ceil(count / columns) * cellSize,
      0,
    ) +
    Math.max(0, bandCounts.length - 1) * HEATMAP_GROUP_GAP
  )
}

function cellOrder(result: HeatmapLayoutResult, visible = false): string[] {
  return (visible ? result.visibleCells : result.cells).map((cell) => cell.stableId)
}

function rectSignature(cell: HeatmapCellRect) {
  return [
    cell.stableId,
    cell.groupStableId,
    cell.x,
    cell.y,
    cell.width,
    cell.height,
    cell.row,
    cell.column,
    cell.showLabel,
  ] as const
}

function bandSignature(group: HeatmapLayoutResult["groups"][number]) {
  return [
    group.stableId,
    group.label,
    group.x,
    group.y,
    group.width,
    group.height,
    group.cellCount,
    group.startIndex,
    group.endIndex,
  ] as const
}

function geometrySignature(result: HeatmapLayoutResult) {
  return {
    cells: result.cells.map(rectSignature),
    visible: result.visibleCells.map((cell) => cell.stableId),
    groups: result.groups.map(bandSignature),
    virtualHeight: result.virtualHeight,
    cellSize: result.cellSize,
  }
}

function geometrySourceSnapshot(roots: readonly FleetMapNode[]): string {
  return JSON.stringify(roots, (_, value) => (typeof value === "bigint" ? value.toString() : value))
}

function actualHealthDistribution(cells: readonly HeatmapCellRect[]): FleetMapNode["health"] {
  const order: readonly FleetHealthStatus[] = [
    "failed",
    "degraded",
    "progressing",
    "missing",
    "unknown",
    "healthy",
    "unspecified",
  ]
  const counts = new Map<FleetHealthStatus, bigint>()
  for (const cell of cells) {
    const health = cell.node.health.find((bucket) => bucket.count > BigInt(0))?.health ?? "unspecified"
    counts.set(health, (counts.get(health) ?? BigInt(0)) + BigInt(1))
  }
  return order
    .filter((health) => (counts.get(health) ?? BigInt(0)) > BigInt(0))
    .map((health) => ({ health, count: counts.get(health)! }))
}

function isFinitePositiveCell(cell: HeatmapCellRect): boolean {
  return (
    Number.isFinite(cell.x) &&
    Number.isFinite(cell.y) &&
    Number.isFinite(cell.width) &&
    Number.isFinite(cell.height) &&
    cell.width > 0 &&
    cell.height > 0
  )
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function pad(value: number): string {
  return value.toString().padStart(6, "0")
}

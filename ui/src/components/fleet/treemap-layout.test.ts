import { describe, expect, it } from "vitest"

import {
  createTreemapCanvasMetrics,
  hitTestTreemap,
  layoutTreemap,
  resolveTreemapMotion,
  resolveTreemapScope,
  semanticZoomPatch,
} from "@/components/fleet/treemap-layout"
import type { FleetMapNode } from "@/lib/fleet-client"

const NO_GAPS = { gap: 0, groupHeaderHeight: 0 } as const

describe("layoutTreemap", () => {
  it("lays out 10,000 applications deterministically with their server stable IDs", () => {
    const applications = Array.from({ length: 10_000 }, (_, index) =>
      application(`application:${index.toString().padStart(5, "0")}`, (index % 17) + 1),
    )
    const forward = group("group:all", applications)
    const reversed = group("group:all", [...applications].reverse())

    const first = layoutTreemap(
      [forward],
      { width: 1_600, height: 900, devicePixelRatio: 2 },
      NO_GAPS,
    )
    const second = layoutTreemap(
      [reversed],
      { width: 1_600, height: 900, devicePixelRatio: 2 },
      NO_GAPS,
    )
    const leaves = first.rectangles.filter((rectangle) => rectangle.selectable)

    expect(leaves).toHaveLength(10_000)
    expect(new Set(leaves.map((rectangle) => rectangle.stableId)).size).toBe(10_000)
    expect(leaves.every((rectangle) => inBounds(rectangle, 1_600, 900))).toBe(true)
    expect(signature(first.rectangles)).toEqual(signature(second.rectangles))
    expect(leaves[7_621]?.stableId).toMatch(/^application:/)
  })

  it("uses deepest half-open rectangles for deterministic hit testing", () => {
    const result = layoutTreemap(
      [group("group:all", [application("application:a"), application("application:b")])],
      { width: 100, height: 40 },
      NO_GAPS,
    )
    const leaves = result.rectangles
      .filter((rectangle) => rectangle.selectable)
      .sort((left, right) => left.x - right.x || left.y - right.y)
    const [first, second] = leaves
    if (!first || !second) throw new Error("expected two selectable rectangles")

    expect(hitTestTreemap(result.rectangles, first.x + first.width / 2, 20)?.stableId).toBe(
      first.stableId,
    )
    expect(hitTestTreemap(result.rectangles, first.x + first.width, 20)?.stableId).toBe(
      second.stableId,
    )
    expect(hitTestTreemap(result.rectangles, 100, 40)?.stableId).toBe(second.stableId)
    expect(hitTestTreemap(result.rectangles, -0.001, 20)).toBeNull()
    expect(hitTestTreemap(result.rectangles, Number.NaN, 20)).toBeNull()
  })

  it("orders application rectangles by the selected field and direction", () => {
    const roots = [group("group:all", [
      application("application:alpha", 1),
      application("application:bravo", 20),
      application("application:charlie", 3),
    ])]
    const ascending = layoutTreemap(
      roots,
      { width: 600, height: 300 },
      { ...NO_GAPS, sort: "name", direction: "asc" },
    )
    const descending = layoutTreemap(
      roots,
      { width: 600, height: 300 },
      { ...NO_GAPS, sort: "name", direction: "desc" },
    )

    expect(selectableOrder(ascending.rectangles)).toEqual([
      "application:alpha",
      "application:bravo",
      "application:charlie",
    ])
    expect(selectableOrder(descending.rectangles)).toEqual([
      "application:charlie",
      "application:bravo",
      "application:alpha",
    ])
  })

  it("resolves semantic zoom as presentation scope and returns a zoom-only URL patch", () => {
    const payments = group("group:payments", [
      application("application:checkout"),
      application("application:ledger"),
    ])
    const orders = group("group:orders", [application("application:fulfilment")])
    const filters = Object.freeze({
      projects: Object.freeze([{ namespace: "tenant", name: "payments" }]),
      health: Object.freeze(["degraded"]),
    })

    const scope = resolveTreemapScope([payments, orders], "group:payments")
    const patch = semanticZoomPatch("group:payments")
    const result = layoutTreemap(
      [payments, orders],
      { width: 800, height: 500 },
      { ...NO_GAPS, zoom: patch.zoom },
    )

    expect(scope.zoom).toBe("group:payments")
    expect(scope.roots).toEqual([payments])
    expect(scope.breadcrumbs.map((node) => node.stableId)).toEqual(["group:payments"])
    expect(result.rectangles.map((rectangle) => rectangle.stableId)).toEqual([
      "group:payments",
      "application:checkout",
      "application:ledger",
    ])
    expect(patch).toEqual({ zoom: "group:payments" })
    expect(Object.keys(patch)).toEqual(["zoom"])
    expect(filters).toEqual({
      projects: [{ namespace: "tenant", name: "payments" }],
      health: ["degraded"],
    })
    expect(resolveTreemapScope([payments, orders], "missing").zoom).toBe("")
  })

  it("reflows on resize while scaling the backing canvas for device pixels", () => {
    const roots = [application("application:checkout")]
    const standard = layoutTreemap(
      roots,
      { width: 200, height: 100, devicePixelRatio: 2 },
      NO_GAPS,
    )
    const resized = layoutTreemap(
      roots,
      { width: 400, height: 200, devicePixelRatio: 2 },
      NO_GAPS,
    )

    expect(standard.canvas).toEqual({
      cssWidth: 200,
      cssHeight: 100,
      pixelWidth: 400,
      pixelHeight: 200,
      scaleX: 2,
      scaleY: 2,
      devicePixelRatio: 2,
    })
    expect(resized.rectangles[0]).toMatchObject({
      stableId: "application:checkout",
      x: 0,
      y: 0,
      width: 400,
      height: 200,
    })
    expect(createTreemapCanvasMetrics(333.25, 100.5, 1.5)).toMatchObject({
      cssWidth: 333.25,
      cssHeight: 100.5,
      pixelWidth: 500,
      pixelHeight: 151,
      devicePixelRatio: 1.5,
    })
  })

  it("disables interpolation when the user requests reduced motion", () => {
    expect(resolveTreemapMotion(true)).toEqual({ animate: false, durationMs: 0 })
    expect(resolveTreemapMotion(false)).toEqual({ animate: true, durationMs: 180 })
  })
})

function application(stableId: string, effectiveWeight = 1): FleetMapNode {
  return {
    stableId,
    kind: "application",
    label: stableId,
    application: { namespace: "apps", name: stableId.replace("application:", "") },
    applicationCount: BigInt(1),
    targetCount: BigInt(1),
    health: [{ health: "healthy", count: BigInt(1) }],
    resourceWeight: BigInt(Math.ceil(effectiveWeight)),
    requestRateWeight: effectiveWeight,
    effectiveWeight,
    usedResourceFallback: false,
    children: [],
  }
}

function group(stableId: string, children: FleetMapNode[]): FleetMapNode {
  const weight = children.reduce((total, child) => total + child.effectiveWeight, 0)
  return {
    stableId,
    kind: "group",
    label: stableId,
    groupValue: stableId.replace("group:", ""),
    applicationCount: BigInt(children.length),
    targetCount: BigInt(children.length),
    health: [{ health: "healthy", count: BigInt(children.length) }],
    resourceWeight: BigInt(Math.ceil(weight)),
    requestRateWeight: weight,
    effectiveWeight: weight,
    usedResourceFallback: false,
    children,
  }
}

function inBounds(
  rectangle: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
): boolean {
  return (
    Number.isFinite(rectangle.x) &&
    Number.isFinite(rectangle.y) &&
    rectangle.width > 0 &&
    rectangle.height > 0 &&
    rectangle.x >= 0 &&
    rectangle.y >= 0 &&
    rectangle.x + rectangle.width <= width &&
    rectangle.y + rectangle.height <= height
  )
}

function signature(
  rectangles: readonly {
    stableId: string
    parentStableId: string | null
    x: number
    y: number
    width: number
    height: number
  }[],
) {
  return rectangles.map((rectangle) => [
    rectangle.stableId,
    rectangle.parentStableId,
    rectangle.x,
    rectangle.y,
    rectangle.width,
    rectangle.height,
  ])
}

function selectableOrder(
  rectangles: readonly { stableId: string; selectable: boolean }[],
): string[] {
  return rectangles
    .filter((rectangle) => rectangle.selectable)
    .map((rectangle) => rectangle.stableId)
}

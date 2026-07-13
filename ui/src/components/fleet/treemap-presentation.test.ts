import { describe, expect, it } from "vitest"

import {
  collectVisibleTreemapHealth,
  createTreemapHealthLegend,
  fitTreemapLabel,
} from "@/components/fleet/treemap-presentation"
import type { FleetMapNode } from "@/lib/fleet-client"

describe("collectVisibleTreemapHealth", () => {
  it("walks nested visible nodes, deduplicates health, and returns severity order", () => {
    const roots = [
      node("root", ["healthy", "unknown"], [
        node("payments", ["progressing", "degraded"], [
          node("checkout", ["failed", "healthy"]),
        ]),
        node("fulfilment", ["missing", "degraded", "unspecified"]),
      ]),
    ]

    expect(collectVisibleTreemapHealth(roots)).toEqual([
      "failed",
      "degraded",
      "progressing",
      "missing",
      "unknown",
      "healthy",
    ])
  })

  it("ignores empty buckets and statuses without a semantic legend entry", () => {
    const root = node("root", ["unspecified"])
    root.health.push({ health: "failed", count: BigInt(0) })

    expect(collectVisibleTreemapHealth([root])).toEqual([])
  })
})

describe("createTreemapHealthLegend", () => {
  it("exposes a visible text label and non-color glyph for each present health", () => {
    expect(
      createTreemapHealthLegend([
        node("root", ["healthy", "degraded", "failed"]),
      ]),
    ).toEqual([
      { health: "failed", label: "Failed", glyph: "×" },
      { health: "degraded", label: "Degraded", glyph: "!" },
      { health: "healthy", label: "Healthy", glyph: "✓" },
    ])
  })
})

describe("fitTreemapLabel", () => {
  const measureText = (label: string) => Array.from(label).length * 10

  it("returns the full label when its measured width plus padding fits", () => {
    expect(fitTreemapLabel("deploy", 68, 8, measureText)).toBe("deploy")
  })

  it("returns the longest fitting prefix followed by exactly one ellipsis", () => {
    const fitted = fitTreemapLabel("deployment", 48, 8, measureText)

    expect(fitted).toBe("dep…")
    expect(fitted.match(/…/gu)).toHaveLength(1)
  })

  it("returns an empty label when even the ellipsis plus padding cannot fit", () => {
    expect(fitTreemapLabel("deployment", 17, 8, measureText)).toBe("")
  })

  it("never splits Unicode code points or grapheme clusters while fitting", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
    const measureGraphemes = (label: string) =>
      Array.from(segmenter.segment(label)).length * 10

    expect(fitTreemapLabel("😀build", 28, 8, measureGraphemes)).toBe("😀…")
    expect(fitTreemapLabel("e\u0301clair", 28, 8, measureGraphemes)).toBe("e\u0301…")
  })
})

function node(
  stableId: string,
  health: FleetMapNode["health"][number]["health"][],
  children: FleetMapNode[] = [],
): FleetMapNode {
  return {
    stableId,
    kind: children.length > 0 ? "group" : "application",
    label: stableId,
    application:
      children.length === 0 ? { namespace: "apps", name: stableId } : undefined,
    applicationCount: BigInt(Math.max(1, children.length)),
    targetCount: BigInt(Math.max(1, children.length)),
    health: health.map((value) => ({ health: value, count: BigInt(1) })),
    resourceWeight: BigInt(1),
    requestRateWeight: 1,
    effectiveWeight: 1,
    usedResourceFallback: false,
    children,
  }
}

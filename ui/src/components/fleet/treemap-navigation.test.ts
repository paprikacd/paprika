import { describe, expect, it } from "vitest"

import {
  navigateTreemapSelection,
  retainTreemapSelection,
  type TreemapNavigationRectangle,
} from "@/components/fleet/treemap-navigation"

describe("navigateTreemapSelection", () => {
  it("moves to the nearest cell in each arrow direction", () => {
    const rectangles = [
      rectangle("center", 40, 40, 20, 20),
      rectangle("left", 15, 40, 20, 20),
      rectangle("right-near", 65, 40, 20, 20),
      rectangle("right-diagonal", 62, 70, 20, 20),
      rectangle("up", 40, 15, 20, 20),
      rectangle("down", 40, 65, 20, 20),
    ]

    expect(navigateTreemapSelection(rectangles, "center", "ArrowLeft")).toBe("left")
    expect(navigateTreemapSelection(rectangles, "center", "ArrowRight")).toBe(
      "right-near",
    )
    expect(navigateTreemapSelection(rectangles, "center", "ArrowUp")).toBe("up")
    expect(navigateTreemapSelection(rectangles, "center", "ArrowDown")).toBe("down")
  })

  it("uses spatial reading order for Home and End and ignores non-selectable frames", () => {
    const rectangles = [
      rectangle("frame", 0, 0, 100, 100, false),
      rectangle("third", 0, 30, 20, 20),
      rectangle("second", 40, 0, 20, 20),
      rectangle("first", 0, 0, 20, 20),
      rectangle("last", 70, 70, 20, 20),
    ]

    expect(navigateTreemapSelection(rectangles, "third", "Home")).toBe("first")
    expect(navigateTreemapSelection(rectangles, "third", "End")).toBe("last")
    expect(navigateTreemapSelection(rectangles, null, "ArrowRight")).toBe("first")
  })

  it("retains the selected stable ID across geometry changes and at a directional edge", () => {
    const before = [rectangle("a", 0, 0, 10, 10), rectangle("b", 10, 0, 10, 10)]
    const afterResize = [
      rectangle("a", 0, 0, 200, 100),
      rectangle("b", 200, 0, 200, 100),
    ]

    expect(retainTreemapSelection("b", afterResize)).toBe("b")
    expect(navigateTreemapSelection(afterResize, "b", "ArrowRight")).toBe("b")
    expect(retainTreemapSelection("b", [before[0]!])).toBeNull()
    expect(retainTreemapSelection(null, afterResize)).toBeNull()
  })

  it("breaks equally near candidates by stable ID and ignores zero-area cells", () => {
    const rectangles = [
      rectangle("origin", 0, 0, 10, 10),
      rectangle("z-candidate", 20, -5, 10, 10),
      rectangle("a-candidate", 20, 5, 10, 10),
      rectangle("zero", 10, 0, 0, 10),
    ]

    expect(navigateTreemapSelection(rectangles, "origin", "ArrowRight")).toBe(
      "a-candidate",
    )
  })

  it("prefers the closest center when several cells share the current edge", () => {
    const rectangles = [
      rectangle("origin", 0, 0, 10, 100),
      rectangle("a-far", 10, 0, 10, 10),
      rectangle("z-near", 10, 40, 10, 20),
    ]

    expect(navigateTreemapSelection(rectangles, "origin", "ArrowRight")).toBe("z-near")
  })
})

function rectangle(
  stableId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  selectable = true,
): TreemapNavigationRectangle {
  return { stableId, x, y, width, height, selectable }
}

import { describe, expect, it } from "vitest"
import { placePointerTooltip } from "./tooltip-pointer"

describe("pointer-relative tooltip placement", () => {
  it("keeps a clear gap to the lower right when space permits", () => {
    expect(placePointerTooltip({ x: 200, y: 100 }, { width: 160, height: 100 }, { width: 800, height: 600 }))
      .toMatchObject({ left: 216, top: 116, placement: "pointer-bottom-right", maxHeight: 472 })
  })
  it("flips at the bottom and right edges without covering the pointer", () => {
    const point = { x: 780, y: 580 }
    const box = placePointerTooltip(point, { width: 160, height: 100 }, { width: 800, height: 600 })
    expect(box.left).toBe(604)
    expect(box.top).toBe(464)
    expect(box.placement).toBe("pointer-top-left")
    expect(box.left + 160).toBeLessThan(point.x)
    expect(box.top + 100).toBeLessThan(point.y)
  })
  it("caps tall content to available space and respects a shifted viewport", () => {
    const box = placePointerTooltip({ x: 130, y: 150 }, { width: 150, height: 900 }, { left: 50, top: 25, width: 400, height: 300 })
    expect(box.left).toBe(146)
    expect(box.top).toBe(166)
    expect(box.maxHeight).toBe(147)
    expect(box.top + box.maxHeight).toBe(313)
  })
})

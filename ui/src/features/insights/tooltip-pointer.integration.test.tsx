import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ObservationTooltip } from "./chart-renderers"
import { installTooltipPointerTracking } from "./tooltip-pointer"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe("pointer-following observations", () => {
  it("follows an in-chart pointer without intercepting it, and restores interactive placement for pin and keyboard", async () => {
    vi.stubGlobal("innerWidth", 800); vi.stubGlobal("innerHeight", 600)
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.id === "pointer-tip") return new DOMRect(0, 0, 160, 100)
      return new DOMRect(100, 100, 400, 300)
    })
    const stop = installTooltipPointerTracking()
    try {
      render(<article data-widget-id="owner"><button>Chart point</button></article>)
      const anchor = screen.getByRole("button", { name: "Chart point" })
      const move = (x: number, y: number) => {
        const event = new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: y })
        Object.defineProperty(event, "pointerType", { value: "mouse" })
        fireEvent(anchor, event)
      }
      move(200, 150)
      const props = { id: "pointer-tip", anchor, avoidWidget: true, onDismiss: () => {}, onEnter: () => {}, onLeave: () => {} }
      const { rerender } = render(<ObservationTooltip {...props}>Observation</ObservationTooltip>)
      const tooltip = screen.getByRole("tooltip")
      expect(tooltip).toHaveAttribute("data-tooltip-pointer", "true")
      expect(tooltip).toHaveStyle({ left: "216px", top: "166px", pointerEvents: "none" })
      move(320, 250)
      await waitFor(() => expect(tooltip).toHaveStyle({ left: "336px", top: "266px" }))
      rerender(<ObservationTooltip {...props} pinned>Observation</ObservationTooltip>)
      expect(tooltip).not.toHaveAttribute("data-tooltip-pointer")
      expect(tooltip).not.toHaveStyle({ pointerEvents: "none" })
      rerender(<ObservationTooltip {...props}>Observation</ObservationTooltip>)
      fireEvent.keyDown(anchor, { key: "ArrowRight" })
      await waitFor(() => expect(tooltip).not.toHaveAttribute("data-tooltip-pointer"))
      expect(tooltip).not.toHaveStyle({ pointerEvents: "none" })
    } finally { stop() }
  })
})

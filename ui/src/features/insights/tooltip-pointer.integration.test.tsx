import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ObservationDetails, ObservationTooltip } from "./observation-tooltip"
import { installTooltipPointerTracking, pointerOverAnchor } from "./tooltip-pointer"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe("pointer-following observations", () => {
  it("does not reopen a newly exposed hover target after Escape until the pointer moves", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 160, 100))
    render(<ObservationDetails label="Map observation" details="Recorded location">Point</ObservationDetails>)
    const anchor = screen.getByRole("button", { name: "Map observation" })
    fireEvent.keyDown(document.body, { key: "Escape" })
    const pointer = (type: string) => {
      const event = new MouseEvent(type, { bubbles: true, clientX: 140, clientY: 130 })
      Object.defineProperty(event, "pointerType", { value: "mouse" })
      fireEvent(anchor, event)
    }
    pointer("pointerover")
    expect(screen.queryByRole("tooltip")).toBeNull()
    pointer("pointermove")
    expect(screen.getByRole("tooltip")).toHaveAttribute("data-tooltip-pointer", "true")
  })
  it("uses pointer-over coordinates on the first render without requiring pointer-move", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 100, 160, 100))
    render(<ObservationDetails label="Map observation" details="Recorded location">Point</ObservationDetails>)
    const anchor = screen.getByRole("button", { name: "Map observation" })
    const event = new MouseEvent("pointerover", { bubbles: true, clientX: 140, clientY: 130 })
    Object.defineProperty(event, "pointerType", { value: "mouse" })
    fireEvent(anchor, event)
    expect(screen.getByRole("tooltip")).toHaveAttribute("data-tooltip-pointer", "true")
    expect(screen.getByRole("tooltip")).toHaveAttribute("data-placement", "pointer-bottom-right")
  })
  it("pins a pointer preview in place while making it interactive, and retains keyboard placement", async () => {
    vi.stubGlobal("innerWidth", 800); vi.stubGlobal("innerHeight", 600)
    let anchorBounds = new DOMRect(100, 100, 400, 300)
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.id === "pointer-tip") return new DOMRect(0, 0, 160, 100)
      return anchorBounds
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
      expect(tooltip).toHaveStyle({ left: "336px", top: "266px" })
      move(450, 350)
      expect(tooltip).toHaveStyle({ left: "336px", top: "266px" })
      anchorBounds = new DOMRect(150, 120, 400, 300)
      fireEvent.scroll(window)
      await waitFor(() => expect(tooltip).toHaveStyle({ left: "386px", top: "286px" }))
      anchorBounds = new DOMRect(100, 100, 400, 300)
      rerender(<ObservationTooltip {...props}>Observation</ObservationTooltip>)
      fireEvent.keyDown(anchor, { key: "ArrowRight" })
      await waitFor(() => expect(tooltip).not.toHaveAttribute("data-tooltip-pointer"))
      expect(tooltip).not.toHaveStyle({ pointerEvents: "none" })
      const over = new MouseEvent("pointerover", { bubbles: true, clientX: 320, clientY: 250 })
      Object.defineProperty(over, "pointerType", { value: "mouse" })
      fireEvent(anchor, over)
      expect(pointerOverAnchor(anchor)).toBeUndefined()
      move(321, 251)
      await waitFor(() => expect(tooltip).toHaveAttribute("data-tooltip-pointer", "true"))
    } finally { stop() }
  })
})

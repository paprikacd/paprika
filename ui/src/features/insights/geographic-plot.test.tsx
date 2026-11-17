import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { GeographicPlot } from "./geographic-plot"

describe("GeographicPlot land outline", () => {
  it("stays aria-busy until the outline has mounted, then reports ready", async () => {
    const { container } = render(<GeographicPlot><span>observation</span></GeographicPlot>)
    const plane = container.querySelector("[data-map-plane]")!
    expect(plane).toHaveAttribute("aria-busy", "true")
    expect(plane).toHaveAttribute("data-land-status", "loading")
    await waitFor(() => expect(plane).toHaveAttribute("data-land-status", "ready"), { timeout: 10000 })
    expect(plane).not.toHaveAttribute("aria-busy")
    expect(container.querySelectorAll("[data-geographic-land]")).toHaveLength(1)
    expect(screen.getByText("observation")).toBeInTheDocument()
  }, 15000)
})

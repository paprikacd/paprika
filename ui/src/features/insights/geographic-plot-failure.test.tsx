import { render, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { GeographicPlot } from "./geographic-plot"

// The land chunk is unavailable. Reading the export rejects the lazy import, as a failed chunk does.
vi.mock("./plugins/world-land", () => ({
  get worldLandPath(): never {
    throw new Error("Failed to load chunk world-land")
  },
}))

describe("GeographicPlot when the land chunk fails", () => {
  it("drops the outline, clears busy, and keeps the grid and observations", async () => {
    const { container } = render(<GeographicPlot showGrid><span>observation</span></GeographicPlot>)
    const plane = container.querySelector("[data-map-plane]")!
    await waitFor(() => expect(plane).toHaveAttribute("data-land-status", "failed"), { timeout: 10000 })
    expect(plane).not.toHaveAttribute("aria-busy")
    expect(container.querySelectorAll("[data-geographic-land]")).toHaveLength(0)
    expect(container.querySelectorAll("line").length).toBeGreaterThan(0)
  }, 15000)
})

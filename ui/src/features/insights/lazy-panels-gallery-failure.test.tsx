import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import InsightsApp from "./insights-app"
import { liveClient } from "./lazy-panels-shared"

vi.mock("./canvas", async () => (await import("./lazy-panels-shared")).canvasMock())
// Only the gallery component's chunk is unavailable; the catalog itself loads. Reading the export rejects the lazy
// import with the bundler's ChunkLoadError, which is what a blocked chunk produces.
vi.mock("./repository-gallery", () => ({
  get RepositoryGallery(): never {
    throw Object.assign(new Error("Failed to load chunk repository-gallery"), { name: "ChunkLoadError" })
  },
}))

describe("examples gallery chunk failure", () => {
  it("keeps the dashboard mounted behind a failed examples panel", async () => {
    render(<InsightsApp client={liveClient()} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: /^Examples \d+$/ }))
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Dashboard examples did not load")
    expect(within(alert).getByRole("button", { name: "Reload the page" })).toBeEnabled()
    expect(screen.getByRole("heading", { name: "Dashboard A" })).toBeInTheDocument()
  })
})

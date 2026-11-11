import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import InsightsApp from "./insights-app"
import { liveClient } from "./lazy-panels-shared"
import { EXAMPLE_STORAGE_KEY } from "./example-storage"

vi.mock("./canvas", async () => (await import("./lazy-panels-shared")).canvasMock())
// The example catalog's chunk is unavailable.
vi.mock("./repository-workspace", () => {
  throw new Error("Failed to load chunk repository-workspace")
})

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, "", "/dashboard/insights/")
})

describe("example catalog chunk failure", () => {
  it("offers a reload instead of retrying a cached failure on the deep link", async () => {
    render(<InsightsApp client={liveClient()} initialExample />)
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("The example workspace could not load. Reload the page to try again.")
    expect(screen.queryByRole("button", { name: "Explore the example" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Retry connection" })).not.toBeInTheDocument()
    expect(within(alert.parentElement ?? document.body).getByRole("button", { name: "Reload the page" })).toBeEnabled()
    expect(localStorage.getItem(EXAMPLE_STORAGE_KEY)).toBeNull()
  })

  it("shows the Examples panel error with a reload action in live mode", async () => {
    render(<InsightsApp client={liveClient()} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: /^Examples \d+$/ }))
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Dashboard examples did not load")
    expect(within(alert).getByRole("button", { name: "Reload the page" })).toBeEnabled()
    expect(screen.getByRole("heading", { name: "Dashboard A" })).toBeInTheDocument()
  })
})

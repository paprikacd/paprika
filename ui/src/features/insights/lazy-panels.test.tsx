import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import InsightsApp from "./insights-app"
import { EXAMPLE_STORAGE_KEY } from "./example-storage"
import { liveClient, liveDashboard } from "./lazy-panels-shared"

vi.mock("./canvas", async () => (await import("./lazy-panels-shared")).canvasMock())

// The first example start waits on this promise, so a test can unmount while the catalog is still loading.
// Later imports resolve immediately because the module is then cached.
const hold = vi.hoisted(() => ({ pending: undefined as Promise<void> | undefined }))
vi.mock("./repository-workspace", async () => {
  if (hold.pending) await hold.pending
  return await vi.importActual<typeof import("./repository-workspace")>("./repository-workspace")
})

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, "", "/dashboard/insights/")
})

describe("lazy example workspace", () => {
  it("does not write storage or move the URL when the page unmounts while the workspace loads", async () => {
    let release!: () => void
    hold.pending = new Promise<void>(resolve => { release = resolve })
    const view = render(<InsightsApp client={liveClient()} initialExample />)
    expect(screen.getByRole("status")).toHaveTextContent("Opening your workspace…")
    // Let the start reach its await on the held workspace before the page leaves.
    await act(() => new Promise(resolve => setTimeout(resolve, 0)))
    view.unmount()
    release()
    await act(() => new Promise(resolve => setTimeout(resolve, 50)))
    expect(localStorage.getItem(EXAMPLE_STORAGE_KEY)).toBeNull()
    expect(window.location.search).toBe("")
  })

  it("disables both recovery actions while an example start is in flight", async () => {
    render(<InsightsApp client={liveClient({ providers: vi.fn().mockRejectedValue(new Error("Insights is down")) })} />)
    const explore = await screen.findByRole("button", { name: "Explore the example" })
    const retry = screen.getByRole("button", { name: "Retry connection" })
    fireEvent.click(explore)
    // The click's state update is committed before the awaited workspace resolves.
    expect(explore).toBeDisabled()
    expect(retry).toBeDisabled()
    expect(await screen.findByRole("button", { name: "Edit dashboard" }, { timeout: 5000 })).toBeInTheDocument()
    expect(localStorage.getItem(EXAMPLE_STORAGE_KEY)).not.toBeNull()
  }, 15000);

  it("loads the Examples panel in live mode without changing the live workspace", async () => {
    render(<InsightsApp client={liveClient()} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: /^Examples \d+$/ }))
    const region = await screen.findByRole("region", { name: "Repository examples" }, { timeout: 10000 })
    expect(within(region).getByText(/16 examples/)).toBeInTheDocument()
    expect(localStorage.getItem(EXAMPLE_STORAGE_KEY)).toBeNull()
    expect(screen.queryByText("Sample data")).not.toBeInTheDocument()
  }, 15000)

  it("moves focus to the examples heading when the lazy gallery mounts on first open", async () => {
    render(<InsightsApp client={liveClient()} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    const button = screen.getByRole("button", { name: /^Examples \d+$/ })
    button.focus()
    fireEvent.keyDown(button, { key: "Enter" })
    fireEvent.click(button)
    await screen.findByRole("region", { name: "Repository examples" }, { timeout: 10000 })
    await waitFor(() => expect(document.activeElement).toHaveTextContent("Dashboard examples"), { timeout: 5000 })
    expect(document.activeElement?.tagName).toBe("H2")
  }, 15000)

  it("moves focus to the chart heading when the focused editor mounts", async () => {
    render(<InsightsApp client={liveClient()} />)
    await screen.findByRole("heading", { name: "Dashboard A" })
    fireEvent.click(screen.getByRole("button", { name: "Edit dashboard" }))
    fireEvent.click(screen.getByRole("button", { name: "Edit Request latency" }))
    await screen.findByRole("textbox", { name: "Title" }, { timeout: 10000 })
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H2"), { timeout: 5000 })
    expect(document.activeElement).toHaveTextContent(liveDashboard.widgets[0].title)
  }, 15000)
})

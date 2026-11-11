import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { lazy, Suspense, useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { LazyPanelBoundary } from "./lazy-panel"

// A lazy import whose chunk failed: React.lazy caches the rejection, as it does for a blocked chunk.
const BlockedEditor = lazy(() => Promise.reject(new Error("Failed to load chunk widget-editor")))

function Workspace({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState("Dashboard A")
  return (
    <div>
      <h1>Dashboard A</h1>
      <label>Dashboard title <input value={title} onChange={event => setTitle(event.target.value)} /></label>
      <section>
        <LazyPanelBoundary label="Widget editor" unsaved onClose={onClose}>
          <Suspense fallback={<p>Loading editor…</p>}>
            <BlockedEditor />
          </Suspense>
        </LazyPanelBoundary>
      </section>
    </div>
  )
}

describe("LazyPanelBoundary", () => {
  it("replaces only the failed panel and keeps the dashboard and its unsaved edit mounted", async () => {
    render(<Workspace onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText("Dashboard title"), { target: { value: "UNSAVED TITLE EDIT" } })
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Widget editor did not load")
    expect(alert).toHaveTextContent("Your unsaved changes are kept on this page until you reload, and reloading discards them.")
    expect(within(alert).getByRole("button", { name: "Reload the page" })).toBeEnabled()
    expect(screen.getByRole("heading", { name: "Dashboard A" })).toBeInTheDocument()
    expect(screen.getByLabelText("Dashboard title")).toHaveValue("UNSAVED TITLE EDIT")
  })

  it("focuses the failure heading so keyboard users land on the message", async () => {
    render(<Workspace onClose={vi.fn()} />)
    await screen.findByRole("alert")
    await waitFor(() => expect(document.activeElement).toHaveTextContent("Widget editor did not load"))
  })

  it("offers a way back to the dashboard that calls onClose", async () => {
    const onClose = vi.fn()
    render(<Workspace onClose={onClose} />)
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Back to dashboard" }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it("omits the unsaved-changes warning when there is nothing unsaved", async () => {
    render(
      <LazyPanelBoundary label="Dashboard examples">
        <Suspense fallback={null}>
          <BlockedEditor />
        </Suspense>
      </LazyPanelBoundary>,
    )
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Dashboard examples did not load")
    expect(alert).not.toHaveTextContent("unsaved")
  })

  it("renders the custom failure for places where a text block cannot go", async () => {
    render(
      <svg>
        <LazyPanelBoundary label="World land" renderFailure={() => null}>
          <Suspense fallback={null}>
            <BlockedEditor />
          </Suspense>
        </LazyPanelBoundary>
      </svg>,
    )
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
    expect(document.querySelector("svg")).toBeInTheDocument()
  })
})

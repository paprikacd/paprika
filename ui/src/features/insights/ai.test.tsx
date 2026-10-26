import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { AIBuilder } from "./ai"
import { dashboardToOpenUI } from "./openui"
import type { Dashboard, Provider, SavedQueryEntry } from "./schema"
import { SavedQueryLibraryProvider } from "./saved-query-context"

vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }))

const dashboard: Dashboard = {
  schemaVersion: 1,
  id: "a",
  title: "A",
  timeRange: "1h",
  refreshInterval: 0,
  widgets: [],
}
const providers: Provider[] = [
  { id: "metrics", name: "Metrics", type: "prometheus", capabilities: ["metrics"] },
]

describe("AI handoff builder", () => {
  const saved: SavedQueryEntry = { schemaVersion: 1, id: "q", name: "Up", providerId: "metrics", kind: "metrics", query: "up", etag: '"v1"' }
  const linked: Dashboard = { ...dashboard, widgets: [{ id: "w", title: "Health", type: "stat", providerId: "metrics", query: "up", queryRef: { id: "q" }, unit: "", layout: { x: 0, y: 0, w: 4, h: 2 } }] }
  it("blocks linked definitions while the library loads but still reviews custom-query documents", () => {
    render(<SavedQueryLibraryProvider queries={[]} variables={[]} values={{}} loading><AIBuilder dashboard={dashboard} providers={providers} onApply={vi.fn()} onClose={vi.fn()} /></SavedQueryLibraryProvider>)
    fireEvent.change(screen.getByLabelText("AI-generated definition"), { target: { value: dashboardToOpenUI(linked) } })
    fireEvent.click(screen.getByRole("button", { name: "Review definition" }))
    expect(screen.getByRole("alert")).toHaveTextContent("still loading")
    expect(screen.getByRole("button", { name: "Apply to canvas" })).toBeDisabled()
    fireEvent.change(screen.getByLabelText("AI-generated definition"), { target: { value: dashboardToOpenUI(dashboard) } })
    fireEvent.click(screen.getByRole("button", { name: "Review definition" }))
    expect(screen.getByRole("button", { name: "Apply to canvas" })).toBeEnabled()
  })
  it("rechecks saved references on apply and blocks library failures after review", () => {
    const props = { dashboard, providers, onApply: vi.fn(), onClose: vi.fn() }
    const { rerender } = render(<SavedQueryLibraryProvider queries={[saved]} variables={[]} values={{}}><AIBuilder {...props} /></SavedQueryLibraryProvider>)
    fireEvent.change(screen.getByLabelText("AI-generated definition"), { target: { value: dashboardToOpenUI(linked) } })
    fireEvent.click(screen.getByRole("button", { name: "Review definition" }))
    expect(screen.getByRole("button", { name: "Apply to canvas" })).toBeEnabled()
    rerender(<SavedQueryLibraryProvider queries={[saved]} variables={[]} values={{}} error="Offline"><AIBuilder {...props} /></SavedQueryLibraryProvider>)
    expect(screen.getByRole("button", { name: "Apply to canvas" })).toBeDisabled()
    rerender(<SavedQueryLibraryProvider queries={[]} variables={[]} values={{}}><AIBuilder {...props} /></SavedQueryLibraryProvider>)
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }))
    expect(screen.getByRole("alert")).toHaveTextContent("unavailable")
    expect(props.onApply).not.toHaveBeenCalled()
  })
  it("requires review before applying and clears review when source changes", () => {
    const onApply = vi.fn()
    render(
      <AIBuilder dashboard={dashboard} providers={providers} onApply={onApply} onClose={vi.fn()} />,
    )
    const input = screen.getByLabelText("AI-generated definition")
    const apply = screen.getByRole("button", { name: "Apply to canvas" })
    expect(apply).toBeDisabled()
    fireEvent.change(input, {
      target: { value: dashboardToOpenUI({ ...dashboard, title: "New title" }) },
    })
    fireEvent.click(screen.getByRole("button", { name: "Review definition" }))
    expect(apply).toBeEnabled()
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: "broken" } })
    expect(apply).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Review definition" }))
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(onApply).not.toHaveBeenCalled()
  })

  it("reviews JSON and applies the validated document", () => {
    const onApply = vi.fn()
    render(
      <AIBuilder dashboard={dashboard} providers={providers} onApply={onApply} onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole("button", { name: /^JSON$/ }))
    const next = { ...dashboard, title: "API performance" }
    fireEvent.change(screen.getByLabelText("AI-generated definition"), {
      target: { value: JSON.stringify(next) },
    })
    fireEvent.click(screen.getByRole("button", { name: "Review definition" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply to canvas" }))
    expect(onApply).toHaveBeenCalledWith(next)
  })

  it("requires another review if the underlying canvas changes", () => {
    const props = { dashboard, providers, onApply: vi.fn(), onClose: vi.fn() }
    const { rerender } = render(<AIBuilder {...props} />)
    fireEvent.change(screen.getByLabelText("AI-generated definition"), {
      target: { value: dashboardToOpenUI(dashboard) },
    })
    fireEvent.click(screen.getByRole("button", { name: "Review definition" }))
    rerender(<AIBuilder {...props} dashboard={{ ...dashboard, title: "Changed elsewhere" }} />)
    expect(screen.getByRole("button", { name: "Apply to canvas" })).toBeDisabled()
    expect(screen.getByText(/canvas changed/i)).toBeInTheDocument()
  })
})

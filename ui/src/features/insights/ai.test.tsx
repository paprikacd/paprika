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
    expect(screen.getByRole("button", { name: "Replace dashboard draft" })).toBeDisabled()
    fireEvent.change(screen.getByLabelText("AI-generated definition"), { target: { value: dashboardToOpenUI(dashboard) } })
    fireEvent.click(screen.getByRole("button", { name: "Review definition" }))
    expect(screen.getByRole("button", { name: "Replace dashboard draft" })).toBeEnabled()
  })
  it("rechecks saved references on apply and blocks library failures after review", () => {
    const props = { dashboard, providers, onApply: vi.fn(), onClose: vi.fn() }
    const { rerender } = render(<SavedQueryLibraryProvider queries={[saved]} variables={[]} values={{}}><AIBuilder {...props} /></SavedQueryLibraryProvider>)
    fireEvent.change(screen.getByLabelText("AI-generated definition"), { target: { value: dashboardToOpenUI(linked) } })
    fireEvent.click(screen.getByRole("button", { name: "Review definition" }))
    expect(screen.getByRole("button", { name: "Replace dashboard draft" })).toBeEnabled()
    rerender(<SavedQueryLibraryProvider queries={[saved]} variables={[]} values={{}} error="Offline"><AIBuilder {...props} /></SavedQueryLibraryProvider>)
    expect(screen.getByRole("button", { name: "Replace dashboard draft" })).toBeDisabled()
    rerender(<SavedQueryLibraryProvider queries={[]} variables={[]} values={{}}><AIBuilder {...props} /></SavedQueryLibraryProvider>)
    fireEvent.click(screen.getByRole("button", { name: "Replace dashboard draft" }))
    expect(screen.getByRole("alert")).toHaveTextContent("unavailable")
    expect(props.onApply).not.toHaveBeenCalled()
  })
  it("requires review before applying and clears review when source changes", () => {
    const onApply = vi.fn()
    render(
      <AIBuilder dashboard={dashboard} providers={providers} onApply={onApply} onClose={vi.fn()} />,
    )
    const input = screen.getByLabelText("AI-generated definition")
    const apply = screen.getByRole("button", { name: "Replace dashboard draft" })
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
    fireEvent.click(screen.getByRole("button", { name: "Replace dashboard draft" }))
    expect(onApply).toHaveBeenCalledWith(next, "document")
  })

  it("requires another review if the underlying canvas changes", () => {
    const props = { dashboard, providers, onApply: vi.fn(), onClose: vi.fn() }
    const { rerender } = render(<AIBuilder {...props} />)
    fireEvent.change(screen.getByLabelText("AI-generated definition"), {
      target: { value: dashboardToOpenUI(dashboard) },
    })
    fireEvent.click(screen.getByRole("button", { name: "Review definition" }))
    rerender(<AIBuilder {...props} dashboard={{ ...dashboard, title: "Changed elsewhere" }} />)
    expect(screen.getByRole("button", { name: "Replace dashboard draft" })).toBeDisabled()
    expect(screen.getByText(/canvas changed/i)).toBeInTheDocument()
  })
  it("shows the widget changes that applying the definition would make", () => {
    const canvas: Dashboard = { ...dashboard, widgets: [{ id: "keep", title: "Keep", type: "stat", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 0, w: 4, h: 2 } }, { id: "drop", title: "Drop", type: "stat", providerId: "metrics", query: "up", unit: "", layout: { x: 4, y: 0, w: 4, h: 2 } }] };
    const next: Dashboard = { ...canvas, widgets: [{ ...canvas.widgets[0], title: "Renamed" }, { id: "new", title: "New", type: "stat", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 2, w: 4, h: 2 } }] };
    render(<AIBuilder dashboard={canvas} providers={providers} onApply={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("AI-generated definition"), { target: { value: dashboardToOpenUI(next) } });
    fireEvent.click(screen.getByRole("button", { name: "Review definition" }));
    expect(screen.getByText("1 added · 1 changed · 1 removed")).toBeInTheDocument();
  });
})

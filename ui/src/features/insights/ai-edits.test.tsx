import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { AIBuilder } from "./ai"
import { CheckFinding, CheckReport, Severity } from "@/gen/paprika/insights/v1/checks_pb"
import type { Dashboard, Provider } from "./schema"

vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }))

const widget = (id: string, title: string) => ({
  id,
  title,
  type: "stat",
  providerId: "metrics",
  query: "up",
  unit: "",
  options: { decimals: 2 },
  layout: { x: id === "a" ? 0 : 6, y: 0, w: 6, h: 4 },
})
const dashboard = { schemaVersion: 1, id: "a", title: "A", timeRange: "1h", refreshInterval: 0, widgets: [widget("a", "Rate"), widget("b", "Errors")] } as unknown as Dashboard
const providers: Provider[] = [{ id: "metrics", name: "Metrics", type: "prometheus", capabilities: ["metrics"] }]

function review(source: string, format: "JSON" | "YAML" | null = null, props: Partial<React.ComponentProps<typeof AIBuilder>> = {}) {
  const onApply = vi.fn()
  render(<AIBuilder dashboard={dashboard} providers={providers} onApply={onApply} onClose={vi.fn()} {...props} />)
  if (format) fireEvent.click(screen.getByRole("button", { name: format }))
  fireEvent.change(screen.getByLabelText("AI-generated definition"), { target: { value: source } })
  fireEvent.click(screen.getByRole("button", { name: "Review definition" }))
  return { onApply }
}

describe("AI builder widget edits", () => {
  it("reviews JSON widget_edits against the current draft and applies them as edits", async () => {
    const { onApply } = review(JSON.stringify({ id: "a", widget_edits: [{ op: "update", id: "a", patch: { title: "Renamed" } }] }), "JSON")
    expect(screen.getByRole("status")).toHaveTextContent("Edits valid · 1 widget changed")
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply edits to draft" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "Apply edits to draft" }))
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply.mock.calls[0][1]).toBe("Edits applied to the draft. Review the canvas, then save the dashboard.")
    expect(onApply.mock.calls[0][0].widgets[0]).toMatchObject({ id: "a", title: "Renamed" })
    expect(onApply.mock.calls[0][0].widgets[1]).toMatchObject({ id: "b", title: "Errors" })
  })

  it("reads YAML widget_edits wrapped in a patch_dashboard call", () => {
    const { onApply } = review("name: patch_dashboard\narguments:\n  id: a\n  widget_edits:\n    - op: remove\n      id: b\n", "YAML")
    expect(screen.getByRole("status")).toHaveTextContent("Edits valid · 1 widget changed")
    fireEvent.click(screen.getByRole("button", { name: "Apply edits to draft" }))
    expect(onApply.mock.calls[0][0].widgets.map((item: { id: string }) => item.id)).toEqual(["a"])
  })

  it("refuses edits for another dashboard", () => {
    review(JSON.stringify({ id: "other", widget_edits: [{ op: "remove", id: "b" }] }), "JSON")
    expect(screen.getByRole("alert")).toHaveTextContent("These edits are for dashboard “other”.")
  })

  it("names the edit that targets a missing widget", () => {
    review(JSON.stringify({ widget_edits: [{ op: "remove", id: "b" }, { op: "update", id: "zz", patch: { title: "x" } }] }), "JSON")
    expect(screen.getByRole("alert")).toHaveTextContent("Edit 2: widget edit target was not found")
  })

  it("says when the edits leave the draft unchanged", () => {
    review(JSON.stringify({ widget_edits: [{ op: "update", id: "a", patch: { options: { decimals: 2 } } }] }), "JSON")
    expect(screen.getByRole("alert")).toHaveTextContent("These edits do not change the draft.")
  })

  it("shows the moved widget and the placement of an added widget", () => {
    review(JSON.stringify({ widget_edits: [{ op: "add", widget: { ...widget("c", "New"), layout: { x: 0, y: 0, w: 6, h: 4 } } }] }), "JSON")
    expect(screen.getByRole("status")).toHaveTextContent("Edits valid · 1 widget changed")
    expect(screen.getByRole("button", { name: /New · added/ })).toBeInTheDocument()
  })

  it("blocks Apply when a check reports errors", async () => {
    const report = new CheckReport({ errorCount: 1, total: 1, issues: [new CheckFinding({ severity: Severity.ERROR, ruleId: "layout.overlap", widgetId: "a", message: "Overlaps" })] })
    const checkDocument = vi.fn().mockResolvedValue(report)
    review(JSON.stringify({ widget_edits: [{ op: "update", id: "a", patch: { title: "Renamed" } }] }), "JSON", { checkDocument })
    await waitFor(() => expect(checkDocument).toHaveBeenCalledTimes(1))
    await screen.findByText("1 error. Fix them before applying.")
    expect(screen.getByRole("button", { name: "Apply edits to draft" })).toBeDisabled()
  })

  it("still allows Apply when the check fails", async () => {
    const checkDocument = vi.fn().mockRejectedValue(new Error("offline"))
    const { onApply } = review(JSON.stringify({ widget_edits: [{ op: "update", id: "a", patch: { title: "Renamed" } }] }), "JSON", { checkDocument })
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply edits to draft" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "Apply edits to draft" }))
    expect(onApply).toHaveBeenCalledTimes(1)
  })

  it("still allows Apply when the check times out", async () => {
    vi.useFakeTimers()
    try {
      const checkDocument = vi.fn(() => new Promise<CheckReport>(() => {}))
      const { onApply } = review(JSON.stringify({ widget_edits: [{ op: "update", id: "a", patch: { title: "Renamed" } }] }), "JSON", { checkDocument })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(screen.getByRole("status")).toHaveTextContent(
        "Could not check this dashboard: The check did not finish within 10 seconds. Applying to the canvas does not depend on the check.",
      )
      fireEvent.click(screen.getByRole("button", { name: "Apply edits to draft" }))
      expect(onApply).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("says a check is running and keeps Apply off until it answers", async () => {
    let answer: (report: CheckReport) => void = () => {}
    const checkDocument = vi.fn(() => new Promise<CheckReport>((resolve) => { answer = resolve }))
    review(JSON.stringify({ widget_edits: [{ op: "update", id: "a", patch: { title: "Renamed" } }] }), "JSON", { checkDocument })
    expect(await screen.findByText("Checking definition…")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Replace dashboard draft" })).toBeDisabled()
    await act(async () => answer(new CheckReport({})))
    expect(screen.queryByText("Checking definition…")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Apply edits to draft" })).toBeEnabled()
  })

  it("names the schema problem in the merged draft", () => {
    review(JSON.stringify({ widget_edits: [{ op: "update", id: "a", patch: { layout: { w: 20 } } }] }), "JSON")
    const alert = screen.getByRole("alert")
    expect(alert.textContent).toMatch(/^widgets\.0\.layout/)
    expect(alert.textContent).not.toContain('"code"')
  })

  it("blocks Apply when the draft changes after the edits were reviewed", () => {
    const onApply = vi.fn()
    const { rerender } = render(<AIBuilder dashboard={dashboard} providers={providers} onApply={onApply} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: "JSON" }))
    fireEvent.change(screen.getByLabelText("AI-generated definition"), { target: { value: JSON.stringify({ widget_edits: [{ op: "remove", id: "b" }] }) } })
    fireEvent.click(screen.getByRole("button", { name: "Review definition" }))
    const moved = { ...dashboard, widgets: [dashboard.widgets[0], { ...dashboard.widgets[1], title: "Edited on canvas" }] } as Dashboard
    rerender(<AIBuilder dashboard={moved} providers={providers} onApply={onApply} onClose={vi.fn()} />)
    expect(screen.getByText("The canvas changed. Review again before applying.")).toBeInTheDocument()
    const button = screen.getByRole("button", { name: "Apply edits to draft" })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onApply).not.toHaveBeenCalled()
  })
})

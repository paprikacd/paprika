import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { copyToClipboard } from "@/lib/clipboard"
import { AIBuilder } from "./ai"
import type { Dashboard, Provider } from "./schema"

vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }))

const dashboard = { schemaVersion: 1, id: "svc", title: "Service", timeRange: "1h", refreshInterval: 0, widgets: [] } as unknown as Dashboard
const providers: Provider[] = [{ id: "metrics", name: "Metrics", type: "prometheus", capabilities: ["metrics"] }]

function open(props: Partial<React.ComponentProps<typeof AIBuilder>> = {}) {
  render(<AIBuilder dashboard={dashboard} providers={providers} onApply={vi.fn()} onClose={vi.fn()} {...props} />)
  fireEvent.click(screen.getByText("Use your agent with Paprika Observe"))
}

describe("AI builder agent handoff", () => {
  beforeEach(() => {
    vi.mocked(copyToClipboard).mockClear()
  })

  it("copies the instructions, switches the review to JSON and says so", async () => {
    open({ observeEndpoint: "https://example.test/observe/mcp" })
    fireEvent.click(screen.getByRole("button", { name: "Copy agent instructions" }))
    await screen.findByText("Instructions copied. Paste the agent’s JSON reply below.")
    expect(vi.mocked(copyToClipboard).mock.calls[0][0]).toContain('Edit the Paprika Insights dashboard "Service" (id: svc).')
    expect(screen.getByRole("button", { name: "JSON" })).toHaveAttribute("aria-pressed", "true")
  })

  it("offers the setup command and the prefilled link when Observe is connected", () => {
    open({ observeEndpoint: "https://example.test/observe/mcp" })
    expect(screen.getByRole("button", { name: "Copy setup command" })).toBeInTheDocument()
    const link = screen.getByRole("link", { name: "Open in Claude" })
    expect(link).toHaveAttribute("target", "_blank")
    expect(link).toHaveAttribute("rel", "noopener noreferrer")
    expect(link.getAttribute("href")).toMatch(/^https:\/\/claude\.ai\/new\?q=/)
  })

  it("hides the setup command when Observe is not connected, and keeps the link", () => {
    open()
    expect(screen.queryByRole("button", { name: "Copy setup command" })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open in Claude" })).toBeInTheDocument()
  })

  it("names this origin's /observe/mcp, without the page's basePath, query or fragment", async () => {
    window.history.pushState({}, "", "/paprika/dashboard/insights?code=sign-in-secret#id_token=fragment-secret")
    try {
      open({ observe: true })
      const endpoint = `${window.location.origin}/observe/mcp`
      fireEvent.click(screen.getByRole("button", { name: "Copy setup command" }))
      await screen.findByText("Setup command copied.")
      expect(vi.mocked(copyToClipboard).mock.calls[0][0]).toBe(`claude mcp add --transport http paprika-observe ${endpoint}`)
      fireEvent.click(screen.getByRole("button", { name: "Copy agent instructions" }))
      await screen.findByText("Instructions copied. Paste the agent’s JSON reply below.")
      const text = vi.mocked(copyToClipboard).mock.calls[1][0]
      expect(text).toContain(`Use the Paprika Observe MCP server at ${endpoint}.`)
      const href = screen.getByRole("link", { name: "Open in Claude" }).getAttribute("href") ?? ""
      for (const copied of [text, decodeURIComponent(href)]) {
        expect(copied).not.toContain("sign-in-secret")
        expect(copied).not.toContain("fragment-secret")
        expect(copied).not.toContain("/paprika/")
      }
    } finally {
      window.history.pushState({}, "", "/")
    }
  })

  it("hands the unsaved draft to the agent", () => {
    open({ unsaved: true })
    fireEvent.click(screen.getByRole("button", { name: "Copy agent instructions" }))
    expect(vi.mocked(copyToClipboard).mock.calls[0][0]).toContain("The open draft has unsaved changes.")
  })
})

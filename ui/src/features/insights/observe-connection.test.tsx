import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ObserveConnectionCard } from "./observe-connection"
import type { InsightsClient, ObserveConnection } from "./client"

const connection: ObserveConnection = {
  configured: true, connected: true, transport: "mcp", providerCount: 2, protocolVersion: "2025-06-18",
  tools: [{ name: "query_metrics", description: "Run PromQL on a metrics provider." }, { name: "query_traces", description: "Run TraceQL on a trace provider." }],
}
function client() {
  return { observeConnection: vi.fn().mockResolvedValue(connection), providers: vi.fn().mockResolvedValue([]) } as unknown as InsightsClient
}

describe("Observe MCP connection", () => {
  it("discovers tools with the current session and refreshes providers without requesting administrative configuration", async () => {
    const api = client(), onChange = vi.fn()
    render(<ObserveConnectionCard client={api} onProvidersChange={onChange} />)
    const card = screen.getByRole("region", { name: "Paprika Observe MCP" })
    expect(await within(card).findByText("Connected")).toBeInTheDocument()
    expect(within(card).getByText("· 2 providers discovered")).toBeInTheDocument()
    expect(within(card).getByText(/current Paprika session and Observability permissions/)).toBeInTheDocument()
    expect(api.observeConnection).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(within(card).queryByText("query_metrics")).not.toBeInTheDocument()
    fireEvent.click(within(card).getByRole("button", { name: "Discovered MCP tools 2" }))
    expect(within(card).getByText("query_metrics")).toBeInTheDocument()
    expect(within(card).getByText("query_traces")).toBeInTheDocument()
    expect(within(card).getByText("Protocol 2025-06-18")).toBeInTheDocument()
    fireEvent.click(within(card).getByRole("button", { name: "Refresh connection and providers" }))
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([]))
    expect(api.observeConnection).toHaveBeenCalledTimes(2)
    expect(api.providers).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(within(card).queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("explains a disabled connection without displaying a connected or empty discovery state", async () => {
    const api = client()
    vi.mocked(api.observeConnection!).mockResolvedValue({ ...connection, configured: false, connected: false, providerCount: 0, tools: [] })
    render(<ObserveConnectionCard client={api} onProvidersChange={vi.fn()} />)
    expect(await screen.findByText("Not configured")).toBeInTheDocument()
    expect(screen.getByText(/Ask your operator/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Discovered MCP tools/ })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Refresh connection and providers" })).toBeEnabled()
  })

  it("replaces stale connected status on failure, preserves the provider list, and supports retry", async () => {
    const api = client(), onChange = vi.fn()
    render(<ObserveConnectionCard client={api} onProvidersChange={onChange} />)
    await screen.findByText("Connected")
    vi.mocked(api.observeConnection!).mockRejectedValueOnce(new Error("Observe access denied."))
    vi.mocked(api.providers).mockRejectedValueOnce(new Error("Discovery unavailable."))
    fireEvent.click(screen.getByRole("button", { name: "Refresh connection and providers" }))
    expect(await screen.findByText("Connection unavailable")).toBeInTheDocument()
    expect(screen.getByText("Observe access denied.")).toBeInTheDocument()
    expect(screen.getByText(/Providers could not be refreshed/)).toBeInTheDocument()
    expect(screen.queryByText("Connected")).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Refresh connection and providers" }))
    expect(await screen.findByText("Connected")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(onChange).toHaveBeenCalledWith([])
  })

  it("does not publish providers after the panel closes during refresh", async () => {
    const api = client(), onChange = vi.fn()
    const { unmount } = render(<ObserveConnectionCard client={api} onProvidersChange={onChange} />)
    await screen.findByText("Connected")
    let finish!: (connection: ObserveConnection) => void
    vi.mocked(api.observeConnection!).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByRole("button", { name: "Refresh connection and providers" }))
    const signal = vi.mocked(api.observeConnection!).mock.calls[1][0]!
    unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => finish(connection))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("supports embedded clients without the Observe API", () => {
    const api = client()
    delete api.observeConnection
    const { container } = render(<ObserveConnectionCard client={api} onProvidersChange={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ObservabilityClient } from "@/app/dashboard/observability/observability-view"
import { DataState } from "@/gen/paprika/v1/api_pb"

import { ObservabilityView } from "@/app/dashboard/observability/observability-view"

const USAGE_NOT_CONFIGURED =
  "observability gateway is not configured; enable it to see MCP tool usage"

function provider(overrides: Record<string, unknown> = {}) {
  return {
    name: "prometheus",
    namespace: "observability",
    type: "prometheus",
    state: "OK",
    reason: "",
    discovered: false,
    endpoint: "http://prometheus.observability:9090",
    signals: ["metrics"],
    observedAtUnixMs: BigInt(0),
    ...overrides,
  }
}

function tool(name: string, calls: bigint, errors: bigint) {
  return { name, calls, errors }
}

function client(
  overrides: {
    items?: unknown[]
    total?: bigint
    indexGeneration?: bigint
    usageState?: DataState
    unavailableReason?: string
    tools?: unknown[]
  } = {},
) {
  const items = overrides.items ?? []
  return {
    listObservabilityProviders: vi.fn().mockResolvedValue({
      items,
      total: overrides.total ?? BigInt(items.length),
      indexGeneration: overrides.indexGeneration ?? BigInt(7),
    }),
    getObservabilityUsage: vi.fn().mockResolvedValue({
      state: overrides.usageState ?? DataState.OK,
      unavailableReason: overrides.unavailableReason ?? "",
      observedAtUnixMs: BigInt(0),
      tools: overrides.tools ?? [],
    }),
    listObservabilityProviderTypes: vi.fn().mockResolvedValue({
      state: DataState.OK,
      unavailableReason: "",
      types: [],
    }),
    getObservabilityProviderType: vi.fn().mockResolvedValue({
      state: DataState.OK,
      unavailableReason: "",
      typeDetail: undefined,
    }),
    validateObservabilityProvider: vi.fn().mockResolvedValue({
      state: DataState.OK,
      unavailableReason: "",
      connectorState: "OK",
      reason: "",
    }),
    createObservabilityProvider: vi.fn().mockResolvedValue({
      name: "prometheus",
      namespace: "observability",
    }),
  }
}

function renderView(fake: ReturnType<typeof client>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ObservabilityView client={fake as unknown as ObservabilityClient} />
    </QueryClientProvider>,
  )
}

describe("ObservabilityView", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders the provider table with state and discovered badges", async () => {
    renderView(
      client({
        items: [
          provider({ name: "prometheus", discovered: true }),
          provider({
            name: "loki",
            type: "loki",
            state: "Error",
            reason: "connection refused",
            endpoint: "",
            signals: ["logs"],
          }),
        ],
      }),
    )

    const table = await screen.findByRole("table", {
      name: "Observability providers",
    })
    expect(screen.getByText("2 providers · gen 7")).toBeInTheDocument()

    const promRow = within(table).getByRole("row", { name: /prometheus/ })
    expect(within(promRow).getByText("OK")).toBeInTheDocument()
    expect(within(promRow).getByText("Discovered")).toBeInTheDocument()
    expect(
      within(promRow).getByText("http://prometheus.observability:9090"),
    ).toBeInTheDocument()

    const lokiRow = within(table).getByRole("row", { name: /loki/ })
    expect(within(lokiRow).getByText("Error")).toBeInTheDocument()
    expect(within(lokiRow).getByText("connection refused")).toBeInTheDocument()
    expect(within(lokiRow).getByText("not reported")).toBeInTheDocument()
    expect(within(lokiRow).queryByText("Discovered")).not.toBeInTheDocument()
  })

  it("maps every provider state onto the closed tone set", async () => {
    const states: Array<[string, string, string]> = [
      ["p-ok", "OK", "healthy"],
      ["p-error", "Error", "failed"],
      ["p-forbidden", "Forbidden", "degraded"],
      ["p-not-configured", "NotConfigured", "pending"],
      ["p-not-available", "NotAvailable", "pending"],
      ["p-empty", "", "unknown"],
    ]
    // The state word lands on the pill verbatim (in the provider's own
    // vocabulary), so an unknown state word would still be readable.
    renderView(
      client({
        items: states.map(([name, state]) => provider({ name, state })),
      }),
    )

    const table = await screen.findByRole("table", {
      name: "Observability providers",
    })
    const labels: Record<string, string> = {
      "p-ok": "OK",
      "p-error": "Error",
      "p-forbidden": "Forbidden",
      "p-not-configured": "Not configured",
      "p-not-available": "Not available",
      "p-empty": "Unknown",
    }
    for (const [name, , tone] of states) {
      const row = within(table).getByRole("row", { name: new RegExp(name) })
      expect(within(row).getByText(labels[name])).toHaveAttribute(
        "data-tone",
        tone,
      )
    }
  })

  it("says how to add a provider when the list is empty", async () => {
    renderView(client())

    expect(
      await screen.findByText(/No observability providers\./),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/observability\.paprika\.io\/discover=true/),
    ).toBeInTheDocument()
  })

  it("renders per-tool usage when the gateway answers", async () => {
    renderView(
      client({
        items: [provider()],
        tools: [
          tool("query_metrics", BigInt(1284), BigInt(321)),
          tool("query_logs", BigInt(10), BigInt(0)),
          tool("query_traces", BigInt(0), BigInt(0)),
        ],
      }),
    )

    const table = await screen.findByRole("table", {
      name: "Observability tool usage",
    })
    expect(screen.getByText("1,294 calls")).toBeInTheDocument()

    const metricsRow = within(table).getByRole("row", { name: /query_metrics/ })
    expect(within(metricsRow).getByText("1,284")).toBeInTheDocument()
    expect(within(metricsRow).getByText("321")).toBeInTheDocument()
    expect(within(metricsRow).getByText("25.0%")).toBeInTheDocument()

    const logsRow = within(table).getByRole("row", { name: /query_logs/ })
    // Zero errors are still printed, but muted: an error count of zero is
    // the absence of failures, not a number worth alarming on.
    expect(within(logsRow).getByText("0", { exact: true })).toHaveClass(
      "text-muted-foreground",
    )
    expect(within(logsRow).getByText("0.0%")).toBeInTheDocument()

    const tracesRow = within(table).getByRole("row", { name: /query_traces/ })
    expect(within(tracesRow).getByText("—")).toBeInTheDocument()

    expect(
      screen.getByText(/Gateway MCP endpoint: .+\/observe\/mcp$/),
    ).toBeInTheDocument()
  })

  it("renders the server's sentence instead of zeros when usage is not configured", async () => {
    const fake = client({
      items: [provider()],
      usageState: DataState.NOT_CONFIGURED,
      unavailableReason: USAGE_NOT_CONFIGURED,
    })
    renderView(fake)

    expect(await screen.findByText(USAGE_NOT_CONFIGURED)).toBeInTheDocument()
    expect(
      screen.queryByRole("table", { name: "Observability tool usage" }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/Gateway MCP endpoint/)).not.toBeInTheDocument()

    // The providers board does not depend on the gateway and still renders.
    expect(
      screen.getByRole("table", { name: "Observability providers" }),
    ).toBeInTheDocument()
  })

  it("keeps the providers board on screen when both boards have nothing to show", async () => {
    renderView(
      client({
        usageState: DataState.NOT_CONFIGURED,
        unavailableReason: USAGE_NOT_CONFIGURED,
      }),
    )

    expect(await screen.findByText(USAGE_NOT_CONFIGURED)).toBeInTheDocument()
    expect(
      screen.getByText(/No observability providers\./),
    ).toBeInTheDocument()
  })

  it("shows a loading state while the first queries are in flight", async () => {
    const fake = client()
    fake.listObservabilityProviders.mockReturnValue(new Promise(() => {}))
    fake.getObservabilityUsage.mockReturnValue(new Promise(() => {}))
    renderView(fake)

    expect(
      await screen.findByText("Loading observability providers."),
    ).toBeInTheDocument()
    expect(screen.getByText("Loading tool usage.")).toBeInTheDocument()
  })
})

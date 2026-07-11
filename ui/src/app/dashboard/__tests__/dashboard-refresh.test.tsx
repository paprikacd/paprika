import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockClient = vi.hoisted(() => ({
  listPipelines: vi.fn().mockResolvedValue({ pipelines: [] }),
  listReleases: vi.fn().mockResolvedValue({ releases: [] }),
  listApplications: vi.fn().mockResolvedValue({ applications: [] }),
  listApplicationSets: vi.fn().mockResolvedValue({ applicationsets: [] }),
  listPolicies: vi.fn().mockResolvedValue({ policies: [] }),
  listRollouts: vi.fn().mockResolvedValue({ rollouts: [] }),
}))
const mockReportRequestOutcome = vi.hoisted(() => vi.fn())
const fleetMocks = vi.hoisted(() => {
  const refresh = vi.fn().mockResolvedValue(undefined)
  const displayData = {
    kind: "applications" as const,
    view: "queue" as const,
    pages: [],
    applications: [] as Array<Record<string, unknown>>,
    facets: [] as Array<Record<string, unknown>>,
    total: BigInt(0),
    indexGeneration: BigInt(1),
  }
  const useFleetData = vi.fn(() => ({
    status: "ready",
    displayData,
    refresh,
  }))
  return { displayData, refresh, useFleetData }
})
const navigation = vi.hoisted(() => ({ query: "" }))

vi.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: vi.fn(() => ({})),
}))
vi.mock("@connectrpc/connect", () => ({
  createPromiseClient: vi.fn(() => mockClient),
}))
vi.mock("@/gen/paprika/v1/api_connect", () => ({ PaprikaService: {} }))
vi.mock("@/lib/connection-context", () => ({
  useConnection: () => ({ reportRequestOutcome: mockReportRequestOutcome }),
}))
vi.mock("@/lib/use-fleet-data", () => ({
  useFleetData: fleetMocks.useFleetData,
}))
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.query),
}))
vi.mock("@/components/dashboard/pipeline-card", () => ({
  PipelineCard: () => <div />,
}))
vi.mock("@/components/dashboard/application-card", () => ({
  ApplicationCard: () => <div />,
}))
vi.mock("@/components/notifications/toast-stack", () => ({
  ToastStack: () => null,
}))

import DashboardPage from "@/app/dashboard/page"

function renderDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <DashboardPage />
    </QueryClientProvider>,
  )
}

async function flushRefresh() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function resetSuccessfulResponses() {
  mockClient.listPipelines.mockResolvedValue({ pipelines: [] })
  mockClient.listReleases.mockResolvedValue({ releases: [] })
  mockClient.listApplications.mockResolvedValue({ applications: [] })
  mockClient.listApplicationSets.mockResolvedValue({ applicationsets: [] })
  mockClient.listPolicies.mockResolvedValue({ policies: [] })
  mockClient.listRollouts.mockResolvedValue({ rollouts: [] })
}

function boundedLegacyMethods() {
  return [
    mockClient.listPipelines,
    mockClient.listReleases,
    mockClient.listApplicationSets,
    mockClient.listPolicies,
    mockClient.listRollouts,
  ]
}

describe("Dashboard bounded refresh", () => {
  const eventSource = vi.fn(function EventSourceMock() {
    return {
      close: vi.fn(),
      onopen: null,
      onmessage: null,
      onerror: null,
    }
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resetSuccessfulResponses()
    fleetMocks.refresh.mockResolvedValue(undefined)
    fleetMocks.displayData.applications = []
    fleetMocks.displayData.facets = []
    fleetMocks.displayData.total = BigInt(0)
    navigation.query = ""
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    })
    vi.stubGlobal("EventSource", eventSource)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("refreshes every dashboard section immediately and every 60 seconds without EventSource", async () => {
    renderDashboard()
    await flushRefresh()

    for (const method of boundedLegacyMethods()) {
      expect(method).toHaveBeenCalledTimes(1)
    }
    expect(mockClient.listApplications).not.toHaveBeenCalled()
    expect(fleetMocks.refresh).toHaveBeenCalledTimes(1)
    expect(eventSource).not.toHaveBeenCalled()
    expect(mockReportRequestOutcome).toHaveBeenLastCalledWith(true)

    vi.clearAllMocks()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    for (const method of boundedLegacyMethods()) {
      expect(method).toHaveBeenCalledTimes(1)
    }
    expect(fleetMocks.refresh).toHaveBeenCalledTimes(1)
  })

  it("keeps partial results usable and preserves pipeline and release anchors", async () => {
    mockClient.listPipelines.mockRejectedValueOnce(new Error("pipeline API unavailable"))

    renderDashboard()
    await flushRefresh()

    const pipelineError = screen.getByText("pipeline API unavailable")
    expect(pipelineError).toBeInTheDocument()
    expect(pipelineError.closest("[role=status]")).toHaveTextContent("pipeline API unavailable")
    expect(document.querySelector("#pipelines")).toBeInTheDocument()
    expect(document.querySelector("#releases")).toBeInTheDocument()
    expect(document.querySelector("#pipelines")).toHaveClass("scroll-mt-28")
    expect(document.querySelector("#releases")).toHaveClass("scroll-mt-28")
    expect(mockReportRequestOutcome).toHaveBeenLastCalledWith(true)
  })

  it("reports a fully failed refresh and waits for the 120 second backoff", async () => {
    for (const method of boundedLegacyMethods()) {
      method.mockRejectedValue(new Error("control plane unavailable"))
    }

    renderDashboard()
    await flushRefresh()
    expect(mockReportRequestOutcome).toHaveBeenLastCalledWith(false)

    vi.clearAllMocks()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(mockClient.listPipelines).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(mockClient.listPipelines).toHaveBeenCalledTimes(1)
  })

  it("reports the outcome of a manual section retry without leaking a rejected promise", async () => {
    for (const method of boundedLegacyMethods()) {
      method.mockRejectedValueOnce(new Error("control plane unavailable"))
    }
    renderDashboard()
    await flushRefresh()

    resetSuccessfulResponses()
    mockReportRequestOutcome.mockClear()
    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0])
    await flushRefresh()

    expect(mockReportRequestOutcome).toHaveBeenLastCalledWith(true)
  })

  it("carries shared URL scope into the fleet query and overview links", async () => {
    navigation.query = "project=tenant%2Fretail&stage=production&q=checkout"
    renderDashboard()
    await flushRefresh()

    expect(fleetMocks.useFleetData).toHaveBeenCalledWith(
      expect.objectContaining({
        projects: [{ namespace: "tenant", name: "retail" }],
        stages: ["production"],
        q: "checkout",
        view: "queue",
        sort: "impact",
        direction: "desc",
      }),
    )
    expect(screen.getByRole("link", { name: "Open application inventory" })).toHaveAttribute(
      "href",
      expect.stringContaining("project=tenant%2Fretail"),
    )
    expect(screen.getByRole("link", { name: "Open full queue" })).toHaveAttribute(
      "href",
      expect.stringContaining("stage=production"),
    )
  })

  it("keeps application search, health tiles, and drill-downs on the bounded fleet window", async () => {
    fleetMocks.displayData.total = BigInt(1)
    fleetMocks.displayData.applications = [
      {
        identity: { namespace: "apps", name: "checkout" },
        project: { namespace: "tenant", name: "retail" },
        targets: [],
        currentStage: "production",
        currentClusterLabel: "omega",
        sourceType: "git",
        sourceRevision: "abc123",
        health: "healthy",
        sync: "synced",
        driftCount: 0,
        missingResourceCount: 0,
        releaseState: "complete",
        rolloutState: "healthy",
        resourceCount: 12,
        repositoryConnection: "healthy",
        observabilityConnection: "not_configured",
        blockedGateCount: 0,
        lastTransitionUnixMs: BigInt(0),
        capabilities: [],
      },
    ]

    renderDashboard()
    await flushRefresh()

    expect(screen.getByRole("link", { name: /checkout/i })).toHaveAttribute(
      "href",
      "/dashboard/application?namespace=apps&name=checkout",
    )
    expect(screen.getByText("1/1 apps loaded")).toBeInTheDocument()
  })

  it("backs off when the fleet query refresh rejects even if legacy sections succeed", async () => {
    fleetMocks.refresh.mockRejectedValue(new Error("fleet unavailable"))
    renderDashboard()
    await flushRefresh()

    expect(mockReportRequestOutcome).toHaveBeenLastCalledWith(false)
    vi.clearAllMocks()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(fleetMocks.refresh).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(fleetMocks.refresh).toHaveBeenCalledTimes(1)
  })
})

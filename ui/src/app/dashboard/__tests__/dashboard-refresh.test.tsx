import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockClient = vi.hoisted(() => ({
  listPipelines: vi.fn().mockResolvedValue({ pipelines: [] }),
  listReleases: vi.fn().mockResolvedValue({ releases: [] }),
  queryReleases: vi.fn().mockResolvedValue({ releases: [], totalCount: BigInt(0) }),
  listApplications: vi.fn().mockResolvedValue({ applications: [] }),
  queryFleetMap: vi.fn().mockResolvedValue({ roots: [], total: BigInt(0) }),
  listApplicationSets: vi.fn().mockResolvedValue({ applicationsets: [] }),
  listPolicies: vi.fn().mockResolvedValue({ policies: [] }),
  listRollouts: vi.fn().mockResolvedValue({ rollouts: [] }),
}))
const mockReportRequestOutcome = vi.hoisted(() => vi.fn())
const fleetMocks = vi.hoisted(() => {
  const mapRefresh = vi.fn().mockResolvedValue(undefined)
  const attentionRefresh = vi.fn().mockResolvedValue(undefined)
  const mapResult = {
    roots: [] as Array<Record<string, unknown>>,
    total: BigInt(0),
    indexGeneration: BigInt(1),
    facets: [] as Array<Record<string, unknown>>,
  }
  const mapDisplayData = {
    kind: "map" as const,
    result: mapResult,
  }
  const attentionDisplayData = {
    kind: "applications" as const,
    view: "queue" as const,
    pages: [],
    applications: [] as Array<Record<string, unknown>>,
    facets: [] as Array<Record<string, unknown>>,
    total: BigInt(0),
    indexGeneration: BigInt(1),
  }
  const currentResult = (state: { view: string }) =>
    state.view === "heatmap"
      ? {
          status: "ready",
          currentData: mapDisplayData,
          displayData: mapDisplayData,
          refresh: mapRefresh,
        }
      : {
          status: "ready",
          currentData: attentionDisplayData,
          displayData: attentionDisplayData,
          refresh: attentionRefresh,
        }
  const useFleetData = vi.fn(currentResult)
  return {
    attentionDisplayData,
    attentionRefresh,
    mapDisplayData,
    mapRefresh,
    mapResult,
    currentResult,
    useFleetData,
  }
})
const navigation = vi.hoisted(() => ({ query: "", replace: vi.fn() }))

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
vi.mock("@/lib/use-fleet-data", async () => {
  const actual = await vi.importActual<typeof import("@/lib/use-fleet-data")>(
    "@/lib/use-fleet-data",
  )
  return { ...actual, useFleetData: fleetMocks.useFleetData }
})
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(navigation.query),
}))
vi.mock("@/lib/fleet-scope-context", async () => {
  const { parseFleetQuery } = await vi.importActual<typeof import("@/lib/fleet-query")>(
    "@/lib/fleet-query",
  )
  return {
    useFleetScope: () => {
      const state = parseFleetQuery(navigation.query).state
      return {
        state,
        scope: {
          projects: state.projects,
          clusters: state.clusters,
          stages: state.stages,
          namespaces: state.namespaces,
        },
      }
    },
  }
})
vi.mock("@/components/dashboard/pipeline-card", () => ({
  PipelineCard: ({ pipeline }: { pipeline: { name: string } }) => <div>{pipeline.name}</div>,
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
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <DashboardPage />
    </QueryClientProvider>
  )
  const rendered = render(tree())
  return { ...rendered, rerenderDashboard: () => rendered.rerender(tree()) }
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
  mockClient.queryReleases.mockResolvedValue({ releases: [], totalCount: BigInt(0) })
  mockClient.listApplications.mockResolvedValue({ applications: [] })
  mockClient.queryFleetMap.mockResolvedValue({ roots: [], total: BigInt(0) })
  mockClient.listApplicationSets.mockResolvedValue({ applicationsets: [] })
  mockClient.listPolicies.mockResolvedValue({ policies: [] })
  mockClient.listRollouts.mockResolvedValue({ rollouts: [] })
}

function boundedLegacyMethods() {
  return [
    mockClient.listPipelines,
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
    fleetMocks.useFleetData.mockImplementation(fleetMocks.currentResult)
    resetSuccessfulResponses()
    fleetMocks.mapRefresh.mockResolvedValue(undefined)
    fleetMocks.attentionRefresh.mockResolvedValue(undefined)
    fleetMocks.mapResult.roots = []
    fleetMocks.mapResult.facets = []
    fleetMocks.mapResult.total = BigInt(0)
    fleetMocks.attentionDisplayData.applications = []
    fleetMocks.attentionDisplayData.facets = []
    fleetMocks.attentionDisplayData.total = BigInt(0)
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
    expect(mockClient.listReleases).not.toHaveBeenCalled()
    expect(mockClient.queryFleetMap).not.toHaveBeenCalled()
    expect(mockClient.queryReleases).not.toHaveBeenCalled()
    expect(mockClient.listApplications).not.toHaveBeenCalled()
    expect(fleetMocks.mapRefresh).toHaveBeenCalledTimes(1)
    expect(fleetMocks.attentionRefresh).toHaveBeenCalledTimes(1)
    expect(eventSource).not.toHaveBeenCalled()
    expect(mockReportRequestOutcome).toHaveBeenLastCalledWith(true)

    vi.clearAllMocks()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    for (const method of boundedLegacyMethods()) {
      expect(method).toHaveBeenCalledTimes(1)
    }
    expect(mockClient.listReleases).not.toHaveBeenCalled()
    expect(mockClient.queryFleetMap).not.toHaveBeenCalled()
    expect(mockClient.queryReleases).not.toHaveBeenCalled()
    expect(fleetMocks.mapRefresh).toHaveBeenCalledTimes(1)
    expect(fleetMocks.attentionRefresh).toHaveBeenCalledTimes(1)
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
    expect(mockClient.listReleases).not.toHaveBeenCalled()
    expect(mockClient.queryFleetMap).not.toHaveBeenCalled()
    expect(mockClient.queryReleases).not.toHaveBeenCalled()
  })

  it("keeps raw scope, presentation, identity, and unknown state in overview links", async () => {
    navigation.query =
      "project=tenant%2Fretail&project=tenant%2Fplatform&stage=production" +
      "&namespace=apps&namespace=platform&q=checkout&view=matrix&sort=name&direction=asc" +
      "&tab=evidence&unknown=kept&application_namespace=delivery&application_name=checkout"
    renderDashboard()
    await flushRefresh()

    expect(fleetMocks.useFleetData).toHaveBeenCalledWith(
      expect.objectContaining({
        projects: [
          { namespace: "tenant", name: "platform" },
          { namespace: "tenant", name: "retail" },
        ],
        stages: ["production"],
        q: "checkout",
        view: "queue",
        sort: "impact",
        direction: "desc",
      }),
    )
    const inventory = new URL(
      screen.getByRole("link", { name: "Open application inventory" }).getAttribute("href")!,
      "https://paprika.test",
    )
    const queue = new URL(
      screen.getByRole("link", { name: "Open full queue" }).getAttribute("href")!,
      "https://paprika.test",
    )
    for (const destination of [inventory, queue]) {
      expect(destination.searchParams.getAll("project")).toEqual([
        "tenant/retail",
        "tenant/platform",
      ])
      expect(destination.searchParams.getAll("namespace")).toEqual(["apps", "platform"])
      expect(destination.searchParams.get("tab")).toBe("evidence")
      expect(destination.searchParams.get("unknown")).toBe("kept")
      expect(destination.searchParams.get("application_namespace")).toBe("delivery")
      expect(destination.searchParams.get("application_name")).toBe("checkout")
      expect(destination.searchParams.get("q")).toBe("checkout")
    }
    expect(inventory.searchParams.get("view")).toBe("matrix")
    expect(inventory.searchParams.get("sort")).toBe("name")
    expect(inventory.searchParams.get("direction")).toBe("asc")
    expect(queue.searchParams.get("view")).toBe("queue")
    expect(queue.searchParams.get("sort")).toBe("impact")
    expect(queue.searchParams.get("direction")).toBe("desc")
  })

  it("queries releases only after command search with the full current FleetFilter and request signal", async () => {
    navigation.query =
      "project=tenant%2Fretail&cluster=platform%2Fomega&stage=production&namespace=apps" +
      "&health=healthy&sync=out_of_sync&release=canarying&rollout=progressing&source=git" +
      "&q=fleet-search&view=queue&unknown=kept"
    mockClient.queryReleases.mockResolvedValue({
      releases: [
        {
          name: "checkout-release-v42",
          namespace: "apps",
          phase: "Canarying",
          application: "checkout",
          pipeline: "delivery",
          target: "production",
          currentStage: "production",
        },
      ],
      totalCount: BigInt(1),
    })
    renderDashboard()
    await flushRefresh()

    expect(mockClient.listReleases).toHaveBeenCalledTimes(1)
    expect(mockClient.queryReleases).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole("searchbox", { name: /search operations/i }), {
      target: { value: "checkout-release-v42" },
    })
    await act(async () => vi.advanceTimersByTimeAsync(249))
    expect(mockClient.queryReleases).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockClient.queryReleases).toHaveBeenCalledTimes(1)
    const [request, options] = mockClient.queryReleases.mock.calls[0]
    expect(request).toMatchObject({
      search: "checkout-release-v42",
      pageSize: 8,
      pageOffset: 0,
      filter: {
        projects: [{ namespace: "tenant", name: "retail" }],
        clusters: [{ namespace: "platform", name: "omega" }],
        stages: ["production"],
        namespaces: ["apps"],
        health: [1],
        sync: [2],
        releaseStates: [3],
        rolloutStates: [2],
        sourceTypes: [1],
      },
    })
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(
      screen.getByRole("link", { name: /Release checkout-release-v42/i }),
    ).toHaveAttribute(
      "href",
      "/dashboard/releases?project=tenant%2Fretail&cluster=platform%2Fomega" +
        "&stage=production&health=healthy&sync=out_of_sync&release=canarying" +
        "&rollout=progressing&source=git&view=queue&unknown=kept&namespace=apps" +
        "&q=checkout-release-v42",
    )
  })

  it("loads complete Releases for Rollout association without using the paginated release search RPC", async () => {
    navigation.query = "project=tenant%2Fretail"
    renderDashboard()
    await flushRefresh()

    await act(async () => vi.advanceTimersByTimeAsync(60_000))

    expect(mockClient.listReleases).toHaveBeenCalledTimes(2)
    expect(mockClient.queryReleases).not.toHaveBeenCalled()
  })

  it("loads Namespace-only Rollouts without Release or fleet-map association requests", async () => {
    navigation.query = "namespace=apps"

    renderDashboard()
    await flushRefresh()

    expect(mockClient.listRollouts).toHaveBeenCalledWith(
      { namespace: "apps" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(mockClient.listReleases).not.toHaveBeenCalled()
    expect(mockClient.queryFleetMap).not.toHaveBeenCalled()
  })

  it("plans canonical Pipeline requests and refreshes immediately when observed scope changes", async () => {
    navigation.query = "project=team-a%2Fpayments&namespace=team-a"
    let resolveInitial!: (value: { pipelines: Array<Record<string, unknown>> }) => void
    const initial = new Promise<{ pipelines: Array<Record<string, unknown>> }>((resolve) => {
      resolveInitial = resolve
    })
    mockClient.listPipelines.mockImplementation((request: { namespace?: string; project?: string }) =>
      request.namespace === "team-a"
        ? initial
        : Promise.resolve({
            pipelines: [{ namespace: "team-b", name: "delivery", project: "delivery", phase: "Running" }],
          }),
    )

    const { rerenderDashboard } = renderDashboard()
    await act(async () => Promise.resolve())
    expect(mockClient.listPipelines).toHaveBeenCalledWith(
      { namespace: "team-a", project: "payments" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )

    navigation.query = "project=team-b%2Fdelivery&namespace=team-b"
    rerenderDashboard()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockClient.listPipelines).toHaveBeenCalledWith(
      { namespace: "team-b", project: "delivery" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(mockClient.listPipelines).toHaveBeenCalledTimes(2)

    await act(async () =>
      resolveInitial({
        pipelines: [
          { namespace: "team-a", name: "stale-a", project: "payments", phase: "Running" },
          { namespace: "team-a", name: "stale-b", project: "payments", phase: "Running" },
        ],
      }),
    )
    const pipelinesStat = screen.getByText("Pipelines", { selector: "p" }).parentElement
    expect(pipelinesStat).toHaveTextContent("1")
  })

  it("does not retain previous-scope Pipeline or Rollout data when replacements fail", async () => {
    navigation.query = "namespace=team-a"
    mockClient.listPipelines.mockImplementation(({ namespace }: { namespace?: string }) =>
      namespace === "team-a"
        ? Promise.resolve({
            pipelines: [
              { namespace: "team-a", name: "pipeline-a", phase: "Running" },
            ],
          })
        : Promise.reject(new Error("team-b pipelines unavailable")),
    )
    mockClient.listRollouts.mockImplementation(({ namespace }: { namespace?: string }) =>
      namespace === "team-a"
        ? Promise.resolve({
            rollouts: [
              { namespace: "team-a", name: "rollout-a", phase: "Progressing" },
            ],
          })
        : Promise.reject(new Error("team-b rollouts unavailable")),
    )

    const { rerenderDashboard } = renderDashboard()
    await flushRefresh()
    expect(screen.getByText("Pipelines", { selector: "p" }).parentElement).toHaveTextContent("1")
    expect(screen.getByText("Rollouts", { selector: "p" }).parentElement).toHaveTextContent("1/1")
    expect(screen.getByText("pipeline-a")).toBeInTheDocument()

    navigation.query = "namespace=team-b"
    rerenderDashboard()

    expect(screen.getByText("Pipelines", { selector: "p" }).parentElement).not.toHaveTextContent("1")
    expect(screen.getByText("Rollouts", { selector: "p" }).parentElement).not.toHaveTextContent("1/1")
    expect(screen.queryByText("pipeline-a")).not.toBeInTheDocument()

    await flushRefresh()
    expect(screen.getByText("team-b pipelines unavailable")).toBeInTheDocument()
    expect(screen.getByText("team-b rollouts unavailable")).toBeInTheDocument()
    expect(screen.getByText("Pipelines", { selector: "p" }).parentElement).toHaveTextContent("0")
    expect(screen.getByText("Rollouts", { selector: "p" }).parentElement).toHaveTextContent("0/0")
    expect(screen.queryByText("pipeline-a")).not.toBeInTheDocument()
    expect(mockClient.listReleases).not.toHaveBeenCalled()
    expect(mockClient.queryFleetMap).not.toHaveBeenCalled()
  })

  it("never presents previous-scope fleet placeholders as current", async () => {
    fleetMocks.mapResult.total = BigInt(1)
    fleetMocks.attentionDisplayData.applications = [
      {
        identity: { namespace: "old-scope", name: "old-checkout" },
        targets: [],
        currentStage: "production",
        currentClusterLabel: "omega",
        sourceType: "git",
        sourceRevision: "old",
        health: "failed",
        sync: "out_of_sync",
        driftCount: 1,
        missingResourceCount: 0,
        releaseState: "promoting",
        rolloutState: "paused",
        resourceCount: 12,
        repositoryConnection: "unhealthy",
        observabilityConnection: "not_configured",
        blockedGateCount: 3,
        lastTransitionUnixMs: BigInt(0),
        capabilities: [],
      },
    ]
    fleetMocks.useFleetData.mockImplementation((state) => ({
      ...fleetMocks.currentResult(state),
      status: "stale",
      currentData: undefined,
    }))

    renderDashboard()
    await flushRefresh()

    expect(screen.queryByRole("region", { name: "Fleet health posture" })).not.toBeInTheDocument()
    const changes = screen.getByRole("region", { name: "Active delivery changes" })
    expect(within(changes).getByLabelText("Active releases")).toHaveTextContent("—")
    expect(within(changes).getByLabelText("Active rollouts")).toHaveTextContent("—")
    expect(within(changes).getByLabelText("Blocked gates")).toHaveTextContent("—")
    expect(screen.queryByText("old-checkout")).not.toBeInTheDocument()
    expect(
      screen.getByRole("status", { name: "Loading complete application health map" }),
    ).toBeInTheDocument()
  })

  it("intersects selected Pipeline projects and namespaces and makes no request for an empty intersection", async () => {
    navigation.query = "project=team-a%2Fpayments&namespace=team-b&cluster=platform%2Fomega&stage=prod"

    renderDashboard()
    await flushRefresh()

    expect(mockClient.listPipelines).not.toHaveBeenCalled()
  })

  it("keeps application search, health tiles, and drill-downs on the bounded fleet window", async () => {
    navigation.query = "namespace=platform&view=heatmap&unknown=kept"
    fleetMocks.mapResult.total = BigInt(1)
    fleetMocks.mapResult.roots = [
      {
        stableId: "application:apps/checkout",
        kind: "application",
        label: "checkout",
        application: { namespace: "apps", name: "checkout" },
        applicationCount: BigInt(1),
        targetCount: BigInt(1),
        health: [{ health: "failed", count: BigInt(1) }],
        resourceWeight: BigInt(12),
        requestRateWeight: 0,
        effectiveWeight: 12,
        usedResourceFallback: false,
        children: [],
      },
    ]
    fleetMocks.attentionDisplayData.total = BigInt(1)
    fleetMocks.attentionDisplayData.applications = [
      {
        identity: { namespace: "apps", name: "checkout" },
        project: { namespace: "tenant", name: "retail" },
        targets: [],
        currentStage: "production",
        currentClusterLabel: "omega",
        sourceType: "git",
        sourceRevision: "abc123",
        health: "failed",
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
      "/dashboard/application?namespace=platform&view=heatmap&unknown=kept&application_namespace=apps&application_name=checkout",
    )
    expect(screen.getByText("1 applications in this complete map")).toBeInTheDocument()
  })

  it("backs off when the fleet query refresh rejects even if legacy sections succeed", async () => {
    fleetMocks.mapRefresh.mockRejectedValue(new Error("fleet unavailable"))
    renderDashboard()
    await flushRefresh()

    expect(mockReportRequestOutcome).toHaveBeenLastCalledWith(false)
    vi.clearAllMocks()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(fleetMocks.mapRefresh).not.toHaveBeenCalled()
    expect(fleetMocks.attentionRefresh).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(fleetMocks.mapRefresh).toHaveBeenCalledTimes(1)
    expect(fleetMocks.attentionRefresh).toHaveBeenCalledTimes(1)
  })
})

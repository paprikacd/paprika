import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockClient = vi.hoisted(() => ({
  getApplication: vi.fn(),
  listReleases: vi.fn(),
  getResourceTreeDetailed: vi.fn(),
  getDataSources: vi.fn(),
  getApplicationOwnership: vi.fn(),
  getApplicationLifecycle: vi.fn(),
  getRevisionInfo: vi.fn(),
  syncApplication: vi.fn(),
  rollbackRelease: vi.fn(),
  approveGate: vi.fn(),
  rejectGate: vi.fn(),
  investigate: vi.fn(),
}))

const reportRequestOutcome = vi.hoisted(() => vi.fn())

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("namespace=payments&name=checkout-api"),
}))

vi.mock("@connectrpc/connect", () => ({
  createPromiseClient: vi.fn(() => mockClient),
}))

vi.mock("@/lib/transport", () => ({ createTransport: vi.fn(() => ({})) }))
vi.mock("@/gen/paprika/v1/api_connect", () => ({ PaprikaService: {} }))
vi.mock("@/lib/connection-context", () => ({
  useConnection: () => ({ reportRequestOutcome }),
}))
vi.mock("@/components/layout/console-header", () => ({
  usePublishConsoleScope: vi.fn(),
}))

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="react-flow">{children}</div>
  ),
  Background: () => null,
  BackgroundVariant: { Lines: "lines" },
  Controls: () => null,
  Handle: () => null,
  Position: { Left: "left", Right: "right" },
}))

import { DataClass, DataState } from "@/gen/paprika/v1/api_pb"

import ApplicationDetailPage from "./page"

const APPLICATION = {
  name: "checkout-api",
  namespace: "payments",
  project: "payments/core",
  phase: "Degraded",
  health: "Degraded",
  currentStage: "prod-eu-1",
  revision: "9f3a1c2",
  synced: false,
  outOfSync: 3,
  releaseRef: "r241",
  pipelineRef: "",
  templateRef: "",
  strategy: "canary",
  syncPolicy: "auto",
  source: { type: "helm", repoUrl: "github.com/acme/checkout-api", path: "deploy/chart" },
  stages: [],
  gates: [],
  conditions: [],
  analysisResults: [],
  healthChecks: [],
  resources: [],
  resourceHealth: [],
  parameters: {},
}

/** One `DataSourceStatus` per class, exactly as the contract promises. */
function sources(overrides: Partial<Record<number, number>> = {}) {
  const classes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  return classes.map((dataClass) => ({
    dataClass,
    state: overrides[dataClass] ?? DataState.NOT_CONFIGURED,
    provider: "",
    observedAtUnixMs: BigInt(0),
    stalenessBudgetMs: BigInt(0),
    unavailableReason: "",
    retentionLimit: 0,
    retentionWindowMs: BigInt(0),
  }))
}

function lifecyclePhases() {
  return [1, 2, 3, 4, 5, 6].map((phase) => ({
    phase,
    state: 5,
    startedAtUnixMs: BigInt(0),
    finishedAtUnixMs: BigInt(0),
    durationMs: BigInt(4000),
    detail: `phase ${phase} detail`,
    referenceKind: "",
  }))
}

describe("ApplicationDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClient.getApplication.mockResolvedValue({ application: { ...APPLICATION } })
    mockClient.listReleases.mockResolvedValue({ releases: [] })
    mockClient.getResourceTreeDetailed.mockResolvedValue({ nodes: [] })
    mockClient.getDataSources.mockResolvedValue({
      sources: sources(),
      indexGeneration: BigInt(4412),
    })
    mockClient.getApplicationOwnership.mockResolvedValue({ ownership: undefined })
    mockClient.getApplicationLifecycle.mockResolvedValue({ lifecycle: undefined })
    mockClient.getRevisionInfo.mockResolvedValue({ commit: undefined })
    mockClient.syncApplication.mockResolvedValue({})
  })

  it("names the application, its health and its drift in words", async () => {
    render(<ApplicationDetailPage />)
    expect(
      await screen.findByRole("heading", { level: 1, name: "checkout-api" })
    ).toBeInTheDocument()
    expect(screen.getByText("Degraded")).toBeInTheDocument()
    expect(screen.getByText("3 out of sync")).toBeInTheDocument()
  })

  describe("OWNERSHIP is NOT_CONFIGURED", () => {
    it("omits the drilldown rail and the owner tags entirely", async () => {
      render(<ApplicationDetailPage />)
      await screen.findByRole("heading", { level: 1, name: "checkout-api" })

      expect(screen.queryByRole("heading", { name: /Drilldowns/i })).not.toBeInTheDocument()
      expect(screen.queryByText(/owner:/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/on-call:/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/tier:/i)).not.toBeInTheDocument()
    })

    it("does not even ask the server for ownership", async () => {
      render(<ApplicationDetailPage />)
      await screen.findByRole("heading", { level: 1, name: "checkout-api" })
      expect(mockClient.getApplicationOwnership).not.toHaveBeenCalled()
    })
  })

  describe("OWNERSHIP is OK", () => {
    beforeEach(() => {
      mockClient.getDataSources.mockResolvedValue({
        sources: sources({ [DataClass.OWNERSHIP]: DataState.OK }),
        indexGeneration: BigInt(4412),
      })
      mockClient.getApplicationOwnership.mockResolvedValue({
        ownership: {
          state: DataState.OK,
          owner: "payments-core",
          ownerLabel: "payments-core",
          onCall: "@rmoreau",
          tier: 1,
          escalationUrl: "",
          source: "appproject",
          links: [
            { kind: 1, label: "Grafana — service overview", url: "https://grafana.example/d/1" },
            { kind: 2, label: "Logs — Loki", url: "https://loki.example/app" },
          ],
        },
      })
    })

    it("draws the rail with the links the server resolved", async () => {
      render(<ApplicationDetailPage />)
      expect(
        await screen.findByRole("heading", { name: /Drilldowns/i })
      ).toBeInTheDocument()
      expect(
        screen.getByRole("link", { name: /Grafana — service overview/ })
      ).toHaveAttribute("href", "https://grafana.example/d/1")
      expect(screen.getByRole("link", { name: /Logs — Loki/ })).toBeInTheDocument()
    })

    it("tags the header with owner, on-call and tier", async () => {
      render(<ApplicationDetailPage />)
      await screen.findByRole("heading", { level: 1, name: "checkout-api" })
      expect(screen.getByText("owner: payments-core")).toBeInTheDocument()
      expect(screen.getByText("on-call: @rmoreau")).toBeInTheDocument()
      expect(screen.getByText("tier: 1")).toBeInTheDocument()
    })
  })

  describe("LIFECYCLE gating", () => {
    it("omits the delivery timeline when the class is NOT_CONFIGURED", async () => {
      render(<ApplicationDetailPage />)
      await screen.findByRole("heading", { level: 1, name: "checkout-api" })
      expect(
        screen.queryByRole("heading", { name: /Delivery timeline/i })
      ).not.toBeInTheDocument()
      expect(mockClient.getApplicationLifecycle).not.toHaveBeenCalled()
    })

    it("draws all six phases when the class is OK", async () => {
      mockClient.getDataSources.mockResolvedValue({
        sources: sources({ [DataClass.LIFECYCLE]: DataState.OK }),
        indexGeneration: BigInt(4412),
      })
      mockClient.getApplicationLifecycle.mockResolvedValue({
        lifecycle: { phases: lifecyclePhases(), observedAtUnixMs: BigInt(0) },
      })

      render(<ApplicationDetailPage />)
      const heading = await screen.findByRole("heading", { name: /Delivery timeline/i })
      const board = within(heading.closest("section")!)
      for (const label of ["Source", "Build", "Test", "Render", "Deploy", "Verify"]) {
        expect(board.getByText(label)).toBeInTheDocument()
      }
      expect(board.getAllByRole("listitem")).toHaveLength(6)
    })

    it("greys the board with the reason and no figures when NOT_AVAILABLE", async () => {
      mockClient.getDataSources.mockResolvedValue({
        sources: sources({ [DataClass.LIFECYCLE]: DataState.NOT_AVAILABLE }).map((s) =>
          s.dataClass === DataClass.LIFECYCLE
            ? { ...s, unavailableReason: "pipeline history is not retained" }
            : s
        ),
        indexGeneration: BigInt(4412),
      })

      render(<ApplicationDetailPage />)
      const heading = await screen.findByRole("heading", { name: /Delivery timeline/i })
      const board = within(heading.closest("section")!)
      expect(board.getByText("pipeline history is not retained")).toBeInTheDocument()
      // Greyed with a reason — and not one phase cell, let alone a zeroed one.
      expect(board.queryAllByRole("listitem")).toHaveLength(0)
      expect(board.queryByText("Source")).not.toBeInTheDocument()
      expect(mockClient.getApplicationLifecycle).not.toHaveBeenCalled()
    })
  })

  it("draws no state-carrying board at all when the capability probe fails", async () => {
    mockClient.getDataSources.mockRejectedValue(new Error("unimplemented"))

    render(<ApplicationDetailPage />)
    await screen.findByRole("heading", { level: 1, name: "checkout-api" })

    expect(
      screen.queryByRole("heading", { name: /Delivery timeline/i })
    ).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: /Drilldowns/i })).not.toBeInTheDocument()
  })

  it("shows a stale age badge rather than presenting old figures as current", async () => {
    mockClient.getDataSources.mockResolvedValue({
      sources: sources({ [DataClass.LIFECYCLE]: DataState.STALE }).map((s) =>
        s.dataClass === DataClass.LIFECYCLE
          ? { ...s, observedAtUnixMs: BigInt(Date.now() - 20 * 60_000) }
          : s
      ),
      indexGeneration: BigInt(4412),
    })
    mockClient.getApplicationLifecycle.mockResolvedValue({
      lifecycle: { phases: lifecyclePhases(), observedAtUnixMs: BigInt(0) },
    })

    render(<ApplicationDetailPage />)
    expect(await screen.findByText(/stale · 20m ago/)).toBeInTheDocument()
  })

  it("moves between sub-tabs and shows the release history behind Releases", async () => {
    const user = userEvent.setup()
    render(<ApplicationDetailPage />)
    await screen.findByRole("heading", { level: 1, name: "checkout-api" })

    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    await user.click(screen.getByRole("tab", { name: "Releases" }))

    expect(screen.getByRole("tab", { name: "Releases" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(
      await screen.findByRole("heading", { name: /Release history/i })
    ).toBeInTheDocument()
  })

  it("switches the resource board between graph and tree", async () => {
    const user = userEvent.setup()
    mockClient.getResourceTreeDetailed.mockResolvedValue({
      nodes: [
        {
          kind: "Deployment",
          name: "checkout-api",
          namespace: "payments",
          syncStatus: "OutOfSync",
          health: "Degraded",
          healthMessage: "",
          parentKind: "",
          parentName: "",
          managed: true,
          ready: 1,
          total: 3,
        },
      ],
    })

    render(<ApplicationDetailPage />)
    await screen.findByRole("heading", { level: 1, name: "checkout-api" })

    await user.click(screen.getByRole("button", { name: "Tree" }))
    expect(await screen.findByRole("treegrid", { name: "Resource tree" })).toBeInTheDocument()
    expect(screen.getByTestId("row-Deployment-checkout-api")).toHaveTextContent("1/3 ready")
  })

  it("asks the server to sync and reports the outcome", async () => {
    const user = userEvent.setup()
    render(<ApplicationDetailPage />)
    await screen.findByRole("heading", { level: 1, name: "checkout-api" })

    await user.click(screen.getByRole("button", { name: "Sync now" }))

    await waitFor(() =>
      expect(mockClient.syncApplication).toHaveBeenCalledWith({
        namespace: "payments",
        name: "checkout-api",
      })
    )
    expect(await screen.findByText("Sync accepted.")).toBeInTheDocument()
  })

  it("refreshes when focus returns, without opening an EventSource", async () => {
    const original = globalThis.EventSource
    globalThis.EventSource = vi.fn() as unknown as typeof globalThis.EventSource
    try {
      render(<ApplicationDetailPage />)
      await screen.findByRole("heading", { level: 1, name: "checkout-api" })
      expect(mockClient.getApplication).toHaveBeenCalledTimes(1)

      window.dispatchEvent(new Event("focus"))

      await waitFor(() => expect(mockClient.getApplication).toHaveBeenCalledTimes(2))
      expect(globalThis.EventSource).not.toHaveBeenCalled()
    } finally {
      globalThis.EventSource = original
    }
  })
})

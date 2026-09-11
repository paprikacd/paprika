import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"

import {
  ArtifactRef,
  CommitInfo,
  ComputeBasis,
  DataClass,
  DataSourceStatus,
  DataState,
  Pipeline,
  PipelineCacheSummary,
  PipelineRunSummary,
  PipelineTestSummary,
  Step,
  StepStatus,
} from "@/gen/paprika/v1/api_pb"

const mockClient = vi.hoisted(() => ({
  getPipeline: vi.fn(),
  getStepLogs: vi.fn().mockResolvedValue({ logs: "" }),
  listPipelineRuns: vi.fn(),
  getDataSources: vi.fn(),
  retryStep: vi.fn(),
  skipStep: vi.fn(),
  cancelPipeline: vi.fn(),
}))

const mockPush = vi.hoisted(() => vi.fn())

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams("namespace=payments&name=checkout-api-build"),
}))

vi.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: vi.fn(() => ({})),
}))

vi.mock("@connectrpc/connect", () => ({
  createPromiseClient: vi.fn(() => mockClient),
}))

vi.mock("@/gen/paprika/v1/api_connect", () => ({ PaprikaService: {} }))

vi.mock("@/components/dashboard/pipeline-dag", () => ({
  PipelineDAG: ({
    steps,
    onStepSelect,
  }: {
    steps: { name: string }[]
    onStepSelect: (name: string) => void
  }) => (
    <div data-testid="pipeline-dag">
      {steps.map((step) => (
        <button key={step.name} type="button" onClick={() => onStepSelect(step.name)}>
          node {step.name}
        </button>
      ))}
    </div>
  ),
}))

import PipelineDetailPage from "../page"
import { resetDataSourcesCache } from "../../pipeline-data"

const STARTED_AT = Math.floor(Date.now() / 1000) - 134

function makePipeline(artifacts: ArtifactRef[] = []): Pipeline {
  return new Pipeline({
    name: "checkout-api-build",
    namespace: "payments",
    phase: "Running",
    maxParallel: 3,
    steps: [
      new Step({ name: "checkout", image: "ghcr.io/acme/git:1", depends: [] }),
      new Step({ name: "unit-test", image: "ghcr.io/acme/test-runner:3.2", depends: ["checkout"] }),
    ],
    stepStatuses: [
      new StepStatus({
        name: "checkout",
        phase: "Succeeded",
        startedAt: BigInt(STARTED_AT),
        completedAt: BigInt(STARTED_AT + 4),
      }),
      new StepStatus({
        name: "unit-test",
        phase: "Running",
        startedAt: BigInt(STARTED_AT + 4),
      }),
    ],
    artifacts,
  })
}

function sources(overrides: Partial<Record<DataClass, DataState>> = {}) {
  return {
    sources: [
      new DataSourceStatus({
        dataClass: DataClass.PIPELINE_RUNS,
        state: overrides[DataClass.PIPELINE_RUNS] ?? DataState.NOT_CONFIGURED,
      }),
      new DataSourceStatus({
        dataClass: DataClass.COMMIT_METADATA,
        state: overrides[DataClass.COMMIT_METADATA] ?? DataState.NOT_CONFIGURED,
      }),
    ],
  }
}

function run(): PipelineRunSummary {
  return new PipelineRunSummary({
    runNumber: BigInt(418),
    triggeredBy: "@rmoreau",
    pipeline: { namespace: "payments", name: "checkout-api-build" },
    cache: new PipelineCacheSummary({ state: DataState.OK, hitRatio: 0.74 }),
    tests: new PipelineTestSummary({ state: DataState.OK, total: 214, passed: 214 }),
    computeState: DataState.OK,
    cpuMinutes: 9.4,
    cpuMinutesBasis: ComputeBasis.MEASURED,
    commit: new CommitInfo({
      state: DataState.OK,
      shortRevision: "9f3a1c2",
      message: "fix idempotent capture",
    }),
  })
}

describe("PipelineDetailPage", () => {
  let originalEventSource: typeof globalThis.EventSource

  beforeEach(() => {
    vi.clearAllMocks()
    resetDataSourcesCache()
    mockClient.getPipeline.mockResolvedValue({ pipeline: makePipeline() })
    mockClient.getStepLogs.mockResolvedValue({ logs: "ok checkout/cart 0.42s" })
    mockClient.getDataSources.mockResolvedValue(sources())
    mockClient.listPipelineRuns.mockResolvedValue({ state: DataState.OK, runs: [run()] })
    originalEventSource = globalThis.EventSource
    globalThis.EventSource = vi.fn() as unknown as typeof globalThis.EventSource
  })

  afterEach(() => {
    globalThis.EventSource = originalEventSource
  })

  it("polls rather than opening an event stream, and refetches on focus", async () => {
    render(<PipelineDetailPage />)
    expect(
      await screen.findByRole("heading", { name: "checkout-api-build", level: 1 })
    ).toBeInTheDocument()
    expect(mockClient.getPipeline).toHaveBeenCalledTimes(1)
    expect(globalThis.EventSource).not.toHaveBeenCalled()

    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    await waitFor(() => expect(mockClient.getPipeline).toHaveBeenCalledTimes(2))
  })

  it("renders the two stats GetPipeline can substantiate", async () => {
    render(<PipelineDetailPage />)
    expect(await screen.findByText("Elapsed")).toBeInTheDocument()
    expect(screen.getByText("Steps")).toBeInTheDocument()
    expect(screen.getByText("1/2")).toBeInTheDocument()
  })

  it("omits cache hit, tests and CPU-minutes when PIPELINE_RUNS is not configured", async () => {
    render(<PipelineDetailPage />)
    await screen.findByText("Elapsed")
    await waitFor(() => expect(mockClient.getDataSources).toHaveBeenCalled())

    expect(screen.queryByText("Cache hit")).not.toBeInTheDocument()
    expect(screen.queryByText("CPU-min")).not.toBeInTheDocument()
    expect(screen.queryByText("Tests")).not.toBeInTheDocument()
    expect(screen.queryByText("0%")).not.toBeInTheDocument()
    expect(mockClient.listPipelineRuns).not.toHaveBeenCalled()
  })

  it("renders the run-derived stats once PIPELINE_RUNS reports OK", async () => {
    mockClient.getDataSources.mockResolvedValue(
      sources({ [DataClass.PIPELINE_RUNS]: DataState.OK })
    )
    render(<PipelineDetailPage />)

    expect(await screen.findByText("Cache hit")).toBeInTheDocument()
    expect(screen.getByText("74%")).toBeInTheDocument()
    expect(screen.getByText("9.4")).toBeInTheDocument()
    expect(screen.getByText("214/214")).toBeInTheDocument()
  })

  it("greys the run metrics with the reason when the class is unavailable", async () => {
    mockClient.getDataSources.mockResolvedValue({
      sources: [
        new DataSourceStatus({
          dataClass: DataClass.PIPELINE_RUNS,
          state: DataState.NOT_AVAILABLE,
          unavailableReason: "history store unreachable",
        }),
      ],
    })
    render(<PipelineDetailPage />)

    expect(await screen.findByText("Run metrics")).toBeInTheDocument()
    expect(screen.getByText("Unavailable")).toBeInTheDocument()
    expect(screen.getByText("history store unreachable")).toBeInTheDocument()
    expect(mockClient.listPipelineRuns).not.toHaveBeenCalled()
  })

  it("omits the run number and commit from the sub-line but still says when it started", async () => {
    render(<PipelineDetailPage />)
    await screen.findByText("Elapsed")
    await waitFor(() => expect(mockClient.getDataSources).toHaveBeenCalled())

    expect(screen.getByText(/started .* ago/)).toBeInTheDocument()
    expect(screen.queryByText(/run #418/)).not.toBeInTheDocument()
    expect(screen.queryByText(/9f3a1c2/)).not.toBeInTheDocument()
  })

  it("shows the commit only when COMMIT_METADATA is configured too", async () => {
    mockClient.getDataSources.mockResolvedValue(
      sources({
        [DataClass.PIPELINE_RUNS]: DataState.OK,
        [DataClass.COMMIT_METADATA]: DataState.OK,
      })
    )
    render(<PipelineDetailPage />)

    expect(await screen.findByText(/run #418/)).toBeInTheDocument()
    expect(screen.getByText(/9f3a1c2/)).toBeInTheDocument()
    expect(screen.getByText(/fix idempotent capture/)).toBeInTheDocument()
  })

  it("selects the running step by default and loads its logs", async () => {
    render(<PipelineDetailPage />)
    expect(
      await screen.findByRole("heading", { name: "unit-test" })
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(mockClient.getStepLogs).toHaveBeenCalledWith(
        expect.objectContaining({ stepName: "unit-test" })
      )
    )
  })

  it("loads logs for a step chosen from the graph", async () => {
    const user = (await import("@testing-library/user-event")).default
    render(<PipelineDetailPage />)
    await screen.findByTestId("pipeline-dag")

    await user.click(screen.getByRole("button", { name: "node checkout" }))
    await waitFor(() =>
      expect(mockClient.getStepLogs).toHaveBeenCalledWith(
        expect.objectContaining({ stepName: "checkout" })
      )
    )
  })

  it("lists pipeline artifacts, and none when there are none", async () => {
    const { unmount } = render(<PipelineDetailPage />)
    await screen.findByTestId("pipeline-dag")
    expect(screen.queryByText("Artifacts")).not.toBeInTheDocument()
    unmount()

    mockClient.getPipeline.mockResolvedValue({
      pipeline: makePipeline([
        new ArtifactRef({
          name: "junit-report.xml",
          kind: "configmap",
          phase: "Ready",
          producingStep: "unit-test",
        }),
      ]),
    })
    render(<PipelineDetailPage />)
    expect(await screen.findByText("Artifacts")).toBeInTheDocument()
    expect(screen.getByText("junit-report.xml")).toBeInTheDocument()
  })

  it("attaches test counts to the report only when PIPELINE_RUNS supplies them", async () => {
    mockClient.getPipeline.mockResolvedValue({
      pipeline: makePipeline([
        new ArtifactRef({
          name: "junit-report.xml",
          kind: "configmap",
          phase: "Ready",
          producingStep: "unit-test",
        }),
      ]),
    })
    const { unmount } = render(<PipelineDetailPage />)
    await screen.findByText("junit-report.xml")
    await waitFor(() => expect(mockClient.getDataSources).toHaveBeenCalled())
    expect(screen.queryByText(/214 tests/)).not.toBeInTheDocument()
    unmount()

    resetDataSourcesCache()
    mockClient.getDataSources.mockResolvedValue(
      sources({ [DataClass.PIPELINE_RUNS]: DataState.OK })
    )
    render(<PipelineDetailPage />)
    expect(await screen.findByText(/214 tests/)).toBeInTheDocument()
  })

  it("cancels a running pipeline and does not offer to cancel a finished one", async () => {
    const user = (await import("@testing-library/user-event")).default
    render(<PipelineDetailPage />)
    await user.click(await screen.findByRole("button", { name: /cancel run/i }))
    expect(mockClient.cancelPipeline).toHaveBeenCalledWith({
      name: "checkout-api-build",
      namespace: "payments",
    })
  })

  it("keeps the last pipeline state visible when a background refresh fails", async () => {
    mockClient.getPipeline
      .mockResolvedValueOnce({ pipeline: makePipeline() })
      .mockRejectedValue(new Error("pipeline refresh unavailable"))
    render(<PipelineDetailPage />)
    expect(await screen.findByTestId("pipeline-dag")).toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new Event("focus"))
    })

    expect(await screen.findByRole("status")).toHaveTextContent(
      "pipeline refresh unavailable"
    )
    expect(screen.getByTestId("pipeline-dag")).toBeInTheDocument()
  })
})

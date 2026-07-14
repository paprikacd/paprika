import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import type { PartialMessage } from "@bufbuild/protobuf"
import { ArtifactRef, Pipeline, Step, StepStatus } from "@/gen/paprika/v1/api_pb"

const mockClient = vi.hoisted(() => ({
  getPipeline: vi.fn(),
  getStepLogs: vi.fn().mockResolvedValue({ logs: "" }),
  retryStep: vi.fn(),
  skipStep: vi.fn(),
  cancelPipeline: vi.fn(),
}))

const mockPush = vi.hoisted(() => vi.fn())
const mockReplace = vi.hoisted(() => vi.fn())
const query = vi.hoisted(() => ({ value: "namespace=ns&name=pipe" }))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => new URLSearchParams(query.value),
}))

vi.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: vi.fn(() => ({})),
}))

vi.mock("@connectrpc/connect", () => ({
  createPromiseClient: vi.fn(() => mockClient),
}))

vi.mock("@/gen/paprika/v1/api_connect", () => ({
  PaprikaService: {},
}))

vi.mock("@/components/dashboard/pipeline-dag", () => ({
  PipelineDAG: () => <div data-testid="pipeline-dag" />,
}))

vi.mock("@/components/dashboard/step-detail-panel", () => ({
  StepDetailPanel: () => <div data-testid="step-detail-panel" />,
}))

import PipelineDetailPage from "../page"

function makePipeline(artifacts: PartialMessage<ArtifactRef>[] = []): Pipeline {
  return new Pipeline({
    name: "pipe",
    namespace: "ns",
    phase: "Running",
    steps: [new Step({ name: "build", image: "img", script: "", depends: [] })],
    stepStatuses: [new StepStatus({ name: "build", phase: "Running" })],
    artifacts: artifacts.map((a) => new ArtifactRef(a)),
  })
}

describe("PipelineDetailPage safe refresh", () => {
  let originalEventSource: typeof globalThis.EventSource

  beforeEach(() => {
    vi.clearAllMocks()
    query.value = "pipeline_namespace=ns&pipeline_name=pipe&namespace=apps&unknown=kept"
    mockClient.getPipeline.mockResolvedValue({
      pipeline: makePipeline([
        { name: "build-image", kind: "oci", phase: "Ready", producingStep: "build" },
        { name: "pipeline-report", kind: "configmap", phase: "Ready", producingStep: "" },
      ]),
    })
    originalEventSource = globalThis.EventSource
    globalThis.EventSource = vi.fn() as unknown as typeof globalThis.EventSource
  })

  afterEach(() => {
    globalThis.EventSource = originalEventSource
  })

  it("refetches the pipeline once when focus returns without constructing EventSource", async () => {
    render(<PipelineDetailPage />)

    expect(await screen.findByText("Pipeline Artifacts")).toBeInTheDocument()
    expect(mockClient.getPipeline).toHaveBeenCalledTimes(1)
    expect(globalThis.EventSource).not.toHaveBeenCalled()

    act(() => {
      window.dispatchEvent(new Event("focus"))
    })

    await waitFor(() => {
      expect(mockClient.getPipeline).toHaveBeenCalledTimes(2)
    })
  })

  it("migrates a single legacy identity once and retains unknown scope", async () => {
    query.value = "namespace=ns&name=pipe&unknown=kept"
    render(<PipelineDetailPage />)

    await waitFor(() => expect(mockClient.getPipeline).toHaveBeenCalledWith({ namespace: "ns", name: "pipe" }))
    expect(mockReplace).toHaveBeenCalledWith(
      "/dashboard/pipelines/detail?namespace=ns&unknown=kept&pipeline_namespace=ns&pipeline_name=pipe",
    )
  })

  it("does not query an ambiguous legacy identity", async () => {
    query.value = "namespace=apps&namespace=platform&name=pipe&unknown=kept"
    render(<PipelineDetailPage />)
    expect(await screen.findByText(/ambiguous pipeline identity/i)).toBeInTheDocument()
    expect(mockClient.getPipeline).not.toHaveBeenCalled()
  })

  it("renders a Pipeline Artifacts section for artifacts without a producingStep", async () => {
    render(<PipelineDetailPage />)

    await waitFor(() => {
      expect(mockClient.getPipeline).toHaveBeenCalledTimes(1)
    })

    expect(await screen.findByText("Pipeline Artifacts")).toBeInTheDocument()
    expect(screen.getByText("pipeline-report")).toBeInTheDocument()
    expect(screen.queryByText("build-image")).not.toBeInTheDocument()
  })

  it("keeps the last pipeline DAG visible when a background refresh fails", async () => {
    mockClient.getPipeline
      .mockResolvedValueOnce({ pipeline: makePipeline() })
      .mockRejectedValueOnce(new Error("pipeline refresh unavailable"))
    render(<PipelineDetailPage />)
    expect(await screen.findByTestId("pipeline-dag")).toBeInTheDocument()

    act(() => window.dispatchEvent(new Event("focus")))

    expect(await screen.findByRole("status")).toHaveTextContent(
      "pipeline refresh unavailable",
    )
    expect(screen.getByTestId("pipeline-dag")).toBeInTheDocument()
  })
})

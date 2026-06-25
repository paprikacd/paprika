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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams("namespace=ns&name=pipe"),
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

describe("PipelineDetailPage pipeline-artifact SSE handling", () => {
  interface MockSSEEvent {
    data: string
  }
  let mockEventSource: {
    onopen: ((e: MockSSEEvent) => void) | null
    onmessage: ((e: MockSSEEvent) => void) | null
    onerror: ((e: MockSSEEvent) => void) | null
    close: ReturnType<typeof vi.fn>
  }
  let originalEventSource: typeof globalThis.EventSource

  beforeEach(() => {
    vi.clearAllMocks()
    mockClient.getPipeline.mockResolvedValue({
      pipeline: makePipeline([
        { name: "build-image", kind: "oci", phase: "Ready", producingStep: "build" },
        { name: "pipeline-report", kind: "configmap", phase: "Ready", producingStep: "" },
      ]),
    })
    mockEventSource = {
      onopen: null,
      onmessage: null,
      onerror: null,
      close: vi.fn(),
    }
    originalEventSource = globalThis.EventSource
    globalThis.EventSource = vi.fn(function () {
      return mockEventSource
    }) as unknown as typeof globalThis.EventSource
  })

  afterEach(() => {
    globalThis.EventSource = originalEventSource
  })

  it("refetches the pipeline when a pipeline-artifact event arrives", async () => {
    render(<PipelineDetailPage />)

    await waitFor(() => {
      expect(mockClient.getPipeline).toHaveBeenCalledTimes(1)
    })

    act(() => {
      mockEventSource.onmessage!({
        data: JSON.stringify({
          type: "pipeline-artifact",
          resourceType: "pipeline-artifact",
          pipeline: "pipe",
          namespace: "ns",
          name: "build-image",
          kind: "oci",
          phase: "Ready",
          producingStep: "build",
          timestamp: "2026-06-25T00:00:00Z",
        }),
      })
    })

    await waitFor(() => {
      expect(mockClient.getPipeline).toHaveBeenCalledTimes(2)
    })
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
})

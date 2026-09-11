import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"

import {
  DataClass,
  DataSourceStatus,
  DataState,
  Pipeline,
  PipelineRunSummary,
  PipelineRunOutcome,
  Step,
  StepStatus,
} from "@/gen/paprika/v1/api_pb"

const mockClient = vi.hoisted(() => ({
  listPipelines: vi.fn(),
  listPipelineRuns: vi.fn(),
  getDataSources: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/dashboard/pipelines/",
}))

vi.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: vi.fn(() => ({})),
}))

vi.mock("@connectrpc/connect", () => ({
  createPromiseClient: vi.fn(() => mockClient),
}))

vi.mock("@/gen/paprika/v1/api_connect", () => ({ PaprikaService: {} }))

import PipelinesPage from "../page"
import { resetDataSourcesCache } from "../pipeline-data"

function dataSources(pipelineRuns: DataState): DataSourceStatus[] {
  return [
    new DataSourceStatus({
      dataClass: DataClass.PIPELINE_RUNS,
      state: pipelineRuns,
      unavailableReason:
        pipelineRuns === DataState.NOT_AVAILABLE ? "history store unreachable" : "",
    }),
  ]
}

const pipelines = [
  new Pipeline({
    name: "checkout-api-build",
    namespace: "payments",
    phase: "Running",
    steps: [
      new Step({ name: "checkout", depends: [] }),
      new Step({ name: "build", depends: ["checkout"] }),
    ],
    stepStatuses: [new StepStatus({ name: "checkout", phase: "Succeeded" })],
  }),
]

beforeEach(() => {
  vi.clearAllMocks()
  resetDataSourcesCache()
  mockClient.listPipelines.mockResolvedValue({ pipelines })
  mockClient.getDataSources.mockResolvedValue({ sources: dataSources(DataState.NOT_CONFIGURED) })
  mockClient.listPipelineRuns.mockResolvedValue({
    state: DataState.OK,
    runs: [
      new PipelineRunSummary({
        runNumber: BigInt(418),
        outcome: PipelineRunOutcome.SUCCEEDED,
        durationMs: BigInt(134_000),
        pipeline: { namespace: "payments", name: "checkout-api-build" },
      }),
    ],
  })
})

describe("PipelinesPage", () => {
  it("lists pipelines from ListPipelines and links each to its detail route", async () => {
    render(<PipelinesPage />)

    const link = await screen.findByRole("link", { name: "checkout-api-build" })
    // next/link normalises the trailing slash here; `trailingSlash: true`
    // restores it in the static export.
    expect(link.getAttribute("href")).toMatch(
      /^\/dashboard\/pipelines\/detail\/?\?namespace=payments&name=checkout-api-build$/
    )
    expect(screen.getByText("payments")).toBeInTheDocument()
  })

  it("states the phase in words and shows real step progress", async () => {
    render(<PipelinesPage />)
    await screen.findByRole("link", { name: "checkout-api-build" })
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0)
    expect(screen.getByText("1/2")).toBeInTheDocument()
  })

  it("omits the last-run column entirely when PIPELINE_RUNS is not configured", async () => {
    render(<PipelinesPage />)
    await screen.findByRole("link", { name: "checkout-api-build" })

    expect(
      screen.queryByRole("columnheader", { name: /last run/i })
    ).not.toBeInTheDocument()
    await waitFor(() => expect(mockClient.getDataSources).toHaveBeenCalled())
    expect(mockClient.listPipelineRuns).not.toHaveBeenCalled()
  })

  it("shows the last run once PIPELINE_RUNS reports OK", async () => {
    mockClient.getDataSources.mockResolvedValue({ sources: dataSources(DataState.OK) })
    render(<PipelinesPage />)

    expect(
      await screen.findByRole("columnheader", { name: /last run/i })
    ).toBeInTheDocument()
    expect(await screen.findByText("#418 · Succeeded · 2m 14s")).toBeInTheDocument()
  })

  it("greys the last-run column with the server's reason when the class is unavailable", async () => {
    mockClient.getDataSources.mockResolvedValue({
      sources: dataSources(DataState.NOT_AVAILABLE),
    })
    render(<PipelinesPage />)

    expect(
      await screen.findByRole("columnheader", { name: /last run/i })
    ).toBeInTheDocument()
    expect(await screen.findByText("history store unreachable")).toBeInTheDocument()
    expect(mockClient.listPipelineRuns).not.toHaveBeenCalled()
  })

  it("keeps the last loaded list and explains a failed refresh", async () => {
    mockClient.listPipelines
      .mockResolvedValueOnce({ pipelines })
      .mockRejectedValue(new Error("pipeline index unavailable"))
    render(<PipelinesPage />)
    await screen.findByRole("link", { name: "checkout-api-build" })

    window.dispatchEvent(new Event("focus"))

    expect(await screen.findByRole("status")).toHaveTextContent(
      "pipeline index unavailable"
    )
    expect(screen.getByRole("link", { name: "checkout-api-build" })).toBeInTheDocument()
  })

  it("surfaces a first-load failure as an alert", async () => {
    mockClient.listPipelines.mockRejectedValue(new Error("pipeline index unavailable"))
    render(<PipelinesPage />)
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "pipeline index unavailable"
    )
  })
})

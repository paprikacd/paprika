import { Code, ConnectError } from "@connectrpc/connect"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

const navigation = vi.hoisted(() => ({
  search: "namespace=payments&name=checkout-api",
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/rollouts/detail",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}))

import {
  AnalysisRun,
  AnalysisRunResult,
  Condition,
  GetDataSourcesResponse,
  GetRolloutResponse,
  IstioRouterConfig,
  ListAnalysisRunsResponse,
  Rollout,
  RolloutAnalysisCheck,
  RolloutStep,
  TrafficRouter,
} from "@/gen/paprika/v1/api_pb"

import type { RolloutConsoleClient } from "../rollout-queries"
import { RolloutDetailView } from "./rollout-detail-view"

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

function heldRollout(patch: Partial<Rollout> = {}): Rollout {
  return new Rollout({
    name: "checkout-api",
    namespace: "payments",
    strategyType: "Canary",
    phase: "Paused",
    paused: true,
    currentStep: 2,
    currentWeight: 25,
    targetKind: "Deployment",
    targetName: "checkout-api",
    stableRs: "checkout-api-6b9c",
    canaryRs: "checkout-api-7d4f",
    stableReadyReplicas: 6,
    canaryReadyReplicas: 2,
    replicas: 8,
    trafficRouter: new TrafficRouter({
      provider: "istio",
      istio: new IstioRouterConfig({ virtualService: "checkout-api" }),
    }),
    canarySteps: [
      new RolloutStep({ setWeight: 5, duration: "2m0s" }),
      new RolloutStep({ setWeight: 10, duration: "2m0s" }),
      new RolloutStep({ setWeight: 25 }),
      new RolloutStep({ setWeight: 50 }),
    ],
    analysisChecks: [
      new RolloutAnalysisCheck({
        type: "pod-metric",
        metric: "error-rate",
        threshold: "0.02",
      }),
    ],
    conditions: [
      new Condition({
        type: "Progressing",
        status: "True",
        reason: "WeightAdvanced",
        lastTransitionTime: "2026-09-10T09:30:00Z",
        message: "Weight advanced 10% to 25%",
      }),
      new Condition({
        type: "Progressing",
        status: "False",
        reason: "AnalysisFailed",
        lastTransitionTime: "2026-09-10T09:41:00Z",
        message: "error rate: 0.04 (threshold 0.02)",
      }),
    ],
    ...patch,
  })
}

function makeClient(
  overrides: Partial<Record<keyof RolloutConsoleClient, unknown>> = {},
): RolloutConsoleClient {
  return {
    getDataSources: vi.fn(async () => new GetDataSourcesResponse({})),
    getRollout: vi.fn(
      async () => new GetRolloutResponse({ rollout: heldRollout() }),
    ),
    listAnalysisRuns: vi.fn(async () => new ListAnalysisRunsResponse({})),
    listRollouts: vi.fn(),
    listRolloutHistory: vi.fn(),
    promoteRollout: vi.fn(),
    abortRollout: vi.fn(),
    holdRollout: vi.fn(),
    resumeRollout: vi.fn(),
    ...overrides,
  } as unknown as RolloutConsoleClient
}

describe("RolloutDetailView", () => {
  it("draws one ladder rung per declared canary step and says which is held", async () => {
    render(<RolloutDetailView client={makeClient()} />, { wrapper })

    expect(await screen.findByText("5%")).toBeInTheDocument()
    expect(screen.getByText("STEP 4")).toBeInTheDocument()
    expect(screen.queryByText("STEP 5")).not.toBeInTheDocument()
    expect(screen.getByText("held")).toBeInTheDocument()
    expect(screen.getAllByText("queued")).toHaveLength(1)
  })

  it("names the rollout state in text, not only in colour", async () => {
    render(<RolloutDetailView client={makeClient()} />, { wrapper })

    expect(
      await screen.findByText("Paused at step 3"),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("img", { name: /Step 3:/ }),
    ).toBeInTheDocument()
  })

  it("shows the declared threshold and the observed value, and no baseline column", async () => {
    render(<RolloutDetailView client={makeClient()} />, { wrapper })

    const table = await screen.findByRole("table", {
      name: /analysis checks/i,
    })
    expect(
      within(table).getByRole("columnheader", { name: "THRESHOLD" }),
    ).toBeInTheDocument()
    expect(
      within(table).getByRole("columnheader", { name: "CANARY" }),
    ).toBeInTheDocument()
    expect(
      within(table).queryByRole("columnheader", { name: "BASELINE" }),
    ).not.toBeInTheDocument()
    expect(within(table).getByText("0.04")).toBeInTheDocument()
    expect(within(table).getByText("0.02")).toBeInTheDocument()
  })

  it("shows a baseline column only once a check actually reports one", async () => {
    const client = makeClient({
      listAnalysisRuns: vi.fn(
        async () =>
          new ListAnalysisRunsResponse({
            analysisRuns: [
              new AnalysisRun({
                applicationRef: "checkout-api",
                startedAt: BigInt(5),
                results: [
                  new AnalysisRunResult({
                    name: "error-rate",
                    passed: false,
                    message: "canary=0.04 baseline=0.01",
                  }),
                ],
              }),
            ],
          }),
      ),
    })
    render(<RolloutDetailView client={client} />, { wrapper })

    expect(
      await screen.findByRole("columnheader", { name: "BASELINE" }),
    ).toBeInTheDocument()
    const table = screen.getByRole("table", { name: /analysis checks/i })
    expect(within(table).getByText("0.01")).toBeInTheDocument()
    expect(within(table).getByText("0.04")).toBeInTheDocument()
  })

  it("orders the rollout log newest first", async () => {
    render(<RolloutDetailView client={makeClient()} />, { wrapper })

    const entries = await screen.findAllByRole("listitem")
    const log = entries.filter((entry) =>
      entry.textContent?.includes("Progressing"),
    )
    expect(log[0]).toHaveTextContent("error rate: 0.04")
    expect(log[1]).toHaveTextContent("Weight advanced 10% to 25%")
  })

  it("reports that Hold is not implemented rather than appearing to succeed", async () => {
    const client = makeClient({
      resumeRollout: vi.fn(async () => {
        throw new ConnectError(
          "ResumeRollout is not implemented on this control plane; no change was made",
          Code.Unimplemented,
        )
      }),
    })
    render(<RolloutDetailView client={client} />, { wrapper })

    await userEvent.click(await screen.findByRole("button", { name: /Resume/ }))

    const status = await screen.findByRole("status")
    expect(status).toHaveTextContent(/not available on this control plane yet/i)
    expect(status).toHaveTextContent(/no change was made/i)
    expect(status).not.toHaveTextContent(/accepted/i)
  })

  it("labels the promote control with the weight it would move to", async () => {
    render(<RolloutDetailView client={makeClient()} />, { wrapper })

    expect(
      await screen.findByRole("button", { name: "Promote to 50%" }),
    ).toBeInTheDocument()
  })

  it("omits the analysis board entirely when the rollout declares no checks", async () => {
    const client = makeClient({
      getRollout: vi.fn(
        async () =>
          new GetRolloutResponse({
            rollout: heldRollout({ analysisChecks: [], conditions: [] }),
          }),
      ),
    })
    render(<RolloutDetailView client={client} />, { wrapper })

    await screen.findByText("Traffic ladder")
    expect(
      screen.queryByRole("table", { name: /analysis checks/i }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/metrics failing/i)).not.toBeInTheDocument()
  })
})

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

const navigation = vi.hoisted(() => ({ search: "" }))

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/rollouts",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}))

import {
  DataClass,
  DataSourceStatus,
  DataState,
  FleetObjectKey,
  GetDataSourcesResponse,
  ListRolloutHistoryResponse,
  ListRolloutsResponse,
  PromoteRolloutResponse,
  Rollout,
  RolloutHistoryEntry,
  RolloutHistoryStats,
  RolloutOutcome,
  RolloutStep,
} from "@/gen/paprika/v1/api_pb"

import { RolloutsView } from "./rollouts-view"
import type { RolloutConsoleClient } from "./rollout-queries"

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

function dataSources(state: DataState, reason = "") {
  return new GetDataSourcesResponse({
    indexGeneration: BigInt(4412),
    sources: [
      new DataSourceStatus({
        dataClass: DataClass.ROLLOUT_HISTORY,
        state,
        unavailableReason: reason,
      }),
    ],
  })
}

function rollouts() {
  return new ListRolloutsResponse({
    rollouts: [
      new Rollout({
        name: "checkout-api",
        namespace: "payments",
        strategyType: "Canary",
        phase: "Paused",
        currentStep: 2,
        currentWeight: 25,
        targetKind: "Deployment",
        targetName: "checkout-api",
        canarySteps: [
          new RolloutStep({ setWeight: 5 }),
          new RolloutStep({ setWeight: 10 }),
          new RolloutStep({ setWeight: 25 }),
        ],
      }),
    ],
  })
}

function history() {
  return new ListRolloutHistoryResponse({
    state: DataState.OK,
    retentionLimit: 200,
    entries: [
      new RolloutHistoryEntry({
        identity: new FleetObjectKey({ namespace: "payments", name: "r-1" }),
        application: new FleetObjectKey({
          namespace: "payments",
          name: "checkout-api",
        }),
        stage: "production",
        strategy: "Canary",
        outcome: RolloutOutcome.SUCCEEDED,
        finishedAtUnixMs: BigInt(Date.now() - 60_000),
        durationMs: BigInt(472_000),
        stepsCompleted: 6,
        stepsTotal: 6,
      }),
    ],
    stats: new RolloutHistoryStats({
      state: DataState.OK,
      total: BigInt(200),
      succeeded: BigInt(120),
      sampleSize: BigInt(200),
      medianDurationMs: BigInt(472_000),
    }),
  })
}

function makeClient(
  overrides: Partial<Record<keyof RolloutConsoleClient, unknown>> = {},
): RolloutConsoleClient {
  return {
    getDataSources: vi.fn(async () => dataSources(DataState.OK)),
    listRollouts: vi.fn(async () => rollouts()),
    listRolloutHistory: vi.fn(async () => history()),
    getRollout: vi.fn(),
    listAnalysisRuns: vi.fn(),
    promoteRollout: vi.fn(async () => new PromoteRolloutResponse({})),
    abortRollout: vi.fn(),
    holdRollout: vi.fn(),
    resumeRollout: vi.fn(),
    ...overrides,
  } as unknown as RolloutConsoleClient
}

describe("RolloutsView", () => {
  it("lists the rollouts the control plane is reconciling", async () => {
    render(<RolloutsView client={makeClient()} />, { wrapper })

    const link = await screen.findByRole("link", { name: "checkout-api" })
    expect(link.getAttribute("href")).toMatch(
      /^\/dashboard\/rollouts\/detail\/?\?namespace=payments&name=checkout-api$/,
    )
    expect(screen.getByRole("table")).toBeInTheDocument()
  })

  it("promotes a rollout and reports that the control plane accepted it", async () => {
    const client = makeClient()
    render(<RolloutsView client={client} />, { wrapper })

    await userEvent.click(
      await screen.findByRole("button", { name: "Promote checkout-api" }),
    )

    expect(client.promoteRollout).toHaveBeenCalledWith({
      namespace: "payments",
      name: "checkout-api",
    })
    expect(await screen.findByRole("status")).toHaveTextContent(/accepted/i)
  })

  it("does not offer the recent window when nothing records rollout history", async () => {
    const client = makeClient({
      getDataSources: vi.fn(async () =>
        dataSources(
          DataState.NOT_CONFIGURED,
          "rollout history recording is not configured",
        ),
      ),
    })
    render(<RolloutsView client={client} />, { wrapper })

    await screen.findByRole("link", { name: "checkout-api" })

    expect(
      screen.queryByRole("button", { name: /recent/i }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/recent rollouts/i)).not.toBeInTheDocument()
    expect(client.listRolloutHistory).not.toHaveBeenCalled()
  })

  it("does not fall back to an empty recent table when the URL asks for one", async () => {
    navigation.search = "tab=recent"
    const client = makeClient({
      getDataSources: vi.fn(async () =>
        dataSources(DataState.NOT_CONFIGURED, "not configured"),
      ),
    })
    render(<RolloutsView client={client} />, { wrapper })

    expect(
      await screen.findByRole("link", { name: "checkout-api" }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/no rollouts completed/i)).not.toBeInTheDocument()
    navigation.search = ""
  })

  it("offers the recent window and shows completed rollouts when the feed exists", async () => {
    render(<RolloutsView client={makeClient()} />, { wrapper })

    await userEvent.click(
      await screen.findByRole("button", { name: "Recent · 7d" }),
    )

    expect(
      await screen.findByRole("table", {
        name: /rollouts that finished/i,
      }),
    ).toBeInTheDocument()
    expect(screen.getByText("Succeeded")).toBeInTheDocument()
    expect(
      screen.getByText(/aggregate over 200 retained records/i),
    ).toBeInTheDocument()
  })

  it("greys the recent window with the server's reason instead of showing zeros", async () => {
    const client = makeClient({
      getDataSources: vi.fn(async () =>
        dataSources(
          DataState.NOT_AVAILABLE,
          "rollout history is temporarily unavailable",
        ),
      ),
      listRolloutHistory: vi.fn(async () =>
        new ListRolloutHistoryResponse({ state: DataState.NOT_AVAILABLE }),
      ),
    })
    render(<RolloutsView client={client} />, { wrapper })

    await userEvent.click(
      await screen.findByRole("button", { name: "Recent · 7d" }),
    )

    await waitFor(() =>
      expect(
        screen.getByText(/rollout history is temporarily unavailable/i),
      ).toBeInTheDocument(),
    )
    expect(screen.queryByText("COMPLETED")).not.toBeInTheDocument()
  })
})

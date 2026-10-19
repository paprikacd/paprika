import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ClustersClient } from "@/app/dashboard/clusters/clusters-view"
import {
  ClusterMode,
  ClusterPhase,
  DataClass,
  DataState,
  FleetConnectionState,
  ResourceUnit,
} from "@/gen/paprika/v1/api_pb"
import type { FleetFacetBucket } from "@/lib/fleet-client"

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }))
const fleet = vi.hoisted(() => ({
  useFleetData: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("next/navigation", () => ({
  useSearchParams: () => navigation.params,
}))

vi.mock("@/lib/connection-context", () => ({
  useConnection: () => ({ reportRequestOutcome: vi.fn() }),
}))

vi.mock("@/lib/use-fleet-data", () => ({
  useFleetData: fleet.useFleetData,
}))

import { ClustersView } from "@/app/dashboard/clusters/clusters-view"

const INVENTORY_NOT_CONFIGURED =
  "cluster inventory collection is not configured; enable it to see node, pod and namespace counts"

function clusterFacet(name: string, count: number): FleetFacetBucket {
  return {
    dimension: "cluster",
    object: { namespace: "clusters", name },
    label: name,
    count: BigInt(count),
  }
}

function mockFleet(facets: FleetFacetBucket[] = [clusterFacet("prod-eu-1", 24)]) {
  const data = {
    kind: "matrix",
    view: "matrix",
    result: {
      rows: [],
      columns: [],
      cells: [],
      total: BigInt(24),
      indexGeneration: BigInt(4412),
      facets,
    },
  }
  fleet.useFleetData.mockReturnValue({
    status: "ready",
    currentData: data,
    staleData: undefined,
    displayData: data,
    applicationFacets: facets,
    isLoading: false,
    isStale: false,
    refresh: fleet.refresh,
  })
}

interface Reading {
  state: DataState
  provider?: string
  observedAtUnixMs?: bigint
  unavailableReason?: string
}

function client(inventory: Reading, clusters: unknown[] = []) {
  return {
    getDataSources: vi.fn().mockResolvedValue({
      sources: [
        {
          dataClass: DataClass.CLUSTER_INVENTORY,
          state: inventory.state,
          provider: inventory.provider ?? "",
          observedAtUnixMs: inventory.observedAtUnixMs ?? BigInt(0),
          stalenessBudgetMs: BigInt(90_000),
          unavailableReason: inventory.unavailableReason ?? "",
        },
      ],
      indexGeneration: BigInt(4412),
    }),
    listClusters: vi.fn().mockResolvedValue({ clusters }),
  }
}

function renderView(fake: ReturnType<typeof client>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ClustersView client={fake as unknown as ClustersClient} />
    </QueryClientProvider>,
  )
}

function registration(overrides: Record<string, unknown> = {}) {
  return {
    identity: { namespace: "clusters", name: "prod-eu-1" },
    displayName: "prod-eu-1",
    mode: ClusterMode.DIRECT,
    phase: ClusterPhase.HEALTHY,
    connection: FleetConnectionState.HEALTHY,
    kubernetesVersion: "v1.31.4",
    applicationCount: BigInt(24),
    targetCount: BigInt(31),
    managementPolicies: ["Observe", "Apply", "Prune", "Delete", "SelfHeal", "Rollout"],
    ...overrides,
  }
}

describe("ClustersView", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    navigation.params = new URLSearchParams()
    mockFleet()
  })

  it("still lists the clusters the fleet index knows about", async () => {
    renderView(
      client({
        state: DataState.NOT_CONFIGURED,
        unavailableReason: INVENTORY_NOT_CONFIGURED,
      }),
    )

    const table = await screen.findByRole("table", {
      name: "Clusters in the fleet index",
    })
    const row = within(table).getByRole("row", { name: /prod-eu-1/ })
    expect(within(row).getByText("24")).toBeInTheDocument()
    expect(
      within(row).getByRole("link", { name: "prod-eu-1" }),
    ).toHaveAttribute("href", expect.stringContaining("cluster=clusters%2Fprod-eu-1"))
  })

  it("says so plainly when no cluster in scope has an application", async () => {
    mockFleet([])
    renderView(client({ state: DataState.NOT_CONFIGURED }))

    expect(
      await screen.findByText(
        "No cluster in this scope has an application targeting it.",
      ),
    ).toBeInTheDocument()
  })

  it("renders registrations even when inventory is not configured", async () => {
    const fake = client(
      {
        state: DataState.NOT_CONFIGURED,
        unavailableReason: INVENTORY_NOT_CONFIGURED,
      },
      [registration()],
    )
    renderView(fake)

    // Registrations are their own read, so the board draws them; only the
    // node and pod counts are withheld, with the server's sentence explaining
    // why rather than a pair of zeros.
    expect(await screen.findByText("Registered clusters")).toBeInTheDocument()
    expect(screen.getByText(/Node and pod counts are unavailable/)).toBeInTheDocument()
    expect(screen.queryByText(/nodes ready/)).not.toBeInTheDocument()
    expect(fake.listClusters).toHaveBeenCalledTimes(1)
  })

  it("renders node and pod counts once the inventory carries data", async () => {
    renderView(
      client({ state: DataState.OK, provider: "kube-state-metrics" }, [
        registration({
          inventory: {
            state: DataState.OK,
            nodeCount: 2,
            readyNodeCount: 1,
            podCount: 9,
            runningPodCount: 7,
            namespaceCount: 4,
          },
        }),
      ]),
    )

    expect(await screen.findByText("1/2")).toBeInTheDocument()
    expect(screen.getByText("7/9")).toBeInTheDocument()
    expect(screen.getByText("Connected")).toBeInTheDocument()
    expect(screen.getByText(/v1.31.4/)).toBeInTheDocument()
  })

  it("badges stale inventory with its age instead of presenting it as current", async () => {
    renderView(
      client(
        {
          state: DataState.STALE,
          observedAtUnixMs: BigInt(Date.now() - 120_000),
        },
        [
          registration({
            mode: ClusterMode.AGENT,
            kubernetesVersion: "",
            applicationCount: BigInt(2),
            targetCount: BigInt(2),
          }),
        ],
      ),
    )

    expect(
      await screen.findByText("inventory stale · 2m old"),
    ).toBeInTheDocument()
    // An unreported version is empty on the wire, which is unambiguous; the
    // console says so rather than printing a fabricated one.
    expect(
      await screen.findByText(/version not reported/),
    ).toBeInTheDocument()
  })

  it("keeps the registration visible when inventory is forbidden", async () => {
    renderView(client({ state: DataState.FORBIDDEN }, [registration()]))

    expect(await screen.findByText("Registered clusters")).toBeInTheDocument()
    expect(screen.getByText("Connected")).toBeInTheDocument()
    expect(screen.queryByText(/nodes ready/)).not.toBeInTheDocument()
  })

  it("renders management policies so the ceiling is visible", async () => {
    renderView(
      client({ state: DataState.OK }, [
        registration({ managementPolicies: ["Observe"] }),
      ]),
    )

    const policies = await screen.findByRole("list", {
      name: "Management policies",
    })
    expect(within(policies).getByText("Observe")).toBeInTheDocument()
  })

  it("says a policy-free cluster will not be touched rather than showing nothing", async () => {
    renderView(
      client({ state: DataState.OK }, [registration({ managementPolicies: [] })]),
    )

    expect(
      await screen.findByText(
        "policies: none — Paprika will not read or write this cluster",
      ),
    ).toBeInTheDocument()
  })

  it("renders capacity meters from the satellite report", async () => {
    renderView(
      client({ state: DataState.OK }, [
        registration({
          mode: ClusterMode.AGENT,
          capacity: {
            cpu: {
              unit: ResourceUnit.MILLICORES,
              usedState: DataState.OK,
              used: 1500,
              requestedState: DataState.OK,
              requested: 2000,
              allocatableState: DataState.OK,
              allocatable: 4000,
            },
            memory: {
              unit: ResourceUnit.BYTES,
              usedState: DataState.NOT_CONFIGURED,
              used: 0,
              requestedState: DataState.OK,
              requested: 1,
              allocatableState: DataState.OK,
              allocatable: 8,
              unavailableReason: "no metrics API",
            },
          },
          satellite: {
            autonomy: "Failover",
            operatingState: "Connected",
            lastSeenUnixMs: BigInt(Date.now() - 30_000),
          },
        }),
      ]),
    )

    expect(await screen.findByText("CPU")).toBeInTheDocument()
    expect(screen.getByText("MEMORY")).toBeInTheDocument()
    expect(screen.getByText(/satellite · autonomy Failover/)).toBeInTheDocument()
    expect(screen.queryByText(/state not reported/)).not.toBeInTheDocument()
  })

  it("does not invent a satellite state that was never reported", async () => {
    renderView(
      client({ state: DataState.OK }, [
        registration({
          mode: ClusterMode.AGENT,
          satellite: { autonomy: "Delegated", operatingState: "" },
        }),
      ]),
    )

    expect(
      await screen.findByText(/satellite · autonomy Delegated · state not reported/),
    ).toBeInTheDocument()
  })
})

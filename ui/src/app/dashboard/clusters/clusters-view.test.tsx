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

describe("ClustersView", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    navigation.params = new URLSearchParams()
    mockFleet()
  })

  it("omits the inventory board entirely when the data class is not configured", async () => {
    const fake = client({
      state: DataState.NOT_CONFIGURED,
      unavailableReason: INVENTORY_NOT_CONFIGURED,
    })
    renderView(fake)

    expect(
      await screen.findByText(INVENTORY_NOT_CONFIGURED),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("table", { name: "Cluster inventory" }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText("nodes")).not.toBeInTheDocument()
    expect(screen.queryByText("0")).not.toBeInTheDocument()
    // The probe answered; asking the RPC anyway would only produce an empty
    // page for an operator to misread as "no clusters".
    expect(fake.listClusters).not.toHaveBeenCalled()
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

  it("renders the inventory once the class carries data", async () => {
    const fake = client({ state: DataState.OK, provider: "kube-state-metrics" }, [
      {
        identity: { namespace: "clusters", name: "prod-eu-1" },
        displayName: "prod-eu-1",
        mode: ClusterMode.DIRECT,
        phase: ClusterPhase.HEALTHY,
        connection: FleetConnectionState.HEALTHY,
        kubernetesVersion: "v1.31.4",
        applicationCount: BigInt(24),
        targetCount: BigInt(31),
      },
    ])
    renderView(fake)

    const table = await screen.findByRole("table", { name: "Cluster inventory" })
    const row = within(table).getByRole("row", { name: /prod-eu-1/ })
    expect(within(row).getByText("Connected")).toBeInTheDocument()
    expect(within(row).getByText("v1.31.4")).toBeInTheDocument()
    expect(fake.listClusters).toHaveBeenCalledTimes(1)
  })

  it("badges stale inventory with its age instead of presenting it as current", async () => {
    renderView(
      client(
        {
          state: DataState.STALE,
          observedAtUnixMs: BigInt(Date.now() - 120_000),
        },
        [
          {
            identity: { namespace: "clusters", name: "prod-eu-1" },
            displayName: "prod-eu-1",
            mode: ClusterMode.AGENT,
            phase: ClusterPhase.HEALTHY,
            connection: FleetConnectionState.HEALTHY,
            kubernetesVersion: "",
            applicationCount: BigInt(2),
            targetCount: BigInt(2),
          },
        ],
      ),
    )

    expect(await screen.findByText("stale · 2m old")).toBeInTheDocument()
    // An unreported version is empty on the wire, which is unambiguous; the
    // console says so rather than printing a fabricated one.
    expect(await screen.findByText("not reported")).toBeInTheDocument()
  })

  it("hides the board without comment when the caller may not see it", async () => {
    renderView(client({ state: DataState.FORBIDDEN }))

    await screen.findByRole("table", { name: "Clusters in the fleet index" })
    expect(screen.queryByText(/Cluster inventory/)).not.toBeInTheDocument()
  })
})

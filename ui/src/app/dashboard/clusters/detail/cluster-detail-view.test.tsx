import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ClusterDetailClient } from "@/app/dashboard/clusters/detail/cluster-detail-view"
import {
  ClusterMode,
  ClusterPhase,
  DataState,
  FleetConnectionState,
  ResourceUnit,
} from "@/gen/paprika/v1/api_pb"

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }))

vi.mock("next/navigation", () => ({
  useSearchParams: () => navigation.params,
}))

import { ClusterDetailView } from "@/app/dashboard/clusters/detail/cluster-detail-view"

function client(cluster: unknown) {
  return {
    getCluster: vi.fn().mockResolvedValue({ cluster }),
  }
}

function renderView(fake: ReturnType<typeof client>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <ClusterDetailView client={fake as unknown as ClusterDetailClient} />
    </QueryClientProvider>,
  )
}

function registration(overrides: Record<string, unknown> = {}) {
  return {
    identity: { namespace: "paprika-system", name: "edge-eu" },
    displayName: "Edge Europe",
    mode: ClusterMode.AGENT,
    phase: ClusterPhase.HEALTHY,
    connection: FleetConnectionState.HEALTHY,
    kubernetesVersion: "v1.31.4",
    managementPolicies: ["Observe", "Apply"],
    inventory: { state: DataState.NOT_CONFIGURED, unavailableReason: "" },
    ...overrides,
  }
}

describe("ClusterDetailView", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    navigation.params = new URLSearchParams("namespace=paprika-system&name=edge-eu")
  })

  it("asks for the cluster the URL names", async () => {
    const fake = client(registration())
    renderView(fake)

    expect(await screen.findByText("Edge Europe")).toBeInTheDocument()
    expect(fake.getCluster).toHaveBeenCalledTimes(1)
  })

  it("renders the management ceiling and says a stage may only narrow it", async () => {
    renderView(client(registration()))

    expect(await screen.findByText("Management policies")).toBeInTheDocument()
    expect(screen.getByText("2 granted")).toBeInTheDocument()
    expect(screen.getByText("Observe")).toBeInTheDocument()
    expect(
      screen.getByText("A stage may request less than this set and never more."),
    ).toBeInTheDocument()
  })

  it("states plainly that a policy-free cluster is untouched", async () => {
    renderView(client(registration({ managementPolicies: [] })))

    expect(
      await screen.findByText(/This registration grants nothing/),
    ).toBeInTheDocument()
  })

  it("shows satellite state without inventing what was not reported", async () => {
    renderView(
      client(
        registration({
          satellite: {
            autonomy: "Failover",
            operatingState: "",
            lastSeenUnixMs: BigInt(Date.now() - 30_000),
          },
        }),
      ),
    )

    expect(await screen.findByText("Satellite")).toBeInTheDocument()
    const autonomy = screen.getByText("Autonomy").closest("dl")
    expect(autonomy).not.toBeNull()
    expect(within(autonomy as HTMLElement).getByText("Failover")).toBeInTheDocument()
    expect(screen.getByText("not reported")).toBeInTheDocument()
    expect(screen.getByText("30s ago")).toBeInTheDocument()
  })

  it("explains why inventory is absent instead of rendering zeros", async () => {
    renderView(
      client(
        registration({
          inventory: {
            state: DataState.NOT_CONFIGURED,
            unavailableReason: "no inventory collector is configured",
          },
        }),
      ),
    )

    expect(
      await screen.findByText("no inventory collector is configured"),
    ).toBeInTheDocument()
    expect(screen.queryByText("Nodes")).not.toBeInTheDocument()
  })

  it("renders inventory counts when the class carries data", async () => {
    renderView(
      client(
        registration({
          inventory: {
            state: DataState.OK,
            nodeCount: 3,
            readyNodeCount: 3,
            podCount: 40,
            runningPodCount: 38,
            namespaceCount: 9,
            regions: ["eu-west"],
            zones: ["eu-west-a"],
            kubeletVersions: ["v1.31.4"],
          },
        }),
      ),
    )

    expect(await screen.findByText("3 ready of 3")).toBeInTheDocument()
    expect(screen.getByText("38 running of 40")).toBeInTheDocument()
    expect(screen.getByText("eu-west")).toBeInTheDocument()
  })

  it("renders capacity meters the satellite measured", async () => {
    renderView(
      client(
        registration({
          capacity: {
            usageProvider: "satellite",
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
              requestedState: DataState.OK,
              requested: 1,
              allocatableState: DataState.OK,
              allocatable: 8,
              unavailableReason: "no metrics API",
            },
          },
        }),
      ),
    )

    expect(await screen.findByText("Capacity")).toBeInTheDocument()
    expect(screen.getByText("satellite")).toBeInTheDocument()
    expect(screen.getByText("CPU")).toBeInTheDocument()
    expect(screen.getByText("MEMORY")).toBeInTheDocument()
  })

  it("renders node pools from the provider projection", async () => {
    renderView(
      client(
        registration({
          provider: {
            type: "vultr",
            state: DataState.NOT_CONFIGURED,
            nodePools: [
              {
                name: "general",
                nodeCount: 3,
                machineType: "vc2-2c-4gb",
                minNodes: 1,
                maxNodes: 5,
                autoScaled: true,
              },
            ],
          },
        }),
      ),
    )

    expect(await screen.findByText("vultr node pools")).toBeInTheDocument()
    const table = screen.getByRole("table", { name: "Node pools" })
    const row = within(table).getByRole("row", { name: /general/ })
    expect(within(row).getByText("vc2-2c-4gb")).toBeInTheDocument()
    expect(within(row).getByText("1–5")).toBeInTheDocument()
  })

  it("asks for a cluster rather than guessing when the URL is incomplete", async () => {
    navigation.params = new URLSearchParams("namespace=paprika-system")
    const fake = client(registration())
    renderView(fake)

    expect(await screen.findByText("No cluster named")).toBeInTheDocument()
    expect(fake.getCluster).not.toHaveBeenCalled()
  })
})

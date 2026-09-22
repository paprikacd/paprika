import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { FleetHealthStatus, FleetMatrixResult } from "@/lib/fleet-client"
import type { FleetDataStatus } from "@/lib/use-fleet-data"

const navigation = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replace: vi.fn(),
}))

const fleet = vi.hoisted(() => ({
  useFleetData: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("next/navigation", () => ({
  useSearchParams: () => navigation.params,
  useRouter: () => ({ replace: navigation.replace }),
  usePathname: () => "/dashboard/map/",
}))

vi.mock("@/lib/connection-context", () => ({
  useConnection: () => ({ reportRequestOutcome: vi.fn() }),
}))

vi.mock("@/lib/use-fleet-data", () => ({
  useFleetData: fleet.useFleetData,
}))

import { FleetMapView } from "@/app/dashboard/map/fleet-map-view"

function bucket(health: FleetHealthStatus, count: number) {
  return { health, count: BigInt(count) }
}

function matrix(): FleetMatrixResult {
  return {
    rows: [
      { stableId: "stage:prod", label: "prod", value: "prod" },
      { stableId: "stage:dev", label: "dev", value: "dev" },
    ],
    columns: [
      {
        stableId: "cluster:prod-eu-1",
        label: "prod-eu-1",
        object: { namespace: "clusters", name: "prod-eu-1" },
      },
    ],
    cells: [
      {
        rowId: "stage:prod",
        columnId: "cluster:prod-eu-1",
        applicationCount: BigInt(5),
        targetCount: BigInt(5),
        health: [bucket("degraded", 1), bucket("healthy", 4)],
        resourceWeight: BigInt(0),
        requestRateWeight: 0,
        usedResourceFallback: false,
      },
    ],
    total: BigInt(5),
    indexGeneration: BigInt(4412),
    facets: [],
  }
}

function mockFleet(
  overrides: {
    status?: FleetDataStatus
    result?: FleetMatrixResult | undefined
  } = {},
) {
  const status = overrides.status ?? "ready"
  const result = "result" in overrides ? overrides.result : matrix()
  const data = result ? { kind: "matrix", view: "matrix", result } : undefined
  fleet.useFleetData.mockReturnValue({
    status,
    currentData: data,
    staleData: undefined,
    displayData: data,
    applicationFacets: [],
    isLoading: status === "loading",
    isStale: status === "stale",
    refresh: fleet.refresh,
  })
}

describe("FleetMapView", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    navigation.params = new URLSearchParams()
    mockFleet()
  })

  it("renders the fleet matrix as a grid of stages by cluster", () => {
    render(<FleetMapView />)

    expect(
      screen.getByRole("heading", { level: 1, name: "Cluster & fleet map" }),
    ).toBeInTheDocument()
    const grid = screen.getByRole("table", { name: "Stages by cluster" })
    expect(within(grid).getByText("prod-eu-1")).toBeInTheDocument()
    expect(
      within(grid).getByText("5 targets · 1 unhealthy"),
    ).toBeInTheDocument()
  })

  it("groups rows by stage until asked for projects", async () => {
    const user = userEvent.setup()
    render(<FleetMapView />)

    const rows = screen.getByRole("group", { name: "Group rows by" })
    expect(within(rows).getByRole("button", { name: "Stage" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )

    await user.click(within(rows).getByRole("button", { name: "Project" }))

    expect(navigation.replace).toHaveBeenCalledTimes(1)
    const [href] = navigation.replace.mock.calls[0]
    expect(href).toContain("rows=project")
  })

  it("queries the matrix on the cluster axis whatever the URL asks for", () => {
    navigation.params = new URLSearchParams("view=treemap&columns=stage")
    render(<FleetMapView />)

    const [state] = fleet.useFleetData.mock.calls[0]
    expect(state.view).toBe("matrix")
    expect(state.columns).toBe("cluster")
    expect(state.rows).toBe("stage")
  })

  it("names only the health states actually on the map", () => {
    render(<FleetMapView />)

    const legend = screen.getByRole("list", { name: "Health legend" })
    expect(within(legend).getByText("Degraded")).toBeInTheDocument()
    expect(within(legend).getByText("Healthy")).toBeInTheDocument()
    expect(within(legend).queryByText("Failed")).not.toBeInTheDocument()
  })

  it("reports an unavailable index instead of an empty grid", () => {
    mockFleet({ status: "unavailable", result: undefined })
    render(<FleetMapView />)

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Fleet index unavailable",
    )
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })
})

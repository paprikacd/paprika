import { render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

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

import { RepositoriesView } from "@/app/dashboard/repositories/repositories-view"

function sourceFacet(value: string, label: string, count: number): FleetFacetBucket {
  return { dimension: "source_type", value, label, count: BigInt(count) }
}

function mockFleet(facets: FleetFacetBucket[]) {
  const data = {
    kind: "matrix",
    view: "matrix",
    result: {
      rows: [],
      columns: [],
      cells: [],
      total: BigInt(57),
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

describe("RepositoriesView", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    navigation.params = new URLSearchParams()
    mockFleet([
      sourceFacet("git", "git", 41),
      sourceFacet("oci", "oci", 7),
      sourceFacet("s3", "s3", 9),
    ])
  })

  it("reports fleet-wide source-type counts from the index facets", () => {
    render(<RepositoriesView />)

    const table = screen.getByRole("table", {
      name: "Applications by source type",
    })
    const row = within(table).getByRole("row", { name: /Git/ })
    expect(within(row).getByText("41")).toBeInTheDocument()
    expect(
      within(row).getByRole("link", { name: "Git" }),
    ).toHaveAttribute("href", expect.stringContaining("source=git"))
  })

  it("says outright that there is no repository inventory to list", () => {
    render(<RepositoriesView />)

    expect(
      screen.getByRole("heading", { name: "Repository inventory" }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/no repository inventory/i),
    ).toBeInTheDocument()
    // Nothing pretends to be a repository count.
    expect(screen.queryByText("41 repositories")).not.toBeInTheDocument()
  })

  it("leaves a source type the console cannot filter on unlinked", () => {
    mockFleet([sourceFacet("cassette", "cassette", 3)])
    render(<RepositoriesView />)

    expect(screen.getByText("cassette")).toBeInTheDocument()
    expect(
      screen.queryByRole("link", { name: "cassette" }),
    ).not.toBeInTheDocument()
  })

  it("does not invent a breakdown when the index reports no sources", () => {
    mockFleet([])
    render(<RepositoriesView />)

    expect(
      screen.getByText("No application in this scope reports a source type."),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("table", { name: "Applications by source type" }),
    ).not.toBeInTheDocument()
  })
})

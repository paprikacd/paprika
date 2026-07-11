import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { FleetMatrix } from "@/components/fleet/fleet-matrix"
import type { FleetMatrixResult } from "@/lib/fleet-client"

const result: FleetMatrixResult = {
  rows: [
    { stableId: "project:payments", label: "Payments" },
    { stableId: "project:storefront", label: "Storefront" },
  ],
  columns: [
    { stableId: "cluster:production", label: "Production" },
    { stableId: "cluster:staging", label: "Staging" },
  ],
  cells: [
    {
      rowId: "project:payments",
      columnId: "cluster:production",
      applicationCount: BigInt(2),
      targetCount: BigInt(3),
      health: [
        { health: "healthy", count: BigInt(2) },
        { health: "degraded", count: BigInt(1) },
      ],
      resourceWeight: BigInt(41),
      requestRateWeight: 0,
      usedResourceFallback: false,
    },
  ],
  total: BigInt(2),
  indexGeneration: BigInt(17),
  facets: [],
}

describe("FleetMatrix", () => {
  it("renders only populated sparse cells with textual health and both counts", () => {
    render(<FleetMatrix result={result} />)

    const table = screen.getByRole("table", { name: "Fleet matrix" })
    const rows = within(table).getAllByRole("row")
    expect(rows).toHaveLength(2)

    const populated = within(table).getByRole("row", {
      name: /payments production/i,
    })
    expect(within(populated).getByText("2", { selector: "[data-application-count]" })).toBeInTheDocument()
    expect(within(populated).getByText("3", { selector: "[data-target-count]" })).toBeInTheDocument()
    expect(within(populated).getByText("Healthy 2")).toBeInTheDocument()
    expect(within(populated).getByText("Degraded 1")).toBeInTheDocument()
    expect(within(table).queryByText("Storefront")).not.toBeInTheDocument()
    expect(within(table).queryByText("Staging")).not.toBeInTheDocument()
  })

  it("renders a useful empty state without inventing matrix intersections", () => {
    render(
      <FleetMatrix
        result={{ ...result, cells: [], total: BigInt(0), indexGeneration: BigInt(18) }}
      />,
    )

    expect(screen.getByRole("status")).toHaveTextContent("No populated intersections")
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })
})

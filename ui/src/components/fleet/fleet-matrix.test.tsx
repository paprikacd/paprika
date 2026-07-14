import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { FleetMatrix } from "@/components/fleet/fleet-matrix"
import type { FleetMatrixResult } from "@/lib/fleet-client"

const result: FleetMatrixResult = {
  rows: [
    {
      stableId: "project:team-00/payments",
      label: "payments",
      object: { namespace: "team-00", name: "payments" },
    },
    {
      stableId: "project:team-01/commerce",
      label: "commerce",
      object: { namespace: "team-01", name: "commerce" },
    },
  ],
  columns: [
    { stableId: "health:healthy", label: "Healthy", value: "healthy" },
    { stableId: "health:degraded", label: "Degraded", value: "degraded" },
  ],
  cells: [
    {
      rowId: "project:team-00/payments",
      columnId: "health:healthy",
      applicationCount: BigInt(5),
      targetCount: BigInt(5),
      health: [{ health: "healthy", count: BigInt(5) }],
      resourceWeight: BigInt(41),
      requestRateWeight: 0,
      usedResourceFallback: false,
    },
    {
      rowId: "project:team-01/commerce",
      columnId: "health:degraded",
      applicationCount: BigInt(5),
      targetCount: BigInt(5),
      health: [{ health: "degraded", count: BigInt(5) }],
      resourceWeight: BigInt(31),
      requestRateWeight: 0,
      usedResourceFallback: false,
    },
  ],
  total: BigInt(10),
  indexGeneration: BigInt(17),
  facets: [],
}

describe("FleetMatrix", () => {
  it("keeps each populated sparse cell in one semantic row with complete operational facts", () => {
    render(<FleetMatrix result={result} />)

    const scroll = screen.getByTestId("fleet-matrix-scroll")
    const table = screen.getByRole("table", { name: "Fleet matrix" })
    expect(within(scroll).getAllByRole("table", { name: "Fleet matrix" })).toHaveLength(1)
    expect(screen.queryByRole("list", { name: /fleet matrix/i })).not.toBeInTheDocument()

    const rows = within(table).getAllByRole("row")
    expect(rows).toHaveLength(3)

    const fixtures = [
      {
        identity: "team-00/payments",
        rowLabel: "payments",
        columnIdentity: "healthy",
        columnLabel: "Healthy",
        health: "Healthy 5",
      },
      {
        identity: "team-01/commerce",
        rowLabel: "commerce",
        columnIdentity: "degraded",
        columnLabel: "Degraded",
        health: "Degraded 5",
      },
    ] as const

    for (const fixture of fixtures) {
      const populated = within(table).getByRole("row", { name: new RegExp(fixture.identity) })
      expect(within(populated).getByText(fixture.identity, { exact: true })).toBeInTheDocument()
      expect(within(populated).getByText(fixture.rowLabel, { exact: true })).toBeInTheDocument()
      expect(within(populated).getByText(fixture.columnIdentity, { exact: true })).toBeInTheDocument()
      expect(within(populated).getByText(fixture.columnLabel, { exact: true })).toBeInTheDocument()
      expect(within(populated).getByText("5", { selector: "[data-application-count]" })).toBeInTheDocument()
      expect(within(populated).getByText("5", { selector: "[data-target-count]" })).toBeInTheDocument()
      expect(within(populated).getByText(fixture.health, { exact: true })).toBeInTheDocument()
    }
  })

  it("reflows the existing table rows below xl and restores the five desktop columns", () => {
    render(<FleetMatrix result={result} />)

    const scroll = screen.getByTestId("fleet-matrix-scroll")
    const table = screen.getByRole("table", { name: "Fleet matrix" })
    const headers = within(table).getAllByRole("columnheader")
    const populated = within(table).getByRole("row", { name: /team-00\/payments/i })

    expect(headers.map((header) => header.textContent)).toEqual([
      "Row",
      "Column",
      "Applications",
      "Targets",
      "Health",
    ])
    expect(scroll).toHaveClass("overflow-x-hidden", "xl:overflow-x-auto")
    expect(table).not.toHaveClass("min-w-[48rem]")
    expect(table).toHaveClass("block", "xl:table")
    expect(populated).toHaveClass("grid", "xl:table-row")
    expect(within(populated).getAllByRole("cell")).toHaveLength(4)
  })

  it("orders populated intersections by the selected field and direction", () => {
    const { rerender } = render(
      <FleetMatrix result={result} sort="resource_count" direction="asc" />,
    )

    const populatedRows = () => screen.getAllByRole("row").slice(1)
    expect(populatedRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("commerce"),
      expect.stringContaining("payments"),
    ])

    rerender(<FleetMatrix result={result} sort="resource_count" direction="desc" />)
    expect(populatedRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("payments"),
      expect.stringContaining("commerce"),
    ])
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

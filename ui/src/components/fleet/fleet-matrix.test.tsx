import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { FleetMatrix } from "@/components/fleet/fleet-matrix"
import type {
  FleetHealthStatus,
  FleetMatrixCell,
  FleetMatrixResult,
} from "@/lib/fleet-client"

function bucket(health: FleetHealthStatus, count: number) {
  return { health, count: BigInt(count) }
}

function cell(
  rowId: string,
  columnId: string,
  health: ReturnType<typeof bucket>[],
  applications?: number,
): FleetMatrixCell {
  const targets = health.reduce((sum, entry) => sum + Number(entry.count), 0)
  return {
    rowId,
    columnId,
    applicationCount: BigInt(applications ?? targets),
    targetCount: BigInt(targets),
    health,
    resourceWeight: BigInt(0),
    requestRateWeight: 0,
    usedResourceFallback: false,
  }
}

const result: FleetMatrixResult = {
  rows: [
    { stableId: "stage:prod", label: "prod", value: "prod" },
    { stableId: "stage:staging", label: "staging", value: "staging" },
  ],
  columns: [
    {
      stableId: "cluster:prod-eu-1",
      label: "prod-eu-1",
      object: { namespace: "clusters", name: "prod-eu-1" },
    },
    {
      stableId: "cluster:staging-1",
      label: "staging-1",
      object: { namespace: "clusters", name: "staging-1" },
    },
  ],
  cells: [
    cell("stage:prod", "cluster:prod-eu-1", [
      bucket("degraded", 1),
      bucket("healthy", 4),
    ]),
    cell("stage:staging", "cluster:staging-1", [bucket("progressing", 2)]),
  ],
  total: BigInt(7),
  indexGeneration: BigInt(4412),
  facets: [],
}

describe("FleetMatrix", () => {
  it("names each intersection with the counts the server sent", () => {
    render(<FleetMatrix result={result} />)

    const grid = screen.getByRole("table", { name: "Fleet matrix" })
    const rows = within(grid).getAllByRole("row")
    expect(
      within(rows[1]).getByText("5 targets · 1 unhealthy"),
    ).toBeInTheDocument()
    // Axis totals are stated in targets, which are the only counts that can
    // be added up across cells without double counting an application.
    expect(within(rows[0]).getByText("5 targets")).toBeInTheDocument()
    expect(within(rows[1]).getByText("5 targets", { selector: "th span" })).toBeInTheDocument()
  })

  it("draws one square per target while the whole mix fits", () => {
    const { container } = render(<FleetMatrix result={result} />)

    expect(container.querySelectorAll('[data-slot="matrix-square"]')).toHaveLength(
      7,
    )
    expect(
      container.querySelectorAll('[data-tone="degraded"]'),
    ).toHaveLength(1)
  })

  it("reports exact per-state counts instead of a node per application at fleet scale", () => {
    const { container } = render(
      <FleetMatrix
        result={{
          ...result,
          cells: [
            cell("stage:prod", "cluster:prod-eu-1", [
              bucket("failed", 12),
              bucket("degraded", 84),
              bucket("healthy", 9_904),
            ]),
          ],
          total: BigInt(10_000),
        }}
      />,
    )

    const squares = container.querySelectorAll('[data-slot="matrix-square"]')
    expect(squares.length).toBeLessThanOrEqual(8)
    expect(container.querySelectorAll("*").length).toBeLessThan(200)
    expect(screen.getByText("9,904")).toBeInTheDocument()
    expect(
      screen.getByText("10,000 targets · 96 unhealthy"),
    ).toBeInTheDocument()
  })

  it("reads the health mix as text where there is no link to name it", () => {
    render(<FleetMatrix result={result} />)

    expect(screen.getByText("Degraded 1, Healthy 4")).toBeInTheDocument()
  })

  it("says an intersection is empty rather than drawing a zero", () => {
    render(<FleetMatrix result={result} />)

    expect(screen.getAllByText("no targets")).toHaveLength(2)
    expect(screen.queryByText("0")).not.toBeInTheDocument()
  })

  it("links a populated cell to the applications behind it", () => {
    render(
      <FleetMatrix
        result={result}
        cellHref={(row, column) =>
          `/dashboard/applications/?row=${row.value ?? ""}&column=${column.object?.name ?? ""}`
        }
      />,
    )

    const link = screen.getByRole("link", {
      name: /prod · prod-eu-1 — 5 targets · 1 unhealthy\. Degraded 1, Healthy 4/,
    })
    // next/link normalises the trailing slash away in the DOM;
    // `trailingSlash: true` restores it in the export.
    expect(link.getAttribute("href")).toMatch(
      /^\/dashboard\/applications\/?\?row=prod&column=prod-eu-1$/,
    )
  })

  it("caps the grid and says how much it is holding back", () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({
      stableId: `stage:s${index}`,
      label: `stage-${index}`,
      value: `s${index}`,
    }))
    render(
      <FleetMatrix
        result={{
          ...result,
          rows,
          cells: rows.map((row) =>
            cell(row.stableId, "cluster:prod-eu-1", [bucket("healthy", 1)]),
          ),
        }}
        maxRows={5}
      />,
    )

    expect(
      screen.getByRole("table", { name: "Fleet matrix" }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole("row")).toHaveLength(6)
    expect(
      screen.getByText(/Showing 5 of 30 rows and 1 of 1 columns/),
    ).toBeInTheDocument()
  })

  it("keeps an unpopulated matrix honest", () => {
    render(
      <FleetMatrix
        result={{ ...result, cells: [], total: BigInt(0) }}
      />,
    )

    expect(screen.getByRole("status")).toHaveTextContent(
      "No populated intersections",
    )
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })
})

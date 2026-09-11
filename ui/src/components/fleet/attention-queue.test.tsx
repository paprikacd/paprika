import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { AttentionQueue } from "@/components/fleet/attention-queue"
import type { FleetApplicationSummary } from "@/lib/fleet-client"
import { createFleetFocusCoordinator } from "@/lib/fleet-focus"

function application(
  name: string,
  overrides: Partial<FleetApplicationSummary> = {},
): FleetApplicationSummary {
  return {
    identity: { namespace: "data", name },
    project: { namespace: "tenant", name: "analytics" },
    targets: [],
    currentStage: "staging",
    currentClusterLabel: "prod-us-1",
    sourceType: "git",
    sourceRevision: "f8a31b2",
    health: "healthy",
    sync: "synced",
    driftCount: 0,
    missingResourceCount: 0,
    releaseState: "complete",
    rolloutState: "healthy",
    resourceCount: 6,
    repositoryConnection: "healthy",
    observabilityConnection: "healthy",
    blockedGateCount: 0,
    lastTransitionUnixMs: BigInt(1_725_000_000_000),
    capabilities: [],
    ...overrides,
  }
}

function renderQueue(
  applications: FleetApplicationSummary[],
  total = BigInt(applications.length),
  onSelectApplication = vi.fn(),
) {
  render(
    <AttentionQueue
      applications={applications}
      total={total}
      sources={undefined}
      onSelectApplication={onSelectApplication}
      onFocusedApplication={vi.fn()}
      focusCoordinator={createFleetFocusCoordinator({ announce: vi.fn() })}
      getResultsHeadingTarget={() => null}
    />,
  )
  return { onSelectApplication }
}

describe("AttentionQueue", () => {
  it("keeps the server's impact order and ranks against it", () => {
    renderQueue([
      application("reporting-etl", { health: "missing", sync: "out_of_sync" }),
      application("checkout-api", { health: "degraded", sync: "out_of_sync" }),
      application("ledger-worker", { health: "progressing" }),
    ])

    const rows = screen
      .getAllByRole("row")
      .filter((row) => row.getAttribute("aria-rowindex") !== "1")
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "data/reporting-etl",
      "data/checkout-api",
      "data/ledger-worker",
    ])
    expect(within(rows[0]).getByText("01")).toBeInTheDocument()
    expect(within(rows[2]).getByText("03")).toBeInTheDocument()
  })

  it("explains each entry from fields the index actually returns", () => {
    renderQueue([
      application("reporting-etl", { health: "missing", sync: "out_of_sync" }),
      application("checkout-api", { health: "degraded", sync: "out_of_sync" }),
      application("ledger-worker", { health: "progressing" }),
      application("gate-held", { blockedGateCount: 2, health: "unknown" }),
    ])

    expect(screen.getByText("source unreachable")).toBeInTheDocument()
    expect(screen.getByText("degraded · drifted")).toBeInTheDocument()
    expect(screen.getByText("rollout in progress")).toBeInTheDocument()
    expect(screen.getByText("gate blocked")).toBeInTheDocument()
  })

  it("counts applications in the pagination contract, not loaded rows", () => {
    renderQueue([application("reporting-etl", { health: "failed" })], BigInt(200))

    expect(screen.getByRole("table", { name: "Attention queue" })).toHaveAttribute(
      "aria-rowcount",
      "201",
    )
  })

  it("opens an application from the keyboard as well as the pointer", () => {
    const { onSelectApplication } = renderQueue([
      application("reporting-etl", { health: "failed" }),
    ])

    const row = screen.getByRole("row", { name: "data/reporting-etl" })
    expect(row).toHaveAttribute("tabindex", "0")
    fireEvent.keyDown(row, { key: "Enter" })

    expect(onSelectApplication).toHaveBeenCalledWith({
      namespace: "data",
      name: "reporting-etl",
    })
  })

  it("states health in words, not only in the accent colour", () => {
    renderQueue([application("reporting-etl", { health: "missing" })])

    expect(screen.getByRole("img", { name: "Missing" })).toBeInTheDocument()
  })
})

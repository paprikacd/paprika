import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import {
  ApplicationSummary,
  FleetHealth,
  FleetSyncState,
} from "@/gen/paprika/v1/api_pb"

import { MAX_HEAT_TILES, PostureHeatmap, buildHeatRows } from "./posture-heatmap"

function fleet(size: number, targetsPerApp = 1): ApplicationSummary[] {
  return Array.from(
    { length: size },
    (_value, index) =>
      new ApplicationSummary({
        identity: { namespace: "payments", name: `app-${index}` },
        project: { namespace: "payments", name: index % 2 ? "core" : "risk" },
        health: index % 5 === 0 ? FleetHealth.DEGRADED : FleetHealth.HEALTHY,
        sync: FleetSyncState.SYNCED,
        resourceCount: 4,
        currentStage: "prod",
        currentClusterLabel: "prod-eu-1",
        targets: Array.from({ length: targetsPerApp }, (_entry, target) => ({
          stableId: `t-${index}-${target}`,
          stage: target === 0 ? "prod" : "staging",
          clusterLabel: target === 0 ? "prod-eu-1" : "staging-1",
          health: FleetHealth.HEALTHY,
        })),
      })
  )
}

describe("buildHeatRows", () => {
  it("never draws more than the tile cap, whatever the fleet size", () => {
    const { rows, shown, truncated } = buildHeatRows(fleet(500, 3), "project")
    const tiles = rows.reduce((count, row) => count + row.tiles.length, 0)
    expect(tiles).toBe(MAX_HEAT_TILES)
    expect(shown).toBe(MAX_HEAT_TILES)
    expect(truncated).toBe(true)
  })

  it("groups by the requested dimension", () => {
    const { rows } = buildHeatRows(fleet(4), "project")
    expect(rows.map((row) => row.label).sort()).toEqual([
      "payments/core",
      "payments/risk",
    ])
  })

  it("groups every target under one row when ungrouped", () => {
    const { rows } = buildHeatRows(fleet(4, 2), "none")
    expect(rows).toHaveLength(1)
    expect(rows[0].tiles).toHaveLength(8)
  })

  it("counts unhealthy targets per group", () => {
    const applications = [
      new ApplicationSummary({
        identity: { namespace: "data", name: "reporting-etl" },
        project: { namespace: "data", name: "analytics" },
        health: FleetHealth.MISSING,
        targets: [{ stableId: "a", stage: "prod", clusterLabel: "prod-us-1" }],
      }),
      new ApplicationSummary({
        identity: { namespace: "data", name: "warehouse-sync" },
        project: { namespace: "data", name: "analytics" },
        health: FleetHealth.HEALTHY,
        targets: [{ stableId: "b", stage: "prod", clusterLabel: "prod-us-1" }],
      }),
    ]
    const { rows } = buildHeatRows(applications, "project")
    expect(rows[0].unhealthy).toBe(1)
    expect(rows[0].worst).toBe("missing")
  })
})

describe("PostureHeatmap", () => {
  it("keeps the DOM bounded and says what the reader is looking at", () => {
    const { container } = render(
      <PostureHeatmap
        applications={fleet(10_000)}
        rankedTotal={BigInt(10_000)}
        group="project"
        detail="full"
        onGroupChange={() => {}}
        onDetailChange={() => {}}
      />
    )

    expect(container.querySelectorAll("a").length).toBe(MAX_HEAT_TILES)
    expect(container.querySelectorAll("*").length).toBeLessThan(600)
    expect(
      screen.getByText(/48 targets shown · top 10000 by impact of 10000 indexed/)
    ).toBeDefined()
  })

  it("names every tile fully, so status never depends on colour alone", () => {
    render(
      <PostureHeatmap
        applications={fleet(1)}
        rankedTotal={BigInt(1)}
        group="none"
        detail="compact"
        onGroupChange={() => {}}
        onDetailChange={() => {}}
      />
    )
    expect(
      screen.getByRole("link", {
        name: "app-0 · prod-eu-1 · prod — Healthy, Synced, 4 resources",
      })
    ).toBeDefined()
  })
})

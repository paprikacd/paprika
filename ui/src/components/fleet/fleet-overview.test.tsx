import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { FleetOverview } from "@/components/fleet/fleet-overview"
import type {
  FleetApplicationSummary,
  FleetFacetBucket,
} from "@/lib/fleet-client"

function application(
  namespace: string,
  name: string,
  overrides: Partial<FleetApplicationSummary> = {},
): FleetApplicationSummary {
  return {
    identity: { namespace, name },
    project: { namespace: "platform", name: "retail" },
    targets: [],
    currentStage: "production",
    currentClusterLabel: "production",
    sourceType: "git",
    sourceRevision: "abc123",
    health: "healthy",
    sync: "synced",
    driftCount: 0,
    missingResourceCount: 0,
    releaseState: "complete",
    rolloutState: "healthy",
    resourceCount: 10,
    repositoryConnection: "healthy",
    observabilityConnection: "healthy",
    blockedGateCount: 0,
    lastTransitionUnixMs: BigInt(1_720_000_000_000),
    capabilities: [],
    ...overrides,
  }
}

function valueFacet(
  dimension: FleetFacetBucket["dimension"],
  value: string,
  count: number,
): FleetFacetBucket {
  return {
    dimension,
    value,
    label: value.replaceAll("_", " "),
    count: BigInt(count),
  }
}

const facets: FleetFacetBucket[] = [
  valueFacet("health", "healthy", 7),
  valueFacet("health", "progressing", 3),
  valueFacet("health", "degraded", 2),
  valueFacet("health", "failed", 1),
  valueFacet("release", "promoting", 2),
  valueFacet("release", "verifying", 1),
  valueFacet("release", "awaiting_approval", 1),
  valueFacet("release", "complete", 9),
  valueFacet("rollout", "progressing", 2),
  valueFacet("rollout", "paused", 1),
  valueFacet("rollout", "healthy", 10),
]

describe("FleetOverview", () => {
  it("shows aggregate health, active change, gates, and connection failures", () => {
    const applications = [
      application("apps", "checkout", {
        health: "failed",
        sync: "out_of_sync",
        blockedGateCount: 3,
        releaseState: "awaiting_approval",
        repositoryConnection: "unhealthy",
        observabilityConnection: "not_configured",
        targets: [
          {
            stableId: "checkout-production",
            stage: "production",
            ring: 0,
            clusterLabel: "production",
            health: "failed",
            clusterConnection: "unhealthy",
            unmanagedInlineCluster: false,
          },
        ],
      }),
      application("apps", "catalog", {
        health: "degraded",
        observabilityConnection: "unhealthy",
      }),
    ]

    render(
      <FleetOverview applications={applications} facets={facets} total={BigInt(13)} />,
    )

    const posture = screen.getByRole("region", { name: "Fleet health posture" })
    expect(posture).toHaveTextContent("13 applications")
    expect(posture).toHaveTextContent("Healthy7")
    expect(posture).toHaveTextContent("Progressing3")
    expect(posture).toHaveTextContent("Degraded2")
    expect(posture).toHaveTextContent("Failed1")

    const changes = screen.getByRole("region", { name: "Active delivery changes" })
    expect(within(changes).getByRole("heading", { name: "Active delivery changes", level: 3 })).toBeInTheDocument()
    expect(within(changes).getByLabelText("Active releases")).toHaveTextContent("4")
    expect(within(changes).getByLabelText("Active rollouts")).toHaveTextContent("3")
    expect(within(changes).getByLabelText("Blocked gates")).toHaveTextContent("3")

    const connections = screen.getByRole("region", { name: "Connection failures" })
    expect(within(connections).getByLabelText("Repository failures")).toHaveTextContent("1")
    expect(within(connections).getByLabelText("Cluster failures")).toHaveTextContent("1")
    expect(within(connections).getByLabelText("Observability failures")).toHaveTextContent("1")
    expect(connections).toHaveTextContent("2 highest-impact applications loaded")
    expect(changes).toHaveTextContent("2 highest-impact applications loaded")
  })

  it("keeps not-configured observability out of failures and preserves server impact order", () => {
    const applications = [
      application("apps", "checkout", {
        health: "failed",
        observabilityConnection: "not_configured",
      }),
      application("apps", "catalog", {
        health: "degraded",
        observabilityConnection: "not_configured",
      }),
      application("apps", "healthy-service", {
        observabilityConnection: "not_configured",
      }),
    ]

    render(
      <FleetOverview applications={applications} facets={[]} total={BigInt(3)} />,
    )

    expect(screen.getByLabelText("Observability failures")).toHaveTextContent("0")
    const attention = screen.getByRole("region", { name: "Highest impact attention" })
    const links = within(within(attention).getByRole("list")).getAllByRole("link")
    expect(links.map((link) => link.textContent)).toEqual([
      expect.stringContaining("checkout"),
      expect.stringContaining("catalog"),
    ])
    expect(links[0]).toHaveAttribute(
      "href",
      "/dashboard/application?namespace=apps&name=checkout",
    )
    expect(within(attention).queryByText("healthy-service")).not.toBeInTheDocument()
  })

  it("keeps failed and paused delivery changes in the attention queue even when health is green", () => {
    render(
      <FleetOverview
        applications={[
          application("apps", "failed-release", { releaseState: "failed" }),
          application("apps", "paused-rollout", { rolloutState: "paused" }),
        ]}
        total={BigInt(2)}
      />,
    )

    const attention = screen.getByRole("region", { name: "Highest impact attention" })
    expect(within(attention).getByText("failed-release")).toBeInTheDocument()
    expect(within(attention).getByText("paused-rollout")).toBeInTheDocument()
  })

  it("folds unspecified health into Unknown so posture totals remain reconcilable", () => {
    render(
      <FleetOverview
        applications={[application("apps", "checkout", { health: "unspecified" })]}
        total={BigInt(1)}
      />,
    )

    const posture = screen.getByRole("region", { name: "Fleet health posture" })
    expect(posture).toHaveTextContent("Unknown1")
  })

  it("scopes self-excluding facet aggregates to active state filters", () => {
    render(
      <FleetOverview
        applications={[]}
        facets={facets}
        total={BigInt(2)}
        selectedHealth={["degraded"]}
        selectedRelease={["complete"]}
        selectedRollout={["paused"]}
      />,
    )

    const posture = screen.getByRole("region", { name: "Fleet health posture" })
    expect(posture).toHaveTextContent("Healthy0")
    expect(posture).toHaveTextContent("Degraded2")
    expect(screen.getByLabelText("Active releases")).toHaveTextContent("0")
    expect(screen.getByLabelText("Active rollouts")).toHaveTextContent("1")
  })
})

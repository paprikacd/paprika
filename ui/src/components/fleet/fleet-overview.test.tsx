import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { FleetOverview } from "@/components/fleet/fleet-overview"
import type {
  FleetApplicationSummary,
  FleetFacetBucket,
  FleetMapResult,
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
      <FleetOverview
        result={mapResult(13, facets)}
        attentionApplications={applications}
      />,
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
    expect(connections).toHaveTextContent("2 impact-ranked applications loaded")
    expect(changes).toHaveTextContent(
      "Release and rollout counts use complete-map facets when available; blocked gates use the 2-application impact window.",
    )
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
      <FleetOverview
        result={mapResult(3)}
        attentionApplications={applications}
        query="namespace=platform&view=queue&unknown=kept"
      />,
    )

    expect(screen.getByLabelText("Observability failures")).toHaveTextContent("0")
    const attention = screen.getByRole("region", { name: "Highest impact attention" })
    const links = within(within(attention).getByRole("list")).getAllByRole("link")
    expect(links.map((link) => link.textContent)).toEqual([
      expect.stringContaining("checkout"),
      expect.stringContaining("catalog"),
    ])
    const detail = new URL(links[0].getAttribute("href")!, "https://paprika.test")
    expect(detail.searchParams.get("namespace")).toBe("platform")
    expect(detail.searchParams.get("view")).toBe("queue")
    expect(detail.searchParams.get("unknown")).toBe("kept")
    expect(detail.searchParams.get("application_namespace")).toBe("apps")
    expect(detail.searchParams.get("application_name")).toBe("checkout")
    expect(within(attention).queryByText("healthy-service")).not.toBeInTheDocument()
  })

  it("keeps failed and paused delivery changes in the attention queue even when health is green", () => {
    render(
      <FleetOverview
        result={mapResult(2)}
        attentionApplications={[
          application("apps", "failed-release", { releaseState: "failed" }),
          application("apps", "paused-rollout", { rolloutState: "paused" }),
        ]}
      />,
    )

    const attention = screen.getByRole("region", { name: "Highest impact attention" })
    expect(within(attention).getByText("failed-release")).toBeInTheDocument()
    expect(within(attention).getByText("paused-rollout")).toBeInTheDocument()
  })

  it("folds unspecified health into Unknown so posture totals remain reconcilable", () => {
    render(
      <FleetOverview
        result={mapResult(1, [valueFacet("health", "unspecified", 1)])}
        attentionApplications={[application("apps", "checkout", { health: "unspecified" })]}
      />,
    )

    const posture = screen.getByRole("region", { name: "Fleet health posture" })
    expect(posture).toHaveTextContent("Unknown1")
  })

  it("never substitutes bounded attention health for incomplete complete-map posture", () => {
    render(
      <FleetOverview
        result={mapResult(3)}
        attentionApplications={[application("apps", "checkout", { health: "failed" })]}
      />,
    )

    const posture = screen.getByRole("region", { name: "Fleet health posture" })
    expect(posture).toHaveTextContent("Failed0")
    expect(posture).toHaveTextContent("Unknown3")
  })

  it("scopes self-excluding facet aggregates to active state filters", () => {
    render(
      <FleetOverview
        result={mapResult(2, facets)}
        attentionApplications={[]}
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

  it("keeps complete map posture separate from the impact-ranked attention window", () => {
    const attentionApplications = [
      application("apps", "highest-impact", {
        health: "failed",
        blockedGateCount: 4,
        repositoryConnection: "unhealthy",
      }),
      application("apps", "second-impact", { health: "degraded" }),
    ]
    const completeFacets = [
      valueFacet("health", "healthy", 240),
      valueFacet("health", "failed", 10),
    ]

    render(
      <FleetOverview
        result={mapResult(250, completeFacets)}
        attentionApplications={attentionApplications}
      />,
    )

    const posture = screen.getByRole("region", { name: "Fleet health posture" })
    expect(posture).toHaveTextContent("250 applications")
    expect(posture).toHaveTextContent("Healthy240")
    expect(posture).toHaveTextContent("Failed10")
    expect(screen.getByLabelText("Blocked gates")).toHaveTextContent("4")
    expect(screen.getByLabelText("Repository failures")).toHaveTextContent("1")
    expect(screen.getByRole("region", { name: "Highest impact attention" })).toHaveTextContent(
      "highest-impact",
    )
    expect(screen.getByRole("region", { name: "Active delivery changes" })).toHaveTextContent(
      "Release and rollout counts use complete-map facets when available; blocked gates use the 2-application impact window.",
    )
    expect(screen.queryByText(/2 applications$/i)).not.toBeInTheDocument()
  })

  it("keeps impact attention usable while the complete map is unavailable", () => {
    render(
      <FleetOverview
        attentionApplications={[
          application("apps", "checkout", {
            health: "failed",
            blockedGateCount: 2,
            releaseState: "promoting",
            rolloutState: "paused",
          }),
        ]}
      />,
    )

    expect(screen.queryByRole("region", { name: "Fleet health posture" })).not.toBeInTheDocument()
    expect(screen.getByRole("region", { name: "Highest impact attention" })).toHaveTextContent(
      "checkout",
    )
    expect(screen.getByLabelText("Blocked gates")).toHaveTextContent("2")
    const changes = screen.getByRole("region", { name: "Active delivery changes" })
    expect(within(changes).getByLabelText("Active releases")).toHaveTextContent("1")
    expect(within(changes).getByLabelText("Active rollouts")).toHaveTextContent("1")
    expect(changes).toHaveTextContent(
      "All change counts use the 1-application impact window while complete-map facets are unavailable.",
    )
  })

  it("marks stale impact-window counts unknown instead of presenting the previous scope", () => {
    render(
      <FleetOverview
        result={mapResult(3, [valueFacet("release", "promoting", 2)])}
        attentionApplications={[
          application("old-scope", "checkout", {
            health: "failed",
            blockedGateCount: 4,
            rolloutState: "paused",
            repositoryConnection: "unhealthy",
          }),
        ]}
        attentionStatus="stale"
      />,
    )

    const changes = screen.getByRole("region", { name: "Active delivery changes" })
    expect(within(changes).getByLabelText("Active releases")).toHaveTextContent("2")
    expect(within(changes).getByLabelText("Active rollouts")).toHaveTextContent("—")
    expect(within(changes).getByLabelText("Blocked gates")).toHaveTextContent("—")
    expect(screen.getByLabelText("Repository failures")).toHaveTextContent("—")
    expect(screen.queryByText("checkout")).not.toBeInTheDocument()
    expect(changes).toHaveTextContent(
      "Refreshing impact-ranked application data; window-derived counts are temporarily unavailable.",
    )
    expect(screen.getByRole("region", { name: "Highest impact attention" })).toHaveTextContent(
      "Refreshing impact-ranked application data",
    )
  })

  it("derives each complete leaf from its strongest positive health bucket", () => {
    const leaf = (
      name: string,
      health: FleetMapResult["roots"][number]["health"],
    ): FleetMapResult["roots"][number] => ({
      stableId: `application:apps/${name}`,
      kind: "application",
      label: name,
      application: { namespace: "apps", name },
      applicationCount: BigInt(1),
      targetCount: BigInt(1),
      health,
      resourceWeight: BigInt(1),
      requestRateWeight: 0,
      effectiveWeight: 1,
      usedResourceFallback: false,
      children: [],
    })
    const result = mapResult(2)
    result.roots = [
      leaf("failed", [
        { health: "healthy", count: BigInt(0) },
        { health: "progressing", count: BigInt(1) },
        { health: "failed", count: BigInt(1) },
      ]),
      leaf("unknown", [
        { health: "unknown", count: BigInt(0) },
        { health: "unspecified", count: BigInt(1) },
      ]),
    ]

    render(<FleetOverview result={result} />)

    const posture = screen.getByRole("region", { name: "Fleet health posture" })
    expect(posture).toHaveTextContent("Failed1")
    expect(posture).toHaveTextContent("Progressing0")
    expect(posture).toHaveTextContent("Healthy0")
    expect(posture).toHaveTextContent("Unknown1")
  })
})

function mapResult(
  total: number,
  mapFacets: FleetFacetBucket[] = [],
): FleetMapResult {
  return {
    roots: [],
    total: BigInt(total),
    indexGeneration: BigInt(7),
    facets: mapFacets,
  }
}

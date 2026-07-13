import { describe, expect, it } from "vitest"

import {
  ApplicationSummary,
  FleetCapability,
  FleetFacetBucket,
  FleetFacetDimension,
  FleetGroupDimension,
  FleetHealth,
  FleetMapApplicationMetadata,
  FleetMapNode,
  FleetObjectKey,
  FleetReleaseState,
  FleetRolloutState,
  FleetSizeMetric,
  FleetSortDirection,
  FleetSortField,
  FleetSourceType,
  FleetSyncState,
  QueryApplicationsResponse,
  QueryFleetMapResponse,
  QueryFleetMatrixResponse,
} from "@/gen/paprika/v1/api_pb"
import {
  fromQueryApplicationsResponse,
  fromQueryFleetMapResponse,
  fromQueryFleetMatrixResponse,
  toQueryApplicationsRequest,
  toQueryFleetMapRequest,
  toQueryFleetMatrixRequest,
} from "@/lib/fleet-client"
import { DEFAULT_FLEET_QUERY, type FleetQueryState } from "@/lib/fleet-query"
import {
  createEnterpriseQueryClient,
  getBrowserQueryClient,
} from "@/lib/query-provider"

describe("enterprise query client", () => {
  it("keeps one browser client with bounded retry and cache defaults", () => {
    const first = getBrowserQueryClient()
    const second = getBrowserQueryClient()

    expect(second).toBe(first)

    const defaults = createEnterpriseQueryClient().getDefaultOptions()
    expect(defaults.queries).toMatchObject({
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      retry: 2,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    })
    expect(defaults.mutations).toMatchObject({ retry: false })
  })
})

describe("fleet protobuf boundary", () => {
  const state: FleetQueryState = {
    ...DEFAULT_FLEET_QUERY,
    projects: [{ namespace: "tenant", name: "payments" }],
    clusters: [{ namespace: "platform", name: "production" }],
    namespaces: ["apps"],
    stages: ["production"],
    health: ["degraded"],
    sync: ["out_of_sync"],
    release: ["awaiting_approval"],
    rollout: ["paused"],
    sources: ["oci"],
    q: "checkout",
    sort: "impact",
    direction: "desc",
    group: "cluster",
    rows: "stage",
    columns: "health",
    size: "request_rate",
  }

  it("maps canonical query state into every fleet request explicitly", () => {
    const applications = toQueryApplicationsRequest(state, {
      cursor: "opaque-cursor",
      pageSize: 25,
    })
    expect(applications.filter?.projects[0]).toMatchObject({
      namespace: "tenant",
      name: "payments",
    })
    expect(applications.filter?.clusters[0]).toMatchObject({
      namespace: "platform",
      name: "production",
    })
    expect(applications.filter).toMatchObject({
      namespaces: ["apps"],
      stages: ["production"],
      health: [FleetHealth.DEGRADED],
      sync: [FleetSyncState.OUT_OF_SYNC],
      releaseStates: [FleetReleaseState.AWAITING_APPROVAL],
      rolloutStates: [FleetRolloutState.PAUSED],
      sourceTypes: [FleetSourceType.OCI],
    })
    expect(applications).toMatchObject({
      search: "checkout",
      sort: FleetSortField.IMPACT,
      direction: FleetSortDirection.DESC,
      pageSize: 25,
      cursor: "opaque-cursor",
    })

    expect(toQueryFleetMapRequest(state)).toMatchObject({
      search: "checkout",
      group: FleetGroupDimension.CLUSTER,
      sizeMetric: FleetSizeMetric.REQUEST_RATE,
    })
    expect(toQueryFleetMatrixRequest(state)).toMatchObject({
      search: "checkout",
      rowGroup: FleetGroupDimension.STAGE,
      columnGroup: FleetGroupDimension.HEALTH,
      sizeMetric: FleetSizeMetric.REQUEST_RATE,
    })

    const namespaceState = {
      ...state,
      group: "namespace",
      rows: "namespace",
    } as unknown as FleetQueryState
    expect(toQueryFleetMapRequest(namespaceState).group).toBe(
      FleetGroupDimension.NAMESPACE,
    )
    expect(toQueryFleetMatrixRequest(namespaceState).rowGroup).toBe(
      FleetGroupDimension.NAMESPACE,
    )
  })

  it("maps generated responses to plain internal values without losing bigint counts", () => {
    const response = new QueryApplicationsResponse({
      applications: [
        new ApplicationSummary({
          identity: new FleetObjectKey({ namespace: "apps", name: "checkout" }),
          project: new FleetObjectKey({ namespace: "tenant", name: "payments" }),
          health: FleetHealth.DEGRADED,
          sync: FleetSyncState.OUT_OF_SYNC,
          releaseState: FleetReleaseState.AWAITING_APPROVAL,
          rolloutState: FleetRolloutState.PAUSED,
          sourceType: FleetSourceType.OCI,
          capabilities: [FleetCapability.APPLICATION_SYNC],
        }),
      ],
      facets: [
        new FleetFacetBucket({
          dimension: FleetFacetDimension.HEALTH,
          key: { case: "value", value: "degraded" },
          label: "Degraded",
          count: BigInt(3),
        }),
      ],
      total: BigInt(3),
      indexGeneration: BigInt(9),
      nextCursor: "next",
    })

    const result = fromQueryApplicationsResponse(response)

    expect(result.total).toBe(BigInt(3))
    expect(result.indexGeneration).toBe(BigInt(9))
    expect(result.nextCursor).toBe("next")
    expect(result.applications[0]).toMatchObject({
      identity: { namespace: "apps", name: "checkout" },
      project: { namespace: "tenant", name: "payments" },
      health: "degraded",
      sync: "out_of_sync",
      releaseState: "awaiting_approval",
      rolloutState: "paused",
      sourceType: "oci",
      capabilities: ["application_sync"],
    })
    expect(result.facets[0]).toMatchObject({
      dimension: "health",
      value: "degraded",
      label: "Degraded",
      count: BigInt(3),
    })
  })

  it("carries authorized facets through map and matrix responses", () => {
    const facet = new FleetFacetBucket({
      dimension: FleetFacetDimension.PROJECT,
      key: {
        case: "object",
        value: new FleetObjectKey({ namespace: "tenant", name: "payments" }),
      },
      label: "Payments",
      count: BigInt(4),
    })

    const map = fromQueryFleetMapResponse(
      new QueryFleetMapResponse({ facets: [facet] }),
    )
    const matrix = fromQueryFleetMatrixResponse(
      new QueryFleetMatrixResponse({ facets: [facet] }),
    )

    expect(map.facets).toEqual([
      {
        dimension: "project",
        object: { namespace: "tenant", name: "payments" },
        label: "Payments",
        count: BigInt(4),
      },
    ])
    expect(matrix.facets).toEqual(map.facets)
  })

  it("maps optional compact application metadata without changing legacy nodes", () => {
    const response = new QueryFleetMapResponse({
      roots: [
        new FleetMapNode({
          stableId: "g:namespace:value:apps",
          children: [
            new FleetMapNode({
              stableId: "a:apps/checkout",
              application: new FleetObjectKey({ namespace: "apps", name: "checkout" }),
              applicationMetadata: new FleetMapApplicationMetadata({
                project: new FleetObjectKey({ namespace: "tenant", name: "payments" }),
                currentCluster: new FleetObjectKey({ namespace: "clusters", name: "west" }),
                currentStage: "production",
                sync: FleetSyncState.OUT_OF_SYNC,
                release: FleetReleaseState.VERIFYING,
                rollout: FleetRolloutState.PROGRESSING,
                driftedResources: BigInt(3),
                missingResources: BigInt(2),
                managedResources: BigInt(12),
                lastTransition: {
                  seconds: BigInt(1_752_000_000),
                  nanos: 123_000_000,
                },
                issueSummary: "2 resources missing",
              }),
            }),
            new FleetMapNode({ stableId: "a:apps/legacy" }),
          ],
        }),
      ],
    })

    const result = fromQueryFleetMapResponse(response)
    expect(result.roots[0].children[0].applicationMetadata).toEqual({
      project: { namespace: "tenant", name: "payments" },
      currentCluster: { namespace: "clusters", name: "west" },
      currentStage: "production",
      sync: "out_of_sync",
      release: "verifying",
      rollout: "progressing",
      driftedResources: BigInt(3),
      missingResources: BigInt(2),
      managedResources: BigInt(12),
      lastTransitionUnixMs: BigInt(1_752_000_000_123),
      issueSummary: "2 resources missing",
    })
    expect(result.roots[0].children[1].applicationMetadata).toBeUndefined()
  })
})

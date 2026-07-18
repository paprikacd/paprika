import { describe, expect, it } from "vitest"

import {
  auditExactFleetMapSubset,
  independentStableIdDigest,
  type FleetMapCapture,
  type WireFleetMapNode,
} from "../../e2e/helpers/fleet-map-oracle"

const namespace = "team-00"
const checkout = leaf(
  "checkout-service",
  "payments",
  "delivery-primary",
  "production",
)
const gated = leaf(
  "application-00004",
  "governance",
  "delivery-unhealthy",
  "staging",
)
const baseline = capture([checkout, gated])

describe("exact fleet-map filter subsets", () => {
  it("rejects an unchanged full-map response for a narrowing Project filter", () => {
    const result = auditExactFleetMapSubset(
      baseline,
      capture([checkout, gated]),
      {
        field: "project",
        value: { namespace, name: "payments" },
      },
    )

    expect(result.expectedStableIds).toEqual([`a:${namespace}/checkout-service`])
    expect(result.violations).toEqual([
      "selected response total=2 leaves=2 expected=1",
      "selected response stable identities differ from the baseline-derived subset",
      `selected response digest=${independentStableIdDigest([
        `a:${namespace}/application-00004`,
        `a:${namespace}/checkout-service`,
      ])} expected=${independentStableIdDigest([`a:${namespace}/checkout-service`])}`,
      "selected response leaf a:team-00/application-00004 does not match project team-00/payments",
    ])
  })

  it("accepts only the exact nonempty baseline-derived subset", () => {
    expect(
      auditExactFleetMapSubset(
        baseline,
        capture([checkout]),
        {
          field: "project",
          value: { namespace, name: "payments" },
        },
      ),
    ).toEqual({
      expectedStableIds: [`a:${namespace}/checkout-service`],
      violations: [],
    })
  })
})

function leaf(
  name: string,
  project: string,
  cluster: string,
  stage: string,
): WireFleetMapNode {
  return {
    stableId: `a:${namespace}/${name}`,
    kind: "FLEET_MAP_NODE_KIND_APPLICATION",
    application: { namespace, name },
    applicationMetadata: {
      project: { namespace, name: project },
      currentCluster: { namespace, name: cluster },
      currentStage: stage,
    },
  }
}

function capture(leaves: WireFleetMapNode[]): FleetMapCapture {
  const stableIds = leaves.map((entry) => entry.stableId!)
  return {
    url: "http://127.0.0.1/paprika.v1.PaprikaService/QueryFleetMap",
    request: {},
    response: { roots: leaves, total: String(leaves.length) },
    leaves,
    stableIds,
    total: leaves.length,
    digest: independentStableIdDigest(stableIds),
  }
}

import { describe, expect, it } from "vitest"

import {
  FleetMapApplicationMetadata,
  FleetMapNode,
  FleetMapNodeKind,
  FleetObjectKey,
  Pipeline,
  Release,
  Rollout,
} from "@/gen/paprika/v1/api_pb"
import type { FleetScope } from "@/lib/fleet-scope-context"
import {
  buildRolloutApplicationAssociations,
  flattenMapApplicationAssociations,
  mergeScopedPipelines,
  planPipelineScopeRequests,
  rolloutMatchesFleetScope,
} from "@/lib/fleet-resource-scope"

const emptyScope: FleetScope = {
  projects: [],
  clusters: [],
  stages: [],
  namespaces: [],
}

function applicationLeaf(
  namespace: string,
  name: string,
  metadata: {
    project?: FleetObjectKey
    currentCluster?: FleetObjectKey
    currentStage?: string
  } = {},
) {
  return new FleetMapNode({
    stableId: `application:${namespace}/${name}`,
    kind: FleetMapNodeKind.APPLICATION,
    application: new FleetObjectKey({ namespace, name }),
    applicationMetadata: new FleetMapApplicationMetadata(metadata),
  })
}

describe("planPipelineScopeRequests", () => {
  it("uses one unscoped request when only unsupported Cluster or Stage scope is selected", () => {
    const requests = planPipelineScopeRequests({
      ...emptyScope,
      clusters: [{ namespace: "platform", name: "omega" }],
      stages: ["production"],
    })

    expect(requests.map((request) => request.toJson())).toEqual([{}])
  })

  it("plans one request per canonical project and pins it to the project namespace", () => {
    const requests = planPipelineScopeRequests({
      ...emptyScope,
      projects: [
        { namespace: "tenant-b", name: "delivery" },
        { namespace: "tenant-a", name: "payments" },
        { namespace: "tenant-a", name: "payments" },
      ],
    })

    expect(requests.map((request) => request.toJson())).toEqual([
      { namespace: "tenant-a", project: "payments" },
      { namespace: "tenant-b", project: "delivery" },
    ])
  })

  it("plans namespace-only requests and intersects namespaces with selected projects", () => {
    expect(
      planPipelineScopeRequests({
        ...emptyScope,
        namespaces: ["team-b", "team-a", "team-a"],
      }).map((request) => request.toJson()),
    ).toEqual([{ namespace: "team-a" }, { namespace: "team-b" }])

    expect(
      planPipelineScopeRequests({
        ...emptyScope,
        projects: [
          { namespace: "team-a", name: "payments" },
          { namespace: "team-b", name: "delivery" },
        ],
        namespaces: ["team-b"],
      }).map((request) => request.toJson()),
    ).toEqual([{ namespace: "team-b", project: "delivery" }])

    expect(
      planPipelineScopeRequests({
        ...emptyScope,
        projects: [{ namespace: "team-a", name: "payments" }],
        namespaces: ["team-b"],
      }),
    ).toEqual([])
  })
})

describe("mergeScopedPipelines", () => {
  it("keeps same-named pipelines in different namespaces and de-duplicates exact identities stably", () => {
    const first = new Pipeline({ namespace: "team-a", name: "deploy", project: "payments" })
    const duplicate = new Pipeline({ namespace: "team-a", name: "deploy", project: "payments" })
    const otherNamespace = new Pipeline({ namespace: "team-b", name: "deploy", project: "delivery" })
    const later = new Pipeline({ namespace: "team-a", name: "verify", project: "payments" })

    expect(mergeScopedPipelines([[first, otherNamespace], [duplicate, later]])).toEqual([
      first,
      otherNamespace,
      later,
    ])
  })
})

describe("Rollout Application associations", () => {
  it("flattens every valid Application leaf from the complete nested map with compact metadata", () => {
    const roots = [
      new FleetMapNode({
        stableId: "group:one",
        kind: FleetMapNodeKind.GROUP,
        children: [
          applicationLeaf("apps", "checkout", {
            project: new FleetObjectKey({ namespace: "apps", name: "payments" }),
            currentCluster: new FleetObjectKey({ namespace: "platform", name: "omega" }),
            currentStage: "production",
          }),
          new FleetMapNode({
            stableId: "group:nested",
            kind: FleetMapNodeKind.GROUP,
            children: [applicationLeaf("apps", "catalog")],
          }),
        ],
      }),
      applicationLeaf("platform", "gateway"),
      new FleetMapNode({
        stableId: "application:invalid",
        kind: FleetMapNodeKind.APPLICATION,
      }),
    ]

    const applications = flattenMapApplicationAssociations(roots)

    expect(applications).toHaveLength(3)
    expect(applications[0]).toEqual({
      identity: { namespace: "apps", name: "checkout" },
      project: { namespace: "apps", name: "payments" },
      currentCluster: { namespace: "platform", name: "omega" },
      currentStage: "production",
    })
    expect(applications.map(({ identity }) => `${identity.namespace}/${identity.name}`)).toEqual([
      "apps/checkout",
      "apps/catalog",
      "platform/gateway",
    ])
  })

  it("joins exact namespace/rollout_ref then exact namespaced Release.application", () => {
    const rollouts = [
      new Rollout({ namespace: "apps", name: "checkout-rollout" }),
      new Rollout({ namespace: "other", name: "checkout-rollout" }),
    ]
    const releases = [
      new Release({
        namespace: "apps",
        name: "checkout-v1",
        rolloutRef: "checkout-rollout",
        application: "checkout",
      }),
      new Release({
        namespace: "other",
        name: "checkout-v1",
        rolloutRef: "checkout-rollout",
        application: "checkout",
      }),
    ]
    const applications = flattenMapApplicationAssociations([
      applicationLeaf("apps", "checkout", { currentStage: "production" }),
      applicationLeaf("other", "checkout", { currentStage: "staging" }),
    ])

    const associations = buildRolloutApplicationAssociations(rollouts, releases, applications)

    expect(associations.get("apps/checkout-rollout")?.currentStage).toBe("production")
    expect(associations.get("other/checkout-rollout")?.currentStage).toBe("staging")
  })

  it("leaves blank, missing, duplicate Release, and duplicate Application matches unassociated", () => {
    const rollouts = [
      new Rollout({ namespace: "apps", name: "missing" }),
      new Rollout({ namespace: "apps", name: "duplicate-release" }),
      new Rollout({ namespace: "apps", name: "duplicate-application" }),
      new Rollout({ namespace: "apps", name: "blank-application" }),
    ]
    const releases = [
      new Release({ namespace: "apps", name: "a", rolloutRef: "duplicate-release", application: "checkout" }),
      new Release({ namespace: "apps", name: "b", rolloutRef: "duplicate-release", application: "checkout" }),
      new Release({ namespace: "apps", name: "c", rolloutRef: "duplicate-application", application: "checkout" }),
      new Release({ namespace: "apps", name: "d", rolloutRef: "blank-application", application: "" }),
      new Release({ namespace: "apps", name: "blank-ref", rolloutRef: "", application: "checkout" }),
    ]
    const applications = flattenMapApplicationAssociations([
      applicationLeaf("apps", "checkout"),
      applicationLeaf("apps", "checkout"),
    ])

    expect(buildRolloutApplicationAssociations(rollouts, releases, applications).size).toBe(0)
  })
})

describe("rolloutMatchesFleetScope", () => {
  const rollout = new Rollout({ namespace: "apps", name: "checkout-rollout" })
  const association = flattenMapApplicationAssociations([
    applicationLeaf("apps", "checkout", {
      project: new FleetObjectKey({ namespace: "apps", name: "payments" }),
      currentCluster: new FleetObjectKey({ namespace: "platform", name: "omega" }),
      currentStage: "production",
    }),
  ])[0]

  it("matches Namespace directly and Project, Cluster, and Stage through the associated Application", () => {
    expect(
      rolloutMatchesFleetScope(rollout, association, {
        projects: [{ namespace: "apps", name: "payments" }],
        clusters: [{ namespace: "platform", name: "omega" }],
        stages: ["production"],
        namespaces: ["apps"],
      }),
    ).toBe(true)

    expect(
      rolloutMatchesFleetScope(rollout, association, {
        ...emptyScope,
        clusters: [{ namespace: "platform", name: "other" }],
      }),
    ).toBe(false)
  })

  it("keeps unassociated Rollouts only when every selected dimension can be checked directly", () => {
    expect(
      rolloutMatchesFleetScope(rollout, undefined, { ...emptyScope, namespaces: ["apps"] }),
    ).toBe(true)
    expect(
      rolloutMatchesFleetScope(rollout, undefined, {
        ...emptyScope,
        namespaces: ["apps"],
        stages: ["production"],
      }),
    ).toBe(false)
    expect(
      rolloutMatchesFleetScope(rollout, undefined, { ...emptyScope, namespaces: ["other"] }),
    ).toBe(false)
  })
})

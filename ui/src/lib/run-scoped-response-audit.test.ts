import { describe, expect, it } from "vitest"

import { auditRunScopedResponse } from "../../e2e/helpers/run-scoped-response-audit"

const namespace = "paprika-fleet-e2e-audit"
const queryApplications = "/paprika.v1.PaprikaService/QueryApplications"
const queryFleetMap = "/paprika.v1.PaprikaService/QueryFleetMap"
const queryFleetMatrix = "/paprika.v1.PaprikaService/QueryFleetMatrix"
const getApplication = "/paprika.v1.PaprikaService/GetApplication"

describe("run-scoped response audit", () => {
  it("accepts every namespaced QueryApplications protojson field", () => {
    const result = auditRunScopedResponse(
      queryApplications,
      { filter: { namespaces: [namespace] } },
      {
        applications: [{
          identity: { namespace, name: "checkout" },
          project: { namespace, name: "finance" },
          currentCluster: { namespace, name: "cluster-west" },
          repository: { namespace, name: "apps" },
          effectiveObservabilitySource: { namespace, name: "prometheus" },
          targets: [{
            stage: "production",
            cluster: { namespace, name: "cluster-west" },
          }],
        }],
        facets: [{
          object: { namespace, name: "finance" },
          label: "finance",
          count: "1",
        }],
      },
      namespace,
    )

    expect(result).toEqual({ scoped: true, violations: [] })
  })

  it("rejects unscoped Query requests before inspecting the response", () => {
    const response = {
      applications: [{
        identity: { name: "checkout" },
        project: { namespace, name: "finance" },
        currentCluster: { namespace: "foreign", name: "cluster-west" },
      }],
    }
    const scoped = auditRunScopedResponse(
      queryApplications,
      { filter: { namespaces: [namespace] } },
      response,
      namespace,
    )
    expect(scoped.scoped).toBe(true)
    expect(scoped.violations).toEqual([
      "applications[0].identity: missing namespace",
      "applications[0].currentCluster: namespace=foreign",
    ])

    expect(
      auditRunScopedResponse(
        queryApplications,
        { filter: { namespaces: [] } },
        response,
        namespace,
      ),
    ).toEqual({
      scoped: false,
      violations: [
        `request.filter.namespaces=[], expected exactly ${JSON.stringify([namespace])}`,
      ],
    })
    expect(
      auditRunScopedResponse(
        queryApplications,
        { filter: {} },
        response,
        namespace,
      ),
    ).toEqual({
      scoped: false,
      violations: [
        `request.filter.namespaces=undefined, expected exactly ${JSON.stringify([namespace])}`,
      ],
    })
  })

  it("requires exact GetApplication request and response identities for both detail flows", () => {
    expect(
      auditRunScopedResponse(
        getApplication,
        { namespace, name: "checkout" },
        { application: { namespace, name: "checkout", phase: "Healthy" } },
        namespace,
      ),
    ).toEqual({ scoped: true, violations: [] })

    expect(
      auditRunScopedResponse(
        getApplication,
        { namespace, name: "checkout" },
        { application: { name: "checkout" } },
        namespace,
      ).violations,
    ).toEqual(["application: missing namespace"])
    expect(
      auditRunScopedResponse(
        getApplication,
        { namespace, name: "checkout" },
        { application: { namespace, name: "catalog" } },
        namespace,
      ).violations,
    ).toEqual(["application: name=catalog, expected checkout"])
    expect(
      auditRunScopedResponse(
        getApplication,
        { namespace: "foreign", name: "checkout" },
        { application: { namespace: "foreign", name: "checkout" } },
        namespace,
      ).violations,
    ).toEqual([`request.namespace=foreign, expected ${namespace}`])
  })

  it("audits recursive FleetMap object keys, metadata, and facets", () => {
    const result = auditRunScopedResponse(
      queryFleetMap,
      { filter: { namespaces: [namespace] } },
      {
        roots: [{
          stableId: `g:project:o:${namespace}/finance`,
          groupObject: { namespace, name: "finance" },
          children: [{
            stableId: `a:${namespace}/checkout`,
            kind: "FLEET_MAP_NODE_KIND_APPLICATION",
            application: { namespace, name: "checkout" },
            applicationMetadata: {
              project: { namespace, name: "finance" },
              currentCluster: { namespace, name: "cluster-west" },
            },
          }],
        }],
        facets: [{ object: { namespace, name: "cluster-west" } }],
      },
      namespace,
    )
    expect(result).toEqual({ scoped: true, violations: [] })

    const missing = auditRunScopedResponse(
      queryFleetMap,
      { filter: { namespaces: [namespace] } },
      {
        roots: [{
          stableId: `a:${namespace}/checkout`,
          kind: "FLEET_MAP_NODE_KIND_APPLICATION",
          application: { name: "checkout" },
        }],
      },
      namespace,
    )
    expect(missing.violations).toEqual(["roots[0].application: missing namespace"])
  })

  it("audits FleetMatrix row, column, and facet object keys", () => {
    const result = auditRunScopedResponse(
      queryFleetMatrix,
      { filter: { namespaces: [namespace] } },
      {
        rows: [{ object: { namespace, name: "finance" } }],
        columns: [{ object: { namespace, name: "cluster-west" } }],
        facets: [{ object: { namespace, name: "production" } }],
      },
      namespace,
    )
    expect(result).toEqual({ scoped: true, violations: [] })

    const foreign = auditRunScopedResponse(
      queryFleetMatrix,
      { filter: { namespaces: [namespace] } },
      { rows: [{ object: { namespace: "foreign", name: "finance" } }] },
      namespace,
    )
    expect(foreign.violations).toEqual(["rows[0].object: namespace=foreign"])
  })

  it("rejects non-exact selected Query filters and direct list namespaces", () => {
    expect(
      auditRunScopedResponse(
        queryApplications,
        { filter: { namespaces: [namespace, "foreign"] } },
        { applications: [] },
        namespace,
      ).violations,
    ).toEqual([
      `request.filter.namespaces=${JSON.stringify([namespace, "foreign"])}, ` +
        `expected exactly ${JSON.stringify([namespace])}`,
    ])
    expect(
      auditRunScopedResponse(
        "/paprika.v1.PaprikaService/ListPipelines",
        { namespace },
        { pipelines: [{ namespace: "foreign", name: "delivery" }] },
        namespace,
      ).violations,
    ).toEqual(["pipelines[0]: namespace=foreign"])
    expect(
      auditRunScopedResponse(
        "/paprika.v1.PaprikaService/ListRollouts",
        { namespace },
        { rollouts: [{ name: "checkout-rollout" }] },
        namespace,
      ).violations,
    ).toEqual(["rollouts[0]: missing namespace"])
  })

  it("audits Query filter object keys and stage shapes even for empty responses", () => {
    expect(
      auditRunScopedResponse(
        queryFleetMap,
        {
          filter: {
            namespaces: [namespace],
            projects: [{ namespace, name: "payments" }],
            clusters: [{ namespace, name: "delivery-primary" }],
            stages: ["production"],
          },
        },
        { roots: [], total: "0" },
        namespace,
      ),
    ).toEqual({ scoped: true, violations: [] })

    expect(
      auditRunScopedResponse(
        queryFleetMap,
        {
          filter: {
            namespaces: [namespace],
            projects: [{ namespace: "foreign", name: "payments" }],
            clusters: [{ namespace }],
            stages: ["", 42],
          },
        },
        { roots: [], total: "0" },
        namespace,
      ).violations,
    ).toEqual([
      "request.filter.projects[0]: namespace=foreign",
      "request.filter.clusters[0]: missing name",
      "request.filter.stages[0]: expected non-empty string",
      "request.filter.stages[1]: expected non-empty string",
    ])
  })
})

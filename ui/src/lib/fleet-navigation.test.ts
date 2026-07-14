import { describe, expect, it } from "vitest"
import {
  fleetDetailHref,
  fleetHref,
  migrateLegacyDetailIdentity,
  patchFleetSearchParams,
  readFleetDetailIdentity,
  type FleetDetailKind,
} from "@/lib/fleet-navigation"

describe("patchFleetSearchParams", () => {
  it("replaces only patched fleet scope while preserving repeated and unknown state", () => {
    const current = new URLSearchParams(
      "project=platform%2Falpha&cluster=fleet%2Fwest&stage=prod&namespace=apps&namespace=platform&q=checkout&health=degraded&group=namespace&view=heatmap&density=compact&labels=all&sort=impact&direction=desc&range=24h&tab=events&unknown=one&unknown=two&application_namespace=delivery&application_name=checkout&page=4&cursor=next&selected=apps%2Fcheckout&zoom=platform",
    )

    const result = patchFleetSearchParams(current, {
      projects: [{ namespace: "platform", name: "beta" }],
      clusters: [],
      stages: ["canary"],
      namespaces: ["delivery", "runtime"],
    })

    expect(result.getAll("project")).toEqual(["platform/beta"])
    expect(result.getAll("cluster")).toEqual([])
    expect(result.getAll("stage")).toEqual(["canary"])
    expect(result.getAll("namespace")).toEqual(["delivery", "runtime"])
    expect(result.getAll("unknown")).toEqual(["one", "two"])
    expect(result.get("application_namespace")).toBe("delivery")
    expect(result.get("application_name")).toBe("checkout")
    expect(result.get("page")).toBe("4")
    expect(result.get("cursor")).toBe("next")
    expect(result.get("selected")).toBe("apps/checkout")
    expect(result.get("zoom")).toBe("platform")
    expect(current.getAll("namespace")).toEqual(["apps", "platform"])
  })

  it("clears only navigation state invalidated by a scope change", () => {
    const current = new URLSearchParams(
      "namespace=apps&q=checkout&filter=owned&group=stage&view=matrix&density=comfortable&labels=none&sort=health&direction=asc&range=6h&tab=resources&page=7&cursor=opaque&selected=apps%2Fcheckout&zoom=team&unknown=kept&pipeline_namespace=ci&pipeline_name=build",
    )

    const result = patchFleetSearchParams(
      current,
      { namespaces: ["platform"] },
      { scopeChanged: true },
    )

    for (const key of ["page", "cursor", "selected", "zoom"]) expect(result.has(key)).toBe(false)
    expect(result.get("q")).toBe("checkout")
    expect(result.get("filter")).toBe("owned")
    expect(result.get("group")).toBe("stage")
    expect(result.get("view")).toBe("matrix")
    expect(result.get("density")).toBe("comfortable")
    expect(result.get("labels")).toBe("none")
    expect(result.get("sort")).toBe("health")
    expect(result.get("direction")).toBe("asc")
    expect(result.get("range")).toBe("6h")
    expect(result.get("tab")).toBe("resources")
    expect(result.get("unknown")).toBe("kept")
    expect(result.get("pipeline_namespace")).toBe("ci")
    expect(result.get("pipeline_name")).toBe("build")
  })
})

describe("fleet route links", () => {
  it("retains current query state and a supplied route hash", () => {
    const current = new URLSearchParams("namespace=apps&unknown=kept&view=heatmap")

    expect(fleetHref("/dashboard?tab=activity#pipelines", current)).toBe(
      "/dashboard?namespace=apps&unknown=kept&view=heatmap&tab=activity#pipelines",
    )
  })

  it.each([
    ["application", "/dashboard/application", "application_namespace", "application_name"],
    ["rollout", "/dashboard/rollouts/detail", "rollout_namespace", "rollout_name"],
    ["pipeline", "/dashboard/pipelines/detail", "pipeline_namespace", "pipeline_name"],
    ["applicationset", "/dashboard/applicationsets/detail", "applicationset_namespace", "applicationset_name"],
  ] as const)("builds a dedicated %s identity without losing scope", (kind, path, namespaceKey, nameKey) => {
    const href = fleetDetailHref(
      kind,
      { namespace: "delivery", name: "checkout" },
      new URLSearchParams("namespace=apps&namespace=platform&unknown=kept&tab=events"),
    )
    const url = new URL(href, "https://paprika.test")

    expect(url.pathname).toBe(path)
    expect(url.searchParams.getAll("namespace")).toEqual(["apps", "platform"])
    expect(url.searchParams.get(namespaceKey)).toBe("delivery")
    expect(url.searchParams.get(nameKey)).toBe("checkout")
    expect(url.searchParams.get("unknown")).toBe("kept")
    expect(url.searchParams.get("tab")).toBe("events")
  })
})

describe("fleet detail identity migration", () => {
  const kinds: FleetDetailKind[] = ["application", "rollout", "pipeline", "applicationset"]

  it.each(kinds)("prefers an explicit %s identity", (kind) => {
    const params = new URLSearchParams(
      `namespace=apps&namespace=platform&${kind}_namespace=delivery&${kind}_name=checkout&name=legacy`,
    )

    expect(readFleetDetailIdentity(kind, params)).toEqual({
      status: "resolved",
      source: "explicit",
      identity: { namespace: "delivery", name: "checkout" },
    })
    expect(migrateLegacyDetailIdentity(kind, params)).toBeInstanceOf(URLSearchParams)
    expect((migrateLegacyDetailIdentity(kind, params) as URLSearchParams).toString()).toBe(params.toString())
  })

  it.each(kinds)("migrates one legacy %s identity while retaining fleet namespace scope", (kind) => {
    const params = new URLSearchParams("namespace=legacy&name=checkout&unknown=kept")
    const migrated = migrateLegacyDetailIdentity(kind, params)

    expect(readFleetDetailIdentity(kind, params)).toEqual({
      status: "resolved",
      source: "legacy",
      identity: { namespace: "legacy", name: "checkout" },
    })
    expect(migrated).toBeInstanceOf(URLSearchParams)
    const result = migrated as URLSearchParams
    expect(result.get("namespace")).toBe("legacy")
    expect(result.get(`${kind}_namespace`)).toBe("legacy")
    expect(result.get(`${kind}_name`)).toBe("checkout")
    expect(result.has("name")).toBe(false)
    expect(result.get("unknown")).toBe("kept")
    expect(params.get("name")).toBe("checkout")
  })

  it.each(kinds)("reports ambiguous legacy %s identity instead of guessing", (kind) => {
    const params = new URLSearchParams("namespace=apps&namespace=platform&name=checkout&unknown=kept")

    expect(readFleetDetailIdentity(kind, params)).toEqual({
      status: "ambiguous",
      reason: "multiple_legacy_namespaces",
      namespaces: ["apps", "platform"],
      name: "checkout",
    })
    expect(migrateLegacyDetailIdentity(kind, params)).toEqual({
      status: "ambiguous",
      reason: "multiple_legacy_namespaces",
      namespaces: ["apps", "platform"],
      name: "checkout",
    })
  })

  it.each(kinds)("fails closed for an incomplete explicit %s identity", (kind) => {
    const params = new URLSearchParams(
      `${kind}_namespace=trusted&${kind}_name=%20&namespace=legacy&name=checkout`,
    )

    expect(readFleetDetailIdentity(kind, params)).toEqual({ status: "missing" })
    expect((migrateLegacyDetailIdentity(kind, params) as URLSearchParams).toString()).toBe(
      params.toString(),
    )
  })
})

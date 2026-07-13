import { describe, expect, it } from "vitest"

import {
  DEFAULT_FLEET_QUERY,
  mergeFleetQuery,
  parseFleetQuery,
  reconcileFleetQuery,
  serializeFleetQuery,
  type FleetDensity,
  type FleetLabelMode,
  type FleetQueryDefaults,
  type FleetQueryState,
} from "@/lib/fleet-query"

describe("fleet query URL codec", () => {
  it("round-trips every field in deterministic canonical order", () => {
    const state: FleetQueryState = {
      projects: [
        { namespace: "z", name: "checkout" },
        { namespace: "a", name: "payments" },
        { namespace: "a", name: "payments" },
      ],
      clusters: [
        { namespace: "platform", name: "us" },
        { namespace: "platform", name: "eu" },
      ],
      stages: ["prod", "dev", "dev"],
      namespaces: ["platform", "apps", "apps"],
      health: ["healthy", "degraded", "healthy"],
      sync: ["synced", "out_of_sync"],
      release: ["failed", "awaiting_approval"],
      rollout: ["progressing", "paused"],
      sources: ["oci", "git"],
      q: "  payments api  ",
      sort: "impact",
      direction: "desc",
      view: "heatmap",
      group: "namespace",
      rows: "stage",
      columns: "health",
      size: "request_rate",
      density: "compact",
      labels: "all",
      zoom: "g:project:a/payments",
      selected: { namespace: "apps", name: "payments-api" },
      range: "24h",
    }

    const serialized = serializeFleetQuery(state)

    expect(serialized.toString()).toBe(
      "project=a%2Fpayments&project=z%2Fcheckout" +
        "&cluster=platform%2Feu&cluster=platform%2Fus" +
        "&stage=dev&stage=prod&namespace=apps&namespace=platform" +
        "&health=degraded&health=healthy&sync=out_of_sync&sync=synced" +
        "&release=awaiting_approval&release=failed" +
        "&rollout=paused&rollout=progressing&source=git&source=oci" +
        "&q=payments+api&sort=impact&direction=desc&view=heatmap" +
        "&group=namespace&rows=stage&columns=health&size=request_rate" +
        "&density=compact&labels=all" +
        "&zoom=g%3Aproject%3Aa%2Fpayments&selected=apps%2Fpayments-api&range=24h",
    )
    expect(parseFleetQuery(serialized)).toEqual({
      state: {
        ...state,
        projects: [
          { namespace: "a", name: "payments" },
          { namespace: "z", name: "checkout" },
        ],
        clusters: [
          { namespace: "platform", name: "eu" },
          { namespace: "platform", name: "us" },
        ],
        stages: ["dev", "prod"],
        namespaces: ["apps", "platform"],
        health: ["degraded", "healthy"],
        sync: ["out_of_sync", "synced"],
        release: ["awaiting_approval", "failed"],
        rollout: ["paused", "progressing"],
        sources: ["git", "oci"],
        q: "payments api",
      },
      notices: [],
    })
  })

  it("omits defaults and recreates fresh default state", () => {
    expect(serializeFleetQuery(DEFAULT_FLEET_QUERY).toString()).toBe("")

    const first = parseFleetQuery("")
    const second = parseFleetQuery(new URLSearchParams())
    expect(first).toEqual({ state: DEFAULT_FLEET_QUERY, notices: [] })
    expect(second).toEqual(first)
    expect(second.state.projects).not.toBe(first.state.projects)
  })

  it("keeps route-specific view defaults independent while omitting each route's default", () => {
    const overviewDefaults = { view: "heatmap" } satisfies FleetQueryDefaults

    const applications = parseFleetQuery("")
    const overview = parseFleetQuery("", overviewDefaults)

    expect(applications.state.view).toBe("treemap")
    expect(overview.state.view).toBe("heatmap")
    expect(serializeFleetQuery(applications.state).toString()).toBe("")
    expect(serializeFleetQuery(overview.state, overviewDefaults).toString()).toBe("")
    expect(serializeFleetQuery(applications.state, overviewDefaults).toString()).toBe("view=treemap")
    expect(serializeFleetQuery(overview.state).toString()).toBe("view=heatmap")
  })

  it("falls back field by field when raw JavaScript supplies malformed defaults", () => {
    const rawDefaults = {
      sort: "random",
      direction: "sideways",
      view: "graph",
      group: "workload",
      rows: "source",
      columns: "release",
      size: "pods",
      density: "spacious",
      labels: "some",
      range: "forever",
    } as unknown as FleetQueryDefaults

    expect(parseFleetQuery("", rawDefaults)).toEqual({
      state: DEFAULT_FLEET_QUERY,
      notices: [],
    })
  })

  it("does not let explicit undefined overrides erase global defaults", () => {
    const rawDefaults = {
      view: undefined,
      density: undefined,
      labels: undefined,
    } as unknown as FleetQueryDefaults

    expect(parseFleetQuery("", rawDefaults)).toEqual({
      state: DEFAULT_FLEET_QUERY,
      notices: [],
    })
  })

  it("notices invalid URL values and uses valid global fallbacks despite malformed overrides", () => {
    const rawDefaults = {
      view: "graph",
      density: "spacious",
      labels: "some",
    } as unknown as FleetQueryDefaults

    const parsed = parseFleetQuery("view=&density=wide&labels=some", rawDefaults)

    expect(parsed.state).toEqual(DEFAULT_FLEET_QUERY)
    expect(parsed.notices.map(({ field, value, reason }) => ({ field, value, reason }))).toEqual([
      { field: "view", value: "", reason: "invalid" },
      { field: "density", value: "wide", reason: "invalid" },
      { field: "labels", value: "some", reason: "invalid" },
    ])
  })

  it("ignores unknown raw override keys without discarding valid overrides", () => {
    const rawDefaults = {
      view: "heatmap",
      experimentalLayout: "spiral",
    } as unknown as FleetQueryDefaults

    const parsed = parseFleetQuery("", rawDefaults)

    expect(parsed).toEqual({
      state: { ...DEFAULT_FLEET_QUERY, view: "heatmap" },
      notices: [],
    })
    expect(parsed.state).not.toHaveProperty("experimentalLayout")
    expect(serializeFleetQuery(parsed.state, rawDefaults).toString()).toBe("")
  })

  it("does not serialize global values merely because a raw override is invalid", () => {
    const rawDefaults = {
      view: "graph",
      density: "spacious",
      labels: "some",
    } as unknown as FleetQueryDefaults

    expect(serializeFleetQuery(DEFAULT_FLEET_QUERY, rawDefaults).toString()).toBe("")
  })

  it.each<[FleetDensity, FleetLabelMode, string]>([
    ["auto", "auto", ""],
    ["compact", "all", "density=compact&labels=all"],
    ["comfortable", "none", "density=comfortable&labels=none"],
  ])("round-trips density=%s and labels=%s", (density, labels, expected) => {
    const state: FleetQueryState = { ...DEFAULT_FLEET_QUERY, density, labels }

    const serialized = serializeFleetQuery(state)

    expect(serialized.toString()).toBe(expected)
    expect(parseFleetQuery(serialized)).toEqual({ state, notices: [] })
  })

  it("drops malformed namespaced keys and unknown enum values with notices", () => {
    const parsed = parseFleetQuery(
      "project=broken&project=tenant%2Fpayments&project=tenant%2Ftoo%2Fdeep" +
        "&cluster=UPPER%2Feu&health=burning&health=healthy&sync=drifting" +
        "&release=complete&rollout=stuck&source=gitlab&sort=random" +
        "&direction=sideways&view=graph&group=workload&rows=source" +
        "&columns=release&size=pods&density=spacious&labels=some" +
        "&selected=broken&range=forever",
    )

    expect(parsed.state).toEqual({
      ...DEFAULT_FLEET_QUERY,
      projects: [{ namespace: "tenant", name: "payments" }],
      health: ["healthy"],
      release: ["complete"],
    })
    expect(parsed.notices.map(({ field, value, reason }) => ({ field, value, reason }))).toEqual([
      { field: "project", value: "broken", reason: "invalid" },
      { field: "project", value: "tenant/too/deep", reason: "invalid" },
      { field: "cluster", value: "UPPER/eu", reason: "invalid" },
      { field: "health", value: "burning", reason: "invalid" },
      { field: "sync", value: "drifting", reason: "invalid" },
      { field: "rollout", value: "stuck", reason: "invalid" },
      { field: "source", value: "gitlab", reason: "invalid" },
      { field: "sort", value: "random", reason: "invalid" },
      { field: "direction", value: "sideways", reason: "invalid" },
      { field: "view", value: "graph", reason: "invalid" },
      { field: "group", value: "workload", reason: "invalid" },
      { field: "rows", value: "source", reason: "invalid" },
      { field: "columns", value: "release", reason: "invalid" },
      { field: "size", value: "pods", reason: "invalid" },
      { field: "density", value: "spacious", reason: "invalid" },
      { field: "labels", value: "some", reason: "invalid" },
      { field: "selected", value: "broken", reason: "invalid" },
      { field: "range", value: "forever", reason: "invalid" },
    ])
    expect(parsed.notices.every((notice) => notice.message.length > 0)).toBe(true)
  })

  it("merges presentation changes without losing unrelated scope or filters", () => {
    const current: FleetQueryState = {
      ...DEFAULT_FLEET_QUERY,
      projects: [{ namespace: "tenant", name: "payments" }],
      clusters: [{ namespace: "platform", name: "prod" }],
      stages: ["prod"],
      namespaces: ["apps"],
      health: ["degraded"],
      q: "checkout",
      selected: { namespace: "apps", name: "checkout" },
      zoom: "project:tenant/payments",
    }

    const merged = mergeFleetQuery(current, {
      view: "table",
      sort: "impact",
      direction: "desc",
    })

    expect(merged).toEqual({
      ...current,
      view: "table",
      sort: "impact",
      direction: "desc",
    })
    expect(parseFleetQuery(serializeFleetQuery(merged))).toEqual({ state: merged, notices: [] })
  })

  it("reconciles only supplied authorized facets and reports every dropped value", () => {
    const current: FleetQueryState = {
      ...DEFAULT_FLEET_QUERY,
      projects: [
        { namespace: "tenant-a", name: "payments" },
        { namespace: "tenant-b", name: "payments" },
      ],
      clusters: [
        { namespace: "platform", name: "dev" },
        { namespace: "platform", name: "prod" },
      ],
      stages: ["dev", "prod"],
      namespaces: ["apps", "platform"],
      health: ["degraded", "healthy"],
      sync: ["out_of_sync", "synced"],
      release: ["complete", "failed"],
      rollout: ["paused", "progressing"],
      sources: ["git", "oci"],
      q: "payments",
      view: "matrix",
    }

    const reconciled = reconcileFleetQuery(current, {
      projects: [{ namespace: "tenant-b", name: "payments" }],
      clusters: [{ namespace: "platform", name: "prod" }],
      stages: ["prod"],
      namespaces: ["apps"],
      health: ["healthy"],
      sync: ["synced"],
      release: ["complete"],
      rollout: ["paused"],
      sources: ["git"],
    })

    expect(reconciled.state).toEqual({
      ...current,
      projects: [{ namespace: "tenant-b", name: "payments" }],
      clusters: [{ namespace: "platform", name: "prod" }],
      stages: ["prod"],
      namespaces: ["apps"],
      health: ["healthy"],
      sync: ["synced"],
      release: ["complete"],
      rollout: ["paused"],
      sources: ["git"],
    })
    expect(reconciled.notices.map(({ field, value, reason }) => ({ field, value, reason }))).toEqual([
      { field: "project", value: "tenant-a/payments", reason: "not_available" },
      { field: "cluster", value: "platform/dev", reason: "not_available" },
      { field: "stage", value: "dev", reason: "not_available" },
      { field: "namespace", value: "platform", reason: "not_available" },
      { field: "health", value: "degraded", reason: "not_available" },
      { field: "sync", value: "out_of_sync", reason: "not_available" },
      { field: "release", value: "failed", reason: "not_available" },
      { field: "rollout", value: "progressing", reason: "not_available" },
      { field: "source", value: "oci", reason: "not_available" },
    ])
    expect(reconciled.state.q).toBe("payments")
    expect(reconciled.state.view).toBe("matrix")
  })
})

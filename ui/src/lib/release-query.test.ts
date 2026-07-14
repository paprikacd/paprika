import { describe, expect, it } from "vitest"

import {
  RELEASE_MAX_OFFSET,
  RELEASE_PAGE_SIZE,
  applicationURL,
  mergeReleaseQuery,
  parseReleaseQuery,
  releaseURL,
  rolloutURL,
  serializeReleaseQuery,
  type ReleaseQueryState,
} from "@/lib/release-query"

describe("release query URL codec", () => {
  it("canonicalizes shared scope through the fleet codec and drops presentation state", () => {
    const parsed = parseReleaseQuery(
      "namespace=platform&project=z%2Fcheckout&view=heatmap&cluster=platform%2Fus" +
        "&project=a%2Fpayments&stage=prod&namespace=apps&project=a%2Fpayments" +
        "&cluster=platform%2Feu&stage=dev&namespace=apps&cluster=platform%2Fus" +
        "&stage=prod&group=namespace&density=compact&labels=all" +
        "&selected=apps%2Fcheckout&q=%20payments%20&page=2",
    )

    expect(parsed).toEqual({
      state: {
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
        q: "payments",
        page: 2,
      },
      needsCanonicalReplace: true,
    })
    expect(serializeReleaseQuery(parsed.state).toString()).toBe(
      "project=a%2Fpayments&project=z%2Fcheckout" +
        "&cluster=platform%2Feu&cluster=platform%2Fus" +
        "&stage=dev&stage=prod&namespace=apps&namespace=platform&q=payments&page=2",
    )
  })

  it("recognizes the canonical order without requesting another replacement", () => {
    const query =
      "project=a%2Fpayments&project=z%2Fcheckout&cluster=platform%2Feu" +
      "&stage=prod&namespace=apps&namespace=platform&q=payments&page=2" +
      "&view=matrix&tab=evidence&unknown=kept&application_namespace=apps&application_name=checkout"

    expect(parseReleaseQuery(query).needsCanonicalReplace).toBe(false)
  })

  it.each([
    ["empty", ""],
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["nonnumeric", "two"],
    ["leading plus", "+2"],
    ["leading zero", "02"],
    ["surrounding whitespace", " 2 "],
    ["unsafe integer", "9007199254740992"],
    ["offset above the API maximum", "41668"],
  ])("canonicalizes an invalid %s page to the omitted first page", (_label, page) => {
    const parsed = parseReleaseQuery(`namespace=apps&page=${encodeURIComponent(page)}`)

    expect(parsed.state.page).toBe(1)
    expect(parsed.needsCanonicalReplace).toBe(true)
    expect(serializeReleaseQuery(parsed.state).toString()).toBe("namespace=apps")
  })

  it("round-trips valid one-based pages through the API offset boundary", () => {
    expect(RELEASE_PAGE_SIZE).toBe(24)
    expect(RELEASE_MAX_OFFSET).toBe(1_000_000)

    for (const page of [2, 41_667]) {
      const parsed = parseReleaseQuery(`page=${page}`)
      expect(parsed.state.page).toBe(page)
      expect(parsed.needsCanonicalReplace).toBe(false)
      expect(serializeReleaseQuery(parsed.state).toString()).toBe(`page=${page}`)
      expect((page - 1) * RELEASE_PAGE_SIZE).toBeLessThanOrEqual(RELEASE_MAX_OFFSET)
    }
  })

  it("omits an explicit first page and uses the last repeated page value", () => {
    expect(parseReleaseQuery("page=1")).toEqual({
      state: {
        projects: [],
        clusters: [],
        stages: [],
        namespaces: [],
        q: "",
        page: 1,
      },
      needsCanonicalReplace: true,
    })

    const repeated = parseReleaseQuery("page=7&page=3")
    expect(repeated.state.page).toBe(3)
    expect(repeated.needsCanonicalReplace).toBe(true)
    expect(serializeReleaseQuery(repeated.state).toString()).toBe("page=3")
  })

  it("resets pagination when the normalized search changes even if a page patch is supplied", () => {
    const current: ReleaseQueryState = {
      projects: [{ namespace: "tenant", name: "payments" }],
      clusters: [{ namespace: "platform", name: "prod" }],
      stages: ["prod"],
      namespaces: ["apps"],
      q: "checkout",
      page: 7,
    }

    expect(mergeReleaseQuery(current, { q: "  payments  ", page: 9 })).toEqual({
      ...current,
      q: "payments",
      page: 1,
    })
    expect(mergeReleaseQuery(current, { q: " checkout ", page: 9 }).page).toBe(9)
    expect(current).toEqual({
      projects: [{ namespace: "tenant", name: "payments" }],
      clusters: [{ namespace: "platform", name: "prod" }],
      stages: ["prod"],
      namespaces: ["apps"],
      q: "checkout",
      page: 7,
    })
  })

  it("patches release-owned keys without dropping raw navigation state", () => {
    const current =
      "view=matrix&namespace=platform&project=tenant%2Fpayments&selected=apps%2Fcheckout" +
      "&cluster=platform%2Fprod&stage=prod&namespace=apps&q=checkout&page=4&group=cluster" +
      "&tab=evidence&unknown=kept&application_namespace=delivery&application_name=checkout"

    const unchanged = new URL(releaseURL(current), "https://paprika.test")
    const paged = new URL(releaseURL(current, { page: 5 }), "https://paprika.test")
    const searched = new URL(
      releaseURL(current, { q: "payments", page: 8 }),
      "https://paprika.test",
    )

    for (const destination of [unchanged, paged, searched]) {
      expect(destination.searchParams.get("view")).toBe("matrix")
      expect(destination.searchParams.get("selected")).toBe("apps/checkout")
      expect(destination.searchParams.get("group")).toBe("cluster")
      expect(destination.searchParams.get("tab")).toBe("evidence")
      expect(destination.searchParams.get("unknown")).toBe("kept")
      expect(destination.searchParams.get("application_namespace")).toBe("delivery")
      expect(destination.searchParams.get("application_name")).toBe("checkout")
    }
    expect(unchanged.searchParams.getAll("namespace")).toEqual(["apps", "platform"])
    expect(paged.searchParams.getAll("namespace")).toEqual(["platform", "apps"])
    expect(searched.searchParams.getAll("namespace")).toEqual(["platform", "apps"])
    expect(unchanged.searchParams.get("page")).toBe("4")
    expect(paged.searchParams.get("page")).toBe("5")
    expect(searched.searchParams.get("q")).toBe("payments")
    expect(searched.searchParams.has("page")).toBe(false)
  })

  it("keeps detail identity separate from every repeated namespace scope value", () => {
    const parameters = new URLSearchParams(
      "namespace=apps&namespace=platform&project=tenant%2Fpayments" +
        "&cluster=platform%2Fprod&stage=prod&q=checkout&page=3&view=table",
    )

    expect(applicationURL(parameters, { namespace: "payments-system", name: "checkout api" })).toBe(
      "/dashboard/application?project=tenant%2Fpayments&cluster=platform%2Fprod" +
        "&stage=prod&namespace=apps&namespace=platform" +
        "&application_namespace=payments-system&application_name=checkout+api",
    )
    expect(rolloutURL(parameters, { namespace: "delivery-system", name: "checkout rollout" })).toBe(
      "/dashboard/rollouts/detail?project=tenant%2Fpayments&cluster=platform%2Fprod" +
        "&stage=prod&namespace=apps&namespace=platform" +
        "&rollout_namespace=delivery-system&rollout_name=checkout+rollout",
    )
    expect(parameters.toString()).toBe(
      "namespace=apps&namespace=platform&project=tenant%2Fpayments" +
        "&cluster=platform%2Fprod&stage=prod&q=checkout&page=3&view=table",
    )
  })
})

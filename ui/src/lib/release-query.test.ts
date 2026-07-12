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
      "namespace=platform&project=z%2Fcheckout&view=matrix&cluster=platform%2Fus" +
        "&project=a%2Fpayments&stage=prod&namespace=apps&project=a%2Fpayments" +
        "&cluster=platform%2Feu&selected=apps%2Fcheckout&q=%20payments%20&page=2",
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
        stages: ["prod"],
        namespaces: ["apps", "platform"],
        q: "payments",
        page: 2,
      },
      needsCanonicalReplace: true,
    })
    expect(serializeReleaseQuery(parsed.state).toString()).toBe(
      "project=a%2Fpayments&project=z%2Fcheckout" +
        "&cluster=platform%2Feu&cluster=platform%2Fus" +
        "&stage=prod&namespace=apps&namespace=platform&q=payments&page=2",
    )
  })

  it("recognizes the canonical order without requesting another replacement", () => {
    const query =
      "project=a%2Fpayments&project=z%2Fcheckout&cluster=platform%2Feu" +
      "&stage=prod&namespace=apps&namespace=platform&q=payments&page=2"

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

  it("builds release links from raw navigation state while preserving only scope, search, and page", () => {
    const current =
      "view=matrix&namespace=platform&project=tenant%2Fpayments&selected=apps%2Fcheckout" +
      "&cluster=platform%2Fprod&stage=prod&namespace=apps&q=checkout&page=4&group=cluster"

    expect(releaseURL(current)).toBe(
      "/dashboard/releases?project=tenant%2Fpayments&cluster=platform%2Fprod" +
        "&stage=prod&namespace=apps&namespace=platform&q=checkout&page=4",
    )
    expect(releaseURL(current, { page: 5 })).toBe(
      "/dashboard/releases?project=tenant%2Fpayments&cluster=platform%2Fprod" +
        "&stage=prod&namespace=apps&namespace=platform&q=checkout&page=5",
    )
    expect(releaseURL(current, { q: "payments", page: 8 })).toBe(
      "/dashboard/releases?project=tenant%2Fpayments&cluster=platform%2Fprod" +
        "&stage=prod&namespace=apps&namespace=platform&q=payments",
    )
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

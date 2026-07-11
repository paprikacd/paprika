import { Code, ConnectError } from "@connectrpc/connect"
import { describe, expect, it } from "vitest"

import type {
  FleetApplicationSummary,
  FleetApplicationsPage,
} from "@/lib/fleet-client"
import {
  createFleetPageLoader,
  mergeFleetApplicationPages,
} from "@/lib/fleet-pages"
import type { NamespacedKey } from "@/lib/fleet-query"

function application(
  sourceRevision: string,
  identity?: NamespacedKey,
): FleetApplicationSummary {
  return {
    identity,
    targets: [],
    currentStage: "",
    currentClusterLabel: "",
    sourceType: "unspecified",
    sourceRevision,
    health: "unspecified",
    sync: "unspecified",
    driftCount: 0,
    missingResourceCount: 0,
    releaseState: "unspecified",
    rolloutState: "unspecified",
    resourceCount: 0,
    repositoryConnection: "unspecified",
    observabilityConnection: "unspecified",
    blockedGateCount: 0,
    lastTransitionUnixMs: BigInt(0),
    capabilities: [],
  }
}

function page(...applications: FleetApplicationSummary[]): FleetApplicationsPage {
  return {
    applications,
    total: BigInt(applications.length),
    nextCursor: "",
    indexGeneration: BigInt(1),
    facets: [],
  }
}

describe("mergeFleetApplicationPages", () => {
  it("deduplicates identities while preserving their first-seen order and value", () => {
    const firstA = application("first-a", { namespace: "apps", name: "api" })
    const missingA = application("missing-a")
    const firstB = application("first-b", { namespace: "apps", name: "worker" })
    const laterA = application("later-a", { namespace: "apps", name: "api" })
    const missingB = application("missing-b")
    const sameNameOtherNamespace = application("other-api", {
      namespace: "other",
      name: "api",
    })

    const merged = mergeFleetApplicationPages([
      page(firstA, missingA, firstB),
      page(laterA, missingB, sameNameOtherNamespace),
    ])

    expect(merged).toEqual([
      firstA,
      missingA,
      firstB,
      missingB,
      sameNameOtherNamespace,
    ])
  })

  it("keeps every identity-less application deterministically instead of conflating them", () => {
    const first = application("missing-a")
    const second = application("missing-b")
    const pages = [page(first), page(second)]

    expect(mergeFleetApplicationPages(pages)).toEqual([first, second])
    expect(mergeFleetApplicationPages(pages)).toEqual([first, second])
  })
})

describe("createFleetPageLoader", () => {
  it("resets fleet pages then fetches page one once for an invalid non-empty cursor", async () => {
    const staleCursor = new ConnectError("cursor expired", Code.InvalidArgument)
    const firstPage = page(application("first", { namespace: "apps", name: "api" }))
    const events: string[] = []
    const queryState = Object.freeze({ search: "payments", sort: "impact" })

    const loadPage = createFleetPageLoader({
      fetchPage: async (cursor) => {
        events.push(`fetch:${cursor || "first"}`)
        expect(queryState).toEqual({ search: "payments", sort: "impact" })
        if (cursor === "expired") {
          throw staleCursor
        }
        return firstPage
      },
      resetFleetPages: () => {
        events.push("reset:fleet-pages")
      },
    })

    await expect(loadPage("expired")).resolves.toBe(firstPage)
    expect(events).toEqual([
      "fetch:expired",
      "reset:fleet-pages",
      "fetch:first",
    ])
    expect(queryState).toEqual({ search: "payments", sort: "impact" })
  })

  it.each([
    {
      name: "InvalidArgument on page one",
      cursor: "",
      error: new ConnectError("bad request", Code.InvalidArgument),
    },
    {
      name: "a different Connect code",
      cursor: "next",
      error: new ConnectError("forbidden", Code.PermissionDenied),
    },
    {
      name: "a non-Connect failure",
      cursor: "next",
      error: new Error("network failed"),
    },
  ])("rethrows $name without resetting", async ({ cursor, error }) => {
    let resets = 0
    const loadPage = createFleetPageLoader<FleetApplicationsPage>({
      fetchPage: async () => {
        throw error
      },
      resetFleetPages: () => {
        resets += 1
      },
    })

    await expect(loadPage(cursor)).rejects.toBe(error)
    expect(resets).toBe(0)
  })

  it("does not loop cursor recovery when page one fails or TanStack retries", async () => {
    const staleCursor = new ConnectError("cursor expired", Code.InvalidArgument)
    const firstPageError = new ConnectError("page one invalid", Code.InvalidArgument)
    const cursors: string[] = []
    let resets = 0
    const loadPage = createFleetPageLoader<FleetApplicationsPage>({
      fetchPage: async (cursor) => {
        cursors.push(cursor)
        if (cursor) {
          throw staleCursor
        }
        throw firstPageError
      },
      resetFleetPages: () => {
        resets += 1
      },
    })

    await expect(loadPage("expired")).rejects.toBe(firstPageError)
    await expect(loadPage("expired")).rejects.toBe(staleCursor)

    expect(cursors).toEqual(["expired", "", "expired"])
    expect(resets).toBe(1)
  })

  it("allows one later recovery when an aborted reset never completed", async () => {
    const staleCursor = new ConnectError("cursor expired", Code.InvalidArgument)
    const resetAbort = new Error("reset canceled")
    resetAbort.name = "AbortError"
    const firstPage = page(
      application("first", { namespace: "apps", name: "api" }),
    )
    const cursors: string[] = []
    let resets = 0
    const loadPage = createFleetPageLoader({
      fetchPage: async (cursor) => {
        cursors.push(cursor)
        if (cursor) throw staleCursor
        return firstPage
      },
      resetFleetPages: () => {
        resets += 1
        if (resets === 1) throw resetAbort
      },
    })

    await expect(loadPage("expired")).rejects.toBe(resetAbort)
    await expect(loadPage("expired")).resolves.toBe(firstPage)

    expect(cursors).toEqual(["expired", "expired", ""])
    expect(resets).toBe(2)
  })
})

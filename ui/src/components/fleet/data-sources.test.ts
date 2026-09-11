import { describe, expect, it } from "vitest"

import {
  dataSurface,
  formatObservedAge,
  type DataSourceMap,
  type DataStateName,
} from "@/components/fleet/data-sources"

function sources(state: DataStateName, reason = ""): DataSourceMap {
  return {
    cost: {
      dataClass: "cost",
      state,
      provider: "rate-card",
      observedAtUnixMs: BigInt(1_725_000_000_000),
      stalenessBudgetMs: BigInt(86_400_000),
      unavailableReason: reason,
      retentionLimit: 0,
      retentionWindowMs: BigInt(0),
    },
  }
}

describe("dataSurface", () => {
  it("hides a surface the control plane has no source for", () => {
    const surface = dataSurface(
      sources("not_configured", "no cost source is configured"),
      "cost",
    )

    expect(surface.present).toBe(false)
    expect(surface.numeric).toBe(false)
  })

  it("hides a surface the caller may not see, without claiming it is absent", () => {
    expect(dataSurface(sources("forbidden"), "cost").present).toBe(false)
  })

  it("hides every surface when the capability probe has not answered", () => {
    expect(dataSurface(undefined, "cost").present).toBe(false)
    expect(dataSurface({}, "lifecycle").present).toBe(false)
  })

  it("keeps a configured-but-unavailable surface and carries the server's reason", () => {
    const surface = dataSurface(
      sources("not_available", "metrics.k8s.io is not served by this cluster"),
      "cost",
    )

    expect(surface.present).toBe(true)
    expect(surface.numeric).toBe(false)
    expect(surface.reason).toBe("metrics.k8s.io is not served by this cluster")
  })

  it("renders stale numbers but marks them as the last good sample", () => {
    const surface = dataSurface(sources("stale"), "cost")

    expect(surface.present).toBe(true)
    expect(surface.numeric).toBe(true)
    expect(surface.stale).toBe(true)
    expect(surface.observedAtUnixMs).toBe(BigInt(1_725_000_000_000))
  })

  it("renders a fresh surface without an age badge", () => {
    const surface = dataSurface(sources("ok"), "cost")

    expect(surface).toMatchObject({ present: true, numeric: true, stale: false })
  })
})

describe("formatObservedAge", () => {
  it("says nothing when there is no observation to age", () => {
    expect(formatObservedAge(undefined)).toBe("")
    expect(formatObservedAge(BigInt(0))).toBe("")
  })

  it("scales from seconds to days", () => {
    const now = 1_000_000_000
    expect(formatObservedAge(BigInt(now - 30_000), now)).toBe("30s old")
    expect(formatObservedAge(BigInt(now - 240_000), now)).toBe("4m old")
    expect(formatObservedAge(BigInt(now - 7_200_000), now)).toBe("2h old")
    expect(formatObservedAge(BigInt(now - 172_800_000), now)).toBe("2d old")
  })
})

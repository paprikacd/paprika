import { describe, expect, it } from "vitest"
import { chartMinimumSpan, pairRefinedSeries, refinedMinimumSpan, refineWindowQuery } from "./time-window"
import type { Series } from "./chart-data"

describe("refineWindowQuery", () => {
  it("queries a zoomed window in seconds at the policy step for its own span and the provider minimum", () => {
    const start = 1_700_000_000_000
    // A 1 h zoom at 300 target points is 12 s raw; with a 15 s minimum it samples at 15 s.
    // The bounds are the window itself: the chart crops to it, so padding would never show.
    expect(refineWindowQuery({ start, end: start + 3_600_000 }, 15)).toEqual({ start: start / 1000, end: (start + 3_600_000) / 1000, step: 15 })
    // A 2 h zoom is 24 s raw and rounds to the nearest rung on a log scale, 30 s.
    expect(refineWindowQuery({ start, end: start + 7_200_000 }, 15).step).toBe(30)
  })

  it("keeps the policy step when the provider has no minimum", () => {
    const start = 1_700_000_000_000
    expect(refineWindowQuery({ start, end: start + 3_600_000 }).step).toBe(10)
  })
})

describe("refinedMinimumSpan", () => {
  it("allows two provider steps, which can be narrower than the observed cadence", () => {
    const day = { start: 0, end: 86_400_000 }
    // Two 15 s steps is 30 s; the extent's ten-thousandth (8.64 s) is smaller, so the steps set the floor.
    expect(refinedMinimumSpan(day, 15)).toBe(30_000)
    // Without a provider minimum only the ten-thousandth applies.
    expect(refinedMinimumSpan(day)).toBe(8_640)
  })

  it("never exceeds the extent", () => {
    expect(refinedMinimumSpan({ start: 0, end: 1000 }, 15)).toBe(1000)
  })
})

describe("pairRefinedSeries", () => {
  const sample = (value: number) => [{ timestamp: 1000, value }]
  const api: Series = { name: "api", labels: { service: "api" }, points: sample(1) }
  const worker: Series = { name: "worker", labels: { service: "worker" }, points: sample(2) }

  it("returns the dashboard result unchanged when there is no refinement", () => {
    expect(pairRefinedSeries([api, worker], undefined)).toEqual([api, worker])
  })

  it("keeps the dashboard order and count when the refine returns a series the dashboard lacks", () => {
    const pod: Series = { name: "pod", labels: { pod: "short-lived" }, points: sample(9) }
    const paired = pairRefinedSeries([api], [pod, { ...api, points: sample(5) }])
    expect(paired).toHaveLength(1)
    expect(paired[0].points).toEqual(sample(5))
  })

  it("keeps the dashboard samples for a series the refine left out, in the dashboard order", () => {
    const paired = pairRefinedSeries([api, worker], [{ ...worker, points: sample(7) }])
    expect(paired.map(entry => entry.name)).toEqual(["api", "worker"])
    expect(paired[0]).toBe(api)
    expect(paired[1].points).toEqual(sample(7))
  })
})

describe("chartMinimumSpan", () => {
  const day = { start: 0, end: 86_400_000 }
  const series = [{ points: [{ timestamp: 0, value: 1 }, { timestamp: 1_800_000, value: 1 }] }]

  it("allows two provider steps only when the provider publishes its step", () => {
    expect(chartMinimumSpan(day, series, true, 15)).toBe(30_000)
  })

  it("falls back to the observed cadence for a provider that ignores step", () => {
    expect(chartMinimumSpan(day, series, true)).toBe(3_600_000)
    expect(chartMinimumSpan(day, series, false, 15)).toBe(3_600_000)
  })
})

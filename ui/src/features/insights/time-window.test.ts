import { describe, expect, it } from "vitest"
import { alignPriorPeriod, comparePriorPeriod, compareWindow, observationTimes, seriesInWindow } from "./time-window"
import type { Series } from "./chart-data"

const series: Series[] = [
  { name: "A", labels: { service: "one" }, points: [{ timestamp: 3000, value: 5 }, { timestamp: 1000, value: 0 }, { timestamp: 2000, value: null }, { timestamp: 4000, value: 8 }] },
  { name: "B", labels: {}, points: [{ timestamp: 2000, value: -2 }, { timestamp: 3000, value: 2 }] },
]

describe("time window comparison", () => {
  it("uses ordered unique real timestamps, including null samples", () => {
    expect(observationTimes(series)).toEqual([1000, 2000, 3000, 4000])
  })
  it("excludes timestamps outside the representable date range", () => {
    expect(observationTimes([{ name: "Bad", labels: {}, points: [{ timestamp: 9e15, value: 5 }, { timestamp: 1000, value: 1 }] }])).toEqual([1000])
  })
  it("retains null gaps and clips without changing the input", () => {
    expect(seriesInWindow(series, { start: 1000, end: 3000 })[0].points).toEqual([series[0].points[0], series[0].points[1], series[0].points[2]])
    expect(series[0].points).toHaveLength(4)
  })
  it("compares actual first and last valid observations inside the window", () => {
    const compared = compareWindow(series, { start: 1000, end: 3000 })
    expect(compared[0]).toMatchObject({ start: { timestamp: 1000, value: 0 }, end: { timestamp: 3000, value: 5 }, delta: 5, percent: undefined })
    expect(compared[1]).toMatchObject({ start: { timestamp: 2000, value: -2 }, end: { timestamp: 3000, value: 2 }, delta: 4, percent: 200 })
  })
  it("does not invent a difference for a series with fewer than two observations", () => {
    const compared = compareWindow(series, { start: 3000, end: 4000 })
    expect(compared[1].delta).toBeUndefined()
    expect(compared[1].percent).toBeUndefined()
  })
  it("does not display overflowing numeric differences", () => {
    const [result] = compareWindow([{ name: "huge", labels: {}, points: [{ timestamp: 1000, value: -1e308 }, { timestamp: 2000, value: 1e308 }] }], { start: 1000, end: 2000 })
    expect(result.delta).toBeUndefined()
    expect(result.percent).toBeUndefined()
  })
  it("compares each series against its own previous recorded sample, rejecting ambiguous matches", () => {
    const current: Series[] = [{ name: "A", labels: { service: "one" }, points: [{ timestamp: 10000, value: 12 }] }, { name: "A", labels: { service: "other" }, points: [{ timestamp: 10000, value: 7 }] }]
    const prior: Series[] = [{ name: "A", labels: { service: "one" }, points: [{ timestamp: 8999, value: 5 }, { timestamp: 9000, value: 6 }, { timestamp: 10000, value: 100 }] }, { name: "A", labels: { service: "other" }, points: [{ timestamp: 9000, value: 0 }] }]
    expect(comparePriorPeriod(current, prior, { start: 10000, end: 11000 })).toMatchObject([{ prior: { value: 6 }, actual: { value: 12 }, delta: 6, percent: 100 }, { prior: { value: 0 }, delta: 7, percent: undefined }])
    expect(comparePriorPeriod(current, [...prior, prior[0]], { start: 10000, end: 11000 })[0].prior).toBeUndefined()
  })
  it("includes fractional timestamps immediately before the boundary, but excludes the boundary itself", () => {
    const current: Series[] = [{ name: "A", labels: {}, points: [{ timestamp: 10000, value: 12 }] }]
    const previous: Series[] = [{ name: "A", labels: {}, points: [{ timestamp: 9999, value: 5 }, { timestamp: 9999.75, value: 8 }, { timestamp: 10000, value: 99 }] }]
    const window = { start: 10000, end: 11000 }
    expect(comparePriorPeriod(current, previous, window)[0]).toMatchObject({ prior: { timestamp: 9999.75, value: 8 }, delta: 4, percent: 50 })
    expect(alignPriorPeriod(current, previous, window)[0].original.points.at(-1)).toEqual({ timestamp: 9999.75, value: 8 })
  })
  it("aligns only uniquely matched preceding observations, retaining originals and null gaps", () => {
    const current: Series[] = [{ name: "A", labels: { service: "one" }, points: [{ timestamp: 10000, value: 12 }] }]
    const previous: Series[] = [{ name: "A", labels: { service: "one" }, points: [{ timestamp: 8999, value: 1 }, { timestamp: 9000, value: 5 }, { timestamp: 9500, value: null }, { timestamp: 9999, value: 7 }, { timestamp: 10000, value: 99 }] }]
    const [aligned] = alignPriorPeriod(current, previous, { start: 10000, end: 11000 })
    expect(aligned.original.points).toEqual([{ timestamp: 9000, value: 5 }, { timestamp: 9500, value: null }, { timestamp: 9999, value: 7 }])
    expect(aligned.shifted.points).toEqual([{ timestamp: 10000, value: 5 }, { timestamp: 10500, value: null }, { timestamp: 10999, value: 7 }])
    expect(previous[0].points).toHaveLength(5)
    expect(alignPriorPeriod(current, [...previous, previous[0]], { start: 10000, end: 11000 })).toEqual([])
    expect(alignPriorPeriod([...current, current[0]], previous, { start: 10000, end: 11000 })).toEqual([])
    expect(alignPriorPeriod(current, [{ ...previous[0], points: [{ timestamp: 9500, value: null }] }], { start: 10000, end: 11000 })).toEqual([])
  })
})

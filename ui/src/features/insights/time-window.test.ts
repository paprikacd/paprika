import { describe, expect, it } from "vitest"
import { alignPriorPeriod, comparePriorPeriod, compareWindow, formatChange, observationTimes, priorWindowQuery, seriesInWindow, statComparison } from "./time-window"
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

const DAY = 86_400_000
describe("stat comparison windows", () => {
  const window = { start: 10 * DAY, end: 10 * DAY + 3_600_000 }
  it("asks for the equal window before the range, or the same window one or seven days earlier, with the lens's bounds", () => {
    expect(priorWindowQuery(window, "previous")).toEqual({ start: (window.start - 3_600_000) / 1000, end: (window.start - 1) / 1000, step: 12 })
    expect(priorWindowQuery(window, "1d")).toEqual({ start: (window.start - DAY) / 1000, end: (window.end - DAY - 1) / 1000, step: 12 })
    expect(priorWindowQuery(window, "7d")).toMatchObject({ start: (window.start - 7 * DAY) / 1000 })
  })
  it("steps the earlier window with the same rule as the primary query", () => {
    expect(priorWindowQuery({ start: 20 * DAY, end: 20 * DAY + 3600_000 * 24 }, "previous")).toMatchObject({ step: Math.ceil(86400 / 300) })
  })
  it("reports unavailable with no earlier room, a span under one second, or a span over 31 days", () => {
    expect(priorWindowQuery({ start: 1 * DAY, end: 1 * DAY + 3_600_000 }, "1d")).toEqual({ unavailable: "no_previous_range" })
    expect(priorWindowQuery({ start: 10 * DAY, end: 10 * DAY + 500 }, "previous")).toEqual({ unavailable: "no_previous_range" })
    expect(priorWindowQuery({ start: 40 * DAY, end: 72 * DAY }, "previous")).toEqual({ unavailable: "no_previous_range" })
  })
})

describe("stat point-to-point comparison", () => {
  const window = { start: 10 * DAY, end: 10 * DAY + 3_600_000 }
  const stat = (points: Array<[number, number | null]>, name = "rate", labels = {}): Series => ({ name, labels, points: points.map(([timestamp, value]) => ({ timestamp, value })) })
  const now = [stat([[10 * DAY + 3_000_000, 4], [10 * DAY + 3_600_000, 12]])]
  const earlier = [stat([[10 * DAY - 3_600_000 + 1, 2], [10 * DAY - 1, 5], [10 * DAY, 99]])]
  it("compares the displayed sample with the latest valid sample before the range", () => {
    expect(statComparison(now, earlier, window, "previous")).toEqual({ state: "ok", current: { timestamp: 10 * DAY + 3_600_000, value: 12 }, baseline: { timestamp: 10 * DAY - 1, value: 5 }, delta: 7, percent: 140, direction: "up" })
  })
  it("uses the window one day earlier with its exclusive end", () => {
    const dayEarlier = [stat([[10 * DAY - DAY + 3_600_000 - 1, 6], [10 * DAY - DAY + 3_600_000, 50]])]
    expect(statComparison(now, dayEarlier, window, "1d")).toMatchObject({ state: "ok", baseline: { value: 6 }, delta: 6, direction: "up" })
  })
  it("ignores a newest current sample that is missing, comparing the last valid one", () => {
    expect(statComparison([stat([[10 * DAY + 3_000_000, 4], [10 * DAY + 3_600_000, null]])], earlier, window, "previous")).toMatchObject({ state: "ok", current: { value: 4 }, delta: -1, direction: "down" })
  })
  it("leaves the percentage out when the earlier value is zero, and never divides by a negative", () => {
    expect(statComparison(now, [stat([[10 * DAY - 1, 0]])], window, "previous")).toMatchObject({ state: "ok", delta: 12, percent: undefined })
    expect(statComparison([stat([[10 * DAY, -4]])], [stat([[10 * DAY - 1, -2]])], window, "previous")).toMatchObject({ delta: -2, percent: -100, direction: "down" })
  })
  it("reports why there is no comparison", () => {
    expect(statComparison(now, [], window, "previous")).toEqual({ state: "unavailable", reason: "no_prior_sample" })
    expect(statComparison([stat([[10 * DAY, null]])], earlier, window, "previous")).toEqual({ state: "unavailable", reason: "no_current_sample" })
    expect(statComparison(now, earlier, { start: DAY, end: DAY + 3_600_000 }, "1d")).toEqual({ state: "unavailable", reason: "no_previous_range" })
  })
  it("never pairs an ambiguous series", () => {
    expect(statComparison([...now, stat([[10 * DAY, 1]])], earlier, window, "previous")).toEqual({ state: "unavailable", reason: "ambiguous_series" })
    expect(statComparison(now, [...earlier, ...earlier], window, "previous")).toEqual({ state: "unavailable", reason: "ambiguous_series" })
  })
  it("is partial when the earlier response was truncated and matched", () => {
    expect(statComparison(now, earlier, window, "previous", true)).toMatchObject({ state: "partial", delta: 7 })
  })
  it("compares only the first series that has a sample, as the stat shows it", () => {
    const shown = [stat([[10 * DAY, null]], "empty"), stat([[10 * DAY + 3_600_000, 12]], "rate")]
    expect(statComparison(shown, [stat([[10 * DAY - 1, 5]], "rate")], window, "previous")).toMatchObject({ state: "ok", delta: 7 })
  })
})

describe("formatChange", () => {
  it("shows a relative headline, with the absolute change in the exact title", () => {
    expect(formatChange(1234.5, 12.345, "req/s", 1)).toMatchObject({ text: "+12.3%", direction: "up", form: "relative" })
    expect(formatChange(1234.5, 12.345, "req/s", 1).exactTitle).toBe("Exact change +1,234.5 req/s (+12.345%)")
  })
  it("reports percentage points for a percentage unit, never a percent of a percent", () => {
    expect(formatChange(-1.25, -10, "%", 1)).toMatchObject({ text: "-1.3 pp", direction: "down", form: "points" })
  })
  it("falls back to the absolute change in the widget unit, scaled, when the earlier value is zero", () => {
    expect(formatChange(314572800, undefined, "B", 0)).toMatchObject({ text: "+300 MiB", form: "absolute" })
    expect(formatChange(1200, undefined, "req/s", 1)).toMatchObject({ text: "+1.2K req/s", form: "absolute" })
  })
  it("shows an unsigned zero with no arrow when a change rounds away at the widget's decimals", () => {
    expect(formatChange(0.001, 0.001, "ms", 1)).toMatchObject({ text: "≈0.0%", direction: "flat" })
    expect(formatChange(0, 0, "", 1)).toMatchObject({ text: "0.0%", direction: "flat" })
  })
  it("pads a whole or zero percent to the widget's decimals, as every other percent does", () => {
    expect(formatChange(50, 50, "req/s", 2)).toMatchObject({ text: "+50.00%", direction: "up" })
    expect(formatChange(50.5, 50.5, "req/s", 2)).toMatchObject({ text: "+50.50%" })
    expect(formatChange(0.001, 0.001, "ms", 2)).toMatchObject({ text: "≈0.00%", direction: "flat" })
    expect(formatChange(50, 50, "req/s", 0)).toMatchObject({ text: "+50%" })
  })
  it("reads float noise as flat in Auto, never as an arrow or an exponent", () => {
    // 0.30000000000000004 against 0.3 is 5.55e-17, a relative change of 1.85e-14 percent.
    expect(formatChange(0.30000000000000004 - 0.3, (0.30000000000000004 - 0.3) / 0.3 * 100, "req/s")).toMatchObject({ text: "≈0%", direction: "flat" })
    expect(formatChange(1e-7, undefined, "%")).toMatchObject({ direction: "up" })
    expect(formatChange(5.55e-17, undefined, "", undefined, 0.3)).toMatchObject({ text: "≈0", direction: "flat" })
    expect(formatChange(1e-7, undefined, "", undefined, 0.3)).toMatchObject({ text: "≈0", direction: "flat" })
  })
  it("keeps a real change in Auto that the current reading can show", () => {
    expect(formatChange(0.5, 0.5, "req/s", undefined, 100)).toMatchObject({ text: "+0.5%", direction: "up" })
  })
  it("keeps explicit decimals in charge of their own rounding, even for a tiny change", () => {
    expect(formatChange(1e-7, undefined, "", 9, 0.3)).toMatchObject({ direction: "up" })
  })
  it("keeps a unit-less whole count whole, as other readings do", () => {
    expect(formatChange(4, undefined, "", 2).text).toBe("+4")
  })
})

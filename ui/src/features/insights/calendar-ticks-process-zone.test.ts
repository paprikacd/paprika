import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { calendarTickLabel, calendarTicks } from "./chart-presentation"

// Every test here runs with a process zone (London) that differs from the dashboard zone it names. A tick that followed
// the browser's midnight would then carry the wrong date, so these tests pin the dashboard zone's own calendar.
const HOUR = 3_600_000
const at = (iso: string) => Date.parse(iso)
const labelsOf = (ticks: ReturnType<typeof calendarTicks>, zone: string) => ticks.map((tick) => calendarTickLabel(tick, zone))
const gapsInHours = (ticks: ReturnType<typeof calendarTicks>) => ticks.slice(1).map((tick, index) => (tick.value - ticks[index].value) / HOUR)

describe("calendar ticks when the process zone is not the dashboard zone", () => {
  beforeEach(() => vi.stubEnv("TZ", "Europe/London"))
  afterEach(() => vi.unstubAllEnvs())

  it("labels a UTC dashboard across London's BST end with consecutive days, each shown once", () => {
    // London's clocks went back at 01:00Z on 25 October 2026. A UTC dashboard has no such night.
    const ticks = calendarTicks(at("2026-10-22T23:00:00Z"), at("2026-10-28T00:00:00Z"), 6, "UTC")
    expect(ticks.every((tick) => tick.grain === "day")).toBe(true)
    const labels = labelsOf(ticks, "UTC")
    expect(labels).toEqual(["Oct 23", "Oct 24", "Oct 25", "Oct 26", "Oct 27", "Oct 28"])
    expect(new Set(labels).size).toBe(labels.length)
    expect(gapsInHours(ticks)).toEqual([24, 24, 24, 24, 24])
  })

  it("keeps a UTC dashboard's ticks identical whatever the process zone is", () => {
    const start = at("2026-10-22T23:00:00Z"), end = at("2026-10-28T00:00:00Z")
    const underLondon = calendarTicks(start, end, 6, "UTC").map((tick) => tick.value)
    vi.stubEnv("TZ", "America/Los_Angeles")
    expect(calendarTicks(start, end, 6, "UTC").map((tick) => tick.value)).toEqual(underLondon)
  })

  it("places London's own midnights by true instant, so 25 October is a 25-hour day in London", () => {
    const ticks = calendarTicks(at("2026-10-23T12:00:00Z"), at("2026-10-27T12:00:00Z"), 6, "Europe/London")
    expect(labelsOf(ticks, "Europe/London")).toEqual(["Oct 24", "Oct 25", "Oct 26", "Oct 27"])
    expect(ticks.map((tick) => new Date(tick.value).toISOString())).toEqual([
      "2026-10-23T23:00:00.000Z",
      "2026-10-24T23:00:00.000Z",
      "2026-10-26T00:00:00.000Z",
      "2026-10-27T00:00:00.000Z",
    ])
    expect(gapsInHours(ticks)).toEqual([24, 25, 24])
  })

  it("keeps Melbourne's 23-hour day when its clocks move forward on 4 October 2026", () => {
    // Melbourne moves from 02:00 AEST to 03:00 AEDT at 16:00Z on 3 October, so midnight of 4 October is the 23-hour day's start.
    const ticks = calendarTicks(at("2026-10-02T14:00:00Z"), at("2026-10-06T00:00:00Z"), 5, "Australia/Melbourne")
    expect(labelsOf(ticks, "Australia/Melbourne")).toEqual(["Oct 3", "Oct 4", "Oct 5", "Oct 6"])
    expect(gapsInHours(ticks)).toEqual([24, 23, 24])
  })

  it("shows London's repeated 01:00 on 25 October once, so an hour axis never repeats a label", () => {
    // The clocks go back from 02:00 BST to 01:00 GMT, so 01:00 happens twice. The axis places it once, at a true instant.
    const ticks = calendarTicks(at("2026-10-24T22:00:00Z"), at("2026-10-25T04:00:00Z"), 8, "Europe/London")
    const labels = labelsOf(ticks, "Europe/London")
    expect(labels.filter((label) => label === "01:00")).toHaveLength(1)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it("keeps New York's 25-hour day on 1 November 2026, when its clocks go back", () => {
    const ticks = calendarTicks(at("2026-10-30T12:00:00Z"), at("2026-11-03T12:00:00Z"), 5, "America/New_York")
    expect(labelsOf(ticks, "America/New_York")).toEqual(["Oct 31", "Nov 1", "Nov 2", "Nov 3"])
    expect(gapsInHours(ticks)).toEqual([24, 25, 24])
  })
})

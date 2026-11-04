import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WidgetVisualization } from "./charts"
import { DashboardTimeZoneProvider } from "./dashboard-time-zone"
import type { QueryResult, Widget } from "./schema"

const HOUR = 3_600_000
const timeseries: Widget = {
  id: "load",
  title: "Load",
  type: "timeseries",
  providerId: "prom",
  query: "load",
  unit: "",
  layout: { x: 0, y: 0, w: 6, h: 4 },
  options: { timeAxis: "calendar" },
}
/** Samples every six hours from `start` to `end`, inclusive, so the plot spans exactly that window. */
function sampled(start: string, end: string): QueryResult {
  const points: { timestamp: number; value: number }[] = []
  for (let at = Date.parse(start); at <= Date.parse(end); at += 6 * HOUR) points.push({ timestamp: at, value: 1 })
  return { series: [{ name: "load", labels: {}, points }] }
}
const dayLabels = (container: HTMLElement) =>
  [...container.querySelectorAll("text")].map((node) => node.textContent ?? "").filter((label) => /^[A-Z][a-z]{2} \d{1,2}$/.test(label))

describe("calendar time axis when the process zone is London", () => {
  beforeEach(() => vi.stubEnv("TZ", "Europe/London"))
  afterEach(() => {
    vi.unstubAllEnvs()
    cleanup()
  })

  it("labels a UTC dashboard across the BST end with consecutive days, each shown once", () => {
    const { container } = render(
      <DashboardTimeZoneProvider timeZone="UTC">
        <WidgetVisualization widget={timeseries} result={sampled("2026-10-23T00:00:00Z", "2026-10-28T00:00:00Z")} />
      </DashboardTimeZoneProvider>,
    )
    expect(dayLabels(container)).toEqual(["Oct 23", "Oct 24", "Oct 25", "Oct 26", "Oct 27", "Oct 28"])
  })

  it("labels a London dashboard at London's own midnights, with 25 October once", () => {
    const { container } = render(
      <DashboardTimeZoneProvider timeZone="Europe/London">
        <WidgetVisualization widget={timeseries} result={sampled("2026-10-23T12:00:00Z", "2026-10-27T12:00:00Z")} />
      </DashboardTimeZoneProvider>,
    )
    expect(dayLabels(container)).toEqual(["Oct 24", "Oct 25", "Oct 26", "Oct 27"])
  })

  it("labels New York's 25-hour 1 November once, in order, when the process zone is London", () => {
    const { container } = render(
      <DashboardTimeZoneProvider timeZone="America/New_York">
        <WidgetVisualization widget={timeseries} result={sampled("2026-10-30T12:00:00Z", "2026-11-03T12:00:00Z")} />
      </DashboardTimeZoneProvider>,
    )
    expect(dayLabels(container)).toEqual(["Oct 31", "Nov 1", "Nov 2", "Nov 3"])
  })
})

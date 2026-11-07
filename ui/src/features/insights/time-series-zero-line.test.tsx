import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { WidgetVisualization } from "./charts"
import type { QueryResult, Widget } from "./schema"

afterEach(cleanup)

const timeseries: Widget = { id: "latency", title: "API latency", type: "timeseries", providerId: "prom", query: "latency", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, options: { display: "area" } }
const series = (samples: [number, number | null][]): QueryResult => ({
  series: [{ name: "api", labels: { service: "api" }, points: samples.map(([seconds, value]) => ({ timestamp: seconds * 1000, value })) }],
})

/** The y pixel of every point in an area path, read from its `M x,y L x,y ...` data. */
function pathYs(d: string): number[] {
  return [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map((match) => Number(match[2]))
}

/**
 * How one area's gradient sits on its path. Its stops are in objectBoundingBox units, so an offset maps across the path's
 * own top and bottom. The transparent stop is where the fade meets the zero line.
 */
function fillGeometry(fill: Element) {
  const id = fill.getAttribute("fill")!.replace(/^url\(#(.+)\)$/, "$1")
  const stops = [...document.getElementById(id)!.querySelectorAll("stop")].map((stop) => {
    const raw = stop.getAttribute("offset")!
    return { offset: raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw), opacity: Number(stop.getAttribute("stop-opacity")) }
  })
  const ys = pathYs(fill.getAttribute("d")!)
  const top = Math.min(...ys), bottom = Math.max(...ys)
  const transparent = stops.find((stop) => stop.opacity === 0)!
  return { stops, top, bottom, zeroPixel: top + transparent.offset * (bottom - top) }
}

const zeroGridline = (container: HTMLElement) => Number(container.querySelector('[data-ts-key="y-grid:number:0"]')!.getAttribute("y1"))

/** The pixel of any value on the y scale, interpolated linearly between two of the drawn gridlines. */
function pixelOfValue(container: HTMLElement, value: number) {
  const [first, last] = [...container.querySelectorAll('[data-ts-key^="y-grid:number:"]')].map((grid) => ({
    value: Number(grid.getAttribute("data-ts-key")!.split(":").pop()),
    pixel: Number(grid.getAttribute("y1")),
  }))
  return first.pixel + ((value - first.value) * (last.pixel - first.pixel)) / (last.value - first.value)
}

describe("zero-anchored area fills", () => {
  it("anchors every run of a gapped series on the chart's zero gridline, so a gap does not move the zero line", () => {
    // The first run is positive and the second is negative. Both fades must reach transparency on the y = 0 gridline.
    const { container } = render(<WidgetVisualization widget={timeseries} result={series([[1, 1], [2, 2], [3, 3], [4, null], [5, -2], [6, -1]])} />)
    const fills = [...container.querySelectorAll("g.ts-chart__area path")]
    expect(fills).toHaveLength(2)
    for (const fill of fills) expect(fillGeometry(fill).zeroPixel).toBeCloseTo(zeroGridline(container), 6)
  })

  it("fades a run that crosses zero toward the zero gridline from both of its extremes", () => {
    const { container } = render(<WidgetVisualization widget={timeseries} result={series([[1, 3], [2, -1], [3, 2]])} />)
    const [fill] = container.querySelectorAll("g.ts-chart__area path")
    const { stops, top, bottom, zeroPixel } = fillGeometry(fill)
    // Strongest at the highest and lowest values, transparent where the run meets zero.
    expect(stops.map((stop) => stop.opacity)).toEqual([0.28, 0, 0.28])
    expect(top).toBeLessThan(zeroGridline(container))
    expect(bottom).toBeGreaterThan(zeroGridline(container))
    expect(zeroPixel).toBeCloseTo(zeroGridline(container), 6)
  })

  it("fades toward the plot's bottom edge when an explicit minimum puts zero off the plot, not toward the off-plot zero", () => {
    // Zero is below the plot here, so the closing zero of the area lies beyond the bottom edge at the domain minimum, 50.
    const raised: Widget = { ...timeseries, options: { display: "area", min: 50 } }
    const { container } = render(<WidgetVisualization widget={raised} result={series([[1, 60], [2, 80], [3, 100]])} />)
    const [fill] = container.querySelectorAll("g.ts-chart__area path")
    const { stops, zeroPixel } = fillGeometry(fill)
    expect(container.querySelector('[data-ts-key="y-grid:number:0"]')).toBeNull()
    expect(stops.map((stop) => stop.opacity)).toEqual([0.28, 0, 0])
    expect(zeroPixel).toBeCloseTo(pixelOfValue(container, 50), 6)
  })
})

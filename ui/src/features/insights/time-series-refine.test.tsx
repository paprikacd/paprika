import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WidgetVisualization } from "./charts"
import { DashboardWindowProvider, type DashboardWindowActions } from "./dashboard-window"
import type { QueryResult, Widget } from "./schema"

afterEach(cleanup)
const widget: Widget = { id: "rate", title: "Rate", type: "timeseries", providerId: "provider", query: "rate", unit: "req/s", layout: { x: 0, y: 0, w: 6, h: 4 }, options: { decimals: 2 } }
const current: QueryResult = { series: [{ name: "api", labels: { service: "api" }, points: [{ timestamp: 10000, value: 10 }, { timestamp: 10500, value: 11 }, { timestamp: 11000, value: 12 }] }] }
// The finer result has a sample between the two dashboard samples that the zoom keeps.
const finer: QueryResult = { series: [{ name: "api", labels: { service: "api" }, points: [{ timestamp: 10500, value: 11 }, { timestamp: 10750, value: 11.5 }, { timestamp: 11000, value: 12 }] }] }

/** Zooms the chart to 10500..11000 through the Compare dialog, the same path a reader takes. */
function zoomToLaterHalf() {
  fireEvent.click(screen.getByRole("button", { name: "Compare window for Rate" }))
  fireEvent.change(screen.getByLabelText("Window start"), { target: { value: "1" } })
  fireEvent.click(screen.getByRole("button", { name: "Zoom chart to window" }))
}

/** The samples the chart plots now, across its series. */
function plottedSamples(): number {
  return Number(document.querySelector("[data-plotted-samples]")?.getAttribute("data-plotted-samples"))
}

function renderWith(actions: DashboardWindowActions) {
  return render(<DashboardWindowProvider value={actions}><WidgetVisualization widget={widget} result={current} /></DashboardWindowProvider>)
}

describe("chart-local zoom refine", () => {
  it("re-queries the zoomed window once after the drag settles and draws the finer samples", async () => {
    const refine = vi.fn(async (_window: { start: number; end: number }, _signal: AbortSignal) => finer)
    renderWith({ refine })
    zoomToLaterHalf()
    expect(refine).not.toHaveBeenCalled()
    await waitFor(() => expect(refine).toHaveBeenCalledTimes(1))
    expect(refine.mock.calls[0][0]).toEqual({ start: 10500, end: 11000 })
    await waitFor(() => expect(plottedSamples()).toBe(3))
  })

  it("keeps the crop of the dashboard samples while the refined samples load", async () => {
    let resolve!: (result: QueryResult) => void
    const refine = vi.fn(() => new Promise<QueryResult>(done => { resolve = done }))
    renderWith({ refine })
    zoomToLaterHalf()
    await waitFor(() => expect(refine).toHaveBeenCalledTimes(1))
    expect(plottedSamples()).toBe(2)
    resolve(finer)
    await waitFor(() => expect(plottedSamples()).toBe(3))
  })

  it("aborts a pending refine when the zoom is reset", async () => {
    const signals: AbortSignal[] = []
    const refine = vi.fn((_window, signal: AbortSignal) => { signals.push(signal); return new Promise<QueryResult>(() => {}) })
    renderWith({ refine })
    zoomToLaterHalf()
    await waitFor(() => expect(refine).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole("button", { name: "Reset chart zoom" }))
    expect(signals[0].aborted).toBe(true)
  })

  it("keeps the ready refinement and sends no second request when the previous period is overlaid", async () => {
    const refine = vi.fn(async (_window: { start: number; end: number }, _signal: AbortSignal) => finer)
    const previous = vi.fn(async () => current)
    renderWith({ refine, previous })
    zoomToLaterHalf()
    await waitFor(() => expect(plottedSamples()).toBe(3))
    fireEvent.click(screen.getByRole("button", { name: "Compare window for Rate" }))
    fireEvent.click(screen.getByRole("button", { name: "Compare previous period" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Overlay previous period" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "Overlay previous period" }))
    await waitFor(() => expect(screen.getByRole("group", { name: "Previous period overlay" })).toBeInTheDocument())
    // Outlast the refine debounce, so a request that the overlay would send has fired before the count is read.
    await new Promise(done => setTimeout(done, 400))
    expect(refine).toHaveBeenCalledTimes(1)
    expect(plottedSamples()).toBe(3)
  })

  it("marks the chart busy while the refined samples load and clears it when they arrive", async () => {
    let resolve!: (result: QueryResult) => void
    const refine = vi.fn(() => new Promise<QueryResult>(done => { resolve = done }))
    const { container } = renderWith({ refine })
    zoomToLaterHalf()
    await waitFor(() => expect(refine).toHaveBeenCalledTimes(1))
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    resolve(finer)
    await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull())
  })

  it("shows a visible cue while the finer samples load and removes it when they arrive", async () => {
    let resolve!: (result: QueryResult) => void
    const refine = vi.fn(() => new Promise<QueryResult>(done => { resolve = done }))
    renderWith({ refine })
    zoomToLaterHalf()
    await waitFor(() => expect(refine).toHaveBeenCalledTimes(1))
    expect(screen.getByText("Loading finer samples…")).toBeVisible()
    resolve(finer)
    await waitFor(() => expect(screen.queryByText("Loading finer samples…")).toBeNull())
  })

  it("keeps the crop and says so when the refine fails", async () => {
    const refine = vi.fn(async () => { throw new Error("upstream refused") })
    renderWith({ refine })
    zoomToLaterHalf()
    expect(await screen.findByText("Showing dashboard-resolution samples.")).toBeInTheDocument()
    expect(plottedSamples()).toBe(2)
  })
})

describe("chart-local zoom refine pairing and colours", () => {
  const two: QueryResult = {
    series: [
      { name: "api", labels: { service: "api" }, points: [{ timestamp: 10000, value: 10 }, { timestamp: 10500, value: 11 }, { timestamp: 11000, value: 12 }] },
      { name: "worker", labels: { service: "worker" }, points: [{ timestamp: 10000, value: 1 }, { timestamp: 10500, value: 2 }, { timestamp: 11000, value: 3 }] },
    ],
  }
  const finerPoints = finer.series?.[0].points ?? []
  const twoWorker = two.series?.[1]
  const apiFiner = { name: "api", labels: { service: "api" }, points: finerPoints }

  /** The legend swatch colours in the order the chart draws its series. */
  function swatchColors(): string[] {
    return [...document.querySelectorAll("[role='listitem'] [aria-hidden='true']")].map(node => (node as HTMLElement).style.background).filter(Boolean)
  }

  it("does not throw and keeps the dashboard series when the refine returns an extra series", async () => {
    const pod = { name: "pod", labels: { pod: "short-lived" }, points: [{ timestamp: 10600, value: 4 }, { timestamp: 10900, value: 5 }] }
    const refine = vi.fn(async () => ({ series: [apiFiner, pod] }))
    // One dashboard series: the refine returns the same series plus one the dashboard never sampled.
    render(<DashboardWindowProvider value={{ refine }}><WidgetVisualization widget={widget} result={current} /></DashboardWindowProvider>)
    zoomToLaterHalf()
    await waitFor(() => expect(refine).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(plottedSamples()).toBe(3))
    expect(document.querySelector("[data-series-count]")?.getAttribute("data-series-count")).toBe("1")
  })

  it("keeps each series colour and the series count when the refine returns fewer series", async () => {
    const refine = vi.fn(async () => ({ series: [{ ...twoWorker!, points: finerPoints }] }))
    render(<DashboardWindowProvider value={{ refine }}><WidgetVisualization widget={widget} result={two} /></DashboardWindowProvider>)
    const before = swatchColors()
    zoomToLaterHalf()
    await waitFor(() => expect(refine).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(plottedSamples()).toBe(2 + 3))
    expect(document.querySelector("[data-series-count]")?.getAttribute("data-series-count")).toBe("2")
    expect(swatchColors()).toEqual(before)
  })
})


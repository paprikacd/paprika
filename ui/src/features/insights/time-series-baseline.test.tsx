import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import type { Layout } from "react-grid-layout"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DashboardCanvas } from "./canvas"
import { BaselineContext, type BaselineState } from "./baseline-context"
import { WidgetVisualization } from "./charts"
import { exampleProviders } from "./example"
import type { Dashboard, QueryRequest, QueryResult, Widget } from "./schema"

vi.mock("react-grid-layout", async () => {
  const { useRef } = await import("react")
  const core = await import("react-grid-layout/core")
  return {
    default: ({ children }: { children: ReactNode; layout: Layout }) => <div>{children}</div>,
    useContainerWidth: () => ({ width: 1100, containerRef: useRef(null), mounted: true }),
    verticalCompactor: core.verticalCompactor,
  }
})

afterEach(() => { cleanup(); vi.unstubAllGlobals(); })

const HOUR_MS = 3_600_000
const provider = exampleProviders[0].id;
const widget: Widget = { id: "rate", title: "Rate", type: "timeseries", providerId: provider, query: "rate", unit: "req/s", layout: { x: 0, y: 0, w: 6, h: 4 }, options: { decimals: 2, baseline: { window: "previous" } } }
const minute = (index: number) => index * 60_000

// Ten current samples at one-minute steps; the earlier window holds the same minutes one hour before.
function series(values: number[], offsetMs = 0) {
  return { series: [{ name: "rate", labels: {}, points: values.map((value, index) => ({ timestamp: minute(index) + offsetMs, value })) }] } as QueryResult
}
const current = series([10, 10, 10, 10, 10, 50, 50, 50, 50, 50], HOUR_MS * 10)
const earlierFlat = series(Array(10).fill(10), HOUR_MS * 9)

function stateFor(overrides: Partial<BaselineState>): BaselineState {
  return { window: "previous", band: "range", offsetMs: HOUR_MS, stepMs: 60_000, span: 10 * HOUR_MS, state: "ready", ...overrides }
}

function renderBaseline(state: BaselineState, result: QueryResult, options: Widget["options"] = widget.options) {
  return render(
    <BaselineContext.Provider value={state}>
      <WidgetVisualization widget={{ ...widget, options }} result={result} />
    </BaselineContext.Provider>,
  )
}

describe("time-series baseline band", () => {
  it("draws one band per plotted series and marks the runs outside it", () => {
    const { container } = renderBaseline(stateFor({ prior: earlierFlat }), current)
    expect(container.querySelectorAll("[data-baseline-band]")).toHaveLength(1)
    expect(container.querySelectorAll("[data-baseline-run]")).toHaveLength(1)
    const footer = container.querySelector("[data-chart-footer]")!
    expect(within(footer as HTMLElement).getByText("Band: vs 10 h earlier")).toBeInTheDocument()
  })

  it("names the run in plain time, and marks no run for a single outside sample", () => {
    const { container } = renderBaseline(stateFor({ prior: earlierFlat }), current)
    const runs = container.querySelector("[data-baseline-runs]")
    expect(runs).toHaveTextContent(/Outside the 10 h earlier range \d\d:\d\d–\d\d:\d\d/)
    const single = series([10, 10, 10, 10, 10, 50, 10, 10, 10, 10], HOUR_MS * 10)
    const quiet = renderBaseline(stateFor({ prior: earlierFlat }), single)
    expect(quiet.container.querySelector("[data-baseline-runs]")).toBeNull()
    expect(quiet.container.querySelectorAll("[data-baseline-run]")).toHaveLength(0)
  })

  it("says why there is no band when the earlier period is unavailable", () => {
    renderBaseline(stateFor({ state: "unavailable" }), current)
    expect(screen.getByText("Baseline unavailable: no earlier period for this range")).toBeInTheDocument()
  })

  it("reports a partial earlier result", () => {
    renderBaseline(stateFor({ prior: earlierFlat, partial: true }), current)
    expect(screen.getByText("Partial earlier result")).toBeInTheDocument()
  })

  it("labels a rolling baseline by its samples", () => {
    const { container } = renderBaseline(stateFor({ window: "rolling", prior: undefined }), current, { ...widget.options, baseline: { window: "rolling" } })
    expect(container.querySelector("[data-baseline-chip]")).toHaveTextContent("Band: last 12 samples")
  })
})

describe("baseline query scope", () => {
  // A one-hour range ending at 10800 s, as the stat comparison tests use: the earlier window starts an hour before it.
  const dashboardWith = (options: Widget["options"]): Dashboard => ({
    schemaVersion: 1, id: "baseline", title: "Baseline", timeRange: "1h", refreshInterval: 0,
    widgets: [{ ...widget, options }],
  } as unknown as Dashboard)
  const END = 10_800, START = 7_200

  it("runs no earlier-window query for a rolling baseline", async () => {
    // Without an observer the tile counts as in view, so it queries at once, as the canvas lazy-query test does.
    vi.stubGlobal("IntersectionObserver", undefined)
    const fetcher = vi.fn(async (request: QueryRequest): Promise<QueryResult> => {
      void request
      return current
    })
    render(<DashboardCanvas dashboard={dashboardWith({ baseline: { window: "rolling" } })} providers={exampleProviders} fetcher={fetcher} end={END} editing={false} selected="" onSelect={vi.fn()} onLayout={vi.fn()} />)
    await act(() => new Promise(resolve => setTimeout(resolve, 30)))
    const starts = fetcher.mock.calls.map(([request]) => request.start)
    expect(starts.length).toBeGreaterThan(0)
    expect(starts.every(start => start === START)).toBe(true)
  })

  it("queries the earlier window once for a previous-period baseline", async () => {
    vi.stubGlobal("IntersectionObserver", undefined)
    const fetcher = vi.fn(async (request: QueryRequest): Promise<QueryResult> => request.start === START ? current : earlierFlat)
    render(<DashboardCanvas dashboard={dashboardWith({ baseline: { window: "previous" } })} providers={exampleProviders} fetcher={fetcher} end={END} editing={false} selected="" onSelect={vi.fn()} onLayout={vi.fn()} />)
    await waitFor(() => expect(fetcher.mock.calls.some(([request]) => request.start === START - HOUR_MS / 1000)).toBe(true))
  })
})

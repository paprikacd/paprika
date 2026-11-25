import { readFileSync } from "node:fs"
import { join } from "node:path"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApplicationDashboards, ApplicationMetricsLink } from "./application-insights"
import { ApplicationInsightsWidget, FRAME_TIMEOUT_MS, frameHeight } from "./application-insights-widget"

const coverage = vi.hoisted(() => ({ dashboards: undefined as unknown[] | undefined }))

vi.mock("@/lib/insights-coverage", () => ({
  useApplicationDashboards: () => ({ data: coverage.dashboards }),
}))

const checkout = { id: "service-overview", title: "Service overview", variables: { service: "checkout" }, specificity: 0 }

function frameOf(container: HTMLElement) {
  return container.querySelector("iframe") as HTMLIFrameElement
}

/** Fires the frame's load event as if it held the given page. A refused frame's location cannot be read. */
function loadFrame(frame: HTMLIFrameElement, pathname: string | null) {
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    get: () => ({
      get location() {
        if (pathname === null) throw new DOMException("Blocked a frame", "SecurityError")
        return { pathname }
      },
    }),
  })
  fireEvent.load(frame)
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("application Insights links", () => {
  beforeEach(() => {
    coverage.dashboards = undefined
  })

  it("renders nothing while loading, on failure or with no covering dashboard", () => {
    const { container, rerender } = render(<><ApplicationMetricsLink namespace="payments" name="checkout" /><ApplicationDashboards namespace="payments" name="checkout" unhealthy /></>)
    expect(container).toBeEmptyDOMElement()
    coverage.dashboards = []
    rerender(<><ApplicationMetricsLink namespace="payments" name="checkout" /><ApplicationDashboards namespace="payments" name="checkout" unhealthy /></>)
    expect(container).toBeEmptyDOMElement()
  })

  it("lists every covering dashboard, names the first to check when unhealthy, and frames its summary widget", () => {
    coverage.dashboards = [{ ...checkout, summaryWidgetId: "request-rate", summaryWidgetRows: 4 }, { id: "capacity", title: "Capacity", variables: {}, specificity: 0, folder: "Ops" }]
    const { container } = render(<ApplicationDashboards namespace="payments" name="checkout" unhealthy />)
    expect(screen.getByText(/Check its metrics/)).toBeInTheDocument()
    const links = screen.getAllByRole("link").map((link) => link.getAttribute("href"))
    expect(links.filter((href) => href?.endsWith("dashboard=capacity"))).toHaveLength(1)
    expect(links.filter((href) => href?.includes("dashboard=service-overview"))).toHaveLength(2)
    const frame = frameOf(container)
    expect(frame).toHaveAttribute("title", "Service overview: summary widget")
    expect(frame.parentElement!.style.height).toBe(`${frameHeight(4)}px`)
  })

  it("leaves out the notice for a healthy application", () => {
    coverage.dashboards = [checkout]
    const { container } = render(<ApplicationDashboards namespace="payments" name="checkout" unhealthy={false} />)
    expect(screen.queryByText(/Check its metrics/)).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Service overview" })).toBeInTheDocument()
    expect(frameOf(container)).toBeNull()
  })

  it("imports no Insights code into the application page", () => {
    for (const file of ["application-insights.tsx", "application-insights-widget.tsx"]) {
      const source = readFileSync(join(process.cwd(), "src/components/dashboard", file), "utf8")
      expect(source).not.toMatch(/insights-console-client|features\/insights|next\/dynamic/)
    }
  })
})

describe("application Insights widget frame", () => {
  const props = { dashboardId: "service-overview", widgetId: "request-rate", variables: { service: "checkout" }, title: "Service overview", href: "/dashboard/insights/?dashboard=service-overview" }

  it("frames the Insights page in embed mode, lazily, at the widget's height", () => {
    const { container } = render(<ApplicationInsightsWidget {...props} rows={2} />)
    const frame = frameOf(container)
    const src = new URL(frame.getAttribute("src")!, "http://console.test")
    expect(src.origin).toBe("http://console.test")
    expect(src.pathname).toBe("/dashboard/insights/")
    expect(Object.fromEntries(src.searchParams)).toEqual({ dashboard: "service-overview", embed: "request-rate", theme: "light", vars: '{"service":"checkout"}' })
    expect(frame).toHaveAttribute("loading", "lazy")
    // Same origin and scripts are needed for the shared session, so the frame is not sandboxed.
    expect(frame).not.toHaveAttribute("sandbox")
    expect(frame.parentElement!.style.height).toBe("160px")
    expect(frameHeight(undefined)).toBe(234)
    expect(frameHeight(1)).toBe(120)
    expect(frameHeight(12)).toBe(560)
  })

  it("renders no frame for an id the Insights schema refuses", () => {
    const { container } = render(<ApplicationInsightsWidget {...props} dashboardId="//evil.example" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows loading until the frame holds the Insights page", () => {
    const { container } = render(<ApplicationInsightsWidget {...props} />)
    expect(screen.getByRole("status")).toHaveTextContent("Loading metrics…")
    expect(frameOf(container)).toHaveClass("invisible")
    loadFrame(frameOf(container), "/dashboard/insights/")
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(frameOf(container)).not.toHaveClass("invisible")
  })

  it("reports a refused frame and retries with a new frame", () => {
    const { container } = render(<ApplicationInsightsWidget {...props} />)
    loadFrame(frameOf(container), null)
    expect(screen.getByRole("alert")).toHaveTextContent("The metrics widget did not load.")
    expect(frameOf(container)).toBeNull()
    expect(screen.getByRole("link", { name: "Open dashboard" }).getAttribute("href")).toMatch(/^\/dashboard\/insights\/?\?dashboard=service-overview$/)
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(screen.getByRole("status")).toHaveTextContent("Loading metrics…")
    loadFrame(frameOf(container), "/login/")
    expect(screen.getByRole("alert")).toBeInTheDocument()
  })

  it("gives up after the load timeout, counted from when the lazy frame nears the viewport", () => {
    vi.useFakeTimers()
    const observers: Array<() => void> = []
    vi.stubGlobal("IntersectionObserver", class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe() { observers.push(() => this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)) }
      unobserve() {}
      disconnect() {}
    })
    render(<ApplicationInsightsWidget {...props} />)
    act(() => { vi.advanceTimersByTime(FRAME_TIMEOUT_MS * 2) })
    // Off screen, the frame has not started loading, so it has not failed.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    act(() => observers.forEach((enter) => enter()))
    act(() => { vi.advanceTimersByTime(FRAME_TIMEOUT_MS - 1) })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.getByRole("alert")).toHaveTextContent("The metrics widget did not load.")
  })
})

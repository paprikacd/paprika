import { readFileSync } from "node:fs"
import { join } from "node:path"
import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApplicationDashboards, ApplicationMetricsLink } from "./application-insights"

const coverage = vi.hoisted(() => ({ dashboards: undefined as unknown[] | undefined }))

vi.mock("@/lib/insights-coverage", () => ({
  useApplicationDashboards: () => ({ data: coverage.dashboards }),
}))
// The summary widget is a lazy chunk; the list must not wait for it.
vi.mock("./application-insights-widget", () => ({
  ApplicationInsightsWidget: ({ widgetId }: { widgetId: string }) => <p>widget {widgetId}</p>,
}))

const checkout = { id: "service-overview", title: "Service overview", variables: { service: "checkout" }, specificity: 0 }

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

  it("lists every covering dashboard and names the first to check when unhealthy", async () => {
    coverage.dashboards = [{ ...checkout, summaryWidgetId: "request-rate" }, { id: "capacity", title: "Capacity", variables: {}, specificity: 0, folder: "Ops" }]
    render(<ApplicationDashboards namespace="payments" name="checkout" unhealthy />)
    expect(screen.getByText(/Check its metrics/)).toBeInTheDocument()
    const links = screen.getAllByRole("link").map((link) => link.getAttribute("href"))
    expect(links.filter((href) => href?.endsWith("dashboard=capacity"))).toHaveLength(1)
    expect(links.filter((href) => href?.includes("dashboard=service-overview"))).toHaveLength(2)
    expect(await screen.findByText("widget request-rate")).toBeInTheDocument()
  })

  it("leaves out the notice for a healthy application", () => {
    coverage.dashboards = [checkout]
    render(<ApplicationDashboards namespace="payments" name="checkout" unhealthy={false} />)
    expect(screen.queryByText(/Check its metrics/)).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Service overview" })).toBeInTheDocument()
  })

  it("loads the widget wrapper, and with it the Insights client, only on demand", () => {
    const source = readFileSync(join(process.cwd(), "src/components/dashboard/application-insights.tsx"), "utf8")
    expect(source).not.toMatch(/^import[^\n]*(application-insights-widget|insights-console-client|features\/insights)/m)
    expect(source).toMatch(/dynamic\(\s*\(\) => import\("\.\/application-insights-widget"\)/)
  })
})

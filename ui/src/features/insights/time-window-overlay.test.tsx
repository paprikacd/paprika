import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WidgetVisualization } from "./charts"
import { DashboardWindowProvider } from "./dashboard-window"
import type { QueryResult, Widget } from "./schema"

afterEach(cleanup)
const widget: Widget = { id: "rate", title: "Rate", type: "timeseries", providerId: "provider", query: "rate", unit: "req/s", layout: { x: 0, y: 0, w: 6, h: 4 }, options: { decimals: 2 } }
const current: QueryResult = { series: [{ name: "api", labels: { service: "api" }, points: [{ timestamp: 10000, value: 10 }, { timestamp: 10500, value: null }, { timestamp: 11000, value: 12 }] }] }
const earlier: QueryResult = { series: [{ name: "api", labels: { service: "api" }, points: [{ timestamp: 9000, value: 4 }, { timestamp: 9500, value: null }, { timestamp: 9999, value: 8 }] }] }

describe("previous-period plot overlay", () => {
  it("plots the matched preceding observations as a distinct aligned series and removes it on reset or query change", async () => {
    const previous = vi.fn(async () => earlier)
    const view = render(<DashboardWindowProvider value={{ previous }}><WidgetVisualization widget={widget} result={current} /></DashboardWindowProvider>)
    fireEvent.click(screen.getByRole("button", { name: "Compare window for Rate" }))
    fireEvent.click(screen.getByRole("button", { name: "Compare previous period" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Overlay previous period" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "Overlay previous period" }))
    const legend = screen.getByRole("group", { name: "Previous period overlay" })
    expect(legend).toHaveTextContent("dashed · aligned")
    expect(legend).toHaveTextContent("8.00 req/s")
    const label = legend.querySelector("[data-prior-series]")!
    expect(label).toHaveAttribute("data-prior-original-first", "9000")
    expect(label).toHaveAttribute("data-prior-aligned-first", "10000")
    expect(within(legend).getByText(/8.00 req\/s/).closest("span")).toHaveAttribute("title", expect.stringContaining(new Date(9999).toISOString()))
    fireEvent.click(screen.getByRole("button", { name: "Inspect chart data for Rate · Previous period" }))
    const dialog = screen.getByRole("dialog", { name: "Rate · Previous period data" })
    expect(within(dialog).getByText(new Date(9000).toISOString())).toBeInTheDocument()
    expect(within(dialog).getByText("No data")).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole("button", { name: "Close data" }))
    fireEvent.click(screen.getByRole("button", { name: "Reset chart zoom" }))
    expect(screen.queryByRole("group", { name: "Previous period overlay" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Compare window for Rate" }))
    fireEvent.click(screen.getByRole("button", { name: "Compare previous period" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Overlay previous period" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "Overlay previous period" }))
    view.rerender(<DashboardWindowProvider value={{ previous }}><WidgetVisualization widget={widget} result={{ series: [{ ...current.series![0], points: [{ timestamp: 20000, value: 99 }, { timestamp: 21000, value: 100 }] }] }} /></DashboardWindowProvider>)
    expect(screen.queryByRole("group", { name: "Previous period overlay" })).not.toBeInTheDocument()
  })
})

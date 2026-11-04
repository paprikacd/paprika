import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { TimeWindowLens } from "./time-window-lens"
import { DashboardWindowProvider } from "./dashboard-window"

const series = [{ name: "Requests", labels: {}, points: [{ timestamp: 1000, value: 4 }, { timestamp: 2000, value: null }, { timestamp: 3000, value: 10 }, { timestamp: 4000, value: 12 }] }]

describe("time window lens", () => {
  it("compares recorded samples and applies an accessible selected window", () => {
    const onZoom = vi.fn()
    render(<TimeWindowLens title="Request rate" series={series} unit="req/s" onZoom={onZoom} onReset={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /compare window/i }))
    fireEvent.change(screen.getByRole("slider", { name: "Window start" }), { target: { value: "1" } })
    expect(screen.getByText(/\+2 req\/s/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Zoom chart to window" }))
    expect(onZoom).toHaveBeenCalledWith({ start: 2000, end: 4000 })
  })
  it("clears a zoom without changing the saved dashboard", () => {
    const onReset = vi.fn()
    render(<TimeWindowLens title="Request rate" series={series} unit="" zoom={{ start: 1000, end: 3000 }} onZoom={() => {}} onReset={onReset} />)
    fireEvent.click(screen.getByRole("button", { name: "Reset chart zoom" }))
    expect(onReset).toHaveBeenCalledOnce()
  })
  it("respects configured precision without presenting a tiny change as exactly zero", () => {
    const tiny = [{ name: "Error ratio", labels: {}, points: [{ timestamp: 1000, value: .8000001 }, { timestamp: 2000, value: .8000002 }] }]
    render(<TimeWindowLens title="Errors" series={tiny} unit="%" decimals={2} onZoom={() => {}} onReset={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /compare window/i }))
    expect(screen.getByText("≈0.00 pp")).toHaveAttribute("aria-label", expect.stringContaining("Exact change"))
    expect(screen.getAllByText("0.80%")).toHaveLength(2)
  })
  it("does not offer timestamps that exist only in hidden series", () => {
    const visible = Array.from({ length: 12 }, (_, i) => ({ name: `Series ${i}`, labels: {}, points: [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: 2 }] }))
    const hidden = { name: "Hidden", labels: {}, points: [{ timestamp: 9000, value: 3 }, { timestamp: 10000, value: 4 }] }
    render(<TimeWindowLens title="Requests" series={[...visible, hidden]} unit="" onZoom={() => {}} onReset={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /compare window/i }))
    expect(screen.getByRole("slider", { name: "Window end" })).toHaveAttribute("max", "1")
  })
  it("compares all displayed record series with their own units", () => {
    const mixed = Array.from({ length: 16 }, (_, i) => ({ name: `Series ${i}`, labels: {}, points: [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: 2 }] }))
    render(<TimeWindowLens title="Records" series={mixed} maxSeries={24} seriesUnits={mixed.map((_, i) => i === 15 ? "ms" : "%")} unit="" onZoom={() => {}} onReset={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /compare window/i }))
    const row = screen.getByRole("row", { name: /Series 15/ })
    expect(within(row).getByText("+1 ms")).toBeInTheDocument()
    expect(within(screen.getByRole("row", { name: /Series 0/ })).getByText("+1 pp")).toBeInTheDocument()
  })
  it("queries a preceding period only on request and applies a runtime dashboard range", async () => {
    const apply = vi.fn(), previous = vi.fn(async () => ({ series: [{ name: "Requests", labels: {}, points: [{ timestamp: 500, value: 2 }] }] }))
    render(<DashboardWindowProvider value={{ apply, previous }}><TimeWindowLens title="Request rate" series={series} unit="req/s" onZoom={() => {}} onReset={() => {}} /></DashboardWindowProvider>)
    fireEvent.click(screen.getByRole("button", { name: /compare window/i }))
    expect(previous).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Compare previous period" }))
    await waitFor(() => expect(screen.getByRole("region", { name: "Previous period results" })).toBeInTheDocument())
    const result = screen.getByRole("region", { name: "Previous period results" })
    expect(within(result).getByText("+10 req/s")).toBeInTheDocument()
    expect(previous).toHaveBeenCalledWith({ start: 1000, end: 4000 }, expect.any(AbortSignal))
    fireEvent.click(screen.getByRole("button", { name: "Apply to dashboard" }))
    expect(apply).toHaveBeenCalledWith({ start: 1000, end: 4000 })
  })
  it("only enables the overlay after a uniquely matched prior series has real values", async () => {
    const onOverlay = vi.fn(), data = { series: [{ name: "Requests", labels: {}, points: [{ timestamp: 500, value: 2 }] }] }
    const previous = vi.fn(async () => data)
    render(<DashboardWindowProvider value={{ previous }}><TimeWindowLens title="Request rate" series={series} unit="req/s" onZoom={() => {}} onReset={() => {}} onOverlay={onOverlay} /></DashboardWindowProvider>)
    fireEvent.click(screen.getByRole("button", { name: /compare window/i }))
    expect(screen.queryByRole("button", { name: "Overlay previous period" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Compare previous period" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Overlay previous period" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "Overlay previous period" }))
    expect(onOverlay).toHaveBeenCalledWith({ start: 1000, end: 4000 }, data)
  })
  it("cancels an obsolete previous-period request when the selection changes", async () => {
    let signal: AbortSignal | undefined
    const previous = vi.fn((_window, next: AbortSignal) => { signal = next; return new Promise<never>(() => {}) })
    render(<DashboardWindowProvider value={{ previous }}><TimeWindowLens title="Request rate" series={series} unit="req/s" onZoom={() => {}} onReset={() => {}} /></DashboardWindowProvider>)
    fireEvent.click(screen.getByRole("button", { name: /compare window/i }))
    fireEvent.click(screen.getByRole("button", { name: "Compare previous period" }))
    expect(signal?.aborted).toBe(false)
    fireEvent.change(screen.getByRole("slider", { name: "Window start" }), { target: { value: "1" } })
    await waitFor(() => expect(signal?.aborted).toBe(true))
    expect(screen.queryByText("Querying the preceding period…")).not.toBeInTheDocument()
  })
})

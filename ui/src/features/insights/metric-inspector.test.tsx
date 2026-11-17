import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { InsightsClient, ProviderMetadata } from "./client"
import { MetricInspector } from "./metric-inspector"
import { QueryBuilder } from "./query-builder"

vi.mock("./charts", () => ({ WidgetVisualization: () => null }))

const stats: ProviderMetadata = { values: [], series: {
  count: 3, limit: 1000, start: 1760000000, end: 1760086400,
  labels: [{ name: "job", cardinality: 1, values: ["paprika"] }, { name: "service", cardinality: 2, values: ["api", "worker"] }],
} }
const props = { providerId: "prod", metric: "up", labels: ["job", "service"], labelsLoading: false, labelsUnavailable: false, labelsTruncated: false, canAddFilter: true, onAddFilter: vi.fn() }

describe("metric inspection", () => {
  it("loads series only on explicit inspection, exposes cardinality and adds an exact label filter", async () => {
    const metadata = vi.fn().mockResolvedValue(stats)
    const add = vi.fn()
    render(<MetricInspector {...props} client={{ metadata } as unknown as InsightsClient} onAddFilter={add} />)
    expect(metadata).not.toHaveBeenCalled()
    const opener = screen.getByRole("button", { name: "Inspect metric" })
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole("dialog", { name: "up" })
    expect(screen.getByRole("button", { name: "Close metric inspector" })).toHaveFocus()
    await waitFor(() => expect(within(dialog).getByText("3")).toBeInTheDocument())
    expect(metadata).toHaveBeenCalledWith("prod", { kind: "series", metric: "up" }, expect.any(AbortSignal))
    expect(within(dialog).getByText(/24-hour window is approximate/)).toBeInTheDocument()
    const label = within(dialog).getByText("service").closest("details")!
    fireEvent.click(label.querySelector("summary")!)
    fireEvent.click(await screen.findByRole("button", { name: 'Filter service = "api"' }))
    expect(add).toHaveBeenCalledWith("service", "api")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it("retains available labels and fetches their values when cardinality fails without leaking raw errors", async () => {
    const metadata = vi.fn((_id: string, options: Parameters<InsightsClient["metadata"]>[1]) => options.kind === "series" ? Promise.reject(new Error("private endpoint credential")) : Promise.resolve({ values: ["api"] }))
    render(<MetricInspector {...props} client={{ metadata } as unknown as InsightsClient} />)
    fireEvent.click(screen.getByRole("button", { name: "Inspect metric" }))
    expect(await screen.findByText(/Cardinality unavailable/)).toBeInTheDocument()
    expect(screen.queryByText(/private endpoint/)).not.toBeInTheDocument()
    const label = screen.getByText("service").closest("details")!
    fireEvent.click(label.querySelector("summary")!)
    expect(await screen.findByRole("button", { name: 'Filter service = "api"' })).toBeInTheDocument()
    expect(metadata).toHaveBeenCalledWith("prod", { kind: "values", label: "service", metric: "up" }, expect.any(AbortSignal))
    fireEvent.click(screen.getByRole("button", { name: "Retry cardinality" }))
    await waitFor(() => expect(metadata.mock.calls.filter((call) => call[1].kind === "series")).toHaveLength(2))
  })

  it("cancels inspection on close and ignores a late response after a different metric is selected", async () => {
    let resolve!: (data: ProviderMetadata) => void
    const metadata = vi.fn((_id: string, options: Parameters<InsightsClient["metadata"]>[1]) => options.metric === "up" ? new Promise<ProviderMetadata>((done) => { resolve = done }) : Promise.resolve({ values: [], series: { ...stats.series!, count: 0, labels: [] } }))
    const client = { metadata } as unknown as InsightsClient
    const { rerender } = render(<MetricInspector {...props} client={client} />)
    fireEvent.click(screen.getByRole("button", { name: "Inspect metric" }))
    const signal = (metadata.mock.calls as unknown as Parameters<InsightsClient["metadata"]>[])[0][2]!
    fireEvent.click(screen.getByRole("button", { name: "Close metric inspector" }))
    expect(signal.aborted).toBe(true)
    rerender(<MetricInspector {...props} metric="new_metric" labels={[]} client={client} />)
    fireEvent.click(screen.getByRole("button", { name: "Inspect metric" }))
    await act(async () => resolve(stats))
    expect(await screen.findByText("No labels found for this metric in the discovery window.")).toBeInTheDocument()
    expect(screen.queryByText("service")).not.toBeInTheDocument()
  })

  it("identifies bounded counts and samples and disables adding filters at the builder limit", async () => {
    const metadata = vi.fn().mockResolvedValue({ ...stats, series: { ...stats.series, truncated: true, sample: true, count: 1000, labels: [{ name: "service", cardinality: 1000, values: ["api"], valuesTruncated: true }] } })
    render(<MetricInspector {...props} client={{ metadata } as unknown as InsightsClient} canAddFilter={false} />)
    fireEvent.click(screen.getByRole("button", { name: "Inspect metric" }))
    expect(await screen.findByText(/series and cardinalities are lower bounds/)).toBeInTheDocument()
    expect(screen.getByText(/Example metadata/)).toBeInTheDocument()
    const label = screen.getByText("service").closest("details")!
    fireEvent.click(label.querySelector("summary")!)
    expect(await screen.findByRole("button", { name: 'Filter service = "api"' })).toBeDisabled()
    expect(screen.getByText(/Showing up to 12 short values/)).toBeInTheDocument()
  })

  it("adds inspected label values to the generated draft without running or applying it", async () => {
    const metadata = vi.fn((_id: string, options: Parameters<InsightsClient["metadata"]>[1]) => Promise.resolve(options.kind === "series" ? stats : { values: options.kind === "metrics" ? ["up"] : ["job", "service"] }))
    const onChange = vi.fn(), query = vi.fn()
    render(<QueryBuilder widget={{ id: "w", title: "Up", type: "timeseries", providerId: "prod", query: "up", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 } }} compact defaultExpanded showRunControl={false} client={{ metadata, query } as unknown as InsightsClient} onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: "Inspect metric" }))
    await screen.findByText("Stored series · last 24h")
    const label = (await screen.findByText("service")).closest("details")!
    fireEvent.click(label.querySelector("summary")!)
    fireEvent.click(await screen.findByRole("button", { name: 'Filter service = "api"' }))
    expect(screen.getByLabelText("Generated query")).toHaveTextContent('up{service="api"}')
    expect(onChange).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Use generated query" }))
    expect(onChange).toHaveBeenCalledWith('up{service="api"}')
  })
})

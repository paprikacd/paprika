import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { useState } from "react"
import { QueryBuilder, buildPromQL, type GuidedQuery } from "./query-builder"
import { changeQueryEditor, readQueryEditor } from "./query-code-editor.test-utils"
import type { InsightsClient, ProviderMetadata } from "./client"
import type { QueryRequest, QueryResult, Widget } from "./schema"

vi.mock("./charts", () => ({
  WidgetVisualization: ({
    result,
    loading,
    error,
  }: {
    result?: QueryResult
    loading: boolean
    error?: string
  }) => (
    <div>
      {loading
        ? "Query loading"
        : (error ?? result?.series?.[0]?.name ?? "No preview")}
    </div>
  ),
}))
const widget: Widget = {
  id: "w",
  title: "Requests",
  type: "timeseries",
  providerId: "prod",
  query: "up",
  unit: "",
  layout: { x: 0, y: 0, w: 6, h: 4 },
}
const basic: GuidedQuery = {
  metric: "http_requests_total",
  filters: [],
  rate: "none",
  window: "5m",
  aggregation: "none",
  groupBy: "",
}

describe("guided PromQL construction", () => {
  it("quotes matcher values rather than allowing their content to become expression syntax", () => {
    const value = 'service\"} or vector(999) #\n\\path'
    expect(
      buildPromQL({
        ...basic,
        filters: [{ label: "job", operator: "=", value }],
      }),
    ).toBe(`http_requests_total{job=${JSON.stringify(value)}}`)
  })
  it("combines filters, counter rate and grouping in the correct order", () => {
    expect(
      buildPromQL({
        ...basic,
        filters: [
          { label: "job", operator: "=~", value: "api|worker" },
          { label: "code", operator: "!=", value: "500" },
        ],
        rate: "rate",
        aggregation: "sum",
        groupBy: "service, region",
      }),
    ).toBe(
      'sum by (service, region) (rate(http_requests_total{job=~"api|worker",code!="500"}[5m]))',
    )
  })
  it.each([
    { ...basic, metric: "up or vector(1)" },
    {
      ...basic,
      filters: [{ label: "job} or up", operator: "=" as const, value: "api" }],
    },
    { ...basic, rate: "rate" as const, window: "5m]) or up" },
    { ...basic, rate: "rate" as const, window: "0m" },
    { ...basic, aggregation: "sum" as const, groupBy: "job, job" },
    { ...basic, aggregation: "sum" as const, groupBy: "job) (up) #" },
  ])("rejects unsafe or invalid structural inputs", (draft) =>
    expect(() => buildPromQL(draft)).toThrow(),
  )
})

describe("query editor", () => {
  it("gates touched invalid live guidance and releases it on code edits or closing", async () => {
    const validity = vi.fn(), onChange = vi.fn();
    render(<QueryBuilder widget={widget} onChange={onChange} onValidityChange={validity} defaultExpanded live />);
    await screen.findByRole("combobox", { name: "Function" });
    expect(validity).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("combobox", { name: "Function" }));
    fireEvent.click(screen.getByRole("option", { name: "Rate per second" }));
    fireEvent.change(screen.getByLabelText("Rate window"), { target: { value: "0m" } });
    expect(validity).toHaveBeenLastCalledWith(false);
    const details = screen.getByText("Guided query builder").closest("details")!;
    details.open = false; fireEvent(details, new Event("toggle"));
    expect(validity).toHaveBeenLastCalledWith(true);
    details.open = true; fireEvent(details, new Event("toggle"));
    expect(validity).toHaveBeenLastCalledWith(false);
    changeQueryEditor(screen.getByLabelText("PromQL query"), "sum(up)");
    expect(validity).toHaveBeenLastCalledWith(true);
    expect(onChange).toHaveBeenLastCalledWith("sum(up)");
  });

  it("does not block an untouched guided builder for an arbitrary code expression", async () => {
    const validity = vi.fn(), onChange = vi.fn();
    render(<QueryBuilder widget={{ ...widget, query: "sum(rate(http_requests_total[5m]))" }} onChange={onChange} onValidityChange={validity} defaultExpanded live />);
    await screen.findByRole("combobox", { name: "Function" });
    expect(validity).toHaveBeenLastCalledWith(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("previews valid guided changes in live mode without overwriting code on open", async () => {
    const onChange = vi.fn();
    render(<QueryBuilder widget={widget} onChange={onChange} defaultExpanded live />);
    await screen.findByRole("combobox", { name: "Function" });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("combobox", { name: "Function" }));
    fireEvent.click(screen.getByRole("option", { name: "Rate per second" }));
    expect(onChange).toHaveBeenLastCalledWith("rate(up[5m])");
    onChange.mockClear();
    fireEvent.change(screen.getByLabelText("Rate window"), { target: { value: "-1" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Rate window"), { target: { value: "10m" } });
    expect(onChange).toHaveBeenLastCalledWith("rate(up[10m])");
  });

  it("switches compact Builder and Code modes without losing the staged expression", () => {
    const changes = vi.fn()
    function Workspace() {
      const [query, setQuery] = useState("up")
      return <QueryBuilder widget={{ ...widget, query }} compact defaultExpanded showRunControl={false} onChange={(next) => { changes(next); setQuery(next) }} />
    }
    render(<Workspace />)
    expect(screen.getByRole("tab", { name: "Builder" })).toHaveAttribute("aria-selected", "true")
    expect(screen.queryByRole("textbox", { name: "PromQL query" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("combobox", { name: "Function" }))
    fireEvent.click(screen.getByRole("option", { name: "Rate per second" }))
    fireEvent.change(screen.getByLabelText("Rate window"), { target: { value: "10m" } })
    expect(changes).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole("tab", { name: "Builder" }), { key: "ArrowRight" })
    expect(screen.getByRole("tab", { name: "Code" })).toHaveFocus()
    expect(readQueryEditor(screen.getByRole("textbox", { name: "PromQL query" }))).toBe("up")
    changeQueryEditor(screen.getByRole("textbox", { name: "PromQL query" }), "up == 1")
    fireEvent.click(screen.getByRole("tab", { name: "Builder" }))
    expect(screen.getByLabelText("Rate window")).toHaveValue("10m")
    fireEvent.click(screen.getByRole("button", { name: "Use generated query" }))
    expect(changes).toHaveBeenLastCalledWith("rate(up[10m])")
    expect(screen.getByRole("tab", { name: "Builder" })).toHaveAttribute("aria-selected", "true")
    fireEvent.click(screen.getByRole("tab", { name: "Code" }))
    expect(readQueryEditor(screen.getByRole("textbox", { name: "PromQL query" }))).toBe("rate(up[10m])")
  })

  it("opens existing compact queries as code and never rewrites them on a mode switch", () => {
    const onChange = vi.fn()
    const expression = "sum by (service) (rate(requests_total[5m]))"
    render(<QueryBuilder widget={{ ...widget, query: expression }} compact onChange={onChange} />)
    expect(screen.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "true")
    expect(readQueryEditor(screen.getByRole("textbox", { name: "PromQL query" }))).toBe(expression)
    fireEvent.click(screen.getByRole("tab", { name: "Builder" }))
    expect(screen.getByRole("button", { name: "Use generated query" })).toBeDisabled()
    fireEvent.click(screen.getByRole("tab", { name: "Code" }))
    expect(readQueryEditor(screen.getByRole("textbox", { name: "PromQL query" }))).toBe(expression)
    expect(onChange).not.toHaveBeenCalled()
  })

  it("keeps compact TraceQL editing available without a PromQL builder tab", () => {
    render(<QueryBuilder widget={{ ...widget, type: "traces", query: "{}" }} compact defaultExpanded onChange={vi.fn()} />)
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument()
    expect(readQueryEditor(screen.getByRole("textbox", { name: "TraceQL query" }))).toBe("{}")
  })

  it("starts an expanded empty workspace with guidance and keeps code available", () => {
    render(<QueryBuilder widget={{ ...widget, query: "" }} onChange={vi.fn()} defaultExpanded />)
    expect(screen.getByText("Guided query builder").closest("details")).toHaveAttribute("open")
    expect(screen.getByLabelText("Generated query")).toHaveTextContent("Choose a metric to start building your query.")
    expect(screen.getByRole("button", { name: "Use generated query" })).toBeDisabled()
    expect(readQueryEditor(screen.getByLabelText("PromQL query"))).toBe("")
  })

  it("keeps a guided draft when the disclosure is collapsed and reopened", async () => {
    const onChange = vi.fn()
    render(<QueryBuilder widget={widget} onChange={onChange} defaultExpanded />)
    fireEvent.click(screen.getByRole("combobox", { name: "Function" }))
    fireEvent.click(screen.getByRole("option", { name: "Rate per second" }))
    fireEvent.change(screen.getByLabelText("Rate window"), { target: { value: "10m" } })
    const details = screen.getByText("Guided query builder").closest("details")!
    details.open = false
    fireEvent(details, new Event("toggle"))
    expect(readQueryEditor(screen.getByLabelText("PromQL query"))).toBe("up")
    details.open = true
    fireEvent(details, new Event("toggle"))
    expect(await screen.findByLabelText("Rate window")).toHaveValue("10m")
    fireEvent.click(screen.getByRole("button", { name: "Use generated query" }))
    expect(onChange).toHaveBeenCalledWith("rate(up[10m])")
  })

  it("builds rate and aggregation expressions through real Gamma options", async () => {
    const onChange = vi.fn()
    const { container } = render(<QueryBuilder widget={widget} onChange={onChange} />)
    const details = screen.getByText("Guided query builder").closest("details")!
    details.open = true
    fireEvent(details, new Event("toggle"))
    await screen.findByRole("combobox", { name: "Function" })
    expect(container.querySelector("select")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Add label filter" }))
    const label = screen.getByRole("combobox", { name: "Filter 1 label" })
    fireEvent.change(label, { target: { value: "job" } })
    fireEvent.click(screen.getByRole("option", { name: "Use “job”" }))
    const operator = screen.getByRole("combobox", { name: "Filter 1 operator" })
    fireEvent.keyDown(operator, { key: "Enter" })
    fireEvent.keyDown(operator, { key: "ArrowDown" })
    fireEvent.keyDown(operator, { key: "Enter" })
    const value = screen.getByRole("combobox", { name: "Filter 1 value" })
    fireEvent.change(value, { target: { value: "worker" } })
    fireEvent.click(screen.getByRole("option", { name: "Use “worker”" }))
    fireEvent.click(screen.getByRole("combobox", { name: "Function" }))
    fireEvent.click(screen.getByRole("option", { name: "Rate per second" }))
    fireEvent.change(screen.getByLabelText("Rate window"), { target: { value: "10m" } })
    fireEvent.click(screen.getByRole("combobox", { name: "Aggregation" }))
    fireEvent.click(screen.getByRole("option", { name: "sum" }))
    fireEvent.change(screen.getByLabelText("Group by labels"), { target: { value: "service" } })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Use generated query" }))
    expect(onChange).toHaveBeenCalledWith('sum by (service) (rate(up{job!="worker"}[10m]))')
  })

  it("does not rewrite a complex query when opening or editing the guided builder", async () => {
    const onChange = vi.fn()
    render(
      <QueryBuilder
        widget={{
          ...widget,
          query:
            "histogram_quantile(0.95,sum by (le)(rate(request_bucket[5m])))",
        }}
        onChange={onChange}
      />,
    )
    const details = screen.getByText("Guided query builder").closest("details")!
    details.open = true
    fireEvent(details, new Event("toggle"))
    const input = await screen.findByRole("combobox", { name: "Metric" })
    fireEvent.change(input, { target: { value: "up" } })
    fireEvent.click(screen.getByRole("option", { name: "Use “up”" }))
    expect(onChange).not.toHaveBeenCalled()
    expect(readQueryEditor(screen.getByLabelText("PromQL query"))).toBe(
      "histogram_quantile(0.95,sum by (le)(rate(request_bucket[5m])))",
    )
    fireEvent.click(screen.getByRole("button", { name: "Use generated query" }))
    expect(onChange).toHaveBeenCalledWith("up")
  })
  it("runs explicit range-bounded previews and ignores results for an edited query", async () => {
    let resolve!: (value: QueryResult) => void
    const fetcher = vi.fn<
      (request: QueryRequest, signal: AbortSignal) => Promise<QueryResult>
    >(
      () =>
        new Promise<QueryResult>((next) => {
          resolve = next
        }),
    )
    const { rerender } = render(
      <QueryBuilder
        widget={widget}
        onChange={vi.fn()}
        range={{ start: 100, end: 700 }}
        queryFetcher={fetcher}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Run query" }))
    expect(fetcher).toHaveBeenCalledWith(
      {
        providerId: "prod",
        kind: "metrics",
        query: "up",
        start: 100,
        end: 700,
        step: 2,
      },
      expect.any(AbortSignal),
    )
    const signal = fetcher.mock.calls[0][1]
    rerender(
      <QueryBuilder
        widget={{ ...widget, query: "rate(requests[5m])" }}
        onChange={vi.fn()}
        range={{ start: 100, end: 700 }}
        queryFetcher={fetcher}
      />,
    )
    expect(signal.aborted).toBe(true)
    await act(async () =>
      resolve({ series: [{ name: "stale result", labels: {}, points: [] }] }),
    )
    expect(screen.queryByText("stale result")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Run query" })).toBeEnabled()
  })
  it("scopes discovery by provider and ignores a late prior provider response", async () => {
    let resolve!: (value: ProviderMetadata) => void
    const metadata = vi.fn((id: string) =>
      id === "prod"
        ? new Promise<ProviderMetadata>((next) => {
            resolve = next
          })
        : Promise.resolve({ values: ["new_metric"] }),
    )
    const client = { metadata } as unknown as InsightsClient
    const { rerender } = render(
      <QueryBuilder widget={widget} onChange={vi.fn()} client={client} />,
    )
    const details = screen.getByText("Guided query builder").closest("details")!
    details.open = true
    fireEvent(details, new Event("toggle"))
    await screen.findByRole("combobox", { name: "Metric" })
    rerender(
      <QueryBuilder
        widget={{ ...widget, providerId: "staging" }}
        onChange={vi.fn()}
        client={client}
      />,
    )
    await waitFor(() =>
      expect(metadata).toHaveBeenCalledWith(
        "staging",
        expect.objectContaining({ kind: "metrics" }),
        expect.any(AbortSignal),
      ),
    )
    await act(async () => resolve({ values: ["old_metric"] }))
    fireEvent.focus(screen.getByRole("combobox", { name: "Metric" }))
    expect(
      screen.queryByRole("option", { name: "old_metric" }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole("option", { name: "new_metric" }),
    ).toBeInTheDocument()
  })
})

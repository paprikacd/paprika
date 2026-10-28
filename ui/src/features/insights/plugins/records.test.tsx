import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RecordTable, RecordList, RecordTreemap, RecordMatrix, registerRecordWidgetPlugins } from "./records"
import { getWidgetDefinition } from "../widget-registry"
import { PluginConfigEditor } from "../plugin-config-editor"
import { parseRecordFrame } from "../record-data"
import type { QueryResult, Widget } from "../schema"

afterEach(cleanup)
const widget: Widget = {
  id: "records",
  title: "Service records",
  type: "plugin",
  pluginId: "record-table",
  dataKind: "records",
  providerId: "uptime",
  query: '{"operation":"services"}',
  unit: "",
  layout: { x: 0, y: 0, w: 6, h: 4 },
  options: { decimals: 2 },
}
const result: QueryResult = {
  records: {
    columns: [
      { key: "service", type: "string" },
      { key: "uptime", type: "number", unit: "%" },
      { key: "active", type: "boolean" },
    ],
    rows: [
      ["api", 0, false],
      ["worker", null, true],
      ["web", 99.9876, true],
    ],
    truncated: true,
  },
}

describe("record widgets", () => {
  it("keeps comfortable searchable defaults and validates compact table controls", () => {
    registerRecordWidgetPlugins()
    const definition = getWidgetDefinition("plugin", "record-table")!
    expect(definition.parseConfig?.({})).toEqual({ density: "comfortable", showSearch: true })
    expect(definition.parseConfig?.({ density: "compact", showSearch: false, columns: ["service"], pageSize: 5 })).toEqual({ density: "compact", showSearch: false, columns: ["service"], pageSize: 5 })
    expect(() => definition.parseConfig?.({ density: "tiny" })).toThrow()
    expect(() => definition.parseConfig?.({ showSearch: "false" })).toThrow()
    expect(() => definition.parseConfig?.({ density: "compact", unsupported: true })).toThrow()
    const { container } = render(<RecordTable widget={widget} result={result} />)
    expect(container.querySelector('[data-table-density="comfortable"]')).not.toBeNull()
    expect(screen.getByRole("textbox", { name: "Filter Service records" })).toBeInTheDocument()
  })
  it("hiding search restores filtered rows while compact sorting and exact selection remain available", () => {
    const select = vi.fn()
    const { rerender, container } = render(<RecordTable widget={widget} result={result} onContextChange={select} />)
    fireEvent.change(screen.getByRole("textbox", { name: "Filter Service records" }), { target: { value: "worker" } })
    expect(screen.queryByText("api")).not.toBeInTheDocument()
    rerender(<RecordTable widget={{ ...widget, config: { density: "compact", showSearch: false } }} result={result} onContextChange={select} />)
    expect(container.querySelector('[data-table-density="compact"]')).not.toBeNull()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(screen.queryByText(/loaded rows/)).not.toBeInTheDocument()
    expect(screen.getByText("api")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "uptime" }))
    fireEvent.click(screen.getByRole("button", { name: "uptime ↑" }))
    expect(screen.getByRole("columnheader", { name: "uptime ↓" })).toHaveAttribute("aria-sort", "descending")
    fireEvent.click(screen.getByRole("button", { name: "Select row 1" }))
    expect(select).toHaveBeenCalledWith({ labels: { service: "web", uptime: "99.9876", active: "true" } })
    expect(screen.getByText("—")).toBeInTheDocument()
    expect(screen.getByText(/Partial result/)).toBeInTheDocument()
    expect(screen.getByRole("region", { name: "Service records records" })).toHaveAttribute("tabindex", "0")
  })
  it("exposes guided density and search controls without discarding explicit columns", () => {
    registerRecordWidgetPlugins()
    const onChange = vi.fn()
    render(<PluginConfigEditor definition={getWidgetDefinition("plugin", "record-table")} value={'{"columns":["service"],"pageSize":5}'} onChange={onChange} />)
    expect(screen.getByRole("switch", { name: /^Show search/ })).toBeChecked()
    fireEvent.click(screen.getByRole("switch", { name: /^Show search/ }))
    expect(JSON.parse(onChange.mock.calls.at(-1)![0])).toEqual({ columns: ["service"], pageSize: 5, showSearch: false })
    fireEvent.click(screen.getByRole("combobox", { name: "Row density" }))
    fireEvent.click(screen.getByRole("option", { name: "Compact" }))
    expect(JSON.parse(onChange.mock.calls.at(-1)![0])).toEqual({ columns: ["service"], pageSize: 5, density: "compact" })
  })
  it("keeps paging available without search and removes an empty footer from small tables", () => {
    const compact = { ...widget, config: { density: "compact", showSearch: false, pageSize: 5 } }
    const { rerender } = render(<RecordTable widget={compact} result={{ records: { ...result.records!, truncated: false } }} />)
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    const rows = Array.from({ length: 6 }, (_, i) => [`service-${i}`, i, true]) as NonNullable<QueryResult["records"]>["rows"]
    rerender(<RecordTable widget={compact} result={{ records: { ...result.records!, rows, truncated: false } }} />)
    expect(screen.getByRole("status")).toHaveTextContent("Page 1 of 2")
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(screen.getByText("service-5")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled()
  })
  it("preserves zero, missing and boolean values, filters, and sends row dimensions to drilldowns", () => {
    const select = vi.fn()
    render(
      <RecordTable widget={widget} result={result} onContextChange={select} />,
    )
    expect(screen.getByText("0.00%")).toBeInTheDocument()
    expect(screen.getByText("—")).toBeInTheDocument()
    expect(screen.getByText("No")).toBeInTheDocument()
    expect(screen.getByText(/Partial result/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Select row 1" }))
    expect(select).toHaveBeenCalledWith({
      labels: { service: "api", uptime: "0", active: "false" },
    })
    fireEvent.change(
      screen.getByRole("textbox", { name: "Filter Service records" }),
      { target: { value: "worker" } },
    )
    expect(screen.queryByText("api")).not.toBeInTheDocument()
    expect(screen.getByText("worker")).toBeInTheDocument()
  })
  it("sorts numeric values without treating null as zero and paginates source records", () => {
    const rows = Array.from({ length: 11 }, (_, i) => [
      `service-${i}`,
      i === 10 ? null : i,
      true,
    ]) as NonNullable<QueryResult["records"]>["rows"]
    render(
      <RecordTable
        widget={{ ...widget, config: { pageSize: 5 } }}
        result={{ records: { ...result.records!, rows } }}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "uptime" }))
    expect(screen.getByText("service-0")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "uptime ↑" }))
    expect(screen.getByText("service-9")).toBeInTheDocument()
    expect(screen.queryByText("service-10")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(screen.getByText("service-10")).toBeInTheDocument()
  })
  it("renders narratives as text and only exposes safe source links", () => {
    const records = {
      columns: [
        { key: "title", type: "string" as const },
        { key: "body", type: "string" as const },
        { key: "url", type: "string" as const },
      ],
      rows: [
        ["Malicious", "<script>alert(1)</script>", "javascript:alert(1)"],
        ["News", "Read me", "https://shorted.com.au/news"],
      ],
    }
    render(
      <RecordList
        widget={{
          ...widget,
          config: { title: "title", body: "body", url: "url" },
        }}
        result={{ records }}
      />,
    )
    expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument()
    expect(
      screen.queryByRole("link", { name: "Malicious" }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "News" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    )
  })
  it("never invents area for missing or negative treemap values", () => {
    render(
      <RecordTreemap
        widget={{ ...widget, config: { label: "service", value: "uptime" } }}
        result={result}
      />,
    )
    expect(screen.getByRole("img", { name: /web: 99.99/ })).toBeInTheDocument()
    expect(screen.getByText(/2 zero, missing or negative/)).toBeInTheDocument()
  })
  it("refuses ambiguous matrix coordinates", () => {
    render(
      <RecordMatrix
        widget={{
          ...widget,
          config: { x: "service", y: "active", value: "uptime" },
        }}
        result={{
          records: {
            ...result.records!,
            rows: [result.records!.rows[0], result.records!.rows[0]],
          },
        }}
      />,
    )
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Duplicate matrix coordinates",
    )
  })
  it.each<Record<string, number>>([{ min: 2 }, { max: -2 }])(
    "refuses an inverted matrix scale with one explicit bound: %j",
    (bound) => {
      render(
        <RecordMatrix
          widget={{
            ...widget,
            config: { x: "service", y: "active", value: "uptime", ...bound },
          }}
          result={{
            records: {
              ...result.records!,
              rows: [["api", bound.min ? 1 : -1, true]],
            },
          }}
        />,
      )
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Matrix minimum must be below its maximum",
      )
    },
  )
})

describe("record frame transport", () => {
  it("preserves scalar values and refuses wrong types, reserved keys and unbounded rows", () => {
    expect(parseRecordFrame(result.records)).toEqual(result.records)
    expect(() =>
      parseRecordFrame({ ...result.records, rows: [["api", "12", true]] }),
    ).toThrow()
    expect(() =>
      parseRecordFrame({ ...result.records, rows: [["api", { x: 12 }, true]] }),
    ).toThrow()
    expect(() =>
      parseRecordFrame({
        columns: [{ key: "__proto__", type: "string" }],
        rows: [],
      }),
    ).toThrow()
    expect(() =>
      parseRecordFrame({
        ...result.records,
        rows: Array.from({ length: 1001 }, () => result.records!.rows[0]),
      }),
    ).toThrow()
  })
})

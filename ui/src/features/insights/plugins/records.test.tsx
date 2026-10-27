import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RecordTable, RecordList, RecordTreemap, RecordMatrix } from "./records"
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

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
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
    expect(screen.getByText("Provider response may be incomplete")).toBeInTheDocument()
    expect(screen.getByRole("region", { name: "Service records records" })).toHaveAttribute("tabindex", "0")
  })
  it("exposes guided density and search controls without discarding explicit columns", () => {
    registerRecordWidgetPlugins()
    const onChange = vi.fn()
    render(<PluginConfigEditor definition={getWidgetDefinition("plugin", "record-table")} value={'{"columns":["service"],"pageSize":5}'} onChange={onChange} />)
    expect(screen.getByRole("switch", { name: /^Show search/ })).toBeChecked()
    expect(screen.getByRole("switch", { name: /^Show row numbers/ })).not.toBeChecked()
    fireEvent.click(screen.getByRole("switch", { name: /^Show row numbers/ }))
    expect(JSON.parse(onChange.mock.calls.at(-1)![0])).toEqual({ columns: ["service"], pageSize: 5, showRowNumbers: true })
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
  it("numbers only displayed loaded rows, including after sorting, filtering and paging", () => {
    const rows = Array.from({ length: 7 }, (_, i) => [`service-${i}`, i, true]) as NonNullable<QueryResult["records"]>["rows"]
    const { rerender } = render(<RecordTable widget={{ ...widget, config: { showRowNumbers: true, pageSize: 5 } }} result={{ records: { ...result.records!, rows } }} />)
    expect(screen.getByRole("columnheader", { name: "Row number" })).toHaveTextContent("#")
    const row = (name: string) => screen.getByText(name).closest("tr")!
    expect(within(row("service-0")).getAllByRole("cell")[0]).toHaveTextContent("1")
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(within(row("service-5")).getAllByRole("cell")[0]).toHaveTextContent("6")
    fireEvent.click(screen.getByRole("button", { name: "uptime" }))
    fireEvent.click(screen.getByRole("button", { name: "uptime ↑" }))
    fireEvent.click(screen.getByRole("button", { name: "Previous" }))
    expect(within(row("service-6")).getAllByRole("cell")[0]).toHaveTextContent("1")
    fireEvent.change(screen.getByRole("textbox", { name: "Filter Service records" }), { target: { value: "service-4" } })
    expect(within(row("service-4")).getAllByRole("cell")[0]).toHaveTextContent("1")
    rerender(<RecordTable widget={{ ...widget, config: { showRowNumbers: false } }} result={{ records: { ...result.records!, rows } }} />)
    expect(screen.queryByRole("columnheader", { name: "Row number" })).not.toBeInTheDocument()
  })
  it("preserves zero, missing and boolean values, filters, and sends row dimensions to drilldowns", () => {
    const select = vi.fn()
    render(
      <RecordTable widget={widget} result={result} onContextChange={select} />,
    )
    expect(screen.getByText("0.00%")).toBeInTheDocument()
    expect(screen.getByText("—")).toBeInTheDocument()
    expect(screen.getByText("No")).toBeInTheDocument()
    expect(screen.getByText("Provider response may be incomplete")).toBeInTheDocument()
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
    expect(screen.getByRole("button", { name: /web: 99.99/ })).toBeInTheDocument()
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
  it("searches the raw digits of a number and keeps matrix coordinates distinct at the authored decimals", () => {
    const rows = [["order-a", 1234567, true], ["order-b", 7, true]] as NonNullable<QueryResult["records"]>["rows"]
    const numeric: QueryResult = { records: { columns: [{ key: "order", type: "string" }, { key: "id", type: "number" }, { key: "active", type: "boolean" }], rows, truncated: false } }
    render(<RecordTable widget={{ ...widget, options: {} }} result={numeric} />)
    fireEvent.change(screen.getByRole("textbox", { name: "Filter Service records" }), { target: { value: "1234567" } })
    expect(screen.getByText("order-a")).toBeInTheDocument()
    cleanup()
    const coordinates: QueryResult = { records: { columns: [{ key: "x", type: "number" }, { key: "y", type: "string" }, { key: "v", type: "number" }], rows: [[0.12341, "a", 1], [0.12342, "a", 2]], truncated: false } }
    const matrix = { ...widget, pluginId: "record-matrix", config: { x: "x", y: "y", value: "v" }, options: { decimals: 3 } } as Widget
    render(<RecordMatrix widget={matrix} result={coordinates} />)
    expect(screen.queryByText(/Duplicate matrix coordinates/)).not.toBeInTheDocument()
    expect(screen.getAllByRole("cell")).toHaveLength(2)
  })
  it("opens a matrix cell's details with its column, row and value facts", () => {
    cleanup()
    const coordinates: QueryResult = { records: { columns: [{ key: "year", type: "number" }, { key: "service", type: "string" }, { key: "latency", type: "number" }], rows: [[2024, "api", 5.878749999999975]], truncated: false } }
    const matrix = { ...widget, pluginId: "record-matrix", config: { x: "year", y: "service", value: "latency" }, options: { decimals: 2 } } as Widget
    render(<RecordMatrix widget={matrix} result={coordinates} />)
    fireEvent.pointerEnter(screen.getByText("5.88"), { pointerType: "mouse" })
    expect(screen.getByText("year")).toBeInTheDocument()
    expect(screen.getByText("service")).toBeInTheDocument()
    expect(screen.getByText("latency")).toBeInTheDocument()
  })
  it("gives each matrix cell one button, so a selectable cell never nests a button inside the panel trigger", () => {
    cleanup()
    const grid: QueryResult = { records: { columns: [{ key: "x", type: "number" }, { key: "y", type: "string" }, { key: "v", type: "number" }], rows: [[1, "a", 1], [2, "a", 2], [1, "b", 3], [2, "b", 4]], truncated: false } }
    const matrix = { ...widget, pluginId: "record-matrix", config: { x: "x", y: "y", value: "v" }, options: { decimals: 2 } } as Widget
    const select = vi.fn()
    const { container } = render(<RecordMatrix widget={matrix} result={grid} onContextChange={select} />)
    expect(container.querySelectorAll("button button")).toHaveLength(0)
    const triggers = screen.getAllByRole("button", { name: /^[ab], [12]: / })
    expect(triggers).toHaveLength(4)
    // One tab stop for the whole grid; the rest are reached with the arrow keys.
    expect(triggers.filter(trigger => trigger.tabIndex === 0)).toHaveLength(1)
    const first = triggers[0]
    fireEvent.click(first)
    expect(select).toHaveBeenCalledTimes(1)
    expect(select).toHaveBeenLastCalledWith({ labels: expect.any(Object), value: 1 })
    expect(first).toHaveAttribute("aria-pressed", "true")
    fireEvent.click(first)
    expect(first).not.toHaveAttribute("aria-pressed", "true")
  })
  it("moves focus with the arrow keys and a click without selecting a cell, and keeps the tab stop on the cell last focused", () => {
    cleanup()
    const grid: QueryResult = { records: { columns: [{ key: "x", type: "number" }, { key: "y", type: "string" }, { key: "v", type: "number" }], rows: [[1, "a", 1], [2, "a", 2], [1, "b", 3], [2, "b", 4]], truncated: false } }
    const matrix = { ...widget, pluginId: "record-matrix", config: { x: "x", y: "y", value: "v" }, options: { decimals: 2 } } as Widget
    const select = vi.fn()
    const { container } = render(<RecordMatrix widget={matrix} result={grid} onContextChange={select} />)
    const triggers = screen.getAllByRole("button", { name: /^[ab], [12]: / })
    act(() => triggers[0].focus())
    // Arrow keys move the stop and focus only: moving the focus never reports a selection.
    fireEvent.keyDown(triggers[0], { key: "ArrowRight" })
    expect(document.activeElement).toBe(triggers[1])
    expect(triggers[1].tabIndex).toBe(0)
    expect(triggers[0].tabIndex).toBe(-1)
    expect(select).not.toHaveBeenCalled()
    // A click elsewhere moves the stop to that cell, so Tab comes back to it.
    act(() => triggers[3].focus())
    expect(triggers[3].tabIndex).toBe(0)
    expect(triggers[1].tabIndex).toBe(-1)
  })
  it("moves the single tab stop through the populated cells with the arrow keys", () => {
    cleanup()
    const grid: QueryResult = { records: { columns: [{ key: "x", type: "number" }, { key: "y", type: "string" }, { key: "v", type: "number" }], rows: [[1, "a", 1], [2, "a", 2], [1, "b", 3]], truncated: false } }
    const matrix = { ...widget, pluginId: "record-matrix", config: { x: "x", y: "y", value: "v" }, options: { decimals: 2 } } as Widget
    const { container } = render(<RecordMatrix widget={matrix} result={grid} />)
    const region = container.querySelector<HTMLElement>('[role="region"]')!
    const cellOf = (key: string) => container.querySelector<HTMLElement>(`td[data-matrix-key="${key}"] button`)!
    expect(cellOf("0-0").tabIndex).toBe(0)
    fireEvent.keyDown(cellOf("0-0"), { key: "ArrowRight" })
    expect(cellOf("0-1")).toHaveFocus()
    expect(cellOf("0-1").tabIndex).toBe(0)
    expect(cellOf("0-0").tabIndex).toBe(-1)
    // Row b, column 2 has no reading: stepping down from column 2 finds nothing and the tab stop stays put.
    expect(container.querySelector('td[data-matrix-key="1-1"] button')).toBeNull()
    fireEvent.keyDown(cellOf("0-1"), { key: "ArrowDown" })
    expect(cellOf("0-1")).toHaveFocus()
    expect(cellOf("0-1").tabIndex).toBe(0)
    fireEvent.keyDown(cellOf("0-0"), { key: "ArrowDown" })
    expect(cellOf("1-0")).toHaveFocus()
    expect(cellOf("1-0").tabIndex).toBe(0)
    expect(region).toBeInTheDocument()
  })
  it("names matrix axis coordinates by their stored digits, so close coordinates keep distinct headers at any decimals", () => {
    cleanup()
    const coordinates: QueryResult = { records: { columns: [{ key: "x", type: "number" }, { key: "y", type: "string" }, { key: "v", type: "number" }], rows: [[1.2, "a", 1], [1.4, "a", 2]], truncated: false } }
    const matrix = { ...widget, pluginId: "record-matrix", config: { x: "x", y: "y", value: "v" }, options: { decimals: 0 } } as Widget
    render(<RecordMatrix widget={matrix} result={coordinates} />)
    expect(screen.getByRole("columnheader", { name: "1.2" })).toBeInTheDocument()
    expect(screen.getByRole("columnheader", { name: "1.4" })).toBeInTheDocument()
  })
  it("labels a matrix axis with the shortest form of its coordinate, so 0.1 + 0.2 never shows float noise", () => {
    cleanup()
    const noisy: QueryResult = { records: { columns: [{ key: "x", type: "number" }, { key: "y", type: "string" }, { key: "v", type: "number" }], rows: [[0.1 + 0.2, "a", 1], [0.4, "a", 2]], truncated: false } }
    const matrix = { ...widget, pluginId: "record-matrix", config: { x: "x", y: "y", value: "v" }, options: { decimals: 2 } } as Widget
    const { container } = render(<RecordMatrix widget={matrix} result={noisy} />)
    expect(container.textContent).not.toMatch(/\d\.\d{6,}/)
    // 0.1 + 0.2 and 0.4 are different floats that both read 0.3 / 0.4: the header is the shortest form, the cell keeps its own key.
    expect(screen.getByRole("columnheader", { name: "0.3" })).toBeInTheDocument()
  })
  it("prints integer identifiers and years as stored, and formats only non-integer readings", () => {
    cleanup()
    const years: QueryResult = { records: { columns: [{ key: "year", type: "number" }, { key: "order", type: "number" }, { key: "v", type: "number" }], rows: [[2024, 10021, 1], [2025, 10022, 2.5]], truncated: false } }
    const matrix = { ...widget, pluginId: "record-matrix", config: { x: "year", y: "order", value: "v" }, options: { decimals: 2 } } as Widget
    render(<RecordMatrix widget={matrix} result={years} />)
    expect(screen.getByText("2024")).toBeInTheDocument()
    expect(screen.getByText("2025")).toBeInTheDocument()
    expect(screen.getByText("10021")).toBeInTheDocument()
    expect(screen.queryByText("2,024")).not.toBeInTheDocument()
    expect(screen.queryByText("10,021")).not.toBeInTheDocument()
  })
})

describe("record truncation notes", () => {
  it("names a row cap with the neutral source limit, and a partial source as partial", () => {
    const capped: QueryResult = { ...result, truncation: { reason: "row_limit", limit: 3, unit: "rows" }, truncated: true }
    const { unmount } = render(<RecordTable widget={widget} result={capped} />)
    expect(screen.getByText("Source row limit reached · narrow the query to see others")).toBeInTheDocument()
    expect(screen.queryByText(/Partial/)).not.toBeInTheDocument()
    unmount()
    render(<RecordTable widget={widget} result={{ ...result, truncation: { reason: "partial" }, truncated: true }} />)
    expect(screen.getByText("Partial source response")).toBeInTheDocument()
    expect(screen.queryByText(/Source row limit/)).not.toBeInTheDocument()
  })
})

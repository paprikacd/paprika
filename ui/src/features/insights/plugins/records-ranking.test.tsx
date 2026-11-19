import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RecordTable, registerRecordWidgetPlugins } from "./records"
import { RecordTableStyleEditor } from "./record-table-style-editor"
import { getWidgetDefinition } from "../widget-registry"
import type { QueryResult, Widget } from "../schema"

afterEach(cleanup)

const mappings = [
  { value: "Down", status: "critical" },
  { value: "Degraded", status: "warning" },
  { value: "Up", status: "ok" },
]
const cellStyles = [{ column: "health", display: "status-badge", mappings }]
// Ranked: queue (critical 80), api (critical 40), mail (warning 60), web (warning 10), worker (ok 90), cache (ok 70), db (no status).
const frame = (truncated = false): QueryResult => ({
  records: {
    columns: [
      { key: "host", type: "string" },
      { key: "health", type: "string" },
      { key: "cpu", type: "number", unit: "%" },
    ],
    rows: [
      ["api", "Down", 40],
      ["worker", "Up", 90],
      ["web", "Degraded", 10],
      ["db", null, 5],
      ["cache", "Up", 70],
      ["queue", "Down", 80],
      ["mail", "Degraded", 60],
    ],
    truncated,
  },
})
const widgetWith = (config: Record<string, unknown>): Widget => ({
  id: "ranked",
  title: "Hosts",
  type: "plugin",
  pluginId: "record-table",
  dataKind: "records",
  providerId: "records",
  query: "{}",
  unit: "",
  layout: { x: 0, y: 0, w: 6, h: 6 },
  config: { cellStyles, rank: { status: "health", value: "cpu" }, ...config },
})
const hosts = (container: HTMLElement) => [...container.querySelectorAll("tbody tr")].map(row => row.querySelector("td[data-record-cell-column='0'], td:nth-child(2)")?.textContent)

describe("ranked record tables", () => {
  it("orders rows worst first by status, then by value, and keeps the source order last", () => {
    const { container } = render(<RecordTable widget={widgetWith({ showRowNumbers: true, columns: ["host", "health", "cpu"] })} result={frame()} />)
    expect(hosts(container)).toEqual(["queue", "api", "mail", "web", "worker", "cache", "db"])
    const numbers = [...container.querySelectorAll("tbody tr")].map(row => row.querySelector("td")?.textContent)
    expect(numbers).toEqual(["1", "2", "3", "4", "5", "6", "7"])
    expect(screen.getByRole("columnheader", { name: "Rank" })).toBeInTheDocument()
    expect(container.querySelector("[data-rank-caption]")).toHaveTextContent("Ranked by health, then cpu, highest first.")
    expect(screen.queryByRole("button", { name: "Ranked order" })).not.toBeInTheDocument()
  })

  it("draws a rail of one pixel for warning and two for critical rows, and none for ok or missing rows", () => {
    const { container } = render(<RecordTable widget={widgetWith({ columns: ["host", "health", "cpu"] })} result={frame()} />)
    const rowFor = (host: string) => [...container.querySelectorAll("tbody tr")].find(row => row.textContent?.startsWith(host))!
    expect(rowFor("queue")).toHaveAttribute("data-status-rail", "critical")
    expect(rowFor("mail")).toHaveAttribute("data-status-rail", "warning")
    expect(rowFor("worker")).not.toHaveAttribute("data-status-rail")
    expect(rowFor("db")).not.toHaveAttribute("data-status-rail")
  })

  it("gives a leading status chip, with its word, when the status column is not drawn as a badge", () => {
    const { container } = render(<RecordTable widget={widgetWith({ columns: ["host", "cpu"] })} result={frame()} />)
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeInTheDocument()
    const first = container.querySelector("tbody tr")!
    expect(first.querySelector('[data-status="critical"]')).toHaveTextContent("Down")
    expect(within(container.querySelectorAll("tbody tr")[6] as HTMLElement).getByText("No status")).toBeInTheDocument()
  })

  it("lets a header click override the rank until Ranked order brings it back", () => {
    const { container } = render(<RecordTable widget={widgetWith({ columns: ["host", "health", "cpu"] })} result={frame()} />)
    fireEvent.click(screen.getByRole("button", { name: "cpu" }))
    expect(hosts(container)).toEqual(["db", "web", "api", "mail", "cache", "queue", "worker"])
    expect(screen.getByRole("columnheader", { name: "cpu ↑" })).toHaveAttribute("aria-sort", "ascending")
    expect(container.querySelector("[data-rank-caption]")).toHaveTextContent("Sorted by cpu")
    fireEvent.click(screen.getByRole("button", { name: "Ranked order" }))
    expect(hosts(container)).toEqual(["queue", "api", "mail", "web", "worker", "cache", "db"])
    expect(screen.queryByRole("button", { name: "Ranked order" })).not.toBeInTheDocument()
    // The button unmounts on reset, so focus moves to the rank caption rather than dropping to the page body.
    expect(container.querySelector("[data-rank-caption]")).toHaveFocus()
  })

  it("keeps keyboard focus on the rank caption after Ranked order is pressed from the keyboard", () => {
    const { container } = render(<RecordTable widget={widgetWith({ columns: ["host", "health", "cpu"] })} result={frame()} />)
    fireEvent.click(screen.getByRole("button", { name: "cpu" }))
    const reset = screen.getByRole("button", { name: "Ranked order" })
    reset.focus()
    expect(reset).toHaveFocus()
    fireEvent.keyDown(reset, { key: "Enter" })
    fireEvent.click(reset)
    expect(document.activeElement).not.toBe(document.body)
    expect(container.querySelector("[data-rank-caption]")).toHaveFocus()
  })

  it("applies search, then the rank, then the limit, then the page", () => {
    const { container } = render(<RecordTable widget={widgetWith({ columns: ["host", "health", "cpu"], pageSize: 5 })} result={frame()} />)
    fireEvent.change(screen.getByRole("textbox", { name: "Filter Hosts" }), { target: { value: "Degraded" } })
    expect(hosts(container)).toEqual(["mail", "web"])
    expect(screen.getByText("2 loaded rows")).toBeInTheDocument()
  })

  it("pages the ranked rows in rank order, with the page count taken from the limited rows", () => {
    const { container } = render(<RecordTable widget={widgetWith({ columns: ["host", "health", "cpu"], pageSize: 5 })} result={frame()} />)
    expect(hosts(container)).toEqual(["queue", "api", "mail", "web", "worker"])
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(hosts(container)).toEqual(["cache", "db"])
  })

  it("limits to the top rows, counts hidden critical and warning rows, and always counts rows without a status", () => {
    const { container } = render(<RecordTable widget={widgetWith({ columns: ["host", "health", "cpu"], pageSize: 10, rank: { status: "health", value: "cpu", limit: 2 } })} result={frame()} />)
    expect(hosts(container)).toEqual(["queue", "api"])
    expect(container.querySelector("[data-rank-summary]")).toHaveTextContent("Top 2 of 7 loaded rows · 2 warning not shown · 1 row has no status")
  })

  it("says 0 rows have no status when every loaded row has a status", () => {
    const complete: QueryResult = { records: { columns: frame().records!.columns, rows: frame().records!.rows.filter(row => row[1] !== null), truncated: false } }
    const { container } = render(<RecordTable widget={widgetWith({ columns: ["host", "health", "cpu"], pageSize: 10 })} result={complete} />)
    expect(container.querySelector("[data-rank-summary]")).toHaveTextContent("0 rows have no status")
    expect(container.querySelector("[data-rank-summary]")).not.toHaveTextContent("1 row has no status")
  })

  it("still counts a missing row that the limit hides", () => {
    const { container } = render(<RecordTable widget={widgetWith({ columns: ["host", "health", "cpu"], pageSize: 10, rank: { status: "health", value: "cpu", limit: 1 } })} result={frame()} />)
    expect(hosts(container)).toEqual(["queue"])
    expect(container.querySelector("[data-rank-summary]")).toHaveTextContent("1 row has no status")
  })

  it("keeps the counts in the caption bar rather than in a footer note", () => {
    const { container } = render(<RecordTable widget={widgetWith({ columns: ["host", "health", "cpu"], pageSize: 10 })} result={frame()} />)
    expect(container.querySelector("[data-rank-caption] [data-rank-summary]")).toHaveTextContent("1 row has no status")
    expect(container.querySelector("[role=status] [data-rank-summary]")).toBeNull()
  })

  it("reports hidden critical rows and the truncation basis", () => {
    render(<RecordTable widget={widgetWith({ columns: ["host", "health", "cpu"], pageSize: 10, rank: { status: "health", value: "cpu", limit: 1 } })} result={frame(true)} />)
    const summary = document.querySelector("[data-rank-summary]")!
    expect(summary).toHaveTextContent("Top 1 of 7 loaded rows · 1 critical · 2 warning not shown · 1 row has no status")
    expect(summary).toHaveTextContent("Ranked among loaded rows only; order the query to rank the whole source.")
  })

  it("states the direction of the value order in the caption", () => {
    const { container } = render(<RecordTable widget={widgetWith({ rank: { status: "health", value: "cpu", order: "ascending" } })} result={frame()} />)
    expect(container.querySelector("[data-rank-caption]")).toHaveTextContent("Ranked by health, then cpu, lowest first.")
  })

  it("draws no status rail when the rank sets rail to false", () => {
    const { container } = render(<RecordTable widget={widgetWith({ rank: { status: "health", value: "cpu", rail: false } })} result={frame()} />)
    const rows = [...container.querySelectorAll("tbody tr")]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(row => !row.hasAttribute("data-status-rail"))).toBe(true)
  })

  it("refuses a numeric status whose thresholds only colour the column", () => {
    render(<RecordTable widget={widgetWith({ columns: ["host", "cpu"], cellStyles: [{ column: "cpu", display: "bar", min: 0, max: 100, thresholds: [{ value: 0, color: "#112233" }] }], rank: { status: "cpu" } })} result={frame()} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Rank status “cpu” needs thresholds that name a status.")
  })

  it("refuses a rank whose status column cannot carry a status", () => {
    render(<RecordTable widget={widgetWith({ columns: ["host", "cpu"], cellStyles: [], rank: { status: "host" } })} result={frame()} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Rank status needs a status-badge column or a numeric column with thresholds; “host” is string.")
  })
})

describe("ranked record table input check", () => {
  it("returns the rank refusal before Apply, and nothing for a usable rank", () => {
    registerRecordWidgetPlugins()
    const definition = getWidgetDefinition("plugin", "record-table")!
    expect(definition.validateInput!(frame(), { cellStyles, rank: { status: "host" } } as Widget["config"])).toEqual([
      { field: "rank", message: "Rank status needs a status-badge column or a numeric column with thresholds; “host” is string." },
    ])
    expect(definition.validateInput!(frame(), { cellStyles, rank: { status: "health" } } as Widget["config"])).toEqual([])
  })
})

describe("ranking editor", () => {
  it("writes the rank JSON through the Ranking section", () => {
    const onChange = vi.fn()
    render(<RecordTableStyleEditor config={{ columns: ["host"] }} onChange={onChange} />)
    fireEvent.click(screen.getByRole("switch", { name: /^Rank rows/ }))
    expect(onChange.mock.calls.at(-1)![0]).toEqual({ columns: ["host"], rank: { status: "" } })
  })

  it("edits the status, value, limit and rail fields of an existing rank", () => {
    const onChange = vi.fn()
    render(<RecordTableStyleEditor config={{ columns: ["host"], rank: { status: "health" } }} onChange={onChange} />)
    fireEvent.change(screen.getByRole("textbox", { name: "Rank value column" }), { target: { value: "cpu" } })
    expect(onChange.mock.calls.at(-1)![0].rank).toEqual({ status: "health", value: "cpu" })
    fireEvent.change(screen.getByRole("spinbutton", { name: "Rank limit" }), { target: { value: "3" } })
    expect(onChange.mock.calls.at(-1)![0].rank).toEqual({ status: "health", limit: 3 })
    fireEvent.click(screen.getByRole("switch", { name: /^Status rail/ }))
    expect(onChange.mock.calls.at(-1)![0].rank).toEqual({ status: "health", rail: false })
  })

  it("registers the rank field as part of the record table schema", () => {
    registerRecordWidgetPlugins()
    const definition = getWidgetDefinition("plugin", "record-table")!
    expect(definition.parseConfig?.({ rank: { status: "health", value: "cpu", limit: 5 } })).toEqual({ density: "comfortable", showSearch: true, rank: { status: "health", value: "cpu", order: "descending", limit: 5, rail: true } })
    expect(() => definition.parseConfig?.({ rank: { status: "health", value: "health" } })).toThrow()
    expect(() => definition.parseConfig?.({ rank: { status: "health", limit: 101 } })).toThrow()
  })
})

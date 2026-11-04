import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { RecordTable } from "./records"
import { tableCellStylesSchema } from "./record-table-cells"
import type { QueryResult, Widget } from "../schema"
import { dashboardSchema } from "../schema"
import { dashboardToOpenUI, parseOpenUIDashboard } from "../openui"
import { parseDashboardBundle, serializeDashboardBundle } from "../workspace-transfer"

const history = [
  { timestamp: "2026-10-28T12:00:00Z", value: 4 },
  { timestamp: "2026-10-28T12:01:00Z", value: 0 },
  { timestamp: "2026-10-28T12:03:00Z", value: null },
  { timestamp: "2026-10-28T12:10:00Z", value: 12.345 },
]
const widget: Widget = { id: "rankings", title: "Company trends", type: "plugin", pluginId: "record-table", dataKind: "records", providerId: "db", query: "SELECT name, trend FROM companies", unit: "", layout: { x: 0, y: 0, w: 6, h: 3 }, config: { cellStyles: [{ column: "trend", display: "sparkline", unit: "%" }] }, options: { decimals: 2 } }
const result: QueryResult = { records: { columns: [{ key: "company", type: "string" }, { key: "trend", label: "Trend", type: "string" }], rows: [["A", JSON.stringify(history)]] } }

describe("record table history cells", () => {
  it("renders actual timestamped observations, retains zero and missing gaps, and exposes exact latest value", () => {
    const { container } = render(<RecordTable widget={widget} result={result} />)
    const chart = screen.getByRole("img", { name: "History for Trend" })
    expect(chart).toHaveAttribute("data-sample-count", "4")
    expect(chart).toHaveAttribute("data-history-start", String(Date.parse(history[0].timestamp)))
    expect(chart).toHaveAttribute("data-history-end", String(Date.parse(history[3].timestamp)))
    expect(chart.querySelector("[data-stat-trend]")?.getAttribute("d")?.match(/M/g)).toHaveLength(2)
    expect(chart).toHaveAttribute("data-history-min", "0")
    expect(container.querySelector('[data-cell-display="sparkline"]')).toHaveTextContent("12.35%")
    expect(within(screen.getByRole("columnheader", { name: "Trend" })).queryByRole("button")).not.toBeInTheDocument()
  })

  it("distinguishes missing, invalid, unordered, and oversized source history without inventing values", () => {
    const rows = [["empty", "[]"], ["missing", null], ["invalid", "not JSON"], ["unordered", JSON.stringify([...history].reverse())], ["too long", JSON.stringify(Array.from({ length: 241 }, () => history[0]))], ["last missing", JSON.stringify([...history, { timestamp: "2026-10-28T12:15:00Z", value: null }])]]
    render(<RecordTable widget={widget} result={{ records: { ...result.records!, rows } }} />)
    for (const [index, text] of [[0, "No history"], [1, "No history"], [2, "Invalid history"], [3, "Invalid history"], [4, "Invalid history"], [5, "No data"]] as const)
      expect(within(screen.getAllByRole("row")[index + 1]).getByText(text)).toBeInTheDocument()
    expect(within(screen.getAllByRole("row")[6]).getByRole("img")).toHaveAccessibleDescription(/Latest observation is missing/)
    expect(within(screen.getAllByRole("row")[6]).getByRole("img")).toHaveAccessibleDescription(/Latest valid sample in history: 12.345%/)
  })

  it("accepts history only from a string result column and preserves configuration in all document forms", () => {
    expect(tableCellStylesSchema.parse([{ column: "trend", display: "sparkline" }])).toHaveLength(1)
    expect(() => tableCellStylesSchema.parse([{ column: "trend", display: "sparkline", min: 0 }])).toThrow()
    expect(tableCellStylesSchema.parse([{ column: "trend", display: "bar", min: 0, max: 1, unit: "%" }])).toHaveLength(1)
    const dashboard = dashboardSchema.parse({ schemaVersion: 1, id: "rankings", title: "Rankings", timeRange: "1h", refreshInterval: 0, widgets: [widget] })
    for (const format of ["json", "yaml"] as const)
      expect(parseDashboardBundle(serializeDashboardBundle({ dashboards: [dashboard] }, format), format).dashboards[0].widgets[0].config).toEqual(widget.config)
    expect(parseOpenUIDashboard(dashboardToOpenUI(dashboard)).widgets[0].config).toEqual(widget.config)
    render(<RecordTable widget={widget} result={{ records: { columns: [{ key: "trend", type: "number" }], rows: [[1]] } }} />)
    expect(screen.getByRole("alert")).toHaveTextContent("requires a string column")
  })

  it("colors each history from the row's numeric threshold, preserving missing values and configuration", () => {
    const colored: Widget = { ...widget, config: { cellStyles: [{ column: "trend", display: "sparkline", thresholdColumn: "risk" }] }, options: { thresholds: [{ value: 0, color: "#13c8a1", label: "Low" }, { value: 70, color: "#ef5a46", label: "High" }] } }
    const frame = { columns: [...result.records!.columns, { key: "risk", type: "number" as const }], rows: [["A", JSON.stringify(history), 94], ["B", JSON.stringify(history), 20], ["C", JSON.stringify(history), null]] }
    const { container, rerender } = render(<RecordTable widget={colored} result={{ records: frame }} />)
    const histories = [...container.querySelectorAll('[data-cell-display="sparkline"][data-history-state="valid"]')]
    expect(histories.map(element => element.querySelector("[data-history-color-meaning]")?.textContent)).toEqual(["Color by risk: 94 · High", "Color by risk: 20 · Low", "Color by risk: no data"])
    expect(histories[0].querySelector("svg")).toHaveStyle({ color: "#ef5a46" })
    expect(histories[1].querySelector("svg")).toHaveStyle({ color: "#13c8a1" })
    expect(histories[2].querySelector("svg")?.getAttribute("style")).toContain("var(--gamma-muted)")
    const dashboard = dashboardSchema.parse({ schemaVersion: 1, id: "colored", title: "Colored", timeRange: "1h", refreshInterval: 0, widgets: [colored] })
    for (const format of ["json", "yaml"] as const)
      expect(parseDashboardBundle(serializeDashboardBundle({ dashboards: [dashboard] }, format), format).dashboards[0].widgets[0].config).toEqual(colored.config)
    expect(parseOpenUIDashboard(dashboardToOpenUI(dashboard)).widgets[0].config).toEqual(colored.config)
    rerender(<RecordTable widget={colored} result={result} />)
    expect(screen.getByRole("alert")).toHaveTextContent("no “risk” threshold column")
    rerender(<RecordTable widget={colored} result={{ records: { ...frame, columns: [...result.records!.columns, { key: "risk", type: "string" }] } }} />)
    expect(screen.getByRole("alert")).toHaveTextContent("requires a numeric column")
    expect(() => tableCellStylesSchema.parse([{ column: "trend", display: "color-text", thresholdColumn: "risk" }])).toThrow()
  })
})

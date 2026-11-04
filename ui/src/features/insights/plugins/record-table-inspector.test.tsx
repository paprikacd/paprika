import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RecordTable, registerRecordWidgetPlugins } from "./records"
import { getWidgetDefinition } from "../widget-registry"
import type { QueryResult, Widget } from "../schema"

afterEach(cleanup)
const widget: Widget = { id: "records", title: "Requests", type: "plugin", pluginId: "record-table", dataKind: "records", providerId: "db", query: "SELECT", unit: "", options: { decimals: 2 }, layout: { x: 0, y: 0, w: 6, h: 4 } }
const result: QueryResult = { records: { columns: [{ key: "service", type: "string" }, { key: "ratio", type: "number", unit: "%" }, { key: "active", type: "boolean" }], rows: [["api", 12.345, false], ["worker", null, true]], truncated: false } }

describe("record table cell inspection", () => {
  it("inspects the hovered recorded value and keyboard-navigates without selecting a row", () => {
    const select = vi.fn()
    render(<RecordTable widget={widget} result={result} onContextChange={select} />)
    const rows = screen.getAllByRole("row")
    const first = within(rows[1]).getByText("api").closest("td")!
    const value = within(rows[1]).getByText("12.35%").closest("td")!
    fireEvent.pointerEnter(value, { pointerType: "mouse" })
    expect(screen.getByRole("tooltip")).toHaveTextContent("ratio")
    expect(screen.getByRole("tooltip")).toHaveTextContent("12.35%")
    expect(screen.getByRole("tooltip")).toHaveTextContent("12.345")
    fireEvent.pointerLeave(value, { pointerType: "mouse" })
    first.focus()
    fireEvent.keyDown(first, { key: "ArrowRight" })
    expect(value).toHaveFocus()
    fireEvent.keyDown(value, { key: "Enter" })
    expect(screen.getByRole("region", { name: "Record cell details" })).toHaveTextContent("12.35%")
    expect(select).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("region", { name: "Record cell details" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Select row 1" }))
    expect(select).toHaveBeenCalledWith({ labels: { service: "api", ratio: "12.345", active: "false" } })
  })
  it("reports missing and boolean cells without manufacturing values", () => {
    render(<RecordTable widget={widget} result={result} />)
    const rows = screen.getAllByRole("row")
    const missing = within(rows[2]).getByText("—").closest("td")!
    fireEvent.pointerEnter(missing, { pointerType: "mouse" })
    expect(screen.getByRole("tooltip")).toHaveTextContent("No data")
    const boolean = within(rows[1]).getByText("No").closest("td")!
    fireEvent.pointerEnter(boolean, { pointerType: "mouse" })
    expect(screen.getByRole("tooltip")).toHaveTextContent("No")
  })
  it("summarizes recorded sparkline history and its threshold meaning without exposing the JSON payload", () => {
    const history = JSON.stringify([{ timestamp: "2026-01-01T00:00:00Z", value: 2.5 }, { timestamp: "2026-01-01T00:01:00Z", value: 3.25 }])
    const historyResult: QueryResult = { records: { columns: [{ key: "name", type: "string" }, { key: "risk", type: "number" }, { key: "history", type: "string" }], rows: [["api", 85, history]] } }
    const configured: Widget = { ...widget, options: { decimals: 2, thresholds: [{ value: 70, color: "#ff0000", label: "High" }] }, config: { cellStyles: [{ column: "history", display: "sparkline", unit: "req/s", thresholdColumn: "risk" }] } }
    const { container } = render(<RecordTable widget={configured} result={historyResult} />)
    const cell = container.querySelector('[data-cell-display="sparkline"]')!.closest("td")!
    fireEvent.pointerEnter(cell, { pointerType: "mouse" })
    const tip = screen.getByRole("tooltip")
    expect(tip).toHaveTextContent("3.25 req/s")
    expect(tip).toHaveTextContent("2 recorded samples")
    expect(tip).toHaveTextContent("Color by risk: 85 · High")
    expect(tip).not.toHaveTextContent(history)
  })
  it("honors the tooltip switch and keeps embedded views noninteractive", () => {
    registerRecordWidgetPlugins()
    expect(getWidgetDefinition("plugin", "record-table")?.styleControls).toContain("tooltips")
    const configured: Widget = { ...widget, config: { cellStyles: [{ column: "ratio", display: "bar", min: 0, max: 100 }] } }
    const { rerender } = render(<RecordTable widget={{ ...configured, options: { decimals: 2, showTooltip: false } }} result={result} />)
    let cell = screen.getByText("api").closest("td")!
    fireEvent.pointerEnter(cell, { pointerType: "mouse" })
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    expect(cell).not.toHaveAttribute("tabindex")
    expect(screen.getByText("12.35%").closest("td")!.querySelector("[title]")).toBeNull()
    rerender(<RecordTable widget={configured} result={result} embedded />)
    cell = screen.getByText("api").closest("td")!
    fireEvent.pointerEnter(cell, { pointerType: "mouse" })
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    expect(cell).not.toHaveAttribute("tabindex")
    expect(screen.getByText("12.35%").closest("td")!.querySelector("[title]")).toBeNull()
  })
})

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { QueryResult, Widget } from "../schema"
import { getWidgetDefinition } from "../widget-registry"
import { RecordTreemap, registerRecordWidgetPlugins } from "./records"

afterEach(cleanup)
const widget: Widget = { id: "market", title: "Market", type: "plugin", pluginId: "record-treemap", dataKind: "records", providerId: "records", query: "select", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, options: { decimals: 2 }, config: { label: "ticker", value: "market_cap", colorField: "short_interest", group: "sector" } }
const result: QueryResult = { records: { columns: [{ key: "ticker", type: "string" }, { key: "market_cap", label: "Market cap", type: "number", unit: "B" }, { key: "short_interest", label: "Short interest", type: "number", unit: "%" }, { key: "sector", type: "string" }], rows: [["AAA", 100.125, 8.5, "Technology"], ["BBB", 50, null, "Finance"]] } }

describe("record treemap tooltip", () => {
  it("exposes the tooltip and precision controls to the widget editor", () => {
    registerRecordWidgetPlugins()
    expect(getWidgetDefinition("plugin", "record-treemap")?.styleControls).toEqual(["unit", "decimals", "tooltips"])
  })
  it("shows exact recorded size, independent color and group on focus and keeps selection explicit", () => {
    const select = vi.fn()
    render(<RecordTreemap widget={widget} result={result} onContextChange={select} />)
    const tile = screen.getByRole("button", { name: /AAA:/ })
    fireEvent.focus(tile)
    const tip = screen.getByRole("tooltip")
    expect(within(tip).getByText("AAA")).toBeInTheDocument()
    expect(tip).toHaveTextContent("Market cap")
    expect(tip).toHaveTextContent("100.13 B")
    expect(tip).toHaveTextContent("Short interest")
    expect(tip).toHaveTextContent("8.50%")
    expect(tip).toHaveTextContent("Technology")
    expect(select).not.toHaveBeenCalled()
    fireEvent.keyDown(tile, { key: "Enter" })
    expect(select).toHaveBeenCalledWith({ labels: { ticker: "AAA", market_cap: "100.125", short_interest: "8.5", sector: "Technology" }, value: 100.125, series: "AAA" })
    expect(tile).toHaveAttribute("aria-pressed", "true")
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })
  it("reports a missing color value without inventing it and respects disabled tooltips", () => {
    const { rerender } = render(<RecordTreemap widget={widget} result={result} />)
    fireEvent.focus(screen.getByRole("button", { name: /BBB:/ }))
    expect(screen.getByRole("tooltip")).toHaveTextContent("No data")
    rerender(<RecordTreemap widget={{ ...widget, options: { showTooltip: false } }} result={result} />)
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    rerender(<RecordTreemap widget={widget} result={result} />)
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })
  it("uses the area column unit first, then the widget unit, without applying it to the color field", () => {
    const withWidgetUnit = { ...widget, unit: "AUD" }
    const { rerender } = render(<RecordTreemap widget={withWidgetUnit} result={result} />)
    fireEvent.focus(screen.getByRole("button", { name: /AAA:/ }))
    expect(screen.getByRole("tooltip")).toHaveTextContent("100.13 B")
    const noAreaUnit: QueryResult = { records: { ...result.records!, columns: result.records!.columns.map((column, index) => index === 1 ? { ...column, unit: undefined } : column) } }
    rerender(<RecordTreemap widget={withWidgetUnit} result={noAreaUnit} />)
    fireEvent.focus(screen.getByRole("button", { name: /AAA:/ }))
    expect(screen.getByRole("tooltip")).toHaveTextContent("100.13 AUD")
    expect(screen.getByRole("tooltip")).toHaveTextContent("8.50%")
  })
  it("does not retain stale tooltip content after precision or configuration changes", () => {
    const { rerender } = render(<RecordTreemap widget={widget} result={result} />)
    fireEvent.focus(screen.getByRole("button", { name: /AAA:/ }))
    expect(screen.getByRole("tooltip")).toHaveTextContent("100.13 B")
    rerender(<RecordTreemap widget={{ ...widget, options: { decimals: 1 } }} result={result} />)
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    fireEvent.focus(screen.getByRole("button", { name: /AAA:/ }))
    expect(screen.getByRole("tooltip")).toHaveTextContent("100.1 B")
  })
  it("deliberately abbreviates narrow tile readings while retaining full units in the accessible name", () => {
    const bounds = vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, right: 240, top: 0, bottom: 200, width: 240, height: 200, toJSON: () => ({}) })
    try {
      const narrow: QueryResult = { records: { columns: [{ key: "ticker", type: "string" }, { key: "market_cap", type: "number" }], rows: Array.from({ length: 8 }, (_, index) => [`company-${index}`, 100 + index]) } }
      const { container } = render(<RecordTreemap widget={{ ...widget, unit: "B AUD", config: { label: "ticker", value: "market_cap" } }} result={narrow} />)
      const tiles = [...container.querySelectorAll("g[role=button]")]
      const values = tiles.flatMap(tile => {
        const width = Number(tile.querySelector("rect")?.getAttribute("width"))
        const content = tile.querySelector("tspan")?.textContent
        return content ? [{ width, content, accessible: tile.getAttribute("aria-label") }] : []
      })
      expect(values.some(value => value.content.endsWith("…"))).toBe(true)
      for (const value of values) {
        expect(value.content.length).toBeLessThanOrEqual(Math.floor((value.width - 16) / 7))
        expect(value.accessible).toContain("B AUD")
      }
    } finally { bounds.mockRestore() }
  })
})

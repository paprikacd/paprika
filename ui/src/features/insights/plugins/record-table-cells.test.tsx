import { useState } from "react"
import { readFileSync } from "node:fs"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RecordTable, registerRecordWidgetPlugins } from "./records"
import { tableBarGeometry, tableCellStylesSchema, tableTextColor, tableTextPalette } from "./record-table-cells"
import { PluginConfigEditor } from "../plugin-config-editor"
import { getWidgetDefinition } from "../widget-registry"
import { contrastRatio } from "../appearance"
import type { QueryResult, Widget } from "../schema"
import { dashboardSchema } from "../schema"
import { dashboardToOpenUI, parseOpenUIDashboard } from "../openui"
import { parseDashboardBundle, serializeDashboardBundle } from "../workspace-transfer"
import { INSIGHTS_THEME_KEY } from "../insights-theme"

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })
const widget: Widget = {
  id: "capacity", title: "Resource capacity", type: "plugin", pluginId: "record-table", dataKind: "records",
  providerId: "records", query: "capacity", unit: "", layout: { x: 0, y: 0, w: 6, h: 3 },
  config: { density: "compact", cellStyles: [{ column: "usage", display: "bar", min: -100, max: 100 }] },
  options: { decimals: 2, thresholds: [{ value: -100, color: "#4b84b1", label: "Low" }, { value: 50, color: "#bd593e", label: "High" }] },
}
const result: QueryResult = { records: {
  columns: [{ key: "host", type: "string" }, { key: "usage", label: "Usage", type: "number", unit: "%" }],
  rows: [["negative", -50], ["zero", 0], ["missing", null], ["positive", 72.1234], ["outside", 120]],
} }

describe("table visual cells", () => {
  it("announces horizontal overflow and clears the hint when the table fits", async () => {
    let wide = true
    let notify: (() => void) | undefined
    const scrollWidth = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(() => wide ? 600 : 250)
    const clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(250)
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { notify = callback }
      observe() {}
      disconnect() {}
    })
    try {
      render(<RecordTable widget={widget} result={result} />)
      const hint = await screen.findByText("Scroll horizontally to see more columns")
      expect(screen.getByRole("region", { name: "Resource capacity records" })).toHaveAttribute("aria-describedby", hint.id)
      wide = false
      act(() => notify?.())
      await waitFor(() => expect(screen.queryByText("Scroll horizontally to see more columns")).not.toBeInTheDocument())
      expect(screen.getByRole("region", { name: "Resource capacity records" })).not.toHaveAttribute("aria-describedby")
    } finally { scrollWidth.mockRestore(); clientWidth.mockRestore() }
  })
  it("keeps threshold text readable against the actual Gamma panel tokens and custom backgrounds", () => {
    const css = readFileSync("src/features/insights/gamma/gamma-theme.module.css", "utf8")
    for (const theme of ["light", "dark"] as const) {
      const block = theme === "light" ? css.split('.scope[data-insights-theme="dark"]')[0] : css.split('.scope[data-insights-theme="dark"]')[1].split("}")[0]
      const background = block.match(/--gamma-bg:\s*(#[\da-f]{6})/)![1]
      const fallback = block.match(/--gamma-chart-3:\s*(#[\da-f]{6})/)![1]
      const thresholds = ["#f2cc0c", "#73bf69", "#c5b749", "#74b367", background].map((color, value) => ({ color, value }))
      const palette = tableTextPalette(theme, undefined, thresholds)
      for (const { color } of thresholds) {
        expect(palette.get(color)).toBe(tableTextColor(color, background))
        expect(contrastRatio(palette.get(color)!, background)).toBeGreaterThanOrEqual(4.5)
      }
      expect(palette.get("var(--gamma-chart-3)")).toBe(tableTextColor(fallback, background))
      expect(contrastRatio(palette.get("var(--gamma-chart-3)")!, background)).toBeGreaterThanOrEqual(4.5)
      for (const custom of ["#ffffff", "#182127", "#777777", "#fff2c8", "#144b39"]) {
        const palette = tableTextPalette(theme, custom, thresholds, "#eab839")
        for (const color of palette.values()) expect(contrastRatio(color, custom)).toBeGreaterThanOrEqual(4.5)
      }
    }
    expect(tableTextColor("#f2cc0c", "#182127")).toBe("#f2cc0c")
    expect(tableTextColor("#73bf69", "#182127")).toBe("#73bf69")
    expect(tableTextColor("#f2cc0c", "#ffffff")).not.toBe("#f2cc0c")
    expect(tableTextColor("#73bf69", "#ffffff")).not.toBe("#73bf69")
  })

  it("updates colored text with the shared theme while preserving authored colors and exact readings", () => {
    localStorage.setItem(INSIGHTS_THEME_KEY, "light")
    const thresholds = [{ value: 0, color: "#73bf69", label: "Normal" }, { value: 50, color: "#f2cc0c", label: "Warning" }]
    const styledWidget: Widget = { ...widget, options: { decimals: 2, thresholds }, config: { cellStyles: [{ column: "usage", display: "color-text" }] } }
    const view = render(<RecordTable widget={styledWidget} result={result} />)
    const reading = screen.getByRole("img", { name: "Usage: 72.1234% · Warning" })
    const normal = screen.getByRole("img", { name: "Usage: 0% · Normal" })
    const light = reading.style.color
    expect(contrastRatio(light, "#ffffff")).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(normal.style.color, "#ffffff")).toBeGreaterThanOrEqual(4.5)
    expect(reading.style.getPropertyValue("--cell-color")).toBe("#f2cc0c")
    expect(reading).toHaveTextContent("72.12%")
    act(() => {
      localStorage.setItem(INSIGHTS_THEME_KEY, "dark")
      window.dispatchEvent(new Event("paprika-insights-theme-change"))
    })
    expect(reading.style.color).toBe("#f2cc0c")
    expect(normal.style.color).toBe("#73bf69")
    expect(contrastRatio(reading.style.color, "#182127")).toBeGreaterThanOrEqual(4.5)
    expect(reading).toHaveAttribute("aria-label", "Usage: 72.1234% · Warning")
    view.rerender(<RecordTable widget={{ ...styledWidget, options: { ...styledWidget.options, background: "#ffffff" } }} result={result} />)
    expect(reading.style.color).toBe(light)
    expect(contrastRatio(reading.style.color, "#ffffff")).toBeGreaterThanOrEqual(4.5)
    expect(styledWidget.options?.thresholds).toEqual(thresholds)
    expect(screen.getByRole("img", { name: "Usage: No data" }).style.color).toBe("")
  })

  it("renders exact text statuses with explicit colors while keeping missing and unmapped values honest", () => {
    const statusResult: QueryResult = { records: { columns: [{ key: "host", type: "string" }, { key: "status", label: "State", type: "string" }], rows: [["a", "At risk"], ["b", "Healthy"], ["c", "Unexpected"], ["d", null]] } }
    const cellStyle = { column: "status", display: "status-badge", mappings: [{ value: "At risk", color: "#e6504d" }, { value: "Healthy", color: "#20cba3" }] }
    const configured: Widget = { ...widget, config: { cellStyles: [cellStyle] } }
    const view = render(<RecordTable widget={configured} result={statusResult} />)
    const risk = screen.getByText("At risk").closest('[data-cell-display="status-badge"]')!
    fireEvent.pointerEnter(risk.closest("td")!, { pointerType: "mouse" })
    expect(screen.getByRole("tooltip")).toHaveTextContent("State")
    expect(screen.getByRole("tooltip")).toHaveTextContent("At risk")
    expect(risk).toHaveAttribute("data-status-state", "mapped")
    expect(risk.querySelector('[aria-hidden="true"]')).toHaveStyle({ backgroundColor: "#e6504d" })
    expect(screen.getByText("Healthy").closest('[data-status-state]')).toHaveAttribute("data-status-state", "mapped")
    expect(screen.getByText("Unexpected").closest('[data-status-state]')).toHaveAttribute("data-status-state", "unmapped")
    expect(screen.getByText("No data").closest('[data-status-state]')).toHaveAttribute("data-status-state", "missing")
    expect(tableCellStylesSchema.parse([cellStyle])).toHaveLength(1)
    for (const invalid of [
      [{ ...cellStyle, mappings: [{ value: "Healthy", color: "red" }] }],
      [{ ...cellStyle, mappings: [cellStyle.mappings[0], cellStyle.mappings[0]] }],
      [{ ...cellStyle, unit: "%" }],
      [{ ...cellStyle, display: "color-text" }],
      [{ ...cellStyle, barColorMode: "value" }],
    ]) expect(() => tableCellStylesSchema.parse(invalid)).toThrow()
    view.rerender(<RecordTable widget={{ ...configured, config: { cellStyles: [{ ...cellStyle, column: "usage" }] } }} result={result} />)
    expect(screen.getByRole("alert")).toHaveTextContent("requires a string column")
    const dashboard = dashboardSchema.parse({ schemaVersion: 1, id: "status", title: "Status", timeRange: "1h", refreshInterval: 0, widgets: [configured] })
    for (const format of ["json", "yaml"] as const) expect(parseDashboardBundle(serializeDashboardBundle({ dashboards: [dashboard] }, format), format).dashboards[0].widgets[0].config).toEqual(configured.config)
    expect(parseOpenUIDashboard(dashboardToOpenUI(dashboard)).widgets[0].config).toEqual(configured.config)
  })

  it("colors a whole gauge by the observed value when configured", () => {
    const rule = { column: "usage", display: "bar-segments", min: 0, max: 100, segments: 6, barColorMode: "value" }
    render(<RecordTable widget={{ ...widget, config: { cellStyles: [rule] } }} result={result} />)
    const warning = screen.getByRole("img", { name: "Usage: 72.1234% · High · Scale 0% to 100%" })
    expect((warning.querySelector("[data-bar-end]") as HTMLElement).style.background).toBe("#bd593e")
    expect(warning).toHaveTextContent("72.12%")
    expect(screen.getByRole("img", { name: /Usage: No data/ }).querySelector("[data-bar-end]")).toBeNull()
  })

  it("preserves column rules through JSON/YAML bundles and OpenUI", () => {
    const dashboard = dashboardSchema.parse({ schemaVersion: 1, id: "capacity", title: "Capacity", timeRange: "1h", refreshInterval: 0, widgets: [widget] })
    const bundle = { dashboards: [dashboard] }
    for (const format of ["json", "yaml"] as const)
      expect(parseDashboardBundle(serializeDashboardBundle(bundle, format), format).dashboards[0].widgets[0].config).toEqual(widget.config)
    expect(parseOpenUIDashboard(dashboardToOpenUI(dashboard)).widgets[0].config).toEqual(widget.config)
  })
  it("requires bounded numeric scales and one style per column", () => {
    expect(tableCellStylesSchema.parse([{ column: "usage", display: "bar", min: -100, max: 100 }])).toHaveLength(1)
    for (const invalid of [
      [{ column: "usage", display: "bar" }],
      [{ column: "usage", display: "bar", min: 0, max: 0 }],
      [{ column: "usage", display: "bar", min: 100, max: 0 }],
      [{ column: "usage", display: "bar", min: 0, max: Infinity }],
      [{ column: "usage", display: "color-text", min: 0 }],
      [{ column: "usage", display: "color-text" }, { column: "usage", display: "color-background" }],
      Array.from({ length: 17 }, (_, i) => ({ column: `column${i}`, display: "color-text" })),
    ]) expect(() => tableCellStylesSchema.parse(invalid)).toThrow()
  })

  it("anchors signed values at zero and clamps only the visual extent", () => {
    expect(tableBarGeometry(-50, -100, 100)).toEqual({ baseline: .5, start: .25, end: .5, outside: false })
    expect(tableBarGeometry(0, -100, 100)).toEqual({ baseline: .5, start: .5, end: .5, outside: false })
    expect(tableBarGeometry(120, -100, 100)).toEqual({ baseline: .5, start: .5, end: 1, outside: true })
    expect(tableBarGeometry(-120, -100, 100)).toEqual({ baseline: .5, start: 0, end: .5, outside: true })
    expect(tableBarGeometry(15, 10, 20)).toEqual({ baseline: 0, start: 0, end: .5, outside: false })
    expect(tableBarGeometry(-15, -20, -10)).toEqual({ baseline: 1, start: .5, end: 1, outside: false })
    expect(tableBarGeometry(Number.MAX_VALUE / 2, -Number.MAX_VALUE, Number.MAX_VALUE)).toEqual({ baseline: .5, start: .5, end: .75, outside: false })
    expect(tableBarGeometry(-Number.MAX_VALUE / 2, -Number.MAX_VALUE, Number.MAX_VALUE)).toEqual({ baseline: .5, start: .25, end: .5, outside: false })
    expect(tableBarGeometry(Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE)).toEqual({ baseline: .5, start: .5, end: 1, outside: false })
    expect(tableBarGeometry(0, -Number.MAX_VALUE, Number.MAX_VALUE)).toEqual({ baseline: .5, start: .5, end: .5, outside: false })
  })

  it("renders segmented percentage gauges with exact values, bounded scales and honest gaps", () => {
    const rules = [{ column: "usage", display: "bar-segments", min: 0, max: 100, unit: "%", segments: 20 }]
    expect(tableCellStylesSchema.parse(rules)).toHaveLength(1)
    expect(() => tableCellStylesSchema.parse([{ ...rules[0], segments: 2 }])).toThrow()
    expect(() => tableCellStylesSchema.parse([{ ...rules[0], display: "bar" }])).toThrow()
    render(<RecordTable widget={{ ...widget, config: { cellStyles: rules } }} result={result} />)
    const positive = screen.getByRole("img", { name: "Usage: 72.1234% · High · Scale 0% to 100%" })
    expect(positive).toHaveTextContent("72.12%")
    expect(positive.querySelector("[data-segmented]")).toHaveStyle("--cell-segments: 20")
    expect(positive.querySelector("[data-bar-end]")).toHaveAttribute("data-bar-end", "0.721234")
    expect(screen.getByRole("img", { name: /Usage: No data/ }).querySelector("[data-bar-start]")).toBeNull()
    expect(screen.getByRole("img", { name: /Usage: 120%.*Outside scale/ })).toHaveTextContent("120.00%")
  })

  it("keeps exact readings, unknowns and threshold meaning while bars remain fixed through filtering", () => {
    const select = vi.fn()
    const { container } = render(<RecordTable widget={widget} result={result} onContextChange={select} />)
    const positive = screen.getByRole("img", { name: "Usage: 72.1234% · High · Scale -100% to 100%" })
    expect(positive).toHaveTextContent("72.12%")
    const fill = positive.querySelector("[data-bar-start]")!
    expect(fill).toHaveAttribute("data-bar-start", "0.5")
    expect(fill).toHaveAttribute("data-bar-end", "0.860617")
    expect((fill as HTMLElement).style.background).toContain("#4b84b1 75%, #bd593e 75%")
    expect(screen.getByRole("img", { name: /Usage: No data/ }).querySelector("[data-bar-start]")).toBeNull()
    expect(screen.getByRole("img", { name: /Usage: 120%.*Outside scale/ })).toHaveTextContent("120.00%")
    expect(container.querySelectorAll('[data-cell-display="bar"]')).toHaveLength(5)
    fireEvent.change(screen.getByRole("textbox", { name: "Filter Resource capacity" }), { target: { value: "positive" } })
    expect(screen.getByRole("img").querySelector("[data-bar-end]")).toHaveAttribute("data-bar-end", "0.860617")
    fireEvent.click(screen.getByRole("button", { name: "Select row 1" }))
    expect(select).toHaveBeenCalledWith({ labels: { host: "positive", usage: "72.1234" } })
  })

  it("sorts the original numbers with visual cells and preserves null at the end", () => {
    render(<RecordTable widget={widget} result={result} />)
    fireEvent.click(screen.getByRole("button", { name: "Usage" }))
    fireEvent.click(screen.getByRole("button", { name: "Usage ↑" }))
    const rows = screen.getAllByRole("row").slice(1)
    expect(rows.map(row => within(row).getAllByRole("cell")[0].textContent)).toEqual(["outside", "positive", "zero", "negative", "missing"])
  })

  it.each(["color-text", "color-background"] as const)("renders %s with exact threshold status and honest nulls", display => {
    const { container } = render(<RecordTable widget={{ ...widget, config: { cellStyles: [{ column: "usage", display }] } }} result={result} />)
    const value = screen.getByRole("img", { name: "Usage: 72.1234% · High" })
    expect(value).toHaveTextContent("72.12%")
    const unknown = screen.getByRole("img", { name: "Usage: No data" })
    expect(unknown.style.background).toBe("")
    expect(unknown.style.color).toBe("")
    expect(container.querySelectorAll("[data-bar-start]")).toHaveLength(0)
    if (display === "color-background") {
      expect(value.style.background).toBe("#bd593e")
      expect(contrastRatio("#ffffff", "#bd593e")).toBeGreaterThanOrEqual(4.5)
      expect(value.style.color).toBe("#ffffff")
    } else expect(value.style.color).toBe("#bd593e")
  })

  it.each(["host", "absent"])("reports invalid numeric column mapping %s without coercing strings", column => {
    render(<RecordTable widget={{ ...widget, config: { cellStyles: [{ column, display: "bar", min: 0, max: 100 }] } }} result={result} />)
    expect(screen.getByRole("alert")).toHaveTextContent(column === "host" ? "requires a numeric column" : "has no “absent” column")
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })

  it("authors status mappings and per-value gauge colors in the guided editor", () => {
    registerRecordWidgetPlugins()
    function Editor() {
      const [value, setValue] = useState('{"columns":["host","usage"]}')
      return <PluginConfigEditor definition={getWidgetDefinition("plugin", "record-table")} value={value} onChange={setValue} />
    }
    render(<Editor />)
    fireEvent.click(screen.getByRole("button", { name: "Add column style" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Column 1 name" }), { target: { value: "host" } })
    fireEvent.click(screen.getByRole("combobox", { name: "Column 1 display" }))
    fireEvent.click(screen.getByRole("option", { name: "Status badge" }))
    fireEvent.click(screen.getByRole("button", { name: "Add status" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Column 1 status 1 value" }), { target: { value: "At risk" } })
    fireEvent.change(screen.getByRole("textbox", { name: "Column 1 status 1 color" }), { target: { value: "#e6504d" } })
    const json = () => JSON.parse((screen.getByRole("textbox", { name: "Plugin configuration", hidden: true }) as HTMLTextAreaElement).value)
    expect(json().cellStyles).toEqual([{ column: "host", display: "status-badge", mappings: [{ value: "At risk", color: "#e6504d" }] }])
    fireEvent.click(screen.getByRole("combobox", { name: "Column 1 display" }))
    fireEvent.click(screen.getByRole("option", { name: "Segmented gauge" }))
    fireEvent.click(screen.getByRole("combobox", { name: "Column 1 gauge colors" }))
    fireEvent.click(screen.getByRole("option", { name: "Current value threshold" }))
    expect(json().cellStyles).toEqual([{ column: "host", display: "bar-segments", min: 0, max: 100, barColorMode: "value" }])
  })

  it("authors column presentation without replacing unrelated configuration", () => {
    registerRecordWidgetPlugins()
    function Editor() {
      const [value, setValue] = useState('{"columns":["host","usage"],"pageSize":5}')
      return <PluginConfigEditor definition={getWidgetDefinition("plugin", "record-table")} value={value} onChange={setValue} />
    }
    render(<Editor />)
    fireEvent.click(screen.getByRole("button", { name: "Add column style" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Column 1 name" }), { target: { value: "usage" } })
    fireEvent.change(screen.getByRole("spinbutton", { name: "Column 1 minimum" }), { target: { value: "-100" } })
    const json = () => JSON.parse((screen.getByRole("textbox", { name: "Plugin configuration", hidden: true }) as HTMLTextAreaElement).value)
    expect(json()).toEqual({ columns: ["host", "usage"], pageSize: 5, cellStyles: [{ column: "usage", display: "bar", min: -100, max: 100 }] })
    fireEvent.click(screen.getByRole("combobox", { name: "Column 1 display" }))
    fireEvent.click(screen.getByRole("option", { name: "Colored background" }))
    expect(json().cellStyles).toEqual([{ column: "usage", display: "color-background" }])
    fireEvent.click(screen.getByRole("combobox", { name: "Column 1 display" }))
    fireEvent.click(screen.getByRole("option", { name: "History sparkline" }))
    expect(json().cellStyles).toEqual([{ column: "usage", display: "sparkline" }])
    expect(screen.getByText(/ordered ISO timestamp and numeric or null value/)).toBeInTheDocument()
    fireEvent.change(screen.getByRole("textbox", { name: "Column 1 history unit" }), { target: { value: "%" } })
    expect(json().cellStyles).toEqual([{ column: "usage", display: "sparkline", unit: "%" }])
    fireEvent.change(screen.getByRole("textbox", { name: "Column 1 threshold column" }), { target: { value: "risk" } })
    expect(json().cellStyles).toEqual([{ column: "usage", display: "sparkline", unit: "%", thresholdColumn: "risk" }])
    fireEvent.click(screen.getByRole("combobox", { name: "Column 1 display" }))
    fireEvent.click(screen.getByRole("option", { name: "Segmented gauge" }))
    fireEvent.change(screen.getByRole("spinbutton", { name: "Column 1 segments" }), { target: { value: "20" } })
    expect(json().cellStyles).toEqual([{ column: "usage", display: "bar-segments", unit: "%", min: 0, max: 100, segments: 20 }])
    fireEvent.click(screen.getByRole("button", { name: "Remove column style 1" }))
    expect(json()).toEqual({ columns: ["host", "usage"], pageSize: 5 })
  })
})

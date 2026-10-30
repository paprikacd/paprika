import { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { DashboardWindowProvider } from "../dashboard-window"
import type { QueryResult, Widget } from "../schema"
import { RecordTable } from "./records"
import { RecordTableStyleEditor } from "./record-table-style-editor"

const widget: Widget = { id: "events", title: "Incidents", type: "plugin", pluginId: "record-table", dataKind: "records", providerId: "db", query: "incidents", unit: "", layout: { x: 0, y: 0, w: 6, h: 4 }, config: { columns: ["date", "duration"], timeSelection: { start: "date", duration: "duration", durationUnit: "minutes", paddingSeconds: 300 } } }
const result: QueryResult = { records: { columns: [{ key: "date", type: "timestamp" }, { key: "duration", type: "number" }], rows: [["2026-10-20T12:00:00Z", 10], ["2026-10-20T12:30:00Z", null], ["2026-10-20T13:00:00Z", 999999]] } }

describe("record interval selection", () => {
  it("focuses only an explicitly selected complete interval, with configured padding", () => {
    const apply = vi.fn(), select = vi.fn()
    render(<DashboardWindowProvider value={{ apply }}><RecordTable widget={widget} result={result} onContextChange={select} /></DashboardWindowProvider>)
    expect(screen.getByRole("button", { name: "Focus time for row 2" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Focus time for row 3" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Focus time for row 1" }))
    expect(apply).toHaveBeenCalledWith({ start: Date.parse("2026-10-20T11:55:00Z"), end: Date.parse("2026-10-20T12:15:00Z") })
    expect(select).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Select row 1" }))
    expect(select).toHaveBeenCalledOnce()
  })
  it("rejects columns of the wrong type and does not offer an action without a dashboard host", () => {
    const invalid = { ...result, records: { ...result.records!, columns: [{ key: "date", type: "string" as const }, { key: "duration", type: "number" as const }] } }
    const { rerender } = render(<DashboardWindowProvider value={{ apply: vi.fn() }}><RecordTable widget={widget} result={invalid} /></DashboardWindowProvider>)
    expect(screen.getByRole("alert")).toHaveTextContent("requires a timestamp")
    rerender(<RecordTable widget={widget} result={result} />)
    expect(screen.queryByRole("button", { name: /Focus time/ })).not.toBeInTheDocument()
  })
  it("authors the explicit recorded-interval mapping without changing other table settings", () => {
    function Editor() { const [config, setConfig] = useState<Record<string, unknown>>({ columns: ["date", "duration"] }); return <><RecordTableStyleEditor config={config} onChange={setConfig} /><pre data-testid="config">{JSON.stringify(config)}</pre></> }
    render(<Editor />)
    fireEvent.click(screen.getByRole("switch", { name: /Focus dashboard time from a row/ }))
    fireEvent.change(screen.getByRole("textbox", { name: "Time selection start column" }), { target: { value: "date" } })
    fireEvent.change(screen.getByRole("textbox", { name: "Time selection duration column" }), { target: { value: "duration" } })
    expect(JSON.parse(screen.getByTestId("config").textContent!)).toEqual({ columns: ["date", "duration"], timeSelection: { start: "date", duration: "duration", durationUnit: "minutes", paddingSeconds: 300 } })
    fireEvent.click(screen.getByRole("switch", { name: /Focus dashboard time from a row/ }))
    expect(JSON.parse(screen.getByTestId("config").textContent!)).toEqual({ columns: ["date", "duration"] })
  })
})

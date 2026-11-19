import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { RecordTableStyleEditor } from "./record-table-style-editor"

const bar = (thresholds: unknown) => ({ columns: ["usage"], cellStyles: [{ column: "usage", display: "bar", thresholds }] })

describe("column thresholds in the record table editor", () => {
  it("shows the JSON correction notice instead of crashing on a malformed band", () => {
    for (const thresholds of [[null], [5], ["ok"]]) {
      const { unmount } = render(<RecordTableStyleEditor config={bar(thresholds)} onChange={vi.fn()} />)
      expect(screen.getByText(/Correct this column's thresholds in the configuration JSON/)).toBeTruthy()
      expect(screen.queryByLabelText("Column 1 threshold 1 value")).toBeNull()
      unmount()
    }
  })

  it("renders the band list for well-formed bands", () => {
    render(<RecordTableStyleEditor config={bar([{ value: 0, status: "ok" }])} onChange={vi.fn()} />)
    expect((screen.getByLabelText("Column 1 threshold 1 value") as HTMLInputElement).value).toBe("0")
  })
})

/** Opens a Gamma select by its accessible name and picks an option by its label, using the keyboard as the listbox does. */
function pickOption(name: string, label: string) {
  const trigger = screen.getByRole("combobox", { name })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  fireEvent.click(screen.getByRole("option", { name: label }))
}

describe("own thresholds follow the column display", () => {
  it("drops a column's bands when its display changes to one that does not use them", () => {
    for (const display of ["Status badge", "History sparkline"]) {
      const onChange = vi.fn()
      const { unmount } = render(<RecordTableStyleEditor config={bar([{ value: 0, status: "ok" }])} onChange={onChange} />)
      pickOption("Column 1 display", display)
      const next = onChange.mock.calls.at(-1)?.[0]
      expect(next.cellStyles[0]).not.toHaveProperty("thresholds")
      unmount()
    }
  })

  it("keeps a column's bands when its display stays a colour display", () => {
    const onChange = vi.fn()
    render(<RecordTableStyleEditor config={bar([{ value: 0, status: "ok" }])} onChange={onChange} />)
    pickOption("Column 1 display", "Colored value")
    expect(onChange.mock.calls.at(-1)?.[0].cellStyles[0].thresholds).toEqual([{ value: 0, status: "ok" }])
  })
})

describe("column threshold buttons", () => {
  it("names each column's add button so two columns with their own bands stay distinct", () => {
    const config = { columns: ["a", "b"], cellStyles: [
      { column: "a", display: "bar", min: 0, max: 100, thresholds: [{ value: 0, status: "ok" }] },
      { column: "b", display: "bar", min: 0, max: 100, thresholds: [{ value: 0, status: "ok" }] },
    ] }
    render(<RecordTableStyleEditor config={config} onChange={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Add column 1 threshold" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Add column 2 threshold" })).toBeTruthy()
    expect(screen.queryAllByRole("button", { name: "Add column threshold" })).toHaveLength(0)
  })
})

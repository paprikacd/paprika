import { describe, expect, it } from "vitest"
import { render, screen, within } from "@testing-library/react"
import { ShortcutList, shortcutGroups } from "./shortcut-list"

describe("shortcutGroups", () => {
  it("names the Command keys on Apple platforms and the Control keys elsewhere", () => {
    const apple = shortcutGroups(true).flatMap(group => group.rows.map(row => `${row.label}=${row.keys}`))
    const other = shortcutGroups(false).flatMap(group => group.rows.map(row => `${row.label}=${row.keys}`))
    expect(apple).toContain("Undo=⌘Z")
    expect(apple).toContain("Apply changes=⌘↵")
    expect(other).toContain("Undo=Ctrl+Z")
    expect(other).toContain("Apply changes=Ctrl+Enter")
    expect(apple).toContain("Apply and save=⌘⇧S")
    expect(other).toContain("Apply and save=Ctrl+Shift+S")
    expect(other).toContain("Remove tile=Delete or Backspace")
  })
})

describe("ShortcutList", () => {
  it("renders as a labelled dialog with one section per scope", () => {
    render(<ShortcutList isMac={false} onClose={() => undefined} />)
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" })
    for (const title of ["Dashboard", "Chart editor", "Tiles (editing, a focused tile)", "Help"]) {
      expect(within(dialog).getByRole("heading", { name: title, level: 3 })).toBeInTheDocument()
    }
  })

  it("reports a cancel to the owner instead of closing on its own", () => {
    let closed = 0
    render(<ShortcutList isMac={false} onClose={() => closed++} />)
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" })
    const event = new Event("cancel", { cancelable: true })
    dialog.dispatchEvent(event)
    expect(closed).toBe(1)
    expect(event.defaultPrevented).toBe(true)
  })
})

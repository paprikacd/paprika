import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useBuilderPanelFocus } from "./use-builder-panel-focus"

const originalScroll = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
)
const scroll = vi.fn()
let compact = true
beforeEach(() => {
  compact = true
  scroll.mockClear()
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  })
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) => ({ matches: compact, media: query }) as MediaQueryList,
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  if (originalScroll)
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollIntoView",
      originalScroll,
    )
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView")
})
function Harness({ identity }: { identity: string | null }) {
  const panel = useBuilderPanelFocus(identity)
  const [text, setText] = useState("")
  return (
    <>
      <button>First widget</button>
      <button>Second widget</button>
      {identity && (
        <aside ref={panel} tabIndex={-1} aria-label="Builder panel">
          {identity !== "loading" && <h2>Widget settings</h2>}
          <label>
            Title
            <input
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <button>Open another panel</button>
        </aside>
      )}
    </>
  )
}

describe("builder panel focus", () => {
  it("focuses and reveals compact panels, preserves typing focus, and restores the opener", () => {
    const { rerender } = render(<Harness identity={null} />)
    const opener = screen.getByRole("button", { name: "First widget" })
    opener.focus()
    rerender(<Harness identity="widget:first" />)
    const heading = screen.getByRole("heading", { name: "Widget settings" })
    expect(heading).toHaveFocus()
    expect(heading).toHaveAttribute("tabindex", "-1")
    expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "auto" })
    const input = screen.getByLabelText("Title")
    input.focus()
    fireEvent.change(input, { target: { value: "My chart" } })
    expect(input).toHaveFocus()
    compact = false
    rerender(<Harness identity="widget:first" />)
    expect(input).toHaveFocus()
    expect(scroll).toHaveBeenCalledTimes(1)
    rerender(<Harness identity={null} />)
    expect(opener).toHaveFocus()
  })

  it("moves focus for a different selected widget and restores its own opener", () => {
    const { rerender } = render(<Harness identity={null} />)
    screen.getByRole("button", { name: "First widget" }).focus()
    rerender(<Harness identity="widget:first" />)
    const next = screen.getByRole("button", { name: "Second widget" })
    next.focus()
    rerender(<Harness identity="widget:second" />)
    expect(
      screen.getByRole("heading", { name: "Widget settings" }),
    ).toHaveFocus()
    expect(scroll).toHaveBeenCalledTimes(2)
    rerender(<Harness identity={null} />)
    expect(next).toHaveFocus()
  })

  it("keeps the original opener through internal panel transitions and avoids desktop scrolling", () => {
    compact = false
    const { rerender } = render(<Harness identity={null} />)
    const opener = screen.getByRole("button", { name: "First widget" })
    opener.focus()
    rerender(<Harness identity="add" />)
    screen.getByRole("button", { name: "Open another panel" }).focus()
    rerender(<Harness identity="ai" />)
    expect(
      screen.getByRole("heading", { name: "Widget settings" }),
    ).toHaveFocus()
    expect(scroll).not.toHaveBeenCalled()
    rerender(<Harness identity={null} />)
    expect(opener).toHaveFocus()
  })
  it("uses the panel as a fallback while an asynchronous section is loading", () => {
    render(<Harness identity="loading" />)
    expect(screen.getByRole("complementary", { name: "Builder panel" })).toHaveFocus()
  })

})

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it } from "vitest"

import {
  MorphTabList,
  MorphTabPanel,
  type MorphTab,
} from "@/components/ui/morph-tabs"

const TABS: readonly MorphTab<"one" | "two" | "three">[] = [
  { id: "one", label: "One" },
  { id: "two", label: "Two" },
  { id: "three", label: "Three" },
]

function Harness() {
  const [value, setValue] = useState<"one" | "two" | "three">("one")
  return (
    <>
      <MorphTabList
        tabs={TABS}
        value={value}
        onValueChange={setValue}
        label="Sections"
        idPrefix="tab"
        panelId="panel"
      />
      <MorphTabPanel
        id="panel"
        labelledBy={`tab-${value}`}
        direction="right"
      >
        {value}
      </MorphTabPanel>
    </>
  )
}

describe("MorphTabList", () => {
  it("wires the tablist, roving tabindex and panel relationship", () => {
    render(<Harness />)

    expect(screen.getByRole("tablist", { name: "Sections" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "One" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByRole("tab", { name: "One" })).toHaveAttribute(
      "tabindex",
      "0"
    )
    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute(
      "tabindex",
      "-1"
    )
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      "tab-one"
    )
    expect(screen.getByRole("tabpanel")).toHaveClass("morph-tab-panel")
  })

  it("moves selection with arrows, Home and End and follows focus", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    screen.getByRole("tab", { name: "One" }).focus()
    await user.keyboard("{ArrowRight}")
    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByRole("tab", { name: "Two" })).toHaveFocus()

    await user.keyboard("{ArrowLeft}")
    expect(screen.getByRole("tab", { name: "One" })).toHaveAttribute(
      "aria-selected",
      "true"
    )

    await user.keyboard("{End}")
    expect(screen.getByRole("tab", { name: "Three" })).toHaveAttribute(
      "aria-selected",
      "true"
    )

    await user.keyboard("{Home}")
    expect(screen.getByRole("tab", { name: "One" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByRole("tab", { name: "One" })).toHaveFocus()
  })

  it("selects on click", async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByRole("tab", { name: "Three" }))
    expect(screen.getByRole("tab", { name: "Three" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByRole("tabpanel")).toHaveTextContent("three")
  })
})

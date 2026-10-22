import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { Tooltip } from "@/components/ui/tooltip"

describe("Tooltip", () => {
  it("stays closed until the trigger is hovered or focused", async () => {
    render(
      <Tooltip content="The full endpoint URL">
        <button type="button">Open</button>
      </Tooltip>,
    )

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()

    await userEvent.hover(screen.getByRole("button", { name: "Open" }))

    await waitFor(() =>
      expect(screen.getByRole("tooltip")).toHaveTextContent(
        "The full endpoint URL",
      ),
    )
  })

  it("opens at once on focus and describes the trigger", async () => {
    render(
      <Tooltip content="The full endpoint URL">
        <button type="button">Open</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole("button", { name: "Open" })
    trigger.focus()

    await waitFor(() => expect(screen.getByRole("tooltip")).toBeInTheDocument())
    expect(trigger.getAttribute("aria-describedby")).toBe(
      screen.getByRole("tooltip").id,
    )
  })

  it("closes on Escape without moving focus", async () => {
    render(
      <Tooltip content="The full endpoint URL">
        <button type="button">Open</button>
      </Tooltip>,
    )

    const trigger = screen.getByRole("button", { name: "Open" })
    trigger.focus()
    await waitFor(() => expect(screen.getByRole("tooltip")).toBeInTheDocument())

    await userEvent.keyboard("{Escape}")

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it("does not open when it is disabled", async () => {
    render(
      <Tooltip content="The full endpoint URL" disabled>
        <button type="button">Open</button>
      </Tooltip>,
    )

    await userEvent.hover(screen.getByRole("button", { name: "Open" }))

    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
  })
})

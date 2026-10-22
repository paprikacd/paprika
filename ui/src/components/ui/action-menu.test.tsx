import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ActionMenu, type ActionMenuGroup } from "@/components/ui/action-menu"

const GROUPS: readonly ActionMenuGroup[] = [
  {
    id: "delivery",
    label: "Delivery",
    items: [
      { id: "promote", label: "Promote to 25%", shortcut: "P" },
      { id: "hold", label: "Hold", disabled: true },
    ],
  },
  {
    id: "danger",
    items: [{ id: "abort", label: "Abort & roll back", danger: true }],
  },
]

describe("ActionMenu", () => {
  it("opens on click and reports the chosen action", async () => {
    const onSelect = vi.fn()
    render(
      <ActionMenu
        groups={GROUPS}
        label="Actions for checkout-api"
        onSelect={onSelect}
      />,
    )

    const trigger = screen.getByRole("button", {
      name: "Actions for checkout-api",
    })
    expect(trigger).toHaveAttribute("aria-expanded", "false")

    await userEvent.click(trigger)
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("menu")).toBeInTheDocument()
    expect(screen.getByRole("group", { name: "Delivery" })).toBeInTheDocument()

    await userEvent.click(screen.getByRole("menuitem", { name: /Promote to 25%/ }))

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "promote" }),
    )
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it("opens from the keyboard on the first enabled action and skips disabled ones", async () => {
    render(<ActionMenu groups={GROUPS} label="Actions" />)

    const trigger = screen.getByRole("button", { name: "Actions" })
    trigger.focus()
    await userEvent.keyboard("{ArrowDown}")

    const promote = screen.getByRole("menuitem", { name: /Promote to 25%/ })
    expect(promote).toHaveFocus()

    await userEvent.keyboard("{ArrowDown}")
    // `Hold` is disabled, so the next stop is the destructive action.
    expect(screen.getByRole("menuitem", { name: /Abort/ })).toHaveFocus()

    await userEvent.keyboard("{ArrowDown}")
    expect(promote).toHaveFocus()
  })

  it("closes on Escape and hands focus back to the trigger", async () => {
    render(<ActionMenu groups={GROUPS} label="Actions" />)

    const trigger = screen.getByRole("button", { name: "Actions" })
    await userEvent.click(trigger)
    expect(screen.getByRole("menu")).toBeInTheDocument()

    await userEvent.keyboard("{Escape}")

    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it("activates an entry from its shortcut letter while open", async () => {
    const onSelect = vi.fn()
    render(<ActionMenu groups={GROUPS} label="Actions" onSelect={onSelect} />)

    await userEvent.click(screen.getByRole("button", { name: "Actions" }))
    await userEvent.keyboard("p")

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "promote" }),
    )
  })

  it("never fires a disabled entry", async () => {
    const onSelect = vi.fn()
    render(<ActionMenu groups={GROUPS} label="Actions" onSelect={onSelect} />)

    await userEvent.click(screen.getByRole("button", { name: "Actions" }))
    const hold = screen.getByRole("menuitem", { name: "Hold" })
    expect(hold).toHaveAttribute("aria-disabled", "true")

    await userEvent.click(hold)

    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByRole("menu")).toBeInTheDocument()
  })
})

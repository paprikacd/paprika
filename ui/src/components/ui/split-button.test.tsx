import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { SplitButton, type SplitButtonItem } from "@/components/ui/split-button"

const ITEMS: readonly SplitButtonItem[] = [
  { id: "hold", label: "Hold", shortcut: "H" },
  { id: "abort", label: "Abort & roll back", danger: true },
]

function renderSplit({
  onPrimary = vi.fn(),
  onSelect = vi.fn(),
  disabled = false,
}: {
  onPrimary?: () => void
  onSelect?: (id: string) => void
  disabled?: boolean
} = {}) {
  render(
    <SplitButton
      label="Promote to 25%"
      menuLabel="More rollout actions"
      items={ITEMS}
      disabled={disabled}
      onPrimary={onPrimary}
      onSelect={onSelect}
    />,
  )
  return { onPrimary, onSelect }
}

describe("SplitButton", () => {
  it("keeps two separate controls inside one labelled group", () => {
    renderSplit()

    expect(
      screen.getByRole("group", { name: "Promote to 25%" }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Promote to 25%" }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "More rollout actions" }),
    ).toHaveAttribute("aria-haspopup", "menu")
  })

  it("runs the primary action without opening the menu", async () => {
    const { onPrimary } = renderSplit()

    await userEvent.click(screen.getByRole("button", { name: "Promote to 25%" }))

    expect(onPrimary).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  })

  it("reports the chosen secondary action and closes", async () => {
    const { onSelect } = renderSplit()

    const toggle = screen.getByRole("button", { name: "More rollout actions" })
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")

    await userEvent.click(
      screen.getByRole("menuitem", { name: /Abort & roll back/ }),
    )

    expect(onSelect).toHaveBeenCalledWith("abort")
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(toggle).toHaveFocus()
  })

  it("opens from the toggle and moves through its actions with the keyboard", async () => {
    renderSplit()

    const toggle = screen.getByRole("button", { name: "More rollout actions" })
    toggle.focus()
    await userEvent.keyboard("{ArrowDown}")

    const hold = screen.getByRole("menuitem", { name: /Hold/ })
    expect(hold).toHaveFocus()

    await userEvent.keyboard("{End}")
    expect(screen.getByRole("menuitem", { name: /Abort/ })).toHaveFocus()

    await userEvent.keyboard("{Escape}")
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
    expect(toggle).toHaveFocus()
  })

  it("disables both halves together", () => {
    renderSplit({ disabled: true })

    expect(screen.getByRole("button", { name: "Promote to 25%" })).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "More rollout actions" }),
    ).toBeDisabled()
  })
})

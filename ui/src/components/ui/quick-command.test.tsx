import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { QuickCommand, type QuickCommandItem } from "@/components/ui/quick-command"

const ITEMS: readonly QuickCommandItem[] = [
  {
    id: "go:overview",
    label: "Overview",
    group: "Go to",
    description: "Fleet posture",
  },
  {
    id: "go:rollouts",
    label: "Rollouts",
    group: "Go to",
    description: "In-flight rollouts",
  },
  {
    id: "app:checkout",
    label: "checkout-api",
    group: "Applications",
    description: "payments",
  },
]

describe("QuickCommand", () => {
  it("opens from the trigger and focuses the search field", async () => {
    render(<QuickCommand items={ITEMS} onSelect={vi.fn()} />)

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /Search commands/ }))

    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByRole("combobox")).toHaveFocus()
  })

  it("filters on labels, groups, descriptions and keywords", async () => {
    render(
      <QuickCommand
        items={[
          ...ITEMS,
          {
            id: "app:other",
            label: "payments-api",
            group: "Applications",
            keywords: ["checkout"],
          },
        ]}
        onSelect={vi.fn()}
      />,
    )

    await userEvent.click(screen.getByRole("button", { name: /Search commands/ }))
    await userEvent.type(screen.getByRole("combobox"), "checkout")

    expect(screen.getByRole("option", { name: /checkout-api/ })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: /payments-api/ })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /Overview/ })).not.toBeInTheDocument()
  })

  it("moves the selection with the keyboard and runs the active result", async () => {
    const onSelect = vi.fn()
    render(<QuickCommand items={ITEMS} onSelect={onSelect} />)

    await userEvent.click(screen.getByRole("button", { name: /Search commands/ }))
    const input = screen.getByRole("combobox")

    expect(input.getAttribute("aria-activedescendant")).toContain("go:overview")

    await userEvent.keyboard("{ArrowDown}")
    expect(input.getAttribute("aria-activedescendant")).toContain("go:rollouts")

    await userEvent.keyboard("{Enter}")
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "go:rollouts" }),
    )
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("closes on Escape and gives focus back to the trigger", async () => {
    render(<QuickCommand items={ITEMS} onSelect={vi.fn()} />)

    const trigger = screen.getByRole("button", { name: /Search commands/ })
    await userEvent.click(trigger)
    await userEvent.keyboard("{Escape}")

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it("reports the query so the host can fetch its own results", async () => {
    const onQueryChange = vi.fn()
    render(
      <QuickCommand items={ITEMS} onSelect={vi.fn()} onQueryChange={onQueryChange} />,
    )

    await userEvent.click(screen.getByRole("button", { name: /Search commands/ }))
    await userEvent.type(screen.getByRole("combobox"), "check")

    expect(onQueryChange).toHaveBeenLastCalledWith("check")
  })

  it("opens on the keyboard shortcut when one is enabled", async () => {
    render(<QuickCommand items={ITEMS} onSelect={vi.fn()} shortcut />)

    await userEvent.keyboard("{Meta>}k{/Meta}")

    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })
})

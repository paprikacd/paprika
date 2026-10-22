import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { DisclosureStack } from "@/components/ui/disclosure-stack"

const ITEMS = [
  { id: "gate", title: "Manual approval", content: <p>Gate detail</p> },
  { id: "policy", title: "Policy checks", content: <p>Policy detail</p> },
]

/** Resolve the panel through the header's own `aria-controls`, so the
 *  relationship — not a test-only selector — is what gets asserted. */
function panelFor(title: string) {
  const button = screen.getByRole("button", { name: title })
  const id = button.getAttribute("aria-controls")
  expect(id).toBeTruthy()
  const panel = document.getElementById(id as string)
  expect(panel).not.toBeNull()
  return panel as HTMLElement
}

describe("DisclosureStack", () => {
  it("wires each header to its panel and starts closed", () => {
    render(<DisclosureStack items={ITEMS} />)

    expect(
      screen.getByRole("button", { name: "Manual approval" }),
    ).toHaveAttribute("aria-expanded", "false")
    expect(panelFor("Manual approval")).toHaveAttribute("hidden")
    expect(panelFor("Manual approval")).toHaveAttribute(
      "aria-labelledby",
      screen.getByRole("button", { name: "Manual approval" }).id,
    )
  })

  it("opens the panels listed in defaultOpen", () => {
    render(<DisclosureStack items={ITEMS} defaultOpen={["policy"]} />)

    expect(screen.getByRole("button", { name: "Policy checks" })).toHaveAttribute(
      "aria-expanded",
      "true",
    )
    expect(panelFor("Policy checks")).not.toHaveAttribute("hidden")
    expect(panelFor("Manual approval")).toHaveAttribute("hidden")
  })

  it("keeps one panel open at a time in single mode", async () => {
    render(<DisclosureStack items={ITEMS} />)

    await userEvent.click(screen.getByRole("button", { name: "Manual approval" }))
    await userEvent.click(screen.getByRole("button", { name: "Policy checks" }))

    expect(
      screen.getByRole("button", { name: "Manual approval" }),
    ).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByRole("button", { name: "Policy checks" })).toHaveAttribute(
      "aria-expanded",
      "true",
    )

    await userEvent.click(screen.getByRole("button", { name: "Policy checks" }))
    expect(screen.getByRole("button", { name: "Policy checks" })).toHaveAttribute(
      "aria-expanded",
      "false",
    )
  })

  it("leaves the other panels open in multiple mode", async () => {
    render(<DisclosureStack items={ITEMS} mode="multiple" />)

    await userEvent.click(screen.getByRole("button", { name: "Manual approval" }))
    await userEvent.click(screen.getByRole("button", { name: "Policy checks" }))

    expect(panelFor("Manual approval")).not.toHaveAttribute("hidden")
    expect(panelFor("Policy checks")).not.toHaveAttribute("hidden")
  })
})

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const copyToClipboard = vi.hoisted(() => vi.fn())

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: (text: string) => copyToClipboard(text),
}))

import { CopyField } from "@/components/ui/copy-field"

describe("CopyField", () => {
  beforeEach(() => {
    copyToClipboard.mockReset()
  })

  it("copies the value and announces success", async () => {
    copyToClipboard.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(
      <CopyField value="github.com/acme/checkout-api" label="Repository" />
    )

    await user.click(
      screen.getByRole("button", { name: "Copy Repository" })
    )

    expect(copyToClipboard).toHaveBeenCalledWith(
      "github.com/acme/checkout-api"
    )
    expect(screen.getByRole("status")).toHaveTextContent(
      "Repository copied"
    )
    expect(
      screen.getByRole("button", { name: "Copied" })
    ).toBeInTheDocument()
  })

  it("offers a retry after a clipboard failure", async () => {
    copyToClipboard.mockRejectedValueOnce(new Error("denied"))
    const user = userEvent.setup()
    render(<CopyField value="r241" label="Revision" />)

    await user.click(screen.getByRole("button", { name: "Copy Revision" }))

    expect(screen.getByRole("status")).toHaveTextContent(
      "Revision copy failed. Retry."
    )
    expect(
      screen.getByRole("button", { name: "Copy Revision failed; retry" })
    ).toBeInTheDocument()
  })

  it("keeps the full value available when the row truncates", () => {
    render(
      <CopyField
        value="a-very-long-repository-url-that-does-not-fit"
        label="Repository"
      />
    )
    expect(
      screen.getByText("a-very-long-repository-url-that-does-not-fit")
    ).toHaveAttribute(
      "title",
      "a-very-long-repository-url-that-does-not-fit"
    )
  })
})

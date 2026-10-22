import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ResizablePanes } from "@/components/ui/resizable-panes"

/** The divider only exists where the panes sit side by side. */
function setViewport(width: number) {
  const happy = (window as unknown as { happyDOM?: { setViewport?: (size: { width: number; height: number }) => void } }).happyDOM
  happy?.setViewport?.({ width, height: 900 })
}

beforeEach(() => {
  setViewport(1600)
})

function renderPanes({
  onRatioChange,
  defaultRatio = 60,
}: { onRatioChange?: (ratio: number) => void; defaultRatio?: number } = {}) {
  render(
    <ResizablePanes
      label="Resize the detail rail"
      defaultRatio={defaultRatio}
      minRatio={40}
      maxRatio={80}
      onRatioChange={onRatioChange}
      left={<p>Main</p>}
      right={<p>Rail</p>}
    />,
  )
  return screen.getByRole("separator", { name: "Resize the detail rail" })
}

describe("ResizablePanes", () => {
  it("states the split to assistive technology", () => {
    const separator = renderPanes()

    expect(separator).toHaveAttribute("aria-orientation", "vertical")
    expect(separator).toHaveAttribute("aria-valuemin", "40")
    expect(separator).toHaveAttribute("aria-valuemax", "80")
    expect(separator).toHaveAttribute("aria-valuenow", "60")
    expect(separator).toHaveAttribute("aria-valuetext", expect.stringContaining("60%"))
  })

  it("moves the split with the arrow keys and clamps it", async () => {
    const onRatioChange = vi.fn()
    const separator = renderPanes({ onRatioChange })

    separator.focus()
    await userEvent.keyboard("{ArrowRight}")
    expect(onRatioChange).toHaveBeenLastCalledWith(62)

    await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}")
    expect(onRatioChange).toHaveBeenLastCalledWith(52)

    await userEvent.keyboard("{End}")
    expect(onRatioChange).toHaveBeenLastCalledWith(80)

    await userEvent.keyboard("{Home}")
    expect(onRatioChange).toHaveBeenLastCalledWith(40)

    expect(separator).toHaveAttribute("aria-valuenow", "40")
  })

  it("resets to the initial split on a double click", async () => {
    const onRatioChange = vi.fn()
    const separator = renderPanes({ onRatioChange, defaultRatio: 65 })

    separator.focus()
    await userEvent.keyboard("{ArrowRight}")
    expect(onRatioChange).toHaveBeenLastCalledWith(67)

    await userEvent.dblClick(separator)
    expect(onRatioChange).toHaveBeenLastCalledWith(65)
  })

  it("keeps both panes in the document", () => {
    renderPanes()
    expect(screen.getByText("Main")).toBeInTheDocument()
    expect(screen.getByText("Rail")).toBeInTheDocument()
  })

  it("stacks the panes and hides the divider when the viewport is narrow", () => {
    setViewport(900)
    render(
      <ResizablePanes
        label="Resize the detail rail"
        left={<p>Main</p>}
        right={<p>Rail</p>}
      />,
    )

    expect(screen.queryByRole("separator")).not.toBeInTheDocument()
    expect(screen.getByText("Main")).toBeInTheDocument()
    expect(screen.getByText("Rail")).toBeInTheDocument()
  })
})

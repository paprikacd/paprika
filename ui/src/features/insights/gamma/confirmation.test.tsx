import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { GammaConfirmation, useConfirmation } from "./confirmation"

function Example({ completed }: { completed: (accepted: boolean) => void }) {
  const { ask, request, resolve } = useConfirmation()
  return <>
    <button onClick={async () => completed(await ask({ title: "Delete dashboard?", description: "This cannot be undone.", action: "Delete dashboard" }))}>Delete</button>
    <GammaConfirmation request={request} onResolve={resolve} />
  </>
}

describe("Gamma confirmation", () => {
  it("focuses the safe action, cancels without side effects, and restores focus", async () => {
    const completed = vi.fn()
    render(<Example completed={completed} />)
    const opener = screen.getByRole("button", { name: "Delete" })
    opener.focus()
    fireEvent.click(opener)
    expect(screen.getByRole("alertdialog")).toHaveAccessibleName("Delete dashboard?")
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(completed).toHaveBeenCalledWith(false))
    expect(opener).toHaveFocus()
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })
  it("resolves acceptance once and cancels a pending decision when unmounted", async () => {
    const completed = vi.fn()
    const view = render(<Example completed={completed} />)
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete dashboard" }))
    await waitFor(() => expect(completed).toHaveBeenCalledOnce())
    expect(completed).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    view.unmount()
    await waitFor(() => expect(completed).toHaveBeenLastCalledWith(false))
  })
})

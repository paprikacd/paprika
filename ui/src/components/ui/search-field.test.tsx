import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { SearchField } from "@/components/ui/search-field"

describe("SearchField", () => {
  it("names the input and emits every keystroke", async () => {
    const onChange = vi.fn()
    render(
      <SearchField
        label="Search applications"
        placeholder="Search apps…"
        onChange={onChange}
      />,
    )

    const input = screen.getByRole("searchbox", { name: "Search applications" })
    await userEvent.type(input, "checkout")

    expect(onChange).toHaveBeenLastCalledWith("checkout")
    expect(input).toHaveValue("checkout")
  })

  it("clears the query and returns focus to the input", async () => {
    const onChange = vi.fn()
    render(
      <SearchField
        label="Search applications"
        defaultValue="checkout"
        onChange={onChange}
      />,
    )

    const clear = screen.getByRole("button", { name: "Clear search" })
    await userEvent.click(clear)

    expect(onChange).toHaveBeenCalledWith("")
    expect(
      screen.getByRole("searchbox", { name: "Search applications" }),
    ).toHaveFocus()
    expect(
      screen.queryByRole("button", { name: "Clear search" }),
    ).not.toBeInTheDocument()
  })

  it("submits on Enter only when the caller asks for an explicit search", async () => {
    const onSearch = vi.fn()
    render(
      <SearchField
        label="Search applications"
        defaultValue="checkout"
        onSearch={onSearch}
      />,
    )

    const input = screen.getByRole("searchbox", { name: "Search applications" })
    input.focus()
    await userEvent.keyboard("{Enter}")

    expect(onSearch).toHaveBeenCalledWith("checkout")

    await userEvent.click(screen.getByRole("button", { name: "Search" }))
    expect(onSearch).toHaveBeenCalledTimes(2)
  })

  it("associates consumer-owned validation with the input", () => {
    render(<SearchField label="Search applications" error="Too short" />)

    const input = screen.getByRole("searchbox", { name: "Search applications" })
    expect(input).toHaveAttribute("aria-invalid", "true")
    expect(input.getAttribute("aria-describedby")).toBeTruthy()
    expect(screen.getByText("Too short")).toBeInTheDocument()
  })
})

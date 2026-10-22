import { render, screen } from "@testing-library/react"
import { Search } from "lucide-react"
import { describe, expect, it } from "vitest"

import { EmptyState } from "@/components/ui/empty-state"

describe("EmptyState", () => {
  it("explains the context and renders one clear action", () => {
    render(
      <EmptyState
        icon={Search}
        title="Choose an application"
        description="The drift queue is scoped to one application."
        action={<button type="button">Open applications</button>}
      />
    )

    expect(screen.getByText("Choose an application")).toBeInTheDocument()
    expect(
      screen.getByText("The drift queue is scoped to one application.")
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Open applications" })
    ).toBeInTheDocument()
  })

  it("renders without an action or description", () => {
    render(<EmptyState compact title="Nothing selected" />)
    expect(screen.getByText("Nothing selected")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })
})

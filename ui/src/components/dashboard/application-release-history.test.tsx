import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Release } from "@/gen/paprika/v1/api_pb"
import { ApplicationReleaseHistory } from "@/components/dashboard/application-release-history"

function makeRelease(index: number) {
  return new Release({
    name: `release-${String(index).padStart(2, "0")}`,
    namespace: "apps",
    application: "checkout-api",
    phase: index % 2 === 0 ? "Complete" : "Running",
    pipeline: "checkout-pipeline",
    target: "prod",
    createdAt: BigInt(1_700_000_000 + index),
    policyResults: [],
  })
}

describe("ApplicationReleaseHistory", () => {
  it("paginates app-scoped releases instead of rendering every release", async () => {
    const user = userEvent.setup()
    const releases = Array.from({ length: 10 }, (_, index) => makeRelease(index + 1))

    render(
      <ApplicationReleaseHistory
        releases={releases}
        onRollback={vi.fn()}
      />,
    )

    expect(screen.getByText("Showing 1-8 of 10 app-scoped releases.")).toBeInTheDocument()
    expect(screen.getByText("release-01")).toBeInTheDocument()
    expect(screen.getByText("release-08")).toBeInTheDocument()
    expect(screen.queryByText("release-09")).not.toBeInTheDocument()
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /next releases/i }))

    expect(screen.getByText("Showing 9-10 of 10 app-scoped releases.")).toBeInTheDocument()
    expect(screen.getByText("release-09")).toBeInTheDocument()
    expect(screen.getByText("release-10")).toBeInTheDocument()
    expect(screen.queryByText("release-01")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: /next releases/i })).toBeDisabled()
  })

  it("routes rollback actions for visible releases", async () => {
    const user = userEvent.setup()
    const onRollback = vi.fn()

    render(
      <ApplicationReleaseHistory
        releases={[makeRelease(1)]}
        onRollback={onRollback}
      />,
    )

    await user.click(screen.getByRole("button", { name: /rollback/i }))

    expect(onRollback).toHaveBeenCalledWith(expect.objectContaining({ name: "release-01" }))
  })
})

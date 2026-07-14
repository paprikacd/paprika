import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HookStatus, Release } from "@/gen/paprika/v1/api_pb"
import { ReleaseGrid } from "@/components/dashboard/release-table"

describe("ReleaseGrid", () => {
  const releases = [
    new Release({
      name: "demo-release",
      namespace: "apps",
      pipeline: "demo-pipeline",
      application: "demo-app",
      target: "prod",
      phase: "Canarying",
      currentStage: "prod",
      rolloutRef: "demo-rollout",
      canaryWeight: 50,
      canaryStepIndex: 2,
      renderedManifestSnapshot: "demo-release-snapshot",
      hookStatuses: [
        new HookStatus({
          kind: "Job",
          name: "pre-sync",
          phase: "PreSync",
          status: "Succeeded",
        }),
        new HookStatus({
          kind: "Job",
          name: "post-sync",
          phase: "PostSync",
          status: "Running",
        }),
      ],
    }),
  ]

  it("renders a semantic flat inventory with valid definition groups and scoped drill-down links", () => {
    const { container } = render(
      <ReleaseGrid
        releases={releases}
        query="namespace=apps&namespace=platform&project=team%2Fpayments&q=demo&page=3&unknown=kept&tab=evidence"
      />,
    )

    expect(screen.getByRole("heading", { name: "Release inventory" })).toBeInTheDocument()
    expect(screen.getByRole("list", { name: "Releases" })).toBeInTheDocument()
    expect(screen.getAllByRole("listitem")).toHaveLength(1)
    expect(screen.getByText("demo-rollout")).toBeInTheDocument()
    expect(screen.getByText("Canary 50%")).toBeInTheDocument()
    expect(screen.getByText("step 2")).toBeInTheDocument()
    expect(screen.getByText("demo-release-snapshot")).toBeInTheDocument()
    expect(screen.getByText("Hooks")).toBeInTheDocument()
    expect(screen.getByText("1/2")).toBeInTheDocument()
    expect(screen.getByText("Canarying")).toHaveClass("text-primary")
    expect(screen.getByRole("link", { name: "Open application demo-app" })).toHaveAttribute(
      "href",
      "/dashboard/application?namespace=apps&namespace=platform&project=team%2Fpayments&q=demo&page=3&unknown=kept&tab=evidence&application_namespace=apps&application_name=demo-app",
    )
    expect(screen.getByRole("link", { name: "Open rollout demo-rollout" })).toHaveAttribute(
      "href",
      "/dashboard/rollouts/detail?namespace=apps&namespace=platform&project=team%2Fpayments&q=demo&page=3&unknown=kept&tab=evidence&rollout_namespace=apps&rollout_name=demo-rollout",
    )
    expect(screen.queryByRole("button", { name: /rollback/i })).not.toBeInTheDocument()
    expect(screen.getByRole("list", { name: "Releases" }).className).not.toMatch(/min-w-/)
    const definitionGroups = [...container.querySelectorAll("dl > div")]
    expect(definitionGroups).toHaveLength(4)
    for (const group of definitionGroups) {
      expect([...group.children].map((child) => child.tagName)).toEqual(["DT", "DD"])
    }
  })

  it("keys same-named releases by namespace and only links references that exist", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    render(
      <ReleaseGrid
        releases={[
          new Release({ name: "shared", namespace: "apps", phase: "Pending" }),
          new Release({ name: "shared", namespace: "platform", phase: "Complete" }),
        ]}
      />,
    )

    expect(screen.getAllByRole("listitem")).toHaveLength(2)
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("same key"), expect.anything())
    consoleError.mockRestore()
  })

  it("announces distinct loading, empty, no-match, and recoverable error states through one live region", async () => {
    const user = userEvent.setup()
    const retry = vi.fn()
    const { rerender } = render(<ReleaseGrid releases={[]} loading />)

    const liveRegion = screen.getByRole("status")
    expect(screen.getAllByRole("status")).toHaveLength(1)
    expect(liveRegion).toHaveTextContent("Loading releases…")
    expect(screen.getByTestId("release-grid-skeleton")).toBeInTheDocument()

    rerender(<ReleaseGrid releases={[]} />)
    expect(screen.getByRole("status")).toHaveTextContent("No releases yet")
    expect(screen.getByText("Create a Release resource to start promoting pipelines")).toBeInTheDocument()

    rerender(<ReleaseGrid releases={[]} search="checkout" />)
    expect(screen.getByRole("status")).toHaveTextContent('No releases match “checkout”')

    rerender(<ReleaseGrid releases={[]} error="Release service unavailable" onRetry={retry} />)
    expect(screen.getByRole("status")).toHaveTextContent("Release service unavailable")
    expect(screen.getByText("Release inventory unavailable")).toBeInTheDocument()
    expect(screen.queryByText("No releases yet")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Retry releases" }))
    expect(retry).toHaveBeenCalledOnce()

    rerender(<ReleaseGrid releases={releases} error="Release service unavailable" onRetry={retry} />)
    expect(screen.getByRole("status")).toHaveTextContent("Release service unavailable")
    expect(screen.getByText("demo-release")).toBeInTheDocument()
  })
})

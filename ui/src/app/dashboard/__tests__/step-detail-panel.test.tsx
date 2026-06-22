import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StepDetailPanel } from "@/components/dashboard/step-detail-panel"
import { Step, StepStatus } from "@/gen/paprika/v1/api_pb"

const baseStep: Step = new Step({ name: "build", image: "", script: "", depends: [] })

describe("StepDetailPanel", () => {
  it("shows placeholder when no step selected", () => {
    render(
      <StepDetailPanel
        step={null}
        status={null}
        logs={null}
        logsLoading={false}
        onRetry={vi.fn()}
        onSkip={vi.fn()}
      />
    )
    expect(screen.getByText("Select a step to view details")).toBeInTheDocument()
  })

  it("shows Retry button for failed step", () => {
    const status = new StepStatus({ name: "build", phase: "Failed" })
    render(
      <StepDetailPanel
        step={baseStep}
        status={status}
        logs="error: build failed"
        logsLoading={false}
        onRetry={vi.fn()}
        onSkip={vi.fn()}
      />
    )
    expect(screen.getByText("Retry")).toBeInTheDocument()
    expect(screen.getByText("error: build failed")).toBeInTheDocument()
  })

  it("shows Skip button for pending step", () => {
    const status = new StepStatus({ name: "build", phase: "Pending" })
    render(
      <StepDetailPanel
        step={baseStep}
        status={status}
        logs={null}
        logsLoading={false}
        onRetry={vi.fn()}
        onSkip={vi.fn()}
      />
    )
    expect(screen.getByText("Skip")).toBeInTheDocument()
  })

  it("calls onRetry when Retry is clicked", async () => {
    const onRetry = vi.fn()
    const status = new StepStatus({ name: "build", phase: "Failed" })
    render(
      <StepDetailPanel
        step={baseStep}
        status={status}
        logs={null}
        logsLoading={false}
        onRetry={onRetry}
        onSkip={vi.fn()}
      />
    )
    await userEvent.click(screen.getByText("Retry"))
    expect(onRetry).toHaveBeenCalled()
  })
})

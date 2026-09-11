import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { StepDetailPanel } from "@/components/dashboard/step-detail-panel"
import { Step, StepStatus } from "@/gen/paprika/v1/api_pb"

const buildStep = new Step({
  name: "unit-test",
  image: "ghcr.io/acme/test-runner:3.2",
  script: "",
  depends: [],
})

function renderPanel(props: Partial<Parameters<typeof StepDetailPanel>[0]> = {}) {
  return render(
    <StepDetailPanel
      step={buildStep}
      status={new StepStatus({ name: "unit-test", phase: "Running" })}
      logs={null}
      logsLoading={false}
      onRetry={vi.fn()}
      onSkip={vi.fn()}
      {...props}
    />
  )
}

describe("StepDetailPanel", () => {
  it("asks for a selection when no step is chosen", () => {
    renderPanel({ step: null, status: null })
    expect(screen.getByText("Select a step to view details")).toBeInTheDocument()
  })

  it("names the step and states its phase in words", () => {
    renderPanel({ status: new StepStatus({ name: "unit-test", phase: "Skipped" }) })
    expect(
      screen.getByRole("heading", { name: "unit-test" })
    ).toBeInTheDocument()
    expect(screen.getByText("Skipped")).toBeInTheDocument()
  })

  it("labels the log region and renders the log text", () => {
    renderPanel({ logs: "ok checkout/cart 0.42s" })
    const region = screen.getByRole("region", { name: /logs for unit-test/i })
    expect(region).toHaveTextContent("ok checkout/cart 0.42s")
  })

  it("says so rather than showing an empty pane when there are no logs", () => {
    renderPanel()
    expect(screen.getByText("No logs available")).toBeInTheDocument()
  })

  it("omits the resource segment when PIPELINE_RUNS cannot supply it", () => {
    renderPanel({ resourceLabel: null })
    expect(screen.queryByText(/CPU/)).not.toBeInTheDocument()
    expect(screen.getByText(/ghcr\.io\/acme\/test-runner:3\.2/)).toBeInTheDocument()
  })

  it("shows the resource segment when the run record supplies one", () => {
    renderPanel({ resourceLabel: "4 CPU / 8 GiB" })
    expect(screen.getByText(/4 CPU \/ 8 GiB/)).toBeInTheDocument()
  })

  it("only offers Retry step on a failed step, and calls back when used", async () => {
    const onRetry = vi.fn()
    const { rerender } = renderPanel({ onRetry })
    expect(screen.getByRole("button", { name: "Retry step" })).toBeDisabled()

    rerender(
      <StepDetailPanel
        step={buildStep}
        status={new StepStatus({ name: "unit-test", phase: "Failed" })}
        logs={null}
        logsLoading={false}
        onRetry={onRetry}
        onSkip={vi.fn()}
      />
    )
    const retry = screen.getByRole("button", { name: "Retry step" })
    expect(retry).toBeEnabled()
    await userEvent.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("only offers Skip on a pending step, and calls back when used", async () => {
    const onSkip = vi.fn()
    renderPanel({
      status: new StepStatus({ name: "unit-test", phase: "Pending" }),
      onSkip,
    })
    const skip = screen.getByRole("button", { name: "Skip" })
    expect(skip).toBeEnabled()
    await userEvent.click(skip)
    expect(onSkip).toHaveBeenCalledTimes(1)
  })

  it("offers full logs only when the caller can widen the tail", async () => {
    const onLoadFullLogs = vi.fn()
    const { rerender } = renderPanel()
    expect(screen.queryByRole("button", { name: /full logs/i })).not.toBeInTheDocument()

    rerender(
      <StepDetailPanel
        step={buildStep}
        status={new StepStatus({ name: "unit-test", phase: "Running" })}
        logs={null}
        logsLoading={false}
        onRetry={vi.fn()}
        onSkip={vi.fn()}
        onLoadFullLogs={onLoadFullLogs}
      />
    )
    await userEvent.click(screen.getByRole("button", { name: "Full logs" }))
    expect(onLoadFullLogs).toHaveBeenCalledTimes(1)
  })
})

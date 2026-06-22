import { describe, expect, it, vi } from "vitest"
import React from "react"
import { render, screen } from "@testing-library/react"
import { PipelineDAG } from "@/components/dashboard/pipeline-dag"
import { Step, StepStatus } from "@/gen/paprika/v1/api_pb"

const mockSteps: Step[] = [
  new Step({ name: "build", image: "golang:1.22", script: "go build", depends: [] }),
  new Step({ name: "test", image: "golang:1.22", script: "go test", depends: ["build"] }),
]

const mockStatuses: StepStatus[] = [
  new StepStatus({ name: "build", phase: "Succeeded" }),
  new StepStatus({ name: "test", phase: "Running" }),
]

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react")
  return {
    ...actual,
    ReactFlow: ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="react-flow">{children}</div>
    ),
    Handle: ({ children }: { children?: React.ReactNode }) => <div data-testid="handle">{children}</div>,
  }
})

describe("PipelineDAG", () => {
  it("renders react flow container", () => {
    render(
      <PipelineDAG
        steps={mockSteps}
        stepStatuses={mockStatuses}
        selectedStep={null}
        onStepSelect={() => {}}
      />
    )
    expect(screen.getByTestId("react-flow")).toBeInTheDocument()
  })
})

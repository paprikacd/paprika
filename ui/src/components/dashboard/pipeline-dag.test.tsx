import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { PipelineStepNode } from "@/components/dashboard/pipeline-dag-node"

// xyflow needs a real viewport to lay anything out. The mock keeps the
// contract that matters here — the nodes the component decided to draw, and
// the node component it drew them with.
vi.mock("@xyflow/react", () => ({
  ReactFlow: ({
    nodes,
    nodeTypes,
  }: {
    nodes: PipelineStepNode[]
    nodeTypes: Record<string, React.ComponentType<{ id: string; data: unknown }>>
  }) => (
    <div data-testid="react-flow">
      {nodes.map((node) => {
        const NodeComponent = nodeTypes[node.type ?? ""]
        return <NodeComponent key={node.id} id={node.id} data={node.data} />
      })}
    </div>
  ),
  Handle: () => null,
  Position: { Top: "top", Bottom: "bottom" },
}))

import { MAX_DAG_NODES, PipelineDAG } from "@/components/dashboard/pipeline-dag"
import { Step, StepStatus } from "@/gen/paprika/v1/api_pb"

const NOW = 1_700_000_000_000

const steps = [
  new Step({ name: "checkout", image: "ghcr.io/acme/git:1", depends: [] }),
  new Step({ name: "build", image: "ghcr.io/acme/kaniko:1", depends: ["checkout"] }),
  new Step({ name: "unit-test", image: "ghcr.io/acme/test-runner:3.2", depends: ["build"] }),
]

const statuses = [
  new StepStatus({
    name: "checkout",
    phase: "Succeeded",
    startedAt: BigInt(NOW / 1000 - 100),
    completedAt: BigInt(NOW / 1000 - 96),
  }),
  new StepStatus({ name: "build", phase: "Succeeded" }),
  new StepStatus({
    name: "unit-test",
    phase: "Running",
    startedAt: BigInt(NOW / 1000 - 66),
  }),
]

function renderDag(props: Partial<Parameters<typeof PipelineDAG>[0]> = {}) {
  return render(
    <PipelineDAG
      steps={steps}
      stepStatuses={statuses}
      selectedStep={null}
      onStepSelect={vi.fn()}
      nowMs={NOW}
      {...props}
    />
  )
}

describe("PipelineDAG", () => {
  it("names the graph so it can be found by assistive technology", () => {
    renderDag()
    expect(screen.getByRole("group", { name: "Step graph" })).toBeInTheDocument()
  })

  it("draws one operable button per step, carrying its phase in words", () => {
    renderDag()
    const nodes = screen.getAllByRole("button")
    expect(nodes).toHaveLength(3)
    expect(
      screen.getByRole("button", { name: /checkout/ })
    ).toHaveAccessibleName(expect.stringContaining("Succeeded"))
    expect(
      screen.getByRole("button", { name: /unit-test/ })
    ).toHaveAccessibleName(expect.stringContaining("Running"))
  })

  it("shows the elapsed time of a running step", () => {
    renderDag()
    expect(screen.getByText(/test-runner:3\.2 · 1m 06s/)).toBeInTheDocument()
  })

  it("selects a step from the keyboard", async () => {
    const onStepSelect = vi.fn()
    renderDag({ onStepSelect })
    await userEvent.tab()
    await userEvent.keyboard("{Enter}")
    expect(onStepSelect).toHaveBeenCalledWith("checkout")
  })

  it("marks the selected step as pressed rather than by colour alone", () => {
    renderDag({ selectedStep: "build" })
    expect(screen.getByRole("button", { name: /build/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
  })

  it("stays bounded and says so when a pipeline has more steps than it draws", () => {
    const many = Array.from(
      { length: MAX_DAG_NODES + 12 },
      (_, index) => new Step({ name: `step-${index}`, image: "", depends: [] })
    )
    renderDag({ steps: many, stepStatuses: [] })
    expect(screen.getAllByRole("button")).toHaveLength(MAX_DAG_NODES)
    expect(screen.getByText("12 further steps not drawn")).toBeInTheDocument()
  })
})

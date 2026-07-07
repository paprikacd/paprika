import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ResourceGraph, type ResourceGraphNode } from "@/components/dashboard/resource-graph"

vi.mock("@xyflow/react", () => ({
  // Mock ReactFlow to render node type components as the real one would.
  ReactFlow: ({ nodes, edges, nodeTypes, children }: Record<string, unknown>) => (
    <div
      data-testid="react-flow"
      data-nodes={JSON.stringify((nodes as { id: string }[]).map((n) => ({ id: n.id })))}
      data-edges={JSON.stringify(edges)}
    >
      {children as React.ReactNode}
      {(nodes as { id: string; type: string; data: Record<string, unknown> }[]).map((n) => {
        const NodeComp = (typeof nodeTypes === "object" && nodeTypes !== null)
          ? (nodeTypes as Record<string, unknown>)[n.type]
          : undefined
        return NodeComp
          ? <div key={n.id} data-testid="rf-node-wrapper"><NodeComp data={n.data} /></div>
          : <div key={n.id}>{n.id}</div>
      })}
    </div>
  ),
  Background: () => <div data-testid="bg" />,
  Controls: () => <div data-testid="controls" />,
  Handle: ({ type }: Record<string, unknown>) => <div data-testid={`handle-${type}`} />,
  Position: { Top: "top", Bottom: "bottom" },
}))

vi.mock("lucide-react", () => {
  const Icon = (p: React.SVGProps<SVGSVGElement>) => <svg data-testid="icon" {...p} />
  return {
    CheckCircle2: Icon,
    AlertCircle: Icon,
    XCircle: Icon,
    Clock: Icon,
    Heart: Icon,
    Activity: Icon,
    ChevronRight: Icon,
    Network: Icon,
    List: Icon,
    Boxes: Icon,
  }
})

const sampleNodes: ResourceGraphNode[] = [
  {
    kind: "Deployment",
    name: "demo-deploy",
    namespace: "test-ns",
    syncStatus: "Synced",
    health: "Healthy",
    healthMessage: "",
    parentKind: "",
    parentName: "",
    uid: "",
    managed: true,
  },
  {
    kind: "ReplicaSet",
    name: "demo-deploy-abc12",
    namespace: "test-ns",
    syncStatus: "Synced",
    health: "Healthy",
    healthMessage: "",
    parentKind: "Deployment",
    parentName: "demo-deploy",
    uid: "",
    managed: false,
  },
]

describe("ResourceGraph", () => {
  it("renders an empty state with no nodes", () => {
    render(<ResourceGraph nodes={[]} onSelectNode={vi.fn()} />)
    expect(screen.getByText("No resources to display.")).toBeInTheDocument()
  })

  it("renders ReactFlow with nodes and edges from graph nodes", () => {
    render(<ResourceGraph nodes={sampleNodes} onSelectNode={vi.fn()} />)
    const rf = screen.getByTestId("react-flow")
    expect(rf).toBeInTheDocument()
    const parsedNodes = JSON.parse(rf.getAttribute("data-nodes")!)
    expect(parsedNodes).toHaveLength(2)
    expect(parsedNodes[0].id).toBe("Deployment/demo-deploy")
    expect(parsedNodes[1].id).toBe("ReplicaSet/demo-deploy-abc12")
    const parsedEdges = JSON.parse(rf.getAttribute("data-edges")!)
    expect(parsedEdges).toHaveLength(1)
    expect(parsedEdges[0].source).toBe("Deployment/demo-deploy")
    expect(parsedEdges[0].target).toBe("ReplicaSet/demo-deploy-abc12")
  })

  it("calls onSelectNode when a node is clicked", async () => {
    const onSelect = vi.fn()
    render(<ResourceGraph nodes={sampleNodes} onSelectNode={onSelect} />)

    // ResourceFlowNode renders a div with role="button".
    const buttons = screen.getAllByRole("button")
    expect(buttons.length).toBeGreaterThan(0)

    await userEvent.setup().click(buttons[0])
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import {
  MAX_GRAPH_NODES,
  ResourceGraph,
  type ResourceGraphNode,
} from "@/components/dashboard/resource-graph"

vi.mock("@xyflow/react", () => ({
  // Render the node-type component the way the real ReactFlow would, so the
  // tests can assert on what a reader actually sees.
  ReactFlow: ({ nodes, edges, nodeTypes, children }: Record<string, unknown>) => (
    <div
      data-testid="react-flow"
      data-nodes={JSON.stringify((nodes as { id: string }[]).map((n) => ({ id: n.id })))}
      data-edges={JSON.stringify(edges)}
    >
      {children as React.ReactNode}
      {(nodes as { id: string; type: string; data: Record<string, unknown> }[]).map(
        (n) => {
          const NodeComp =
            typeof nodeTypes === "object" && nodeTypes !== null
              ? (nodeTypes as Record<string, unknown>)[n.type]
              : undefined
          return NodeComp ? (
            <div key={n.id}>
              <NodeComp data={n.data} />
            </div>
          ) : (
            <div key={n.id}>{n.id}</div>
          )
        }
      )}
    </div>
  ),
  Background: () => <div data-testid="bg" />,
  BackgroundVariant: { Lines: "lines", Dots: "dots", Cross: "cross" },
  Controls: () => <div data-testid="controls" />,
  Handle: ({ type }: Record<string, unknown>) => <div data-testid={`handle-${type}`} />,
  Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
}))

function node(over: Partial<ResourceGraphNode> = {}): ResourceGraphNode {
  return {
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
    ...over,
  }
}

const sampleNodes: ResourceGraphNode[] = [
  node({ ready: 3, total: 3 }),
  node({
    kind: "ReplicaSet",
    name: "demo-deploy-abc12",
    parentKind: "Deployment",
    parentName: "demo-deploy",
    health: "Failed",
    managed: false,
  }),
]

describe("ResourceGraph", () => {
  it("says there is nothing to draw rather than drawing an empty canvas", () => {
    render(<ResourceGraph nodes={[]} onSelectNode={vi.fn()} />)
    expect(screen.getByText(/No managed resources reported/i)).toBeInTheDocument()
  })

  it("names each node by kind, name, health and sync for assistive tech", () => {
    render(<ResourceGraph nodes={sampleNodes} onSelectNode={vi.fn()} />)
    expect(
      screen.getByRole("button", { name: "DEPLOYMENT demo-deploy, Healthy, Synced" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: "REPLICASET demo-deploy-abc12, Failed, Synced",
      })
    ).toBeInTheDocument()
  })

  it("draws the parent edge and marks the one landing on a failed object", () => {
    render(<ResourceGraph nodes={sampleNodes} onSelectNode={vi.fn()} />)
    const edges = JSON.parse(
      screen.getByTestId("react-flow").getAttribute("data-edges")!
    )
    expect(edges).toHaveLength(1)
    expect(edges[0].source).toBe("Deployment/demo-deploy")
    expect(edges[0].target).toBe("ReplicaSet/demo-deploy-abc12")
    expect(edges[0].style.strokeDasharray).toBe("3 2")
  })

  it("opens the inspector from the keyboard", async () => {
    const onSelect = vi.fn()
    render(<ResourceGraph nodes={sampleNodes} onSelectNode={onSelect} />)

    const target = screen.getByRole("button", {
      name: "DEPLOYMENT demo-deploy, Healthy, Synced",
    })
    target.focus()
    await userEvent.setup().keyboard("{Enter}")

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "Deployment", name: "demo-deploy" })
    )
  })

  it("badges a ready count only when the server sent one", () => {
    render(
      <ResourceGraph
        nodes={[node({ ready: 1, total: 3 }), node({ kind: "Service", name: "svc" })]}
        onSelectNode={vi.fn()}
      />
    )
    expect(screen.getByText("1/3")).toBeInTheDocument()
    // The Service reported no ready/total, so it carries no badge at all —
    // not a "0/0".
    expect(screen.queryByText("0/0")).not.toBeInTheDocument()
  })

  it("refuses to draw past its node budget and points at the tree", () => {
    const many = Array.from({ length: MAX_GRAPH_NODES + 1 }, (_, i) =>
      node({ name: `pod-${i}`, kind: "Pod" })
    )
    render(<ResourceGraph nodes={many} onSelectNode={vi.fn()} />)
    expect(screen.queryByTestId("react-flow")).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent(/Switch to Tree/i)
  })
})

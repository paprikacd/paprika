import { describe, it, expect, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ResourceGraph, type ResourceGraphNode } from "@/components/dashboard/resource-graph"

vi.mock("@xyflow/react", () => ({
  // Mock ReactFlow to render node type components as the real one would.
  ReactFlow: ({ nodes, edges, nodeTypes, children, nodesFocusable, nodesConnectable }: Record<string, unknown>) => (
    <div
      data-testid="react-flow"
      data-nodes={JSON.stringify((nodes as { id: string }[]).map((n) => ({ id: n.id })))}
      data-edges={JSON.stringify(edges)}
    >
      {children as React.ReactNode}
      {(nodes as {
        id: string
        type: string
        data: Record<string, unknown>
        focusable?: boolean
        connectable?: boolean
      }[]).map((n) => {
        const NodeComp = (typeof nodeTypes === "object" && nodeTypes !== null)
          ? (nodeTypes as Record<string, unknown>)[n.type]
          : undefined
        return NodeComp
          ? (
              <div
                key={n.id}
                data-testid="rf-node-wrapper"
                tabIndex={nodesFocusable === false || n.focusable === false ? undefined : 0}
              >
                <NodeComp
                  data={n.data}
                  isConnectable={n.connectable ?? nodesConnectable ?? true}
                />
              </div>
            )
          : <div key={n.id}>{n.id}</div>
      })}
    </div>
  ),
  Background: () => <div data-testid="bg" />,
  Controls: () => <div data-testid="controls" />,
  Handle: ({
    type,
    isConnectable,
    isConnectableStart,
    isConnectableEnd,
    onClick,
    className,
    style,
  }: Record<string, unknown>) => {
    const hasPointerEventsOverride = (style as React.CSSProperties | undefined)?.pointerEvents === "auto"
      || (typeof className === "string" && className.split(/\s+/).includes("!pointer-events-auto"))

    return (
      <div
        data-testid={`handle-${type}`}
        data-is-connectable={String(isConnectable)}
        data-is-connectable-start={String(isConnectableStart)}
        data-is-connectable-end={String(isConnectableEnd)}
        data-pointer-events={hasPointerEventsOverride ? "auto" : "none"}
        onClick={hasPointerEventsOverride && typeof onClick === "function"
          ? onClick as React.MouseEventHandler<HTMLDivElement>
          : undefined}
      />
    )
  },
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

  it("renders each resource as a native button with one keyboard stop", async () => {
    const user = userEvent.setup()
    render(<ResourceGraph nodes={sampleNodes} onSelectNode={vi.fn()} />)

    const button = screen.getByRole("button", {
      name: "Open Deployment demo-deploy resource details",
      exact: true,
    })
    const wrapper = button.closest("[data-testid='rf-node-wrapper']")

    expect(button.tagName).toBe("BUTTON")
    expect(button).toHaveAttribute("type", "button")
    expect(wrapper).not.toHaveAttribute("tabindex")
    expect(within(button).queryByTestId("handle-target")).not.toBeInTheDocument()
    expect(within(button).queryByTestId("handle-source")).not.toBeInTheDocument()
    expect(wrapper).toContainElement(screen.getAllByTestId("handle-target")[0])
    expect(wrapper).toContainElement(screen.getAllByTestId("handle-source")[0])

    await user.tab()
    expect(button).toHaveFocus()
  })

  it("uses only phrasing content inside each resource button", () => {
    render(<ResourceGraph nodes={sampleNodes} onSelectNode={vi.fn()} />)

    const button = screen.getByRole("button", {
      name: "Open Deployment demo-deploy resource details",
      exact: true,
    })

    expect(button.querySelector("div, p")).not.toBeInTheDocument()
  })

  it("forwards disabled connection state to both resource handles", () => {
    render(<ResourceGraph nodes={sampleNodes} onSelectNode={vi.fn()} />)

    const button = screen.getByRole("button", {
      name: "Open Deployment demo-deploy resource details",
      exact: true,
    })
    const wrapper = button.closest("[data-testid='rf-node-wrapper']") as HTMLElement

    const handles = [
      within(wrapper).getByTestId("handle-target"),
      within(wrapper).getByTestId("handle-source"),
    ]

    for (const handle of handles) {
      expect(handle).toHaveAttribute("data-is-connectable", "false")
      expect(handle).toHaveAttribute("data-is-connectable-start", "false")
      expect(handle).toHaveAttribute("data-is-connectable-end", "false")
    }
  })

  it("overrides disabled handle pointer events for resource selection", () => {
    render(<ResourceGraph nodes={sampleNodes} onSelectNode={vi.fn()} />)

    const button = screen.getByRole("button", {
      name: "Open Deployment demo-deploy resource details",
      exact: true,
    })
    const wrapper = button.closest("[data-testid='rf-node-wrapper']") as HTMLElement

    expect(within(wrapper).getByTestId("handle-target")).toHaveAttribute("data-pointer-events", "auto")
    expect(within(wrapper).getByTestId("handle-source")).toHaveAttribute("data-pointer-events", "auto")
  })

  it("selects a resource exactly once when either non-connectable handle is clicked", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<ResourceGraph nodes={sampleNodes} onSelectNode={onSelect} />)

    const button = screen.getByRole("button", {
      name: "Open Deployment demo-deploy resource details",
      exact: true,
    })
    const wrapper = button.closest("[data-testid='rf-node-wrapper']") as HTMLElement

    await user.click(within(wrapper).getByTestId("handle-target"))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(sampleNodes[0])

    onSelect.mockClear()
    await user.click(within(wrapper).getByTestId("handle-source"))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(sampleNodes[0])
  })

  it("activates a resource once with click, Enter, and Space without scrolling", async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<ResourceGraph nodes={sampleNodes} onSelectNode={onSelect} />)

    const button = screen.getByRole("button", {
      name: "Open Deployment demo-deploy resource details",
      exact: true,
    })

    await user.click(button)
    expect(onSelect).toHaveBeenCalledTimes(1)

    onSelect.mockClear()
    button.focus()
    await user.keyboard("{Enter}")
    expect(onSelect).toHaveBeenCalledTimes(1)

    onSelect.mockClear()
    const initialScrollTop = 37
    document.documentElement.scrollTop = initialScrollTop
    await user.keyboard(" ")
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(document.documentElement.scrollTop).toBe(initialScrollTop)
    document.documentElement.scrollTop = 0
  })
})
